/**
 * Extension integration: deferred and immediate delivery, edit/write blocking,
 * the status command, notifications, and parallel tool batches.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  type JsonObject,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  assistantText,
  assistantToolCalls,
  createHarness,
  fauxModel,
  makeProject,
} from "./harness";
import {
  DEFERRED_LEAD_IN,
  lastMessage,
  messageTexts,
  NESTED_MARKER,
  nativeSectionOf,
  notifyCapture,
  readCall,
  sectionOf,
  snapshotCount,
  toolResultTexts,
  writeFixture,
} from "./helpers";

describe("delivery and blocking", () => {
  it("appends discovered instructions to read results in deferred mode without duplicating the root", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      writeFixture(project);
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // no mid-conversation system messages: auto -> deferred
        responses: [readCall("tests/integration/caas/lifecycle_test.go"), assistantText("done")],
      });
      await harness.session.prompt("read the file");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain(DEFERRED_LEAD_IN);
      expect(texts[0]).toContain("caas: lifecycle tests need cleanup");
      const first = texts[0].indexOf('path="tests/AGENTS.md"');
      const second = texts[0].indexOf('path="tests/integration/AGENTS.md"');
      const third = texts[0].indexOf('path="tests/integration/caas/AGENTS.md"');
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);

      // The root file is Pi's responsibility and must not be injected again.
      expect(texts[0]).not.toContain("root: use tabs everywhere");
      const nativeSection = getCurrentSystemMessage(harness.faux.requests[0].messages)?.sections
        ?.project_context;
      expect(nativeSection).toContain("root: use tabs everywhere");

      // Deferred mode does not patch the system prompt.
      expect(lastMessage(harness.faux.requests[1])?.role).not.toBe("system");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not inject twice when the same file is read repeatedly", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      writeFixture(project);
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/integration/caas/lifecycle_test.go"),
          readCall("tests/integration/caas/lifecycle_test.go"),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the file twice");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).not.toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("package caas");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("discovers nested files created after the session started", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/plain.txt", "plain");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/plain.txt"),
          assistantText("done"),
          readCall("tests/newdir/other.txt"),
          assistantText("done again"),
        ],
      });
      await harness.session.prompt("read the file");
      expect(toolResultTexts(harness.sessionManager)[0]).not.toContain(DEFERRED_LEAD_IN);

      project.write("tests/newdir/AGENTS.md", "newdir: fresh rules");
      project.write("tests/newdir/other.txt", "other");

      await harness.session.prompt("read the other file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[1]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("newdir: fresh rules");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("keeps instructions discoverable when a read fails", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/missing.txt"),
          readCall("tests/file.txt"),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the files");

      // The failed read delivers and registers nothing; the successful read
      // discovers them fresh (exactly one snapshot is recorded).
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts).toHaveLength(2);
      expect(texts[0]).not.toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain(DEFERRED_LEAD_IN);
      expect(snapshotCount(harness.sessionManager)).toBe(1);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("discovers instructions when read receives a file URL", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      const target = project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        responses: [readCall(pathToFileURL(target).href), assistantText("done")],
      });
      await harness.session.prompt("read the file URL");
      expect(toolResultTexts(harness.sessionManager)[0]).toContain("tests: run with vitest");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it.each(["edit", "write"] as const)(
    "blocks a first %s with a file URL until instructions are delivered",
    { timeout: 30000 },
    async (tool) => {
      const project = makeProject();
      let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
      try {
        project.write("tests/AGENTS.md", "tests: run with vitest");
        const target = project.write("tests/target.txt", "alpha\n");
        const args: JsonObject =
          tool === "edit"
            ? { path: pathToFileURL(target).href, edits: [{ oldText: "alpha", newText: "beta" }] }
            : { path: pathToFileURL(target).href, content: "beta\n" };
        harness = await createHarness({
          cwd: project.dir,
          responses: [
            assistantToolCalls([{ name: tool, args }]),
            assistantToolCalls([{ name: tool, args }]),
            assistantText("done"),
          ],
        });
        await harness.session.prompt("modify the file URL");
        const texts = toolResultTexts(harness.sessionManager);
        expect(texts[0]).toContain("Blocked:");
        expect(texts[0]).toContain("tests: run with vitest");
        expect(texts[1]).not.toContain("Blocked:");
        expect(project.read("tests/target.txt")).toBe("beta\n");
      } finally {
        harness?.cleanup();
        project.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "blocks a mutation when applicable instructions cannot be read",
    { timeout: 30000 },
    async () => {
      const project = makeProject();
      let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
      try {
        const instructions = project.write("tests/AGENTS.md", "tests: run with vitest");
        project.write("tests/target.txt", "alpha\n");
        chmodSync(instructions, 0o000);
        const args = {
          path: "tests/target.txt",
          edits: [{ oldText: "alpha", newText: "beta" }],
        };
        harness = await createHarness({
          cwd: project.dir,
          responses: [
            assistantToolCalls([{ name: "edit", args }]),
            assistantText("blocked"),
            assistantToolCalls([{ name: "edit", args }]),
            assistantToolCalls([{ name: "edit", args }]),
            assistantText("done"),
          ],
        });
        await harness.session.prompt("edit the file");
        const texts = toolResultTexts(harness.sessionManager);
        expect(texts[0]).toContain("could not inspect");
        expect(texts[0]).toContain(instructions);
        expect(project.read("tests/target.txt")).toBe("alpha\n");

        chmodSync(instructions, 0o644);
        await harness.session.prompt("retry the edit");
        const retried = toolResultTexts(harness.sessionManager);
        expect(retried[1]).toContain("tests: run with vitest");
        expect(retried[2]).not.toContain("Blocked:");
        expect(project.read("tests/target.txt")).toBe("beta\n");
      } finally {
        harness?.cleanup();
        project.cleanup();
      }
    },
  );

  it("blocks the first edit that discovers instructions and allows the retry", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("edit the file");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain("Blocked:");
      expect(texts[0]).toContain("tests: run with vitest");
      expect(texts[1]).not.toContain("Blocked:");
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks the first write that discovers instructions and allows the retry", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("docs/AGENTS.md", "docs: use kebab-case filenames");
      const writeArgs = { path: "docs/new-file.md", content: "# new" };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          assistantToolCalls([{ name: "write", args: writeArgs }]),
          assistantToolCalls([{ name: "write", args: writeArgs }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("write the file");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("Blocked:");
      expect(texts[0]).toContain("docs: use kebab-case filenames");
      expect(project.read("docs/new-file.md")).toBe("# new");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks the first edit in immediate mode without duplicating the instructions", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }), // auto -> immediate
        responses: [
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("edit the file");

      // The block reason is short: it does not repeat the instructions.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("Blocked:");
      expect(texts[0]).not.toContain("tests: run with vitest");

      // The next request carries the instructions exactly once, in the
      // dedicated system section.
      const retryRequest = harness.faux.requests[1];
      expect(messageTexts(retryRequest).includes("tests: run with vitest")).toBe(false);
      expect(sectionOf(retryRequest).split("tests: run with vitest")).toHaveLength(2);
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("keeps the dedicated section independent of foreign project_context content", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      // A native instruction file containing a literal closing tag used to
      // corrupt shared-section block removal.
      project.write("AGENTS.md", "root mentions </project_instructions> literally");
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          assistantText("continued"),
          assistantText("continued again"),
        ],
      });
      await harness.session.prompt("read the file");

      // The nested instruction reaches the model in its own section...
      const secondRequest = harness.faux.requests[1];
      expect(sectionOf(secondRequest)).toContain(NESTED_MARKER);
      // ...while the native content, literal closing tag included, stays intact.
      expect(nativeSectionOf(secondRequest)).toContain(
        "root mentions </project_instructions> literally",
      );

      // The first compaction retains the used file in its own section...
      await harness.session.compact();
      await harness.session.prompt("continue");
      expect(sectionOf(harness.faux.requests[2])).not.toContain(NESTED_MARKER);
      // ...and an unused cycle expires and removes it cleanly.
      await harness.session.compact();
      await harness.session.prompt("continue again");
      expect(sectionOf(harness.faux.requests[3])).toBe("");
      expect(nativeSectionOf(harness.faux.requests[3])).toContain(
        "root mentions </project_instructions> literally",
      );
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("delivers instructions once for parallel reads in the same directory", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          assistantToolCalls([
            { name: "read", args: { path: "tests/a.txt" } },
            { name: "read", args: { path: "tests/b.txt" } },
          ]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read both files");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts).toHaveLength(2);
      // Exactly one read delivers the instructions, whichever completes first.
      expect(texts.filter((text) => text.includes(DEFERRED_LEAD_IN))).toHaveLength(1);
      // Both reads succeeded and each result starts with its own file content.
      expect(texts.map((text) => text.slice(0, 1)).sort()).toEqual(["a", "b"]);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("patches the system prompt mid-run in immediate mode without touching the read result", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }), // auto -> immediate
        responses: [readCall("tests/file.txt"), readCall("tests/file.txt"), assistantText("done")],
      });
      await harness.session.prompt("read the file");

      // The read results carry no instructions in immediate mode.
      expect(
        toolResultTexts(harness.sessionManager).every((text) => !text.includes(DEFERRED_LEAD_IN)),
      ).toBe(true);

      // The patch stays at the same position as the conversation grows.
      for (const request of [harness.faux.requests[1], harness.faux.requests[2]]) {
        const patchIndex = request.messages.findIndex(
          (message) =>
            message.role === "system" &&
            Object.keys(message.sections ?? {}).some((name) =>
              name.startsWith("pi_agents_md_file_"),
            ),
        );
        expect(request.messages[patchIndex - 1]?.role).toBe("toolResult");
        const patch = request.messages[patchIndex] as SystemMessage;
        expect(sectionOf(request)).toContain("tests: run with vitest");
        expect(request.messages[0]?.role).toBe("system");
        expect(getCurrentTools(request.messages).map((tool) => tool.name)).toContain("read");
        expect(Object.keys(patch?.sections ?? {})).toHaveLength(1);
        expect(Object.keys(patch?.sections ?? {})[0]).toMatch(/^pi_agents_md_file_/);
      }
      expect(
        harness.faux.requests[2].messages.slice(0, harness.faux.requests[1].messages.length),
      ).toEqual(harness.faux.requests[1].messages);
      const sections = getCurrentSystemMessage(harness.faux.requests[1].messages)?.sections ?? {};
      expect(sections.preamble).toContain("coding assistant");
      expect(sections.rules).toContain("read");
      // The first request predates discovery and carries no patch.
      expect(messageTexts(harness.faux.requests[0])).not.toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("adds only new files to the system prompt and keeps their patch fixed across tool calls", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write("docs/AGENTS.md", "docs: use kebab-case filenames");
      project.write("docs/file.txt", "d");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          readCall("docs/file.txt"),
          readCall("docs/file.txt"),
          assistantText("done again"),
          readCall("tests/file.txt"),
          assistantText("updated"),
          readCall("tests/file.txt"),
          readCall("tests/file.txt"),
          assistantText("removed"),
        ],
      });
      await harness.session.prompt("read tests");
      await harness.session.prompt("read docs twice");

      const first = harness.faux.requests[3];
      const next = harness.faux.requests[4];
      const latestPatch = first.messages.filter((message) => message.role === "system").at(-1);
      expect(latestPatch?.sections && Object.values(latestPatch.sections).join("")).toContain(
        "docs: use kebab-case filenames",
      );
      expect(JSON.stringify(latestPatch)).not.toContain("tests: run with vitest");
      expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
      const systemText = first.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => Object.values(message.sections ?? {}))
        .join("\n");
      expect(systemText.split("tests: run with vitest")).toHaveLength(2);
      expect(systemText.split("docs: use kebab-case filenames")).toHaveLength(2);

      project.write("tests/AGENTS.md", "tests: run with vitest and lint");
      await harness.session.prompt("read tests again");
      const updated = harness.faux.requests[6];
      const updatePatch = updated.messages.filter((message) => message.role === "system").at(-1);
      expect(JSON.stringify(updatePatch)).toContain("tests: run with vitest and lint");
      expect(JSON.stringify(updatePatch)).not.toContain("docs: use kebab-case filenames");
      expect(sectionOf(updated)).toContain("tests: run with vitest and lint");
      expect(sectionOf(updated)).toContain("docs: use kebab-case filenames");

      rmSync(project.path("tests/AGENTS.md"));
      await harness.session.prompt("read tests after deletion");
      const removed = harness.faux.requests[8];
      const removalPatch = removed.messages.filter((message) => message.role === "system").at(-1);
      expect(removalPatch?.sections?.[Object.keys(updatePatch?.sections ?? {})[0]]).toBeNull();
      expect(sectionOf(removed)).not.toContain(NESTED_MARKER);
      expect(sectionOf(removed)).toContain("docs: use kebab-case filenames");
      expect(harness.faux.requests[9].messages.slice(0, removed.messages.length)).toEqual(
        removed.messages,
      );
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("migrates a persisted combined section to per-file sections", { timeout: 30000 }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      const saved = SessionManager.create(project.dir, sessionDir);
      saved.appendMessage({
        role: "system",
        content: "",
        sections: { pi_agents_md: "<pi_agents_md>\nold combined section\n</pi_agents_md>" },
        timestamp: Date.now(),
      });
      saved.appendCustomEntry("pi-agents-autoload", {
        files: [
          {
            path: "tests/AGENTS.md",
            content: "tests: run with vitest",
            delivery: "system",
          },
        ],
      });
      saved.appendMessage({
        role: "user",
        content: [{ type: "text", text: "previous turn" }],
        timestamp: Date.now(),
      });
      saved.appendMessage(assistantText("finished"));
      saved.appendMessage({
        role: "system",
        content: "",
        sections: { pi_agents_md_file_legacy: "old per-file section" },
        timestamp: Date.now(),
      });
      harness = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile: saved.getSessionFile() ?? "",
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("continued")],
      });
      await harness.session.prompt("continue");

      const request = harness.faux.requests[0];
      expect(harness.faux.requests[1].messages.slice(0, request.messages.length)).toEqual(
        request.messages,
      );
      expect(getCurrentSystemMessage(request.messages)?.sections?.pi_agents_md).toBeUndefined();
      expect(sectionOf(request)).toContain("tests: run with vitest");
      const persisted = harness.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message");
      expect(
        persisted.some(
          (entry) =>
            entry.message.role === "system" && entry.message.sections?.pi_agents_md === null,
        ),
      ).toBe(true);
    } finally {
      harness?.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
      project.cleanup();
    }
  });

  it("replays the same anchored section at the next run", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done"), assistantText("continued")],
      });
      await harness.session.prompt("read the file");
      await harness.session.prompt("continue");

      const patches = harness.sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-agents-autoload-sections",
        );
      expect(patches).toHaveLength(1);

      // The same request-time patch stays after its original tool result.
      const thirdRequest = harness.faux.requests[2];
      expect(lastMessage(thirdRequest)?.role).not.toBe("system");
      expect(sectionOf(thirdRequest)).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("anchors sections after a nested read batch", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/a/AGENTS.md", "alpha nested instructions");
      project.write("tests/a/file.txt", "a");
      project.write("tests/b/AGENTS.md", "beta nested instructions");
      project.write("tests/b/file.txt", "b");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withNestedReadHelper: true,
        responses: [
          assistantToolCalls([
            {
              name: "nested_reads",
              args: { paths: ["tests/a/file.txt", "tests/b/file.txt"] },
            },
          ]),
          assistantText("done"),
          assistantText("continued"),
        ],
      });
      await harness.session.prompt("read both files");
      const request = harness.faux.requests[1];
      expect(request.messages.at(-2)?.role).toBe("toolResult");
      expect(request.messages.at(-1)?.role).toBe("system");
      const branch = harness.sessionManager.getBranch();
      const result = branch
        .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
        .at(-1);
      const patch = branch
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "pi-agents-autoload-sections",
        )
        .at(-1);
      expect(patch?.type === "custom" ? (patch.data as { afterId: string }).afterId : "").toBe(
        result?.id,
      );
      expect(sectionOf(request)).toContain("alpha nested instructions");
      expect(sectionOf(request)).toContain("beta nested instructions");
      await harness.session.prompt("continue");
      expect(harness.faux.requests[2].messages.slice(0, request.messages.length)).toEqual(
        request.messages,
      );
      expect(harness.extensionErrors).toEqual([]);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("applies an immediate project configuration even when the model lacks mid-conversation system messages", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ mode: "immediate" }));
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel(), // incapable, but the mode is forced
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      await harness.session.prompt("read the file");

      expect(toolResultTexts(harness.sessionManager)[0]).not.toContain(DEFERRED_LEAD_IN);
      const patch = harness.faux.requests[1].messages.at(-1);
      expect(patch?.role).toBe("system");
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});

describe("/agents-md-status", () => {
  it("reports the empty state without a model request", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("README.md", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        responses: [assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("/agents-md-status");

      expect(harness.faux.requests).toHaveLength(0);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("faux/faux-1");
      expect(notifications[0]).toContain("Mid-convo system: no | Mode: auto (default) → deferred");
      expect(notifications[0]).toContain("No AGENTS.md files loaded.");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("groups native and managed files with hits and mode", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("AGENTS.md", "root instructions");
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the file");
      const requestsBefore = harness.faux.requests.length;
      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");

      expect(harness.faux.requests).toHaveLength(requestsBefore);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("faux/faux-1");
      expect(notifications[0]).toContain(
        "Mid-convo system: yes | Mode: auto (default) → immediate",
      );
      expect(notifications[0]).toMatch(/ {2}- AGENTS\.md +\(~\d+ tokens\)/);
      expect(notifications[0]).toMatch(/ {2}- tests\/AGENTS\.md +\(~\d+ tokens · 1 hit\)/);
      expect(notifications[0]).toContain("  ---------- Not carried over ----------");
      expect(notifications[0]).toContain("2 files | ~");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});

describe("discovery notifications", () => {
  it("notifies once per discovery batch with paths in parent-first order", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/integration/AGENTS.md", "integration instructions");
      project.write("tests/integration/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        responses: [readCall("tests/integration/file.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the file");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatch(/AGENTS\.md loaded \(~\d+ tokens\):/);
      const first = notifications[0].indexOf("tests/AGENTS.md");
      const second = notifications[0].indexOf("tests/integration/AGENTS.md");
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not notify again for reads under already active instructions", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [readCall("tests/a.txt"), readCall("tests/b.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read both files");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatch(/AGENTS\.md loaded \(~\d+ tokens\):/);
      expect(notifications[0]).toContain("  tests/AGENTS.md");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("notifies in immediate mode", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }), // immediate
        responses: [readCall("tests/file.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the file");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatch(/AGENTS\.md loaded \(~\d+ tokens\):/);
      expect(notifications[0]).toContain("  tests/AGENTS.md");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("notifies again when instructions are rediscovered after compaction", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          assistantText("idle"),
          readCall("tests/file.txt"),
          assistantText("done again"),
        ],
        uiContext,
      });
      await harness.session.prompt("read the file");
      expect(notifications).toHaveLength(1);

      await harness.session.compact(); // retained: no notification
      await harness.session.prompt("sit idle");
      expect(notifications).toHaveLength(1);
      await harness.session.compact(); // expired
      await harness.session.prompt("read the file again");
      expect(notifications).toHaveLength(2);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not notify for a failed read", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [readCall("tests/missing.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the missing file");

      expect(notifications).toHaveLength(0);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("notifies once for a first edit discovery while keeping the block", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("done"),
        ],
        uiContext,
      });
      await harness.session.prompt("edit the file");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatch(/AGENTS\.md loaded \(~\d+ tokens\):/);
      // First-write protection is unchanged.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("Blocked:");
      expect(texts[0]).toContain("tests: run with vitest");
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});

describe("parallel tool batches", () => {
  it("blocks every edit in a batch that discovers instructions, then allows the retries", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.go", "alpha\n");
      project.write("tests/b.go", "beta\n");
      const editA = { path: "tests/a.go", edits: [{ oldText: "alpha", newText: "gamma" }] };
      const editB = { path: "tests/b.go", edits: [{ oldText: "beta", newText: "delta" }] };
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        responses: [
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("done"),
        ],
        uiContext,
      });
      await harness.session.prompt("edit both files");

      // Both edits are blocked; the contents ride with the first block
      // reason, and the sibling gets the short reason without a repeat.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(2);
      expect(texts.filter((text) => text.includes("tests: run with vitest"))).toHaveLength(1);
      expect(texts[1]).toContain("tool batch or the system prompt");
      expect(project.read("tests/a.go")).toBe("alpha\n");
      expect(project.read("tests/b.go")).toBe("beta\n");
      expect(notifications).toHaveLength(1);
      // The request after the batch delivers the instructions to the model.
      expect(messageTexts(harness.faux.requests[1])).toContain("tests: run with vitest");

      // Retried in a later run, both edits proceed.
      await harness.session.prompt("retry both");
      expect(project.read("tests/a.go")).toBe("gamma\n");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks every write in a batch that discovers instructions, then allows the retries", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("docs/AGENTS.md", "docs: use kebab-case filenames");
      const writeA = { path: "docs/first-note.md", content: "# first" };
      const writeB = { path: "docs/second-note.md", content: "# second" };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        responses: [
          assistantToolCalls([
            { name: "write", args: writeA },
            { name: "write", args: writeB },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([
            { name: "write", args: writeA },
            { name: "write", args: writeB },
          ]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("write both files");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(2);
      expect(existsSync(project.path("docs/first-note.md"))).toBe(false);
      expect(existsSync(project.path("docs/second-note.md"))).toBe(false);
      // The request after the batch delivered the instructions.
      expect(messageTexts(harness.faux.requests[1])).toContain("docs: use kebab-case filenames");

      await harness.session.prompt("retry both");
      expect(project.read("docs/first-note.md")).toBe("# first");
      expect(project.read("docs/second-note.md")).toBe("# second");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks a same-batch edit after a read of the same scope", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.go", "alpha\n");
      project.write("tests/b.go", "beta\n");
      const editB = { path: "tests/b.go", edits: [{ oldText: "beta", newText: "delta" }] };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        responses: [
          assistantToolCalls([
            { name: "read", args: { path: "tests/a.go" } },
            { name: "edit", args: editB },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([{ name: "edit", args: editB }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read a and edit b");

      // The read in the same batch does not let the edit bypass review; the
      // instructions ride with the edit's block reason.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(1);
      expect(texts.some((text) => text.includes("alpha"))).toBe(true); // the read succeeded
      expect(project.read("tests/b.go")).toBe("beta\n");

      await harness.session.prompt("retry the edit");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks a same-batch edit before a read of the same scope", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.go", "alpha\n");
      project.write("tests/b.go", "beta\n");
      const editB = { path: "tests/b.go", edits: [{ oldText: "beta", newText: "delta" }] };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        responses: [
          assistantToolCalls([
            { name: "edit", args: editB },
            { name: "read", args: { path: "tests/a.go" } },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([{ name: "edit", args: editB }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("edit b and read a");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(1);
      expect(texts.some((text) => text.includes("alpha"))).toBe(true); // the read succeeded
      expect(project.read("tests/b.go")).toBe("beta\n");

      await harness.session.prompt("retry the edit");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks every edit in a batch in immediate mode with the short reason", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.go", "alpha\n");
      project.write("tests/b.go", "beta\n");
      const editA = { path: "tests/a.go", edits: [{ oldText: "alpha", newText: "gamma" }] };
      const editB = { path: "tests/b.go", edits: [{ oldText: "beta", newText: "delta" }] };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }), // immediate
        responses: [
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("edit both files");

      // Both edits are blocked with the short reason; neither repeats the
      // contents, which arrive through the system section instead.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(2);
      expect(texts.every((text) => !text.includes("tests: run with vitest"))).toBe(true);
      expect(project.read("tests/a.go")).toBe("alpha\n");
      expect(project.read("tests/b.go")).toBe("beta\n");
      expect(sectionOf(harness.faux.requests[1])).toContain("tests: run with vitest");

      await harness.session.prompt("retry both");
      expect(project.read("tests/a.go")).toBe("gamma\n");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("allows parallel edits under instructions delivered by an earlier request", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.go", "alpha\n");
      project.write("tests/b.go", "beta\n");
      const editA = { path: "tests/a.go", edits: [{ oldText: "alpha", newText: "gamma" }] };
      const editB = { path: "tests/b.go", edits: [{ oldText: "beta", newText: "delta" }] };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        responses: [
          readCall("tests/a.go"),
          assistantText("read"),
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read a");

      // The read delivered the instructions in a previous request, so the
      // parallel edits proceed without blocking.
      await harness.session.prompt("edit both files");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain(DEFERRED_LEAD_IN);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(0);
      expect(project.read("tests/a.go")).toBe("gamma\n");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks parallel edits after compaction until changed instructions reach the model", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.go", "alpha\n");
      project.write("tests/b.go", "beta\n");
      const editA = { path: "tests/a.go", edits: [{ oldText: "alpha", newText: "gamma" }] };
      const editB = { path: "tests/b.go", edits: [{ oldText: "beta", newText: "delta" }] };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a.go"),
          assistantText("done"),
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([
            { name: "edit", args: editA },
            { name: "edit", args: editB },
          ]),
          assistantText("edited"),
        ],
      });
      await harness.session.prompt("read a");
      await harness.session.compact();

      // The instruction file changed while retained: the first edit of the
      // batch refreshes it, and both stay blocked until the update reaches
      // the model through the system section.
      project.write("tests/AGENTS.md", "tests: run with vitest and lint");
      await harness.session.prompt("edit both files");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(2);
      expect(project.read("tests/a.go")).toBe("alpha\n");
      expect(project.read("tests/b.go")).toBe("beta\n");
      expect(sectionOf(harness.faux.requests[3])).toContain("tests: run with vitest and lint");

      await harness.session.prompt("retry both");
      expect(project.read("tests/a.go")).toBe("gamma\n");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Explicit instruction reads
// ---------------------------------------------------------------------------

describe("explicit instruction reads", () => {
  it("does not duplicate an explicitly read instruction file in its read result", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/integration/AGENTS.md", "integration: spin up containers");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [readCall("tests/integration/AGENTS.md"), assistantText("done")],
      });
      await harness.session.prompt("read the instructions");

      // The read result carries the file itself exactly once...
      const text = toolResultTexts(harness.sessionManager)[0];
      expect(text.split("integration: spin up containers")).toHaveLength(2);
      // ...while the applicable parent is still discovered and appended.
      expect(text).toContain(DEFERRED_LEAD_IN);
      expect(text).toContain('path="tests/AGENTS.md"');
      expect(text).not.toContain('path="tests/integration/AGENTS.md"');
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not register an automatically truncated instruction read as delivered", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", `${"filler\n".repeat(2100)}tests: check the final rule`);
      project.write("tests/target.txt", "alpha\n");
      const args = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "beta" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        responses: [
          readCall("tests/AGENTS.md"),
          assistantToolCalls([{ name: "edit", args }]),
          assistantToolCalls([{ name: "edit", args }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the instructions and edit the file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("Use offset=");
      expect(texts[0]).not.toContain("tests: check the final rule");
      expect(texts[1]).toContain("Blocked:");
      expect(texts[1]).toContain("tests: check the final rule");
      expect(texts[2]).not.toContain("Blocked:");
      expect(project.read("tests/target.txt")).toBe("beta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("keeps an explicit symlink read registered under the link's scope", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("shared/AGENTS.md", "shared: check edits");
      project.write("tests/target.txt", "alpha\n");
      symlinkSync(project.path("shared/AGENTS.md"), project.path("tests/AGENTS.md"));
      const args = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "beta" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        responses: [
          readCall("tests/AGENTS.md"),
          assistantToolCalls([{ name: "edit", args }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the link and edit under it");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0].split("shared: check edits")).toHaveLength(2);
      expect(texts[1]).not.toContain("Blocked:");
      expect(project.read("tests/target.txt")).toBe("beta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not mark instructions changed after a read as delivered", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: original rules");
      project.write("tests/target.txt", "alpha\n");
      const args = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "beta" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        withReadRaceHelper: true,
        responses: [
          readCall("tests/AGENTS.md"),
          assistantToolCalls([{ name: "edit", args }]),
          assistantToolCalls([{ name: "edit", args }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the instructions and edit the file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("tests: original rules");
      expect(texts[0]).not.toContain("tests: updated rules");
      expect(texts[1]).toContain("Blocked:");
      expect(texts[1]).toContain("tests: updated rules");
      expect(texts[2]).not.toContain("Blocked:");
      expect(project.read("tests/target.txt")).toBe("beta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("registers a complete BOM-prefixed instruction read as delivered", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "\uFEFFtests: run with vitest");
      project.write("tests/target.txt", "alpha\n");
      const args = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "beta" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        responses: [
          readCall("tests/AGENTS.md"),
          assistantToolCalls([{ name: "edit", args }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the instructions and edit the file");
      expect(
        toolResultTexts(harness.sessionManager).some((text) => text.includes("Blocked:")),
      ).toBe(false);
      expect(project.read("tests/target.txt")).toBe("beta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("registers a complete explicit read as delivered", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/AGENTS.md"),
          readCall("tests/target.txt"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
        ],
        uiContext,
      });
      await harness.session.prompt("read the instructions and edit");

      const texts = toolResultTexts(harness.sessionManager);
      // The explicit read itself carries no appended copy...
      expect(texts[0]).not.toContain(DEFERRED_LEAD_IN);
      // ...and neither does the read under the registered instructions.
      expect(texts[1]).not.toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("alpha");
      // The instructions reached the model in the read result, so the first
      // edit proceeds without a block.
      expect(texts.some((text) => text.includes("Blocked:"))).toBe(false);
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
      // The read delivered the content, so there is no discovery notification.
      expect(notifications).toHaveLength(0);

      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toMatch(/ {2}- tests\/AGENTS\.md +\(~\d+ tokens · 3 hits\)/);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not register a partial read of an instruction file", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "line one\nline two\nline three\n");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          assistantToolCalls([
            { name: "read", args: { path: "tests/AGENTS.md", offset: 1, limit: 2 } },
          ]),
          readCall("tests/file.txt"),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read part of the instructions");

      // The partial read returns a slice without an appended copy...
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).not.toContain(DEFERRED_LEAD_IN);
      expect(texts[0]).toContain("line one");
      // ...and the file was not registered as delivered: the next relevant
      // read discovers it and supplies the full instructions.
      expect(texts[1]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("line three");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("still blocks the first edit of an unread instruction file", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      const editArgs = {
        path: "tests/AGENTS.md",
        edits: [{ oldText: "tests: run with vitest", newText: "tests: edited by the model" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
        ],
      });
      await harness.session.prompt("edit the instructions");

      // The model has not read the file it is about to modify: the edit is
      // blocked with the current contents in the reason.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("Blocked:");
      expect(texts[0]).toContain("tests: run with vitest");
      expect(texts[1]).not.toContain("Blocked:");
      // After reviewing the block reason, the retry modifies the file.
      expect(project.read("tests/AGENTS.md")).toBe("tests: edited by the model");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not register an ignored instruction file that is read explicitly", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("vendor/AGENTS.md", "vendor: vendored rules");
      project.write("vendor/target.txt", "alpha\n");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: ["vendor/**"] }));
      const editArgs = {
        path: "vendor/target.txt",
        edits: [{ oldText: "alpha", newText: "beta" }],
      };
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel(),
        responses: [
          readCall("vendor/AGENTS.md"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
        ],
        uiContext,
      });
      await harness.session.prompt("read the vendor instructions and edit");

      // The read passes through untouched and registers nothing.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain("vendor: vendored rules");
      expect(texts[0]).not.toContain(DEFERRED_LEAD_IN);
      expect(texts.some((text) => text.includes("Blocked:"))).toBe(false);
      expect(project.read("vendor/target.txt")).toBe("beta\n");
      expect(notifications).toHaveLength(0);

      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("No AGENTS.md files loaded.");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});
