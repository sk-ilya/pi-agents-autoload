/**
 * Instruction lifecycle: rendering, status output, compaction retention and
 * expiry, content refresh, and restoration across resume and tree navigation.
 */

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBlockReason, renderDeferredText } from "../src/delivery";
import { formatStatus } from "../src/status";
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
  lastSnapshotData,
  NESTED_MARKER,
  nativeSectionOf,
  notifyCapture,
  persistedSectionPatches,
  readCall,
  sectionOf,
  snapshotCount,
  toolResultTexts,
} from "./helpers";

describe("formatStatus", () => {
  const base = {
    modelLabel: "faux/faux-1",
    midConvoSystemMessages: true,
    configuredMode: "auto" as const,
    modeOrigin: "project" as const,
    effectiveMode: "immediate" as const,
    ignorePatterns: 0,
    cwd: "/proj",
    home: "/home/u",
  };

  it("lists native files first, then nested files in order, with delivery and token estimates", () => {
    const text = formatStatus({
      ...base,
      nativeFiles: [{ path: "/proj/AGENTS.md", content: "y".repeat(400) }],
      nestedFiles: [
        {
          key: "a",
          displayPath: "tests/AGENTS.md",
          content: "x".repeat(400),
          delivery: "system",
          usedSinceCompact: true,
        },
        {
          key: "b",
          displayPath: "docs/AGENTS.md",
          content: "z".repeat(80),
          delivery: "toolResult",
          usedSinceCompact: false,
        },
      ],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("AGENTS.md: faux/faux-1");
    expect(lines[1]).toBe("Mid-convo system: yes | Mode: auto (project) → immediate");
    expect(lines[3]).toBe("1  AGENTS.md (Pi, ~100 tokens)");
    expect(lines[4]).toBe("2  tests/AGENTS.md (System, ~100 tokens)");
    expect(lines[5]).toBe("3  docs/AGENTS.md (Tool result, ~20 tokens)");
    expect(text).toContain("3 files | ~220 tokens");
  });

  it("handles the empty case concisely", () => {
    const text = formatStatus({ ...base, nativeFiles: [], nestedFiles: [] });
    expect(text).toContain("AGENTS.md: faux/faux-1");
    expect(text).toContain("Mid-convo system: yes | Mode: auto (project) → immediate");
    expect(text).toContain("No AGENTS.md files loaded.");
  });
});

describe("rendering", () => {
  const files = [
    { displayPath: "tests/AGENTS.md", content: "tests instructions" },
    { displayPath: "tests/integration/AGENTS.md", content: "integration instructions" },
  ];

  it("renderDeferredText includes every file in order", () => {
    const text = renderDeferredText(files);
    expect(text).toContain(DEFERRED_LEAD_IN);
    const first = text.indexOf('path="tests/AGENTS.md"');
    const second = text.indexOf('path="tests/integration/AGENTS.md"');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("renderBlockReason tells the model to retry", () => {
    const reason = renderBlockReason(files);
    expect(reason).toContain("retry");
    expect(reason).toContain('path="tests/AGENTS.md"');
    expect(reason).toContain("tests instructions");
  });
});

describe("instruction lifecycle", () => {
  it("promotes deferred instructions to the system section when compaction retains them", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      // Large enough that the projected context crosses the compaction threshold
      // after the read result is appended (usage-backed estimate + trailing tokens).
      project.write("tests/file.txt", `${"x".repeat(80)}\n`.repeat(300));
      project.write("tests/small.txt", "s");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // auto -> deferred
        withCompactionHelper: true,
        // Force a threshold compaction between the two turns of the run. The
        // faux usage total (150 tokens) stays below the threshold so the check
        // does not re-trigger after the run ends.
        settings: { compaction: { reserveTokens: 128000 - 500, keepRecentTokens: 1 } },
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          assistantText("continued"),
          readCall("tests/small.txt"),
          assistantText("done again"),
          assistantText("continued again"),
          assistantText("sat idle"),
        ],
        uiContext,
      });
      await harness.session.prompt("read the file");

      // Delivered deferred-style before compaction.
      expect(toolResultTexts(harness.sessionManager)[0]).toContain(DEFERRED_LEAD_IN);
      // The mid-run compaction retained the file and promoted it to system
      // delivery, since the tool result that carried it was compacted away.
      expect(
        harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
      ).toHaveLength(1);
      const retained = lastSnapshotData(harness.sessionManager)?.files ?? [];
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ delivery: "system", usedSinceCompact: false });
      // The retry request in the same run carries the promoted instructions.
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);
      expect(sectionOf(harness.faux.requests[1])).toContain("tests: run with vitest");
      // Retention is silent: no rediscovery notification at compaction.
      expect(notifications).toHaveLength(1);

      // The next run keeps them in the effective system prompt.
      await harness.session.prompt("continue");
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);

      // The status reflects the promoted delivery while the mode stays deferred.
      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: auto (default) → deferred");
      expect(notifications[0]).toMatch(/1 {2}tests\/AGENTS\.md \(System, ~\d+ tokens\)/);

      // Re-access renews the file without a second tool-result delivery.
      await harness.session.prompt("read the file again");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes(DEFERRED_LEAD_IN))).toHaveLength(1);
      expect(sectionOf(harness.faux.requests[4])).toContain(NESTED_MARKER);
      expect(lastSnapshotData(harness.sessionManager)?.files[0]).toMatchObject({
        usedSinceCompact: true,
      });

      // A full cycle without access expires them.
      await harness.session.compact();
      await harness.session.prompt("continue again");
      await harness.session.compact();
      await harness.session.prompt("sit idle");
      expect(sectionOf(harness.faux.requests[6])).not.toContain(NESTED_MARKER);
      expect(lastSnapshotData(harness.sessionManager)?.files).toEqual([]);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("retains used instructions across the first compaction and expires them after an unused one", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("AGENTS.md", "root: use tabs everywhere");
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
          assistantText("idle"),
          readCall("tests/file.txt"),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read the file");
      await harness.session.prompt("continue");
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);

      // Manual compaction retains the used file for one more cycle: the
      // checkpoint still carries the promoted file...
      await harness.session.compact();
      const compaction = harness.sessionManager
        .getBranch()
        .find((entry) => entry.type === "compaction") as
        | { systemMessage?: { sections?: Record<string, string | null> } }
        | undefined;
      expect(compaction?.systemMessage?.sections?.pi_agents_md).toContain(NESTED_MARKER);
      // ...marked as unused for the new cycle, in system delivery.
      const retained = lastSnapshotData(harness.sessionManager)?.files ?? [];
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ delivery: "system", usedSinceCompact: false });

      // ...and the next request still applies it, with no patch needed.
      await harness.session.prompt("continue again");
      const thirdRequest = harness.faux.requests[3];
      expect(lastMessage(thirdRequest)?.role).not.toBe("system");
      expect(sectionOf(thirdRequest)).toContain(NESTED_MARKER);
      expect(nativeSectionOf(thirdRequest)).toContain("root: use tabs everywhere");

      // A second compaction without access expires the file: Pi's native
      // section update removes the dedicated section while the root
      // instructions in Pi's own project_context remain untouched.
      await harness.session.compact();
      const expiredSnapshot = lastSnapshotData(harness.sessionManager);
      expect(expiredSnapshot?.files).toEqual([]);
      expect(JSON.stringify(expiredSnapshot)).not.toContain("tests: run with vitest");
      await harness.session.prompt("sit idle");
      const fourthRequest = harness.faux.requests[4];
      expect(lastMessage(fourthRequest)?.role).not.toBe("system");
      expect(sectionOf(fourthRequest)).toBe("");
      expect(nativeSectionOf(fourthRequest)).toContain("root: use tabs everywhere");
      const patches = persistedSectionPatches(harness.sessionManager);
      expect(patches.at(-1)).toBeNull();

      // The next access rediscovers the file into the system prompt.
      await harness.session.prompt("read the file again");
      expect(sectionOf(harness.faux.requests[6])).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("retains promoted instructions on the retry after automatic mid-run compaction", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("AGENTS.md", "root: use tabs everywhere");
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write("tests/big.txt", `${"x".repeat(80)}\n`.repeat(300));
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { reserveTokens: 128000 - 500, keepRecentTokens: 1 } },
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          assistantText("continued"),
          readCall("tests/big.txt"),
          assistantText("done"),
          assistantText("continued again"),
        ],
      });
      await harness.session.prompt("read the file");
      await harness.session.prompt("continue");
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);

      // The big read crosses the threshold mid-run: compaction, then the
      // retry request in the same run. The retained instructions stay in the
      // effective section, carried by the compaction checkpoint, so no
      // ephemeral patch is needed.
      await harness.session.prompt("read the big file");
      const retryRequest = harness.faux.requests[4];
      expect(lastMessage(retryRequest)?.role).not.toBe("system");
      expect(sectionOf(retryRequest)).toContain(NESTED_MARKER);
      expect(nativeSectionOf(retryRequest)).toContain("root: use tabs everywhere");
      expect(
        harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
      ).toHaveLength(1);

      // An unused cycle expires them: the next run records the durable removal.
      await harness.session.compact();
      await harness.session.prompt("continue again");
      const lastRequest = harness.faux.requests[5];
      expect(lastMessage(lastRequest)?.role).not.toBe("system");
      expect(sectionOf(lastRequest)).toBe("");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("renews instructions accessed between compactions across multiple cycles", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/b.txt"),
          assistantText("done again"),
          readCall("tests/a.txt"),
          assistantText("done once more"),
        ],
        uiContext,
      });

      // Three compaction cycles, each followed by a re-access in the same
      // directory: the instructions stay active throughout.
      await harness.session.prompt("read a");
      await harness.session.compact();
      await harness.session.prompt("read b");
      await harness.session.compact();
      await harness.session.prompt("read a again");
      await harness.session.compact();
      await harness.session.prompt("summarize");

      // Renewal re-delivers nothing: one tool-result delivery, no further
      // notifications, and the instructions remain in the system section.
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes(DEFERRED_LEAD_IN))).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      const lastRequest = harness.faux.requests[5];
      expect(sectionOf(lastRequest)).toContain(NESTED_MARKER);
      expect(sectionOf(lastRequest).split("tests: run with vitest")).toHaveLength(2);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("tracks the usage of parent, child, and unrelated instructions per file", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("AGENTS.md", "root: use tabs everywhere");
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/integration/AGENTS.md", "integration: spin up containers");
      project.write("tests/integration/file.txt", "x");
      project.write("osac-operator/AGENTS.md", "osac: reconcile gently");
      project.write("osac-operator/file.txt", "y");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/integration/file.txt"),
          assistantText("done"),
          readCall("osac-operator/file.txt"),
          assistantText("done again"),
          assistantText("idle"),
          readCall("tests/integration/file.txt"),
          assistantText("done once more"),
          assistantText("idle again"),
        ],
      });

      // Cycle 1: parent and child discovered.
      await harness.session.prompt("read the file");
      await harness.session.compact(); // both retained
      // Cycle 2: only osac-operator is used; it gets its own grace period.
      await harness.session.prompt("read the operator file");
      await harness.session.compact(); // tests/* expire, osac retained
      await harness.session.prompt("idle");
      let section = sectionOf(harness.faux.requests[4]);
      expect(section).toContain("osac: reconcile gently");
      expect(section).not.toContain("tests: run with vitest");
      expect(section).not.toContain("integration: spin up containers");

      // Cycle 3: a descendant access renews parent and child alike.
      await harness.session.prompt("read the file again");
      await harness.session.compact(); // tests/* retained, osac expires
      await harness.session.prompt("idle again");
      section = sectionOf(harness.faux.requests[7]);
      expect(section).toContain("tests: run with vitest");
      expect(section).toContain("integration: spin up containers");
      expect(section).not.toContain("osac: reconcile gently");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("allows a first write under retained unchanged instructions", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
          assistantText("continued"),
        ],
        uiContext,
      });
      await harness.session.prompt("read a");
      await harness.session.compact();

      // The retained instructions are unchanged, so the first write proceeds
      // without a block and without a new notification.
      await harness.session.prompt("edit the file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.every((text) => !text.includes("Blocked:"))).toBe(true);
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
      expect(notifications).toHaveLength(1);
      // The write renewed the instructions for the next cycle.
      await harness.session.compact();
      await harness.session.prompt("continue");
      expect(sectionOf(harness.faux.requests[4])).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks a first write after compaction when the instructions changed", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
        ],
      });
      await harness.session.prompt("read a");
      await harness.session.compact();

      // The instruction file changed after compaction: the first write is
      // blocked so the model reviews the updated instructions before retry.
      project.write("tests/AGENTS.md", "tests: run with vitest and lint");
      await harness.session.prompt("edit the file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(1);
      // The retry sees the updated instructions in the system section and
      // only then modifies the file.
      const retryRequest = harness.faux.requests[3];
      expect(sectionOf(retryRequest)).toContain("tests: run with vitest and lint");
      expect(sectionOf(retryRequest)).not.toContain(
        'path="tests/AGENTS.md">\ntests: run with vitest\n',
      );
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not renew instructions on a failed read", {
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
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          readCall("tests/missing.txt"),
          assistantText("missing"),
          assistantText("idle"),
        ],
      });
      await harness.session.prompt("read the file");
      await harness.session.compact();

      // The failed read neither renews nor notifies; the idle cycle expires.
      await harness.session.prompt("read the missing file");
      await harness.session.compact();
      await harness.session.prompt("sit idle");
      expect(sectionOf(harness.faux.requests[4])).not.toContain(NESTED_MARKER);
      expect(lastSnapshotData(harness.sessionManager)?.files).toEqual([]);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not age instructions when a compaction is cancelled", {
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
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [readCall("tests/file.txt"), assistantText("done"), assistantText("idle")],
      });
      await harness.session.prompt("read the file");

      // A cancelled compaction must not age the instructions: they were used
      // this cycle, so the next successful compaction still retains them.
      project.write("cancel-compaction", "");
      await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
      // Remove the marker so the next compaction succeeds.
      rmSync(project.path("cancel-compaction"));
      await harness.session.compact();
      await harness.session.prompt("sit idle");
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("renews instructions once for parallel reads after compaction", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(), // deferred
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          assistantToolCalls([
            { name: "read", args: { path: "tests/a.txt" } },
            { name: "read", args: { path: "tests/b.txt" } },
          ]),
          assistantText("done again"),
        ],
        uiContext,
      });
      await harness.session.prompt("read a");
      expect(snapshotCount(harness.sessionManager)).toBe(1); // discovery
      await harness.session.compact();
      expect(snapshotCount(harness.sessionManager)).toBe(2); // retention

      // Both parallel reads renew the same file: one registry change, no
      // second delivery, no second notification.
      await harness.session.prompt("read both");
      expect(snapshotCount(harness.sessionManager)).toBe(3); // one renewal
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes(DEFERRED_LEAD_IN))).toHaveLength(1);
      expect(notifications).toHaveLength(1);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not lose system-delivered instructions when the model switches", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ id: "faux-capable", supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          assistantText("continued"),
          assistantText("idle"),
        ],
      });
      await harness.session.prompt("read the file");
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);
      await harness.session.compact(); // retained, unused for the new cycle

      // Switching to a model without mid-conversation system messages keeps
      // the retained instructions in the prompt, exactly once.
      await harness.session.setModel(fauxModel({ id: "faux-alt" }));
      await harness.session.prompt("continue");
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);
      expect(sectionOf(harness.faux.requests[2]).split("tests: run with vitest")).toHaveLength(2);

      // The switch does not reset the usage flag: without another access,
      // the next compaction expires the instructions.
      await harness.session.compact();
      await harness.session.prompt("sit idle");
      expect(sectionOf(harness.faux.requests[3])).not.toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("lists rediscovered files in their rediscovery order", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/a/AGENTS.md", "a instructions");
      project.write("tests/a/file.txt", "a");
      project.write("tests/b/AGENTS.md", "b instructions");
      project.write("tests/b/file.txt", "b");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a/file.txt"),
          readCall("tests/b/file.txt"),
          assistantText("done"),
          assistantText("idle"),
          readCall("tests/b/file.txt"),
          readCall("tests/a/file.txt"),
          assistantText("done again"),
        ],
        uiContext,
      });
      await harness.session.prompt("read both");
      await harness.session.compact(); // both retained
      await harness.session.prompt("sit idle");
      await harness.session.compact(); // both expire unused
      await harness.session.prompt("read both again");
      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatch(/1 {2}tests\/b\/AGENTS\.md \(Tool result, ~\d+ tokens\)/);
      expect(notifications[0]).toMatch(/2 {2}tests\/a\/AGENTS\.md \(Tool result, ~\d+ tokens\)/);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("restores state when resuming a session file", { timeout: 30000 }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let second: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "snapshot: original instructions");
      project.write("tests/file.txt", "x");
      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read the file");
      first.cleanup();
      first = undefined;

      // The file changes on disk after the snapshot was recorded.
      project.write("tests/AGENTS.md", "CHANGED AFTER SNAPSHOT");

      second = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      await second.session.prompt("read the file again");

      // The restored registry prevents re-discovery in the resumed session.
      // (The branch carries the first session's read result as well.)
      const texts = toolResultTexts(second.sessionManager);
      expect(texts).toHaveLength(2);
      expect(texts.every((text) => !text.includes(DEFERRED_LEAD_IN))).toBe(true);

      // The restored snapshot, not the changed file, reaches the first prompt...
      const section = sectionOf(second.faux.requests[0]);
      expect(section).toContain("snapshot: original instructions");
      expect(section).not.toContain("CHANGED AFTER SNAPSHOT");

      // ...and the first re-access refreshes the changed content into the
      // section, with no compaction in between.
      const refreshed = sectionOf(second.faux.requests[1]);
      expect(refreshed).toContain("CHANGED AFTER SNAPSHOT");
      expect(refreshed).not.toContain("snapshot: original instructions");
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("ignores snapshot paths outside nested project instructions", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let resumed: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "valid instructions");
      project.write("tests/file.txt", "x");
      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read the file");
      first.cleanup();
      first = undefined;

      const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
      const invalid = [
        "../AGENTS.md",
        "AGENTS.md",
        project.path("tests/AGENTS.md"),
        "tests/../AGENTS.md",
      ];
      const rewritten = lines.map((line) => {
        const entry = JSON.parse(line) as {
          type?: string;
          customType?: string;
          data?: { files?: Array<Record<string, unknown>> };
        };
        if (entry.type === "custom" && entry.customType === "pi-agents-autoload") {
          for (const path of invalid) {
            entry.data?.files?.push({
              path,
              content: `invalid instructions from ${path}`,
              delivery: "system",
              usedSinceCompact: true,
            });
          }
        }
        return JSON.stringify(entry);
      });
      writeFileSync(sessionFile, `${rewritten.join("\n")}\n`, "utf8");

      resumed = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [assistantText("done")],
      });
      await resumed.session.prompt("continue");
      const section = sectionOf(resumed.faux.requests[0]);
      expect(section).toContain("valid instructions");
      expect(section).not.toContain("invalid instructions");
    } finally {
      first?.cleanup();
      resumed?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("restores scoped symlink identity when resuming a session", { timeout: 30000 }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let second: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("shared/AGENTS.md", "shared instructions");
      project.write("tests/file.txt", "x");
      symlinkSync(project.path("shared/AGENTS.md"), project.path("tests/AGENTS.md"));

      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel(),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read the file");
      const texts = toolResultTexts(first.sessionManager);
      expect(texts[0]).toContain('path="tests/AGENTS.md"');
      expect(texts[0]).toContain("shared instructions");
      expect(lastSnapshotData(first.sessionManager)?.files[0]?.path).toBe("tests/AGENTS.md");
      first.cleanup();
      first = undefined;

      second = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel(),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      await second.session.prompt("read the file again");

      // The restored scoped key matches a fresh discovery, so the file is not
      // delivered a second time (the branch carries only the first delivery).
      const textsAfterResume = toolResultTexts(second.sessionManager);
      expect(textsAfterResume.filter((text) => text.includes(DEFERRED_LEAD_IN))).toHaveLength(1);
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("restores retention across resume and refreshes content on re-access", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let second: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "before compaction content");
      project.write("tests/file.txt", "x");
      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read the file");
      await first.session.compact(); // retained, unused for the new cycle
      first.cleanup();
      first = undefined;

      project.write("tests/AGENTS.md", "after compaction content");

      second = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      await second.session.prompt("read the file again");

      // The retained file stays active across the resume, still unused and
      // carrying the snapshotted content...
      expect(sectionOf(second.faux.requests[0])).toContain("before compaction content");
      // ...and the first re-access renews it, refreshing the changed content.
      expect(sectionOf(second.faux.requests[1])).toContain("after compaction content");
      expect(sectionOf(second.faux.requests[1])).not.toContain("before compaction content");
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("expires idle instructions and retains renewed ones after resume", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let second: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/a/AGENTS.md", "a instructions");
      project.write("tests/a/file.txt", "a");
      project.write("tests/b/AGENTS.md", "b instructions");
      project.write("tests/b/file.txt", "b");
      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [
          readCall("tests/a/file.txt"),
          assistantText("done"),
          readCall("tests/b/file.txt"),
          assistantText("done again"),
        ],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read a");
      await first.session.compact(); // a retained, now unused
      await first.session.prompt("read b"); // b discovered; a stays idle
      first.cleanup();
      first = undefined;

      second = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [assistantText("continued")],
      });
      await second.session.compact(); // a expires, b survives
      await second.session.prompt("continue");

      const section = sectionOf(second.faux.requests[0]);
      expect(section).toContain("b instructions");
      expect(section).not.toContain("a instructions");
      expect(section).not.toContain('path="tests/a/AGENTS.md"');
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("restores snapshots written before usage tracking with one grace cycle", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let second: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "legacy instructions");
      project.write("tests/file.txt", "x");
      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read the file");
      await first.session.compact();
      first.cleanup();
      first = undefined;

      // Strip the usage flag from the persisted snapshot, as written by
      // versions before usage tracking.
      const sessionLines = readFileSync(sessionFile, "utf8").trim().split("\n");
      const rewritten = sessionLines.map((line) => {
        const entry = JSON.parse(line) as {
          type?: string;
          customType?: string;
          data?: { files?: Array<Record<string, unknown>> };
        };
        if (entry.type === "custom" && entry.customType === "pi-agents-autoload") {
          for (const file of entry.data?.files ?? []) delete file.usedSinceCompact;
        }
        return JSON.stringify(entry);
      });
      writeFileSync(sessionFile, `${rewritten.join("\n")}\n`, "utf8");

      second = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [assistantText("continued"), assistantText("sat idle")],
      });
      // The flag-less snapshot restores as used, so the file survives one
      // more compaction instead of expiring immediately.
      await second.session.prompt("continue");
      await second.session.compact();
      await second.session.prompt("sit idle");
      expect(sectionOf(second.faux.requests[1])).toContain("legacy instructions");
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("restores usage flags when navigating the session tree", {
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
        withCompactionHelper: true,
        settings: { compaction: { keepRecentTokens: 1 } },
        responses: [readCall("tests/file.txt"), assistantText("done"), assistantText("idle")],
      });
      await harness.session.prompt("read the file");
      const leafAfterDiscovery = harness.sessionManager.getLeafId();
      if (!leafAfterDiscovery) throw new Error("no leaf after discovery");

      // The compaction retains the file and marks it unused.
      await harness.session.compact();

      // Navigating back to the discovery point restores the branch state
      // where the file was used this cycle, so a compaction there retains it.
      await harness.session.navigateTree(leafAfterDiscovery, { summarize: false });
      await harness.session.compact();
      await harness.session.prompt("sit idle");
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("restores branch state when navigating the session tree", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      const done = assistantText("done");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/file.txt"),
          done,
          readCall("tests/file.txt"),
          done,
          readCall("tests/file.txt"),
          done,
        ],
      });

      await harness.session.prompt("read the file");
      expect(toolResultTexts(harness.sessionManager)[0]).toContain(DEFERRED_LEAD_IN);

      const entries = harness.sessionManager.getBranch();
      const firstUserEntry = entries.find(
        (entry) => entry.type === "message" && (entry.message as { role?: string }).role === "user",
      );
      const leafAfterFirstPrompt = harness.sessionManager.getLeafId();
      if (!firstUserEntry) throw new Error("no user entry on the branch");
      if (!leafAfterFirstPrompt) throw new Error("no leaf after the first prompt");

      // Navigating before the discovery leaves the registry empty.
      await harness.session.navigateTree(firstUserEntry.id, { summarize: false });
      await harness.session.prompt("read the file again");
      const textsAfterRewind = toolResultTexts(harness.sessionManager);
      expect(textsAfterRewind.at(-1)).toContain(DEFERRED_LEAD_IN);

      // Navigating back to the discovered branch restores the registry.
      await harness.session.navigateTree(leafAfterFirstPrompt, { summarize: false });
      await harness.session.prompt("read the file once more");
      const textsAfterRestore = toolResultTexts(harness.sessionManager);
      expect(textsAfterRestore.at(-1)).not.toContain(DEFERRED_LEAD_IN);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Refresh and deletion
