import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  discoverInstructionFiles,
  formatDisplayPath,
  formatStatus,
  parseMode,
  renderBlockReason,
  renderDeferredText,
} from "../index";
import {
  assistantText,
  assistantToolCalls,
  createHarness,
  fauxModel,
  makeProject,
  type Project,
} from "./harness";

const DEFERRED_LEAD_IN = "Discovered nested AGENTS.md instructions";
const NESTED_MARKER = 'path="tests/AGENTS.md"';

/** Text content of every tool result on the current branch, in order. */
function toolResultTexts(sessionManager: SessionManager): string[] {
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

function messageTexts(context: TranscriptContext): string {
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

function lastMessage(context: TranscriptContext) {
  return context.messages.at(-1) as
    | { role: string; sections?: Record<string, string | null> }
    | undefined;
}

function sectionOf(context: TranscriptContext): string {
  return getCurrentSystemMessage(context.messages)?.sections?.pi_agents_md ?? "";
}

function nativeSectionOf(context: TranscriptContext): string {
  return getCurrentSystemMessage(context.messages)?.sections?.project_context ?? "";
}

/** Persisted `pi_agents_md` section values (null = removal), in branch order. */
function persistedSectionPatches(sessionManager: SessionManager): Array<string | null> {
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

function snapshotCount(sessionManager: SessionManager): number {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-agents-autoload").length;
}

/** The latest extension snapshot on the current branch. */
interface SnapshotView {
  files: Array<{
    path: string;
    content: string;
    delivery?: string;
    usedSinceCompact?: boolean;
  }>;
}

function lastSnapshotData(sessionManager: SessionManager): SnapshotView | undefined {
  let data: unknown;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "pi-agents-autoload") {
      data = (entry as { data?: unknown }).data;
    }
  }
  return data as SnapshotView | undefined;
}

function readCall(path: string) {
  return assistantToolCalls([{ name: "read", args: { path } }]);
}

function writeFixture(project: Project): void {
  project.write("AGENTS.md", "root: use tabs everywhere");
  project.write("tests/AGENTS.md", "tests: run with vitest");
  project.write("tests/integration/AGENTS.md", "integration: spin up containers");
  project.write("tests/integration/caas/AGENTS.md", "caas: lifecycle tests need cleanup");
  project.write("tests/integration/caas/lifecycle_test.go", "package caas\n");
}

function notifyCapture(): { notifications: string[]; uiContext: ExtensionUIContext } {
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

describe("parseMode", () => {
  it("accepts every documented mode", () => {
    expect(parseMode("auto")).toBe("auto");
    expect(parseMode("immediate")).toBe("immediate");
    expect(parseMode("deferred")).toBe("deferred");
  });

  it("rejects unknown values with an actionable error", () => {
    expect(() => parseMode("sometimes")).toThrow(/Invalid mode "sometimes"/);
    expect(() => parseMode("sometimes")).toThrow(/"auto", "immediate", or "deferred"/);
  });
});

describe("discoverInstructionFiles", () => {
  it("discovers nested AGENTS.md files from shallowest to deepest and skips the root", async () => {
    const project = makeProject();
    try {
      writeFixture(project);
      const found = await discoverInstructionFiles(
        "tests/integration/caas/lifecycle_test.go",
        project.dir,
      );
      expect(found.map((file) => file.displayPath)).toEqual([
        "tests/AGENTS.md",
        "tests/integration/AGENTS.md",
        "tests/integration/caas/AGENTS.md",
      ]);
      expect(found.map((file) => file.content)).toEqual([
        "tests: run with vitest",
        "integration: spin up containers",
        "caas: lifecycle tests need cleanup",
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("discovers nothing for targets directly in the working directory", async () => {
    const project = makeProject();
    try {
      project.write("AGENTS.md", "root: use tabs everywhere");
      project.write("README.md", "# project");
      expect(await discoverInstructionFiles("README.md", project.dir)).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it("ignores targets outside the working directory", async () => {
    const project = makeProject();
    const outside = makeProject();
    try {
      project.write("AGENTS.md", "root");
      outside.write("AGENTS.md", "outside instructions");
      outside.write("file.txt", "outside");

      const relativeEscape = relative(project.dir, outside.path("file.txt"));
      expect(await discoverInstructionFiles(relativeEscape, project.dir)).toEqual([]);
      expect(await discoverInstructionFiles(outside.path("file.txt"), project.dir)).toEqual([]);
    } finally {
      project.cleanup();
      outside.cleanup();
    }
  });

  it("ignores symlink aliases that escape the working directory", async () => {
    const project = makeProject();
    const outside = makeProject();
    try {
      project.write("AGENTS.md", "root");
      outside.write("AGENTS.md", "outside instructions");
      outside.write("file.txt", "outside");
      symlinkSync(outside.dir, join(project.dir, "link"), "dir");
      symlinkSync(outside.path("file.txt"), join(project.dir, "alias.txt"));

      expect(await discoverInstructionFiles("link/file.txt", project.dir)).toEqual([]);
      expect(await discoverInstructionFiles("alias.txt", project.dir)).toEqual([]);
    } finally {
      project.cleanup();
      outside.cleanup();
    }
  });

  it("resolves symlinked subdirectories inside the project to canonical paths", async () => {
    const project = makeProject();
    try {
      project.write("real/AGENTS.md", "real instructions");
      project.write("real/file.txt", "x");
      symlinkSync(join(project.dir, "real"), join(project.dir, "alias"), "dir");

      const found = await discoverInstructionFiles("alias/file.txt", project.dir);
      expect(found.map((file) => file.displayPath)).toEqual(["real/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("identifies a symlinked instruction file by its directory scope", async () => {
    const project = makeProject();
    try {
      project.write("shared/AGENTS.md", "shared instructions");
      project.write("tests/file.txt", "x");
      symlinkSync(project.path("shared/AGENTS.md"), project.path("tests/AGENTS.md"));

      const found = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(found.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
      expect(found[0]?.content).toBe("shared instructions");
    } finally {
      project.cleanup();
    }
  });

  it("keeps two scopes that share one instruction source distinct", async () => {
    const project = makeProject();
    try {
      project.write("shared/AGENTS.md", "shared instructions");
      project.write("tests/file.txt", "x");
      project.write("docs/file.txt", "d");
      symlinkSync(project.path("shared/AGENTS.md"), project.path("tests/AGENTS.md"));
      symlinkSync(project.path("shared/AGENTS.md"), project.path("docs/AGENTS.md"));

      const tests = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(tests.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
      const docs = await discoverInstructionFiles("docs/file.txt", project.dir);
      expect(docs.map((file) => file.displayPath)).toEqual(["docs/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("deduplicates directory aliases onto the same scoped file", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      symlinkSync(join(project.dir, "tests"), join(project.dir, "alias"), "dir");

      const direct = await discoverInstructionFiles("tests/file.txt", project.dir);
      const aliased = await discoverInstructionFiles("alias/file.txt", project.dir);
      expect(aliased).toHaveLength(1);
      expect(aliased[0]?.key).toBe(direct[0]?.key);
    } finally {
      project.cleanup();
    }
  });

  it("ignores instruction files that are symlinks pointing outside the working directory", async () => {
    const project = makeProject();
    const outside = makeProject();
    try {
      project.write("tests/file.txt", "x");
      outside.write("AGENTS.md", "outside instructions");
      symlinkSync(outside.path("AGENTS.md"), join(project.dir, "tests", "AGENTS.md"));

      expect(await discoverInstructionFiles("tests/file.txt", project.dir)).toEqual([]);
    } finally {
      project.cleanup();
      outside.cleanup();
    }
  });

  it("resolves target paths literally, without trimming", async () => {
    const project = makeProject();
    try {
      // A directory whose name genuinely starts with a space.
      project.write(" spaced/AGENTS.md", "spaced instructions");
      project.write(" spaced/file.txt", "x");
      const found = await discoverInstructionFiles(" spaced/file.txt", project.dir);
      expect(found.map((file) => file.displayPath)).toEqual([" spaced/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("strips a leading @ from tool paths", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      const found = await discoverInstructionFiles("@tests/file.txt", project.dir);
      expect(found.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("expands a leading ~ like Pi's built-in tools", async () => {
    const project = makeProject(homedir());
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      const homeRelative = `~/${relative(homedir(), project.path("tests/file.txt"))}`;
      const found = await discoverInstructionFiles(homeRelative, project.dir);
      expect(found.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });
});

describe("formatDisplayPath", () => {
  it("prefers project-relative paths, then ~, then absolute", () => {
    expect(formatDisplayPath("/proj/tests/AGENTS.md", "/proj", "/home/u")).toBe("tests/AGENTS.md");
    expect(formatDisplayPath("/home/u/.pi/agent/AGENTS.md", "/proj", "/home/u")).toBe(
      "~/.pi/agent/AGENTS.md",
    );
    expect(formatDisplayPath("/elsewhere/AGENTS.md", "/proj", "/home/u")).toBe(
      "/elsewhere/AGENTS.md",
    );
    expect(formatDisplayPath("tests/AGENTS.md", "/proj", "/home/u")).toBe("tests/AGENTS.md");
  });
});

describe("formatStatus", () => {
  const base = {
    modelLabel: "faux/faux-1",
    midConvoSystemMessages: true,
    configuredMode: "auto" as const,
    modeOrigin: "project" as const,
    effectiveMode: "immediate" as const,
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

// ---------------------------------------------------------------------------
// Session integration
// ---------------------------------------------------------------------------

describe("pi-agents-autoload extension", () => {
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
      expect(sectionOf(harness.faux.requests[2])).toContain(NESTED_MARKER);
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

      // Every request after discovery ends with exactly one ephemeral patch.
      for (const request of [harness.faux.requests[1], harness.faux.requests[2]]) {
        const patch = lastMessage(request);
        expect(patch?.role).toBe("system");
        expect(patch?.sections?.pi_agents_md).toContain(NESTED_MARKER);
        expect(patch?.sections?.pi_agents_md).toContain("tests: run with vitest");
        // The patch retains the leading system message, tool declarations, and other sections.
        expect(request.messages[0]?.role).toBe("system");
        expect(getCurrentTools(request.messages).map((tool) => tool.name)).toContain("read");
        expect(Object.keys(patch?.sections ?? {})).toEqual(["pi_agents_md"]);
      }
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

  it("records a durable patch at the next run and stops reapplying the ephemeral one", {
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

      // A native system-message section update is persisted on the branch.
      const patches = persistedSectionPatches(harness.sessionManager);
      expect(patches.some((section) => section?.includes(NESTED_MARKER))).toBe(true);

      // The next run's request relies on the durable patch: no ephemeral one at the end.
      const thirdRequest = harness.faux.requests[2];
      expect(lastMessage(thirdRequest)?.role).not.toBe("system");
      expect(sectionOf(thirdRequest)).toContain(NESTED_MARKER);
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
      const patch = lastMessage(harness.faux.requests[1]);
      expect(patch?.role).toBe("system");
      expect(patch?.sections?.pi_agents_md).toContain(NESTED_MARKER);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

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

      // ...and the promoted snapshot, not the changed file, reaches the prompt.
      const section = sectionOf(second.faux.requests[0]);
      expect(section).toContain("snapshot: original instructions");
      expect(section).not.toContain("CHANGED AFTER SNAPSHOT");
    } finally {
      first?.cleanup();
      second?.cleanup();
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
        expect(notifications[0]).toContain(
          "Mid-convo system: no | Mode: auto (default) → deferred",
        );
        expect(notifications[0]).toContain("No AGENTS.md files loaded.");
      } finally {
        harness?.cleanup();
        project.cleanup();
      }
    });

    it("lists native and nested files with delivery and mode", { timeout: 30000 }, async () => {
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
        expect(notifications[0]).toMatch(/1 {2}AGENTS\.md \(Pi, ~\d+ tokens\)/);
        expect(notifications[0]).toMatch(/2 {2}tests\/AGENTS\.md \(System, ~\d+ tokens\)/);
        expect(notifications[0]).toContain("2 files | ~");
      } finally {
        harness?.cleanup();
        project.cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("defaults to auto with no configuration", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("README.md", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("/agents-md-status");
      expect(harness.faux.requests).toHaveLength(0);
      expect(notifications[0]).toContain("Mode: auto (default) → immediate");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("loads global configuration", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        // Capable model, but the global configuration forces deferred delivery.
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        globalConfig: JSON.stringify({ mode: "deferred" }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the file");
      expect(toolResultTexts(harness.sessionManager)[0]).toContain(DEFERRED_LEAD_IN);
      notifications.length = 0;

      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: deferred (global) → deferred");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("prefers trusted project configuration over global", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ mode: "immediate" }));
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        globalConfig: JSON.stringify({ mode: "deferred" }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the file");
      expect(toolResultTexts(harness.sessionManager)[0]).not.toContain(DEFERRED_LEAD_IN);
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);
      notifications.length = 0;

      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: immediate (project) → immediate");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("ignores untrusted project configuration", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ mode: "immediate" }));
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        globalConfig: JSON.stringify({ mode: "deferred" }),
        responses: [assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: deferred (global) → deferred");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("inherits global mode from an empty project configuration", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", "{}");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        globalConfig: JSON.stringify({ mode: "deferred" }),
        responses: [assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: deferred (global) → deferred");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reports an invalid mode with the configuration file and falls back", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ mode: "sometimes" }));
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [assistantText("done")],
        uiContext,
      });
      expect(harness.extensionErrors.length).toBeGreaterThan(0);
      expect(harness.extensionErrors[0]?.event).toBe("session_start");
      expect(harness.extensionErrors[0]?.error).toMatch(
        /pi-agents-autoload\.json: Invalid mode "sometimes"/,
      );

      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: auto (default) → immediate");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reports malformed JSON with the configuration file", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", "{ not json");
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [assistantText("done")],
      });
      expect(harness.extensionErrors.length).toBeGreaterThan(0);
      expect(harness.extensionErrors[0]?.error).toMatch(/pi-agents-autoload\.json: malformed JSON/);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reports an unreadable configuration file instead of ignoring it", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      // A directory where the configuration file is expected: reading it
      // fails with EISDIR, which must be reported rather than treated as a
      // missing file.
      project.write(".pi/pi-agents-autoload.json/keep", "");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [assistantText("done")],
        uiContext,
      });
      expect(harness.extensionErrors.length).toBeGreaterThan(0);
      expect(harness.extensionErrors[0]?.event).toBe("session_start");
      expect(harness.extensionErrors[0]?.error).toMatch(
        /pi-agents-autoload\.json: EISDIR: illegal operation on a directory, read/,
      );

      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: auto (default) → immediate");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("falls back to the default mode after a reload with invalid configuration", {
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
        globalConfig: JSON.stringify({ mode: "deferred" }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
        uiContext,
      });
      await harness.session.prompt("read the file");
      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: deferred (global) → deferred");

      // Break the configuration and reload: the fresh extension instance
      // reports the error and runs with the default mode, not the previous one.
      writeFileSync(join(harness.agentDir, "pi-agents-autoload.json"), "{ not json", "utf8");
      await harness.session.reload();
      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: auto (default) → immediate");
      const sessionStartErrors = harness.extensionErrors.filter(
        (error) => error.event === "session_start",
      );
      expect(sessionStartErrors.length).toBeGreaterThan(0);
      expect(sessionStartErrors.at(-1)?.error).toMatch(/pi-agents-autoload\.json: malformed JSON/);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reloads configuration and keeps loaded instructions on reload", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write("docs/AGENTS.md", "docs: use kebab-case filenames");
      project.write("docs/file.txt", "d");
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          readCall("docs/file.txt"),
          assistantText("done again"),
        ],
        uiContext,
      });
      await harness.session.prompt("read the file");
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);

      // Switch the global configuration to deferred and reload the session.
      writeFileSync(
        join(harness.agentDir, "pi-agents-autoload.json"),
        '{"mode":"deferred"}',
        "utf8",
      );
      await harness.session.reload();
      notifications.length = 0;

      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: deferred (global) → deferred");
      // The previously loaded file keeps its delivery...
      expect(notifications[0]).toMatch(/1 {2}tests\/AGENTS\.md \(System, /);

      // ...and new discoveries use the reloaded mode.
      await harness.session.prompt("read the docs file");
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts.at(-1)).toContain(DEFERRED_LEAD_IN);
      expect(texts.at(-1)).toContain("docs: use kebab-case filenames");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("applies the new configuration when a session is resumed", { timeout: 30000 }, async () => {
    const project = makeProject();
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-sessions-"));
    let first: Awaited<ReturnType<typeof createHarness>> | undefined;
    let second: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write("docs/AGENTS.md", "docs: use kebab-case filenames");
      project.write("docs/file.txt", "d");

      first = await createHarness({
        cwd: project.dir,
        sessionDir,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        globalConfig: JSON.stringify({ mode: "deferred" }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      const sessionFile = first.sessionFile;
      await first.session.prompt("read the file");
      expect(toolResultTexts(first.sessionManager)[0]).toContain(DEFERRED_LEAD_IN);
      first.cleanup();
      first = undefined;

      // The resumed session has no global configuration: new discoveries use
      // the default mode while the restored file keeps its delivery.
      const { notifications, uiContext } = notifyCapture();
      second = await createHarness({
        cwd: project.dir,
        sessionDir,
        sessionFile,
        sessionStartEvent: { type: "session_start", reason: "resume" },
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("docs/file.txt"), assistantText("done")],
        uiContext,
      });
      await second.session.prompt("read the docs file");
      expect(toolResultTexts(second.sessionManager).at(-1)).not.toContain(DEFERRED_LEAD_IN);
      expect(sectionOf(second.faux.requests[1])).toContain('path="docs/AGENTS.md"');
      notifications.length = 0;

      await second.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Mode: auto (default) → immediate");
      expect(notifications[0]).toMatch(/tests\/AGENTS\.md \(Tool result, /);
      expect(notifications[0]).toMatch(/docs\/AGENTS\.md \(System, /);
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery notifications
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parallel tool batches
// ---------------------------------------------------------------------------

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
