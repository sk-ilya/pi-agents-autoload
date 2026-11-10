/**
 * Shared test helpers: transcript inspection, snapshot views, notification
 * capture, and common fixtures.
 */

import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { assistantToolCalls, type Project } from "./harness";

export const DEFERRED_LEAD_IN = "Discovered nested AGENTS.md instructions";
export const NESTED_MARKER = 'path="tests/AGENTS.md"';

/** Text content of every tool result on the current branch, in order. */
export function toolResultTexts(sessionManager: SessionManager): string[] {
  const texts: string[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (message.role !== "toolResult") continue;
    texts.push(
      (message.content ?? [])
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join(""),
    );
  }
  return texts;
}

export function messageTexts(context: TranscriptContext): string {
  return context.messages
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((block) => (block as { text?: string }).text ?? "").join("");
      }
      return "";
    })
    .join("\n");
}

export function lastMessage(context: TranscriptContext) {
  return context.messages.at(-1) as
    | { role: string; sections?: Record<string, string | null> }
    | undefined;
}

export function sectionOf(context: TranscriptContext): string {
  return getCurrentSystemMessage(context.messages)?.sections?.pi_agents_md ?? "";
}

export function nativeSectionOf(context: TranscriptContext): string {
  return getCurrentSystemMessage(context.messages)?.sections?.project_context ?? "";
}

/** Persisted `pi_agents_md` section values (null = removal), in branch order. */
export function persistedSectionPatches(sessionManager: SessionManager): Array<string | null> {
  const sections: Array<string | null> = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      sections?: Record<string, string | null>;
    };
    if (message.role !== "system") continue;
    if (message.sections && "pi_agents_md" in message.sections) {
      sections.push(message.sections.pi_agents_md ?? null);
    }
  }
  return sections;
}

export function snapshotCount(sessionManager: SessionManager): number {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-agents-autoload").length;
}

/** The latest extension snapshot on the current branch. */
export interface SnapshotView {
  files: Array<{
    path: string;
    content: string;
    delivery?: string;
    usedSinceCompact?: boolean;
  }>;
}

export function lastSnapshotData(sessionManager: SessionManager): SnapshotView | undefined {
  let data: unknown;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "pi-agents-autoload") {
      data = (entry as { data?: unknown }).data;
    }
  }
  return data as SnapshotView | undefined;
}

export function readCall(path: string) {
  return assistantToolCalls([{ name: "read", args: { path } }]);
}

export function writeFixture(project: Project): void {
  project.write("AGENTS.md", "root: use tabs everywhere");
  project.write("tests/AGENTS.md", "tests: run with vitest");
  project.write("tests/integration/AGENTS.md", "integration: spin up containers");
  project.write("tests/integration/caas/AGENTS.md", "caas: lifecycle tests need cleanup");
  project.write("tests/integration/caas/lifecycle_test.go", "package caas\n");
}

export function notifyCapture(): { notifications: string[]; uiContext: ExtensionUIContext } {
  const notifications: string[] = [];
  const uiContext = {
    notify: (message: string) => {
      notifications.push(message);
    },
  } as unknown as ExtensionUIContext;
  return { notifications, uiContext };
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------
