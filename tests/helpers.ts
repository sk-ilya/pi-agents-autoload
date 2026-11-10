/**
 * Shared test helpers: transcript inspection, snapshot views, notification
 * capture, and common fixtures.
 */

import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { FILE_SECTION_PREFIX } from "../src/delivery";
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
  const sections = getCurrentSystemMessage(context.messages)?.sections ?? {};
  return Object.entries(sections)
    .filter(([name]) => name.startsWith(FILE_SECTION_PREFIX))
    .map(([, content]) => content)
    .join("\n");
}

export function nativeSectionOf(context: TranscriptContext): string {
  return getCurrentSystemMessage(context.messages)?.sections?.project_context ?? "";
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

export function lastHitCounts(sessionManager: SessionManager): Map<string, number> {
  let counts: Array<[string, number]> = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "pi-agents-autoload-hits") {
      counts = (entry.data as { counts: Array<[string, number]> }).counts;
    }
  }
  return new Map(counts);
}

export function readCall(path: string) {
  return assistantToolCalls([{ name: "read", args: { path } }]);
}

export function readRepeatedCall(path: string, count: number) {
  return assistantToolCalls(
    Array.from({ length: count }, () => ({ name: "read", args: { path } })),
  );
}

export function readTwiceCall(path: string) {
  return readRepeatedCall(path, 2);
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
