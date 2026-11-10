/**
 * How discovered instructions reach the model: rendering for tool-result
 * delivery, the dedicated system-prompt section, and blocking messages for
 * first edits and writes. Mode resolution picks the mechanism per model
 * compatibility.
 */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "./config";

/** Section names owned by this extension. The unsuffixed name belongs to older sessions. */
export const SECTION_NAME = "pi_agents_md";
export const FILE_SECTION_PREFIX = `${SECTION_NAME}_file_`;

export function fileSectionName(displayPath: string): string {
  return `${FILE_SECTION_PREFIX}${createHash("sha256").update(displayPath).digest("hex")}`;
}

const BLOCK_OPEN = '<project_instructions path="';
const BLOCK_CLOSE = "</project_instructions>";

/** Block reason when another result or the system section carries the instructions. */
export const REVIEW_BLOCK_REASON =
  "Blocked: nested context-file instructions were discovered for this path. Review them in this " +
  "tool batch or the system prompt, then retry the same operation.";

/** How the model receives a discovered file. */
export type Delivery = "system" | "toolResult";

export function supportsMidConvoSystemMessages(ctx: ExtensionContext): boolean {
  // The flag exists on most compat shapes (Bedrock's does not have it), so read it structurally.
  const compat = ctx.model?.compat as { supportsMidConvoSystemMessages?: boolean } | undefined;
  return compat?.supportsMidConvoSystemMessages === true;
}

/**
 * Resolve "auto" against the active model. Models that accept mid-conversation
 * system messages receive anchored section updates; others use tool-result delivery.
 */
export function effectiveMode(configured: Mode, ctx: ExtensionContext): "immediate" | "deferred" {
  if (configured === "immediate" || configured === "deferred") return configured;
  return supportsMidConvoSystemMessages(ctx) ? "immediate" : "deferred";
}

export function renderInstructionBlocks(
  files: ReadonlyArray<{ displayPath: string; content: string }>,
): string {
  const renderBlock = (file: { displayPath: string; content: string }): string =>
    `${BLOCK_OPEN}${file.displayPath}">\n${file.content}\n${BLOCK_CLOSE}`;
  return files.map(renderBlock).join("\n\n");
}

/** Text appended to a successful read result in deferred mode. */
export function renderDeferredText(
  files: ReadonlyArray<{ displayPath: string; content: string }>,
): string {
  return (
    "Discovered nested context-file instructions. Each applies to its own directory and " +
    `every directory beneath it, in addition to previously loaded project instructions:\n\n${renderInstructionBlocks(files)}`
  );
}

/** Block reason for a first edit/write that discovers new instructions. */
export function renderBlockReason(
  files: ReadonlyArray<{ displayPath: string; content: string }>,
): string {
  return (
    "Blocked: nested context-file instructions were discovered for this path. Review them, " +
    "then retry the same operation. They apply in addition to previously loaded project " +
    `instructions:\n\n${renderInstructionBlocks(files)}`
  );
}
