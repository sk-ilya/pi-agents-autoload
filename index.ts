/**
 * pi-agents-autoload — automatically load nested AGENTS.md files.
 *
 * Pi loads AGENTS.md from the working directory and its ancestor directories
 * at startup. This extension discovers AGENTS.md files in subdirectories as
 * the agent reads, edits, or writes files beneath them, and delivers them to
 * the model without duplicating the instruction files Pi already loaded.
 *
 * The loading mode is optional JSON configuration (`{"mode": "auto"}`) from
 * - "auto": patch the system prompt mid-run when the model supports
 *   mid-conversation system messages, otherwise append to read results.
 * - "immediate": always patch the system prompt on the next model request.
 * - "deferred": append instructions to read tool results.
 *
 * System-delivered instructions live in a dedicated `pi_agents_md`
 * system-prompt section, separate from Pi's own `project_context` section;
 * each file keeps Pi's usual `<project_instructions path="...">` block
 * format. Discovered files survive one compaction cycle of disuse: files
 * used since the previous compaction are retained, and instructions first
 * delivered through tool results are promoted to the system section when
 * retained, since their original delivery may be compacted away. Files that
 * go a full compaction cycle without use expire; the next file access in
 * their directory discovers them again. Root and ancestor files loaded by
 * Pi are unaffected. Mentions inside retained conversation messages or
 * summaries are never rewritten.
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  getCurrentSystemMessage,
  type ImageContent,
  type SystemMessage,
  type TextContent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "pi-agents-autoload";
const FILE_NAME = "AGENTS.md";
const CONFIG_FILE_NAME = "pi-agents-autoload.json";
/** Dedicated system-prompt section for nested instructions. */
const SECTION_NAME = "pi_agents_md";
const BLOCK_OPEN = '<project_instructions path="';
const BLOCK_CLOSE = "</project_instructions>";
/** Block reason when the instructions arrive through the system prompt instead. */
const SYSTEM_BLOCK_REASON =
  "Blocked: nested AGENTS.md instructions were discovered for this path and added to the " +
  "system prompt. Review them, then retry the same operation.";

export type Mode = "auto" | "immediate" | "deferred";

/** Where the configured mode came from. */
export type ConfigOrigin = "project" | "global" | "default";

/** How the model receives a discovered file. */
export type Delivery = "system" | "toolResult";

/** One discovered instruction file, snapshotted for the current session branch. */
export interface InstructionFile {
  /**
   * Scoped path of the instruction file (its canonical directory plus
   * `AGENTS.md`); the deduplication key. Directory aliases collapse onto one
   * key, while symlinks in different scopes stay distinct even when they
   * share a source file.
   */
  key: string;
  /** Path relative to the working directory, with `/` separators; used for display. */
  displayPath: string;
  content: string;
  delivery: Delivery;
  /** Whether the file was discovered or used during the current compaction cycle. */
  usedSinceCompact: boolean;
}

/** Shape persisted with `pi.appendEntry` and restored from the active branch. */
interface SnapshotFile {
  path: string;
  content: string;
  delivery: Delivery;
  /** Absent in snapshots written before usage tracking; restored as `true`. */
  usedSinceCompact: boolean;
}

interface Snapshot {
  files: SnapshotFile[];
}

