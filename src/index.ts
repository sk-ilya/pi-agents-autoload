/** Load nested context files when Pi accesses files below the project root. */

import { homedir } from "node:os";
import type { ImageContent, SystemMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isReadToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, type ExtensionConfig, isIgnoredPath, loadConfig } from "./config";
import {
  effectiveMode,
  FILE_SECTION_PREFIX,
  REVIEW_BLOCK_REASON,
  renderBlockReason,
  renderDeferredText,
  SECTION_NAME,
  supportsMidConvoSystemMessages,
} from "./delivery";
import {
  type DiscoveryResult,
  discoverInstructionFiles,
  resolveInstructionTarget,
} from "./discovery";
import { InstructionRegistry, PATCH_ENTRY_TYPE, type SectionPatch } from "./instructions";
import { formatStatus, notifyDiscovered } from "./status";

export { type ConfigOrigin, type Mode, parseMode } from "./config";
export { type Delivery, renderBlockReason, renderDeferredText } from "./delivery";
export { formatDisplayPath } from "./discovery";
export { formatStatus } from "./status";

export default function piAgentsMd(pi: ExtensionAPI): void {
  /** Effective configuration, (re)loaded at every session start. */
  let config: ExtensionConfig = {
    mode: "auto",
    modeOrigin: "default",
    ignore: [],
    maxBytes: DEFAULT_MAX_BYTES,
    maxFiles: 0,
  };
  const registry = new InstructionRegistry(pi);

  function deliveryForNewFiles(ctx: ExtensionContext): "system" | "toolResult" {
    return effectiveMode(config.mode, ctx) === "immediate" ? "system" : "toolResult";
  }

  function placementEntries(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    let start = 0;
    for (const [index, entry] of branch.entries()) {
      if (entry.type === "compaction") start = index + 1;
    }
    return branch
      .slice(start)
      .filter((entry) => entry.type === "custom" && entry.customType === PATCH_ENTRY_TYPE);
  }

  function restorePlacement(ctx: ExtensionContext): void {
    const current = new Map<string, string>();
    for (const entry of placementEntries(ctx)) {
      if (entry.type !== "custom") continue;
      for (const [name, value] of Object.entries((entry.data as SectionPatch).sections)) {
        if (value === null) current.delete(name);
        else current.set(name, value);
      }
    }
    const desired = registry.systemSections();
    const sections: SectionPatch["sections"] = {};
    for (const [name, value] of Object.entries(desired)) {
      if (current.get(name) !== value) sections[name] = value;
    }
    for (const name of current.keys()) {
      if (!(name in desired)) sections[name] = null;
    }
    if (Object.keys(sections).length === 0) return;
    const anchor = ctx.sessionManager
      .buildSessionProjection()
      .entries.filter((entry) => entry.messages.length > 0)
      .at(-1);
    pi.appendEntry(PATCH_ENTRY_TYPE, {
      afterId: anchor?.sourceEntry.id ?? "",
      sections,
    } satisfies SectionPatch);
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
    restorePlacement(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await registry.restoreFromBranch(ctx, config.ignore);
    restorePlacement(ctx);
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
          "Blocked: could not inspect nested instructions for this path. Retry the operation.",
      };
    }
    if (result.unverifiedPaths.length > 0) {
      return {
        block: true,
        reason: `Blocked: could not inspect nested instructions at ${result.unverifiedPaths.join(", ")}. Fix access and retry the operation.`,
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
  // complete read of the selected context file already carries its instructions,
  // so it is registered without appending a second copy.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      const target = (event.input as { path?: unknown }).path;
      if (typeof target === "string") {
        try {
          const result = await discoverFor(target, ctx);
          registry.recordHits(result.files.map((file) => file.key));
        } catch {
          // Discovery already succeeded before this operation was allowed.
        }
      }
      return;
    }
    if (!isReadToolResult(event)) return;
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
    const explicitIsWinner = explicit && result.files.some((file) => file.key === explicit.key);
    const discovered = explicitIsWinner
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
      explicitIsWinner &&
      completeRead &&
      deliveredText === explicit.content &&
      !isIgnoredPath(explicit.displayPath, config.ignore)
    ) {
      registry.registerDelivered(explicit);
    }
    registry.recordHits(result.files.map((file) => file.key));
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

  // Turn-end runs after Pi persists the complete tool batch. Its result ID
  // anchors the new section delta at the same point in every later request.
  pi.on("turn_end", (event) => {
    const sections = registry.takePendingSections();
    if (Object.keys(sections).length === 0) return;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom" as const,
          customType: PATCH_ENTRY_TYPE,
          data: {
            afterId: event.toolResultEntryIds.at(-1) ?? event.messageEntryId,
            sections,
          } satisfies SectionPatch,
        },
      ],
    };
  });

  pi.on("context_with_system", async (event, ctx) => {
    const stripOwnedSections = (message: (typeof event.messages)[number]) => {
      if (message.role !== "system" || !message.sections) return message;
      const sections = Object.fromEntries(
        Object.entries(message.sections).filter(
          ([name]) => name !== SECTION_NAME && !name.startsWith(FILE_SECTION_PREFIX),
        ),
      );
      return Object.keys(sections).length === Object.keys(message.sections).length
        ? message
        : { ...message, sections };
    };
    const messages = event.messages.map(stripOwnedSections);
    const patches = placementEntries(ctx);
    if (patches.length === 0) {
      registry.endReviewWindow();
      return messages.some((message, index) => message !== event.messages[index])
        ? { messages }
        : undefined;
    }
    const projection = ctx.sessionManager.buildSessionProjection();
    const canonicalMessages = projection.messages.map(stripOwnedSections);
    const byId = new Map<string, { message: (typeof messages)[number]; index: number }>();
    let offset = 0;
    for (const entry of projection.entries) {
      if (entry.messages.length > 0) {
        byId.set(entry.sourceEntry.id, {
          message: canonicalMessages[offset + entry.messages.length - 1],
          index: offset + entry.messages.length - 1,
        });
      }
      offset += entry.messages.length;
    }
    const positions = (source: typeof messages) => {
      const bySignature = new Map<string, number[]>();
      for (const [index, message] of source.entries()) {
        const signature = JSON.stringify(message);
        const indexes = bySignature.get(signature) ?? [];
        indexes.push(index);
        bySignature.set(signature, indexes);
      }
      return bySignature;
    };
    const canonical = positions(canonicalMessages);
    const visible = positions(messages);
    const insertions = new Map<number, SystemMessage[]>();
    let missingAnchor = false;
    const patchNames = new Set<string>();
    for (const entry of patches) {
      if (entry.type !== "custom") continue;
      const patch = entry.data as SectionPatch;
      for (const name of Object.keys(patch.sections)) patchNames.add(name);
      const anchor = byId.get(patch.afterId);
      const signature = anchor === undefined ? undefined : JSON.stringify(anchor.message);
      const ordinal =
        anchor === undefined ? -1 : (canonical.get(signature ?? "")?.indexOf(anchor.index) ?? -1);
      const index = patch.afterId === "" ? 0 : (visible.get(signature ?? "")?.[ordinal] ?? -1);
      if (index < 0) {
        missingAnchor = true;
        continue;
      }
      const system: SystemMessage = {
        role: "system",
        content: "",
        sections: patch.sections,
        timestamp: 0,
      };
      insertions.set(index, [...(insertions.get(index) ?? []), system]);
    }
    if (missingAnchor) {
      // Context edits can remove an anchor; reconcile the current sections at the tail.
      const sections: SectionPatch["sections"] = registry.systemSections();
      for (const name of patchNames) {
        if (!(name in sections)) sections[name] = null;
      }
      insertions.set(messages.length - 1, [
        ...(insertions.get(messages.length - 1) ?? []),
        { role: "system", content: "", sections, timestamp: 0 },
      ]);
    }
    registry.endReviewWindow();
    const result = messages.flatMap((message, index) => [
      message,
      ...(insertions.get(index) ?? []),
    ]);
    return {
      messages: [...(insertions.get(-1) ?? []), ...result],
    };
  });

  // Select the files that fit the current hit and byte budget after Pi saves
  // its checkpoint; the request projection omits any checkpointed exclusions.
  pi.on("session_compact", (event) => {
    registry.ageForCompaction(config);
    const sections = registry.systemSections();
    if (Object.keys(sections).length > 0) {
      pi.appendEntry(PATCH_ENTRY_TYPE, {
        afterId: event.compactionEntry.id,
        sections,
      } satisfies SectionPatch);
    }
  });

  pi.registerCommand("agents-md-status", {
    description: "Show context files, hit counts, and compaction carry-over",
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
          hits: registry.hits(),
          carryOver: registry.carryOver(config),
          maxBytes: config.maxBytes,
          maxFiles: config.maxFiles,
        }),
        "info",
      );
    },
  });
}
