/** Configuration: mode parsing, precedence, validation, reload, and resume. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMode, readConfigFile } from "../src/config";
import {
  assistantText,
  assistantToolCalls,
  createHarness,
  fauxModel,
  makeProject,
} from "./harness";
import {
  DEFERRED_LEAD_IN,
  NESTED_MARKER,
  notifyCapture,
  readCall,
  sectionOf,
  toolResultTexts,
} from "./helpers";

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

describe("configuration", () => {
  it("validates byte and file limits", async () => {
    const project = makeProject();
    try {
      const file = project.path("limits.json");
      for (const [name, value] of [
        ["maxBytes", -1],
        ["maxBytes", 1.5],
        ["maxBytes", Number.MAX_SAFE_INTEGER + 1],
        ["maxFiles", "2"],
      ] as const) {
        project.write("limits.json", JSON.stringify({ [name]: value }));
        await expect(readConfigFile(file)).rejects.toThrow(
          `"${name}" must be a non-negative integer`,
        );
      }
      project.write("limits.json", JSON.stringify({ maxBytes: 0, maxFiles: 0 }));
      await expect(readConfigFile(file)).resolves.toEqual({ maxBytes: 0, maxFiles: 0 });
    } finally {
      project.cleanup();
    }
  });

  it("resolves limits per field from trusted project and global configuration", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ maxBytes: 1024 }));
      const { notifications, uiContext } = notifyCapture();
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel(),
        globalConfig: JSON.stringify({ maxBytes: 2048, maxFiles: 2 }),
        responses: [],
        uiContext,
      });
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("Carry-over: 4+ hits | 1 KiB total | up to 2 files");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
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
      expect(notifications[0]).toContain("Carry-over: 4+ hits | 50 KiB total | files unlimited");
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
      expect(notifications[0]).toMatch(/ {2}- tests\/AGENTS\.md +\(~\d+ tokens · 1 hit\)/);

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
      expect(notifications[0]).toMatch(/ {2}- tests\/AGENTS\.md +\(~\d+ tokens · 1 hit\)/);
      expect(notifications[0]).toMatch(/ {2}- docs\/AGENTS\.md +\(~\d+ tokens · 1 hit\)/);
    } finally {
      first?.cleanup();
      second?.cleanup();
      project.cleanup();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ignore configuration
// ---------------------------------------------------------------------------

describe("ignore configuration", () => {
  it("excludes ignored instruction files from discovery and edit blocking", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("vendor/AGENTS.md", "vendor: vendored rules");
      project.write("vendor/file.txt", "v");
      project.write("vendor/target.txt", "alpha\n");
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: ["vendor/**"] }));
      const editArgs = {
        path: "vendor/target.txt",
        edits: [{ oldText: "alpha", newText: "beta" }],
      };
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel(),
        responses: [
          readCall("vendor/file.txt"),
          assistantToolCalls([{ name: "edit", args: editArgs }]),
          readCall("tests/file.txt"),
          assistantText("done"),
        ],
      });
      await harness.session.prompt("work");

      // The ignored instructions are neither appended to the read result...
      const texts = toolResultTexts(harness.sessionManager);
      expect(texts[0]).not.toContain(DEFERRED_LEAD_IN);
      // ...nor blocking the first edit under them.
      expect(texts.some((text) => text.includes("Blocked:"))).toBe(false);
      expect(project.read("vendor/target.txt")).toBe("beta\n");
      // Non-ignored instructions keep flowing.
      expect(texts.at(-1)).toContain(DEFERRED_LEAD_IN);
      expect(texts.at(-1)).toContain("tests: run with vitest");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("inherits the global mode from a project configuration that sets only ignore", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: ["vendor/**"] }));
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
      expect(notifications[0]).toContain("Ignore patterns: 1");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("lets an explicitly empty project ignore override the global ignore", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: [] }));
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel(),
        globalConfig: JSON.stringify({ ignore: ["tests/**"] }),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      await harness.session.prompt("read the file");
      expect(toolResultTexts(harness.sessionManager)[0]).toContain(DEFERRED_LEAD_IN);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("does not read ignore patterns from an untrusted project", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write("docs/AGENTS.md", "docs: use kebab-case filenames");
      project.write("docs/file.txt", "d");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: ["tests/**"] }));
      harness = await createHarness({
        cwd: project.dir,
        model: fauxModel(),
        globalConfig: JSON.stringify({ ignore: ["docs/**"] }),
        responses: [readCall("tests/file.txt"), readCall("docs/file.txt"), assistantText("done")],
      });
      await harness.session.prompt("read the files");
      const texts = toolResultTexts(harness.sessionManager);
      // The untrusted project ignore is not applied...
      expect(texts[0]).toContain(DEFERRED_LEAD_IN);
      // ...while the global ignore is.
      expect(texts[1]).not.toContain(DEFERRED_LEAD_IN);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reports an ignore value that is not an array", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.md", "tests: run with vitest");
      project.write("tests/file.txt", "x");
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: "vendor/**" }));
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel(),
        responses: [readCall("tests/file.txt"), assistantText("done")],
      });
      expect(harness.extensionErrors[0]?.event).toBe("session_start");
      expect(harness.extensionErrors[0]?.error).toMatch(
        /pi-agents-autoload\.json: "ignore" must be an array/,
      );
      await harness.session.prompt("read the file");
      // The session continues with nothing ignored.
      expect(toolResultTexts(harness.sessionManager)[0]).toContain(DEFERRED_LEAD_IN);
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reports ignore entries that are not strings", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: [1] }));
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        responses: [assistantText("done")],
      });
      expect(harness.extensionErrors[0]?.error).toMatch(
        /pi-agents-autoload\.json: "ignore" entries must be strings/,
      );
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("reports empty ignore patterns", { timeout: 30000 }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: ["  "] }));
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        responses: [assistantText("done")],
      });
      expect(harness.extensionErrors[0]?.error).toMatch(
        /pi-agents-autoload\.json: invalid ignore pattern " {2}"/,
      );
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("selects the next file when a reload ignores the previous winner", {
    timeout: 30000,
  }, async () => {
    const project = makeProject();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      project.write("tests/AGENTS.override.md", "original winner");
      project.write("tests/CLAUDE.md", "fallback winner");
      project.write("tests/file.txt", "x");
      harness = await createHarness({
        cwd: project.dir,
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [
          readCall("tests/file.txt"),
          assistantText("done"),
          readCall("tests/file.txt"),
          assistantText("done again"),
        ],
      });
      await harness.session.prompt("read the file");
      expect(sectionOf(harness.faux.requests[1])).toContain("original winner");
      project.write(
        ".pi/pi-agents-autoload.json",
        JSON.stringify({ ignore: ["tests/AGENTS.override.md"] }),
      );
      await harness.session.reload();
      await harness.session.prompt("read it again");
      expect(sectionOf(harness.faux.requests[3])).toContain("fallback winner");
      expect(sectionOf(harness.faux.requests[3])).not.toContain("original winner");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });

  it("stops managing instructions that match a new ignore pattern after a reload", {
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
        trusted: true,
        model: fauxModel({ supportsMidConvoSystemMessages: true }),
        responses: [readCall("tests/file.txt"), assistantText("done"), assistantText("continued")],
        uiContext,
      });
      await harness.session.prompt("read the file");
      expect(sectionOf(harness.faux.requests[1])).toContain(NESTED_MARKER);

      project.write(".pi/pi-agents-autoload.json", JSON.stringify({ ignore: ["tests/**"] }));
      await harness.session.reload();
      await harness.session.prompt("continue");

      // The restored registry drops the now-ignored file and the managed
      // section is removed; the historical messages are left untouched.
      expect(sectionOf(harness.faux.requests[2])).toBe("");
      notifications.length = 0;
      await harness.session.prompt("/agents-md-status");
      expect(notifications[0]).toContain("No instruction files loaded.");
      expect(notifications[0]).toContain("Ignore patterns: 1");
    } finally {
      harness?.cleanup();
      project.cleanup();
    }
  });
});