/** Parse and validate a configured mode value. */
export function parseMode(raw: string): Mode {
  if (raw === "auto" || raw === "immediate" || raw === "deferred") return raw;
  throw new Error(`Invalid mode "${raw}". Expected "auto", "immediate", or "deferred".`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the configured mode from a JSON configuration file. Returns undefined
 * when the file is absent or sets no mode. Malformed JSON, a non-object
 * document, an invalid mode, or an unreadable file throw an error naming the
 * file.
 */
export async function readModeFile(file: string): Promise<Mode | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`${file}: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: malformed JSON (${errorMessage(error)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object with an optional "mode" property`);
  }
  const mode = (parsed as { mode?: unknown }).mode;
  if (mode === undefined) return undefined;
  if (typeof mode !== "string") {
    throw new Error(`${file}: "mode" must be a string`);
  }
  try {
    return parseMode(mode);
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`);
  }
}

/**
 * Resolve the configured mode: trusted project configuration over global
 * configuration over the default. Untrusted project configuration is never
 * read.
 */
export async function loadMode(
  ctx: ExtensionContext,
): Promise<{ mode: Mode; origin: ConfigOrigin }> {
  if (ctx.isProjectTrusted()) {
    const project = await readModeFile(path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
    if (project !== undefined) return { mode: project, origin: "project" };
  }
  const globalMode = await readModeFile(path.join(getAgentDir(), CONFIG_FILE_NAME));
  if (globalMode !== undefined) return { mode: globalMode, origin: "global" };
  return { mode: "auto", origin: "default" };
}

function supportsMidConvoSystemMessages(ctx: ExtensionContext): boolean {
  // The flag exists on most compat shapes (Bedrock's does not have it), so read it structurally.
  const compat = ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined;
  return compat?.supportsMidConvoSystemMessages === true;
}

/**
 * Resolve "auto" against the active model. Mid-run system-prompt patches keep
 * the cached prefix only on models that accept mid-conversation system
 * messages; other models fall back to tool-result delivery.
 */
function effectiveMode(configured: Mode, ctx: ExtensionContext): "immediate" | "deferred" {
  if (configured === "immediate" || configured === "deferred") return configured;
  return supportsMidConvoSystemMessages(ctx) ? "immediate" : "deferred";
}

function stripAtPrefix(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

/** Expand a leading `~` or `~/` to the home directory, like Pi's built-in tools. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function realpathOrNull(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Canonicalize an already-resolved path by realpath-ing its nearest existing
 * ancestor, so symlink aliases resolve to their real location and `..`
 * segments inside symlinked directories follow kernel semantics. Returns
 * undefined when the canonical path is outside `cwdReal`.
 */
async function canonicalizeWithin(resolved: string, cwdReal: string): Promise<string | undefined> {
  let current = resolved;
  const suffix: string[] = [];
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== undefined) {
      const canonical = suffix.length === 0 ? real : path.join(real, ...suffix);
      return isWithin(cwdReal, canonical) ? canonical : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

export interface DiscoveredFile {
  key: string;
  displayPath: string;
  content: string;
}

/**
 * Find AGENTS.md files in every directory from the first subdirectory below
 * `cwd` down to the target's parent, shallowest first. The working directory
 * itself is skipped: Pi loads root and ancestor instruction files at startup.
 * Targets and instruction sources outside `cwd` are ignored; a symlinked
 * instruction file is identified by the directory it is linked from, so two
 * scopes can share one source file.
 */
export async function discoverInstructionFiles(
  target: string,
  cwd: string,
): Promise<DiscoveredFile[]> {
  const cleaned = expandTilde(stripAtPrefix(target));
  if (cleaned === "") return [];
  const cwdReal = (await realpathOrNull(cwd)) ?? path.resolve(cwd);
  const canonicalTarget = await canonicalizeWithin(path.resolve(cwd, cleaned), cwdReal);
  if (canonicalTarget === undefined) return [];

  const relParent = path.relative(cwdReal, path.dirname(canonicalTarget));
  if (relParent === "") return [];
  const segments = relParent.split(path.sep).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return [];

  const found: DiscoveredFile[] = [];
  for (let depth = 1; depth <= segments.length; depth++) {
    const dir = path.join(cwdReal, ...segments.slice(0, depth));
    const instructionPath = path.join(dir, FILE_NAME);
    let isFile = false;
    try {
      isFile = (await fs.stat(instructionPath)).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    // The instruction file may itself be a symlink. Its identity and scope are
    // the directory being walked; resolve the symlink only for the boundary
    // check, so sources outside the project are ignored.
    const sourcePath = await realpathOrNull(instructionPath);
    if (!sourcePath || !isWithin(cwdReal, sourcePath)) continue;
    if (found.some((candidate) => candidate.key === instructionPath)) continue;
    let content: string;
    try {
      content = stripBom(await fs.readFile(instructionPath, "utf8"));
    } catch {
      continue;
    }
    found.push({
      key: instructionPath,
      displayPath: toPosix(path.relative(cwdReal, instructionPath)),
      content,
    });
  }
  return found;
}

function renderInstructionBlock(file: { displayPath: string; content: string }): string {
  return `${BLOCK_OPEN}${file.displayPath}">\n${file.content}\n${BLOCK_CLOSE}`;
}

