/**
 * User-facing surfaces: the `/agents-md-status` summary and terminal
 * notifications for newly loaded instruction batches.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigOrigin, Mode } from "./config";
import { formatDisplayPath } from "./discovery";
import type { InstructionFile } from "./instructions";

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
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
}

/** The `/agents-md-status` summary. */
export function formatStatus(input: StatusInput): string {
  const modeLine =
    `Mid-convo system: ${input.midConvoSystemMessages ? "yes" : "no"} | ` +
    `Mode: ${input.configuredMode} (${input.modeOrigin}) → ${input.effectiveMode}`;
  const header =
    input.ignorePatterns > 0
      ? [`AGENTS.md: ${input.modelLabel}`, `${modeLine} | Ignore patterns: ${input.ignorePatterns}`]
      : [`AGENTS.md: ${input.modelLabel}`, modeLine];
  const rows = [
    ...input.nativeFiles.map((file) => ({
      label: formatDisplayPath(file.path, input.cwd, input.home),
      via: "Pi",
      tokens: estimateTokens(file.content),
    })),
    ...input.nestedFiles.map((file) => ({
      label: formatDisplayPath(file.displayPath, input.cwd, input.home),
      via: file.delivery === "system" ? "System" : "Tool result",
      tokens: estimateTokens(file.content),
    })),
  ];
  if (rows.length === 0) return `${header.join("\n")}\n\nNo AGENTS.md files loaded.`;

  const lines = [...header, ""];
  for (const [index, row] of rows.entries()) {
    lines.push(`${index + 1}  ${row.label} (${row.via}, ~${row.tokens} tokens)`);
  }
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  lines.push("", `${rows.length} ${rows.length === 1 ? "file" : "files"} | ~${total} tokens`);
  return lines.join("\n");
}

/** Terminal notification for a newly loaded batch; not sent to the model. */
export function notifyDiscovered(ctx: ExtensionContext, files: readonly InstructionFile[]): void {
  if (!ctx.hasUI || files.length === 0) return;

  const tokens = files.reduce((total, file) => total + estimateTokens(file.content), 0);
  const paths = files.map((file) => `  ${file.displayPath}`).join("\n");

  ctx.ui.notify(`AGENTS.md loaded (~${tokens} tokens):\n${paths}`, "info");
}
