/** Load nested AGENTS.md instructions when Pi accesses files below the project root. */

import { homedir } from "node:os";
import {
  getCurrentSystemMessage,
  type ImageContent,
  type SystemMessage,
  type TextContent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isReadToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { type ExtensionConfig, isIgnoredPath, loadConfig } from "./config";
import {
  effectiveMode,
  REVIEW_BLOCK_REASON,
  renderBlockReason,
  renderDeferredText,
  renderInstructionBlocks,
  SECTION_NAME,
  supportsMidConvoSystemMessages,
} from "./delivery";
import {
  type DiscoveryResult,
  discoverInstructionFiles,
  resolveInstructionTarget,
} from "./discovery";
import { InstructionRegistry } from "./instructions";
import { formatStatus, notifyDiscovered } from "./status";

export { type ConfigOrigin, type Mode, parseMode } from "./config";
export { type Delivery, renderBlockReason, renderDeferredText } from "./delivery";
export { formatDisplayPath } from "./discovery";
export { formatStatus } from "./status";

export default function piAgentsMd(pi: ExtensionAPI): void {
  /** Effective configuration, (re)loaded at every session start. */
  let config: ExtensionConfig = { mode: "auto", modeOrigin: "default", ignore: [] };
  const registry = new InstructionRegistry(pi);

  function deliveryForNewFiles(ctx: ExtensionContext): "system" | "toolResult" {
    return effectiveMode(config.mode, ctx) === "immediate" ? "system" : "toolResult";
  }

  pi.on("session_start", async (_event, ctx) => {
    // Configuration errors surface through Pi's extension error reporting;
    // the session then runs with the default configuration. Reload, new,
    // and resume create a fresh extension instance, so there is no earlier
    // configuration to fall back to within this session either.
    let loaded: ExtensionConfig;
    try {
      loaded = await loadConfig(ctx);
    } catch (error) {
      await registry.restoreFromBranch(ctx, []);
      throw error;
    }
    config = loaded;
    await registry.restoreFromBranch(ctx, config.ignore);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await registry.restoreFromBranch(ctx, config.ignore);
  });

  function discoverFor(target: string, ctx: ExtensionContext) {
    return discoverInstructionFiles(target, ctx.cwd, {
      ignore: config.ignore,
      known: registry.knownFiles(),
    });
  }

  // A first edit/write that discovers new or changed instructions is blocked
  // so the model reviews them before retrying; unchanged instructions that
  // are merely used again do not block. Sibling calls in the same tool batch
  // stay blocked until the instructions have reached the model.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) {
      return;
    }
    let result: DiscoveryResult;
    try {
      result = await discoverFor(event.input.path, ctx);
    } catch {
      return {
        block: true,
        reason:
          "Blocked: could not inspect nested AGENTS.md instructions for this path. Retry the operation.",
      };
    }
    if (result.unverifiedPaths.length > 0) {
      return {
        block: true,
        reason: `Blocked: could not inspect nested AGENTS.md instructions at ${result.unverifiedPaths.join(", ")}. Fix access and retry the operation.`,
      };
    }
    const { added, updated } = registry.observeDiscovered(result, deliveryForNewFiles(ctx));
    // Another call in this batch may have registered the instructions
    // already; they still need review before any edit or write proceeds.
    const needsReview = result.files.some((file) => registry.isPendingReview(file.key));
    if (!needsReview) return;
    notifyDiscovered(ctx, [...added, ...updated]);
    // Deferred delivery includes new or changed instructions in the first
    // block reason; other blocked calls refer to that result or the system section.
    const ownPending = [...added, ...updated].filter((file) => file.delivery === "toolResult");
    return {
      block: true,
      reason: ownPending.length > 0 ? renderBlockReason(ownPending) : REVIEW_BLOCK_REASON,
    };
  });

  // Successful reads deliver discovered instructions in their result. A
  // complete read of AGENTS.md already carries its instructions, so it is
  // registered without appending a second copy.
  pi.on("tool_result", async (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;
    const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
    const target = input.path;
    if (typeof target !== "string") return;
    let result: DiscoveryResult;
    try {
      result = await discoverFor(target, ctx);
    } catch {
      return;
    }
    const explicit = await resolveInstructionTarget(target, ctx.cwd);
    const discovered = explicit
      ? result.files.filter((file) => file.key !== explicit.key)
      : result.files;
    const { added, updated } = registry.observeDiscovered(
      { ...result, files: discovered },
      deliveryForNewFiles(ctx),
    );
    // A caller-limited or automatically truncated read does not deliver the
    // entire file; leave it discoverable on the next relevant access.
    const completeRead =
      input.offset === undefined &&
      input.limit === undefined &&
      !event.details?.truncation?.truncated;
    // Pi's read result may include a BOM; discovery strips it from registered content.
    const deliveredText =
      event.content.length === 1 && event.content[0]?.type === "text"
        ? event.content[0].text.replace(/^\uFEFF/, "")
        : undefined;
    if (
      explicit &&
      completeRead &&
      deliveredText === explicit.content &&
      !isIgnoredPath(explicit.displayPath, config.ignore)
    ) {
      registry.registerDelivered(explicit);
    }
    notifyDiscovered(ctx, [...added, ...updated]);

    const deliver = [...added, ...updated].filter((file) => file.delivery === "toolResult");
    if (deliver.length === 0) {
      return; // delivered by the next system-prompt patch
    }
    const content: (TextContent | ImageContent)[] = [
      ...event.content,
      { type: "text" as const, text: renderDeferredText(deliver) },
    ];
    // Preserve Pi's machine-readable file data; the added instructions are model-facing only.
    if (event.structuredContent === undefined) return { content };
    return { content, structuredContent: event.structuredContent };
  });

  /**
   * Ephemeral update of the dedicated section for the current request: apply
   * the active system-delivered files, or remove the section when it should be
   * gone (after compaction expired them or an access deleted them).
   * Re-applied until the equivalent durable section change lands in the
   * transcript (via before_agent_start), which the comparison detects.
   * Covers mid-run discovery and the first request after a mid-run
   * compaction, including an automatic retry.
   */
  pi.on("context_with_system", async (event) => {
    const content = renderInstructionBlocks(registry.systemFiles());
    const desired = content ? `<${SECTION_NAME}>\n${content}\n</${SECTION_NAME}>` : undefined;
    const current = getCurrentSystemMessage(event.messages)?.sections?.[SECTION_NAME];
    // Preparing this request ends the review window: the tool results of the
    // batch that discovered the instructions are part of the context the
    // model is about to see, with or without a section patch.
    registry.endReviewWindow();
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
   * resulting section update, including removals after compaction or deletion.
   */
  pi.on("before_agent_start", (event) => {
    const content = renderInstructionBlocks(registry.systemFiles());
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
    registry.ageForCompaction();
  });

  pi.registerCommand("agents-md-status", {
    description: "Show loaded AGENTS.md files, their delivery, and the active mode",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        formatStatus({
          modelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
          midConvoSystemMessages: supportsMidConvoSystemMessages(ctx),
          configuredMode: config.mode,
          modeOrigin: config.modeOrigin,
          effectiveMode: effectiveMode(config.mode, ctx),
          ignorePatterns: config.ignore.length,
          cwd: ctx.cwd,
          home: homedir(),
          nativeFiles: ctx.getSystemPromptOptions().contextFiles ?? [],
          nestedFiles: registry.files(),
        }),
        "info",
      );
    },
  });
}