function renderInstructionBlocks(
  files: ReadonlyArray<{ displayPath: string; content: string }>,
): string {
  return files.map(renderInstructionBlock).join("\n\n");
}

/** Text appended to a successful read result in deferred mode. */
export function renderDeferredText(
  files: ReadonlyArray<{ displayPath: string; content: string }>,
): string {
  return (
    "Discovered nested AGENTS.md instructions. Each applies to its own directory and " +
    `every directory beneath it, in addition to previously loaded project instructions:\n\n${renderInstructionBlocks(files)}`
  );
}

/** Block reason for a first edit/write that discovers new instructions. */
export function renderBlockReason(
  files: ReadonlyArray<{ displayPath: string; content: string }>,
): string {
  return (
    "Blocked: nested AGENTS.md instructions were discovered for this path. Review them, " +
    "then retry the same operation. They apply in addition to previously loaded project " +
    `instructions:\n\n${renderInstructionBlocks(files)}`
  );
}

/** Project-relative where possible, `~` under the home directory, else absolute. */
export function formatDisplayPath(p: string, cwd: string, home: string): string {
  const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  if (isWithin(cwd, absolute)) return toPosix(path.relative(cwd, absolute));
  if (isWithin(home, absolute)) return `~/${toPosix(path.relative(home, absolute))}`;
  return toPosix(absolute);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export interface StatusInput {
  modelLabel: string;
  midConvoSystemMessages: boolean;
  configuredMode: Mode;
  modeOrigin: ConfigOrigin;
  effectiveMode: "immediate" | "deferred";
  cwd: string;
  home: string;
  /** Pi's native context files, in prompt order. */
  nativeFiles: ReadonlyArray<{ path: string; content: string }>;
  /** Active nested files, in discovery order. */
  nestedFiles: ReadonlyArray<InstructionFile>;
}

/** The `/agents-md-status` summary. */
export function formatStatus(input: StatusInput): string {
  const header = [
    `AGENTS.md: ${input.modelLabel}`,
    `Mid-convo system: ${input.midConvoSystemMessages ? "yes" : "no"} | ` +
      `Mode: ${input.configuredMode} (${input.modeOrigin}) → ${input.effectiveMode}`,
  ];
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
function notifyDiscovered(ctx: ExtensionContext, files: readonly InstructionFile[]): void {
  if (!ctx.hasUI || files.length === 0) return;

  const tokens = files.reduce((total, file) => total + estimateTokens(file.content), 0);
  const paths = files.map((file) => `  ${file.displayPath}`).join("\n");

  ctx.ui.notify(`AGENTS.md loaded (~${tokens} tokens):\n${paths}`, "info");
}

export default function piAgentsMd(pi: ExtensionAPI): void {
  /** Configured mode and its origin, (re)loaded at every session start. */
  let configuredMode: Mode = "auto";
  let modeOrigin: ConfigOrigin = "default";
  /** Active instruction files, in discovery order; each survives one
   * compaction cycle of disuse. */
  const activeFiles = new Map<string, InstructionFile>();
  /**
   * Keys of instructions added or changed by the current tool batch that
   * have not yet reached the model. Edit and write calls under them stay
   * blocked until the next model request is prepared.
   */
  const pendingReviewKeys = new Set<string>();
  let lastSnapshotJson: string | undefined;

  function buildSnapshot(): Snapshot {
    return {
      files: [...activeFiles.values()].map(
        ({ displayPath, content, delivery, usedSinceCompact }) => ({
          path: displayPath,
          content,
          delivery,
          usedSinceCompact,
        }),
      ),
    };
  }

  function persistSnapshot(): void {
    const snapshot = buildSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshotJson) return;
    pi.appendEntry(ENTRY_TYPE, snapshot);
    lastSnapshotJson = json;
  }

  /** Rebuild the active files from the latest snapshot on the active branch. */
  async function restoreFromBranch(ctx: ExtensionContext): Promise<void> {
    activeFiles.clear();
    lastSnapshotJson = undefined;
    let snapshot: Snapshot | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        snapshot = entry.data as Snapshot | undefined;
      }
    }
    if (!snapshot || !Array.isArray(snapshot.files)) return;
    // Reconstruct the scoped keys the same way discovery builds them,
    // so a resumed session deduplicates against fresh discoveries.
    const cwdReal = (await realpathOrNull(ctx.cwd)) ?? path.resolve(ctx.cwd);
    for (const file of snapshot.files) {
      if (typeof file?.path !== "string" || typeof file?.content !== "string") continue;
      const key = path.join(cwdReal, file.path);
      if (activeFiles.has(key)) continue;
      activeFiles.set(key, {
        key,
        displayPath: file.path,
        content: file.content,
        delivery: file.delivery === "toolResult" ? "toolResult" : "system",
        // Snapshots from before usage tracking carry no flag; give those
        // files one full grace cycle.
        usedSinceCompact: file.usedSinceCompact !== false,
      });
    }
    lastSnapshotJson = JSON.stringify(buildSnapshot());
  }

  function activeSystemFiles(): InstructionFile[] {
    return [...activeFiles.values()].filter((file) => file.delivery === "system");
  }

  /** Register newly discovered files in discovery order. */
  function registerDiscoveredFiles(
    files: DiscoveredFile[],
    ctx: ExtensionContext,
  ): InstructionFile[] {
    const delivery: Delivery =
      effectiveMode(configuredMode, ctx) === "immediate" ? "system" : "toolResult";
    return files.map((file) => {
      const record: InstructionFile = { ...file, delivery, usedSinceCompact: true };
      activeFiles.set(record.key, record);
      return record;
    });
  }

  interface ObservedFiles {
    /** Newly registered files, in discovery order. */
    added: InstructionFile[];
    /** Retained files whose content changed while being renewed. */
    updated: InstructionFile[];
  }

  /**
   * Fold a discovery into the registry: register new files, renew retained
   * ones, and refresh a retained file's content on its first re-access
   * after compaction. Newly added or changed files stay pending review
   * until the next model request delivers them. Called after asynchronous
   * discovery, so it is the recheck point for concurrent tool calls: files
   * registered by another call in between are treated as already known.
   * Persists only when the registry changed.
   */
  function observeDiscoveredFiles(
    discovered: DiscoveredFile[],
    ctx: ExtensionContext,
  ): ObservedFiles {
    const added = registerDiscoveredFiles(
      discovered.filter((file) => !activeFiles.has(file.key)),
      ctx,
    );
    const updated: InstructionFile[] = [];
    let changed = added.length > 0;
    for (const file of discovered) {
      const existing = activeFiles.get(file.key);
      if (existing === undefined || existing.usedSinceCompact) continue;
      existing.usedSinceCompact = true;
      changed = true;
      if (file.content !== existing.content) {
        existing.content = file.content;
        updated.push(existing);
      }
    }
    for (const file of [...added, ...updated]) {
      pendingReviewKeys.add(file.key);
    }
    if (changed) persistSnapshot();
    return { added, updated };
  }

  pi.on("session_start", async (_event, ctx) => {
    await restoreFromBranch(ctx);
    // Configuration errors surface through Pi's extension error reporting;
    // the session then runs with the default mode. Reload, new, and resume
    // create a fresh extension instance, so there is no earlier mode to fall
    // back to within this session either.
    ({ mode: configuredMode, origin: modeOrigin } = await loadMode(ctx));
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreFromBranch(ctx);
  });

  // A first edit/write that discovers new or changed instructions is blocked
  // so the model reviews them before retrying; unchanged instructions that
  // are merely used again do not block. Sibling calls in the same tool batch
  // stay blocked until the instructions have reached the model.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) {
      return;
    }
    let discovered: DiscoveredFile[];
    try {
      discovered = await discoverInstructionFiles(event.input.path, ctx.cwd);
    } catch {
      // Discovery failure must not block the tool call.
      return;
    }
    const { added } = observeDiscoveredFiles(discovered, ctx);
    // Another call in this batch may have registered the instructions
    // already; they still need review before any edit or write proceeds.
    const needsReview = discovered.some((file) => pendingReviewKeys.has(file.key));
    if (!needsReview) return;
    notifyDiscovered(ctx, added);
    // Deferred delivery includes the new instructions in the block reason;
    // system-delivered instructions (immediate mode, retained files whose
    // content changed, and instructions a sibling call already carries)
    // arrive with the next system-prompt update instead.
    const toolResultFiles = added.filter((file) => file.delivery === "toolResult");
    return {
      block: true,
      reason: toolResultFiles.length > 0 ? renderBlockReason(toolResultFiles) : SYSTEM_BLOCK_REASON,
    };
  });

  // Reads discover on success and deliver in the same result, so registration
  // and delivery cannot diverge. Unsuccessful reads register nothing; the next
  // read rediscovers.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return;
    const target = (event.input as { path?: unknown }).path;
    if (typeof target !== "string") return;
    let discovered: DiscoveredFile[];
    try {
      discovered = await discoverInstructionFiles(target, ctx.cwd);
    } catch {
      return;
    }
    const { added } = observeDiscoveredFiles(discovered, ctx);
    notifyDiscovered(ctx, added);

    if (added.length === 0 || added[0].delivery === "system") {
      return; // delivered by the next system-prompt patch
    }
    const content: (TextContent | ImageContent)[] = [
      ...event.content,
      { type: "text" as const, text: renderDeferredText(added) },
    ];
    // Replacing content drops structuredContent unless it is passed through.
    if (event.structuredContent === undefined) return { content };
    return { content, structuredContent: event.structuredContent };
  });

  /**
   * Ephemeral update of the dedicated section for the current request: apply
   * the active system-delivered files, or remove the section when it should be
   * gone (after compaction expired them). Re-applied until the equivalent
   * durable section change lands in the transcript (via before_agent_start),
   * which the comparison detects. Covers mid-run discovery and the first
   * request after a mid-run compaction, including an automatic retry.
   */
  pi.on("context_with_system", async (event) => {
    const content = renderInstructionBlocks(activeSystemFiles());
    const desired = content ? `<${SECTION_NAME}>\n${content}\n</${SECTION_NAME}>` : undefined;
    const current = getCurrentSystemMessage(event.messages)?.sections?.[SECTION_NAME];
    // Preparing this request ends the review window: the tool results of the
    // batch that discovered the instructions are part of the context the
    // model is about to see, with or without a section patch.
    pendingReviewKeys.clear();
    if (current === desired) return;
    const patch: SystemMessage = {
      role: "system",
      content: "",
      sections: { [SECTION_NAME]: desired ?? null },
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, patch] };
  });

  /**
   * Maintain the dedicated section through Pi's native prompt options; Pi
   * builds the section, diffs it against what the model has, and persists the
   * resulting section update, including the removal after compaction.
   */
  pi.on("before_agent_start", (event) => {
    const content = renderInstructionBlocks(activeSystemFiles());
    if (content) {
      event.systemPromptOptions.sections[SECTION_NAME] = content;
    } else {
      delete event.systemPromptOptions.sections[SECTION_NAME];
    }
  });

  // Compaction ages every discovered file by one cycle. Files used during
  // the cycle are retained and demoted to "unused" for the next one; files
  // that were already unused expire and return on the next file access in
  // their directory. Retained files are promoted to system delivery, since
  // the tool results that carried deferred instructions may be compacted
  // away while the registry entry lives on.
  pi.on("session_compact", () => {
    for (const [key, file] of activeFiles) {
      if (!file.usedSinceCompact) {
        activeFiles.delete(key);
        continue;
      }
      file.usedSinceCompact = false;
      file.delivery = "system";
    }
    persistSnapshot();
  });

  pi.registerCommand("agents-md-status", {
    description: "Show loaded AGENTS.md files, their delivery, and the active mode",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        formatStatus({
          modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
          midConvoSystemMessages: supportsMidConvoSystemMessages(ctx),
          configuredMode,
          modeOrigin,
          effectiveMode: effectiveMode(configuredMode, ctx),
          cwd: ctx.cwd,
          home: homedir(),
          nativeFiles: ctx.getSystemPromptOptions().contextFiles ?? [],
          nestedFiles: [...activeFiles.values()],
        }),
        "info",
      );
    },
  });
}