// ---------------------------------------------------------------------------

describe("refresh and deletion", () => {
  it("refreshes changed instructions on the next access without compaction", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          readCall("tests/file.txt"),
          assistantText("done again"),
        ],
        uiContext,
      });
      await harness.session.prompt("read the file");
      expect(sectionOf(harness.faux.requests[1])).toContain("tests: run with vitest");

      project.write("tests/AGENTS.md", "tests: run with vitest and lint");
      await harness.session.prompt("read the file again");

      // The changed content reaches the model on the very next request,
      // with no compaction in between, and only once.
      const refreshed = sectionOf(harness.faux.requests[3]);
      expect(refreshed).toContain("tests: run with vitest and lint");
      expect(refreshed).not.toContain("tests: run with vitest\n");
      expect(refreshed.split("tests: run with vitest and lint")).toHaveLength(2);
      expect(lastSnapshotData(harness.sessionManager)?.files[0]?.content).toBe(
        "tests: run with vitest and lint",
      );
      // One notification for the discovery, one for the update.
      expect(notifications).toHaveLength(2);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("delivers updated instructions through the next read result in deferred mode", {
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
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/b.txt"),
          assistantText("done again"),
        ],
      });
      await harness.session.prompt("read a");
      project.write("tests/AGENTS.md", "tests: run with vitest and lint");
      await harness.session.prompt("read b");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain(DEFERRED_LEAD_IN);
      expect(texts[0]).toContain("tests: run with vitest");
      // The updated content rides with the next relevant read result.
      expect(texts[1]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("tests: run with vitest and lint");
      expect(texts[1]).not.toContain('path="tests/AGENTS.md">\ntests: run with vitest\n');
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks an edit until instructions changed without compaction reach the model", {
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
          readCall("tests/target.txt"),
          assistantText("read"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
        ],
      });
      await harness.session.prompt("read the file");
      project.write("tests/AGENTS.md", "tests: run with vitest and lint");

      await harness.session.prompt("edit the file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(1);
      // The block reason carries the updated content, not the stale one.
      const blocked = texts.find((text) => text.includes("Blocked:"));
      expect(blocked).toContain("tests: run with vitest and lint");
      expect(blocked).not.toContain('path="tests/AGENTS.md">\ntests: run with vitest\n');
      // The retry proceeds once the model has seen the update.
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("detects same-size content changes", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "aaaa");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/b.txt"),
          assistantText("done again"),
        ],
      });
      await harness.session.prompt("read a");
      project.write("tests/AGENTS.md", "bbbb");
      await harness.session.prompt("read b");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[1]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("bbbb");
      expect(texts[1]).not.toContain("aaaa");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("removes deleted instructions on the next access", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/target.txt", "alpha\nbeta\n");
      const editArgs = {
        path: "tests/target.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/a.txt"),
          assistantText("done again"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          assistantText("edited"),
        ],
      });
      await harness.session.prompt("read a");
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);

      rmSync(project.path("tests/AGENTS.md"));
      await harness.session.prompt("read a again");

      // The deleted file leaves the managed section and the registry.
      expect(sectionOf(harness.faux.requests[3])).toBe("");
      expect(lastSnapshotData(harness.sessionManager)?.files).toEqual([]);

      // Edits under it are no longer blocked by the deleted instructions.
      await harness.session.prompt("edit the file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.every((text) => !text.includes("Blocked:"))).toBe(true);
      expect(project.read("tests/target.txt")).toBe("gamma\nbeta\n");
      // The next run records the durable section removal.
      expect(persistedSectionPatches(harness.sessionManager).at(-1)).toBeNull();
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("rediscovers recreated instructions", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/a.txt"),
          assistantText("done again"),
          readCall("tests/a.txt"),
          assistantText("done once more"),
        ],
      });
      await harness.session.prompt("read a");
      rmSync(project.path("tests/AGENTS.md"));
      await harness.session.prompt("read a again");
      project.write("tests/AGENTS.md", "tests: run with vitest and lint");
      await harness.session.prompt("read a once more");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).not.toContain(DEFERRED_LEAD_IN);
      expect(texts[2]).toContain(DEFERRED_LEAD_IN);
      expect(texts[2]).toContain("tests: run with vitest and lint");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reuses unchanged instructions without new deliveries, patches, or snapshots", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/b.txt"),
          assistantText("done again"),
          readCall("tests/a.txt"),
          assistantText("done once more"),
        ],
        uiContext,
      });
      await harness.session.prompt("read a");
      await harness.session.prompt("read b");
      await harness.session.prompt("read a once more");

      // Checking unchanged instructions is invisible to the model and the
      // transcript: one durable patch, one snapshot, one notification.
      expect(
        persistedSectionPatches(harness.sessionManager).filter((section) =>
          section?.includes(NESTED_MARKER),
        ),
      ).toHaveLength(1);
      expect(snapshotCount(harness.sessionManager)).toBe(1);
      expect(notifications).toHaveLength(1);
      const lastRequest = harness.faux.requests[5];
      expect(lastMessage(lastRequest)?.role).not.toBe("system");
      expect(sectionOf(lastRequest).split("tests: run with vitest")).toHaveLength(2);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("refreshes instructions reached through a changed symlink target", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("shared/AGENTS.md", "shared: first version");
      project.write("tests/a.txt", "a");
      project.write("tests/b.txt", "b");
      symlinkSync(project.path("shared/AGENTS.md"), project.path("tests/AGENTS.md"));
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        responses: [
          readCall("tests/a.txt"),
          assistantText("done"),
          readCall("tests/b.txt"),
          assistantText("done again"),
        ],
      });
      await harness.session.prompt("read a");
      expect(toolResultTexts(harness.sessionManager)[0]).toContain("shared: first version");

      project.write("shared/AGENTS.md", "shared: second version");
      await harness.session.prompt("read b");

      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[1]).toContain(DEFERRED_LEAD_IN);
      expect(texts[1]).toContain("shared: second version");
      expect(texts[1]).not.toContain("shared: first version");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("blocks a same-batch edit when instructions changed since the last delivery", {
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
        model: fauxModel(),
        responses: [
          readCall("tests/a.go"),
          assistantText("read"),
          assistantToolCalls([
            { name: "read", args: { path: "tests/a.go" } },
            { name: "edit", args: editB },
          ]),
          assistantText("acknowledged"),
          assistantToolCalls([{ name: "edit", args: editB }]),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("read a");
      project.write("tests/AGENTS.md", "tests: run with vitest and lint");

      await harness.session.prompt("read a and edit b");
      const texts = toolResultTexts(harness.sessionManager);
      // The read succeeded and did not re-deliver; the edit is blocked with
      // the updated instructions in its block reason.
      expect(texts.filter((text) => text.includes("Blocked:"))).toHaveLength(1);
      expect(texts.some((text) => text.includes("alpha"))).toBe(true);
      expect(texts.find((text) => text.includes("Blocked:"))).toContain(
        "tests: run with vitest and lint",
      );
      expect(project.read("tests/b.go")).toBe("beta\n");

      await harness.session.prompt("retry the edit");
      expect(project.read("tests/b.go")).toBe("delta\n");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});
