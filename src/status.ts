/**
 * User-facing surfaces: the `/agents-md-status` summary and terminal
 * notifications for newly loaded instruction batches.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigOrigin, Mode } from "./config";
import { formatDisplayPath } from "./discovery";
import { type InstructionFile, MIN_HITS } from "./instructions";

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Number((bytes / 1024).toFixed(1))} KiB`;
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

export interface StatusInput {
  modelLabel: string;
  midConvoSystemMessages: boolean;
  configuredMode: Mode;
  modeOrigin: ConfigOrigin;
  effectiveMode: "immediate" | "deferred";
  /** Number of configured ignore patterns. */
  ignorePatterns: number;
  cwd: string;
  home: string;
  /** Pi's native context files, in prompt order. */
  nativeFiles: ReadonlyArray<{ path: string; content: string }>;
  /** Active nested files, in discovery order. */
  nestedFiles: ReadonlyArray<InstructionFile>;
  hits: ReadonlyMap<string, number>;
  carryOver: ReadonlyArray<InstructionFile>;
  maxBytes: number;
  maxFiles: number;
}

/** The `/agents-md-status` summary. */
export function formatStatus(input: StatusInput): string {
  const modeLine =
    `Mid-convo system: ${input.midConvoSystemMessages ? "yes" : "no"} | ` +
    `Mode: ${input.configuredMode} (${input.modeOrigin}) → ${input.effectiveMode}`;
  const header =
    input.ignorePatterns > 0
      ? [
          `Instructions: ${input.modelLabel}`,
          `${modeLine} | Ignore patterns: ${input.ignorePatterns}`,
        ]
      : [`Instructions: ${input.modelLabel}`, modeLine];
  const nativeTokens = input.nativeFiles.reduce(
    (total, file) => total + estimateTokens(file.content),
    0,
  );
  const managedTokens = input.nestedFiles.reduce(
    (total, file) => total + estimateTokens(file.content),
    0,
  );
  const managedBytes = input.nestedFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  const budget = input.maxBytes === 0 ? "unlimited" : formatBytes(input.maxBytes);
  const files = input.maxFiles === 0 ? "files unlimited" : `up to ${input.maxFiles} files`;
  const lines = [...header, `Carry-over: ${MIN_HITS}+ hits | ${budget} total | ${files}`];
  if (input.nativeFiles.length + input.nestedFiles.length === 0) {
    return `${lines.join("\n")}\n\nNo instruction files loaded.`;
  }

  const nativePaths = input.nativeFiles.map((file) =>
    formatDisplayPath(file.path, input.cwd, input.home),
  );
  const managedPaths = input.nestedFiles.map((file) =>
    formatDisplayPath(file.displayPath, input.cwd, input.home),
  );
  const width = Math.max(
    ...nativePaths.map((label) => label.length),
    ...managedPaths.map((label) => label.length),
  );
  const row = (label: string, details: string) => `  - ${label.padEnd(width)} (${details})`;
  if (input.nativeFiles.length > 0) {
    lines.push(
      "",
      `Pi-loaded (${fileCount(input.nativeFiles.length)} | ~${formatCount(nativeTokens)} tokens)`,
    );
    for (const [index, file] of input.nativeFiles.entries()) {
      lines.push(row(nativePaths[index], `~${formatCount(estimateTokens(file.content))} tokens`));
    }
  }
  if (input.nestedFiles.length > 0) {
    lines.push(
      "",
      `Managed (${fileCount(input.nestedFiles.length)} | ~${formatCount(managedTokens)} tokens | ${formatBytes(managedBytes)})`,
      "If compacted now:",
    );
    const selected = new Set(input.carryOver.map((file) => file.key));
    const notSelected = input.nestedFiles.filter((file) => !selected.has(file.key));
    const managedRow = (file: InstructionFile) => {
      const hits = input.hits.get(file.key) ?? 0;
      const label = formatDisplayPath(file.displayPath, input.cwd, input.home);
      return row(
        label,
        `~${formatCount(estimateTokens(file.content))} tokens · ${formatCount(hits)} ${hits === 1 ? "hit" : "hits"}`,
      );
    };
    if (input.carryOver.length > 0) {
      lines.push("  Carry over", ...input.carryOver.map(managedRow));
    }
    if (notSelected.length > 0) {
      if (input.carryOver.length > 0) lines.push("");
      lines.push("  ---------- Not carried over ----------", ...notSelected.map(managedRow));
    }
  }
  const keptTokens = input.carryOver.reduce(
    (total, file) => total + estimateTokens(file.content),
    0,
  );
  const keptBytes = input.carryOver.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  lines.push(
    "",
    `${fileCount(input.nativeFiles.length + input.nestedFiles.length)} | ~${formatCount(nativeTokens + managedTokens)} tokens`,
    `If compacted now: ${input.carryOver.length} of ${input.nestedFiles.length} managed | ~${formatCount(keptTokens)} tokens | ${formatBytes(keptBytes)}`,
  );
  return lines.join("\n");
}

/** Terminal notification for a newly loaded batch; not sent to the model. */
export function notifyDiscovered(ctx: ExtensionContext, files: readonly InstructionFile[]): void {
  if (!ctx.hasUI || files.length === 0) return;

  const tokens = files.reduce((total, file) => total + estimateTokens(file.content), 0);
  const paths = files.map((file) => `  ${file.displayPath}`).join("\n");

  ctx.ui.notify(`Instructions loaded (~${tokens} tokens):\n${paths}`, "info");
}
