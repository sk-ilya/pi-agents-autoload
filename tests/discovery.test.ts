/** Discovery: the directory walk, path resolution, symlinks, and display paths. */

import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverInstructionFiles,
  formatDisplayPath,
  resolveInstructionTarget,
} from "../src/discovery";
import { makeProject } from "./harness";
import { writeFixture } from "./helpers";

describe("discoverInstructionFiles", () => {
  it("selects the first usable file in Pi's order for each nested directory", async () => {
    const project = makeProject();
    try {
      project.write("AGENTS.override.md", "native override");
      project.write("tests/file.txt", "x");
      const names = ["CLAUDE.MD", "CLAUDE.md", "AGENTS.MD", "AGENTS.md", "AGENTS.override.md"];
      for (const name of names) {
        project.write(`tests/${name}`, name);
        const result = await discoverInstructionFiles("tests/file.txt", project.dir);
        expect(result.files.map((file) => file.displayPath)).toEqual([`tests/${name}`]);
        expect(result.inactiveKeys).not.toContain(project.path(`tests/${name}`));
        expect(result.files[0]?.content).toBe(name);
      }
    } finally {
      project.cleanup();
    }
  });

  it("falls back when the winner disappears or an exact path is ignored", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.override.md", "override");
      project.write("tests/AGENTS.md", "agents");
      project.write("tests/CLAUDE.md", "claude");
      project.write("tests/file.txt", "x");
      const first = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(first.files.map((file) => file.displayPath)).toEqual(["tests/AGENTS.override.md"]);
      expect(first.inactiveKeys).toContain(project.path("tests/AGENTS.md"));
      const ignored = await discoverInstructionFiles("tests/file.txt", project.dir, {
        ignore: ["tests/AGENTS.override.md"],
      });
      expect(ignored.files.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
      rmSync(project.path("tests/AGENTS.override.md"));
      rmSync(project.path("tests/AGENTS.md"));
      expect(
        (await discoverInstructionFiles("tests/file.txt", project.dir)).files.map(
          (file) => file.displayPath,
        ),
      ).toEqual(["tests/CLAUDE.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("discovers nested AGENTS.md files from shallowest to deepest and skips the root", async () => {
    const project = makeProject();
    try {
      writeFixture(project);
      const found = await discoverInstructionFiles(
        "tests/integration/caas/lifecycle_test.go",
        project.dir,
      );
      expect(found.files.map((file) => file.displayPath)).toEqual([
        "tests/AGENTS.md",
        "tests/integration/AGENTS.md",
        "tests/integration/caas/AGENTS.md",
      ]);
      expect(found.files.map((file) => file.content)).toEqual([
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
      expect((await discoverInstructionFiles("README.md", project.dir)).files).toEqual([]);
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
      expect((await discoverInstructionFiles(relativeEscape, project.dir)).files).toEqual([]);
      expect((await discoverInstructionFiles(outside.path("file.txt"), project.dir)).files).toEqual(
        [],
      );
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

      expect((await discoverInstructionFiles("link/file.txt", project.dir)).files).toEqual([]);
      expect((await discoverInstructionFiles("alias.txt", project.dir)).files).toEqual([]);
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
      expect(found.files.map((file) => file.displayPath)).toEqual(["real/AGENTS.md"]);
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
      expect(found.files.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
      expect(found.files[0]?.content).toBe("shared instructions");
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
      expect(tests.files.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
      const docs = await discoverInstructionFiles("docs/file.txt", project.dir);
      expect(docs.files.map((file) => file.displayPath)).toEqual(["docs/AGENTS.md"]);
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
      expect(aliased.files).toHaveLength(1);
      expect(aliased.files[0]?.key).toBe(direct.files[0]?.key);
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

      const result = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(result.files).toEqual([]);
      // The containment violation deactivates the scoped path.
      expect(result.inactiveKeys).toContain(project.path("tests/AGENTS.md"));
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
      expect(found.files.map((file) => file.displayPath)).toEqual([" spaced/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("resolves file URLs like Pi's file tools", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      const target = project.write("tests/a file.txt", "x");
      const url = pathToFileURL(target).href;
      expect(
        (await discoverInstructionFiles(url, project.dir)).files.map((file) => file.displayPath),
      ).toEqual(["tests/AGENTS.md"]);
      expect((await discoverInstructionFiles(`@${url}`, project.dir)).files).toHaveLength(1);
      expect(
        (
          await resolveInstructionTarget(
            pathToFileURL(project.path("tests/AGENTS.md")).href,
            project.dir,
          )
        )?.key,
      ).toBe(project.path("tests/AGENTS.md"));
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
      expect(found.files.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
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
      expect(found.files.map((file) => file.displayPath)).toEqual(["tests/AGENTS.md"]);
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

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

describe("ignore patterns in discovery", () => {
  it("excludes files matching directory patterns", async () => {
    const project = makeProject();
    try {
      writeFixture(project);
      project.write("vendor/AGENTS.md", "vendor: vendored rules");
      project.write("vendor/lib/AGENTS.md", "vendor lib: internal");
      project.write("vendor/lib/file.txt", "v");
      project.write("src/generated/AGENTS.md", "generated: do not edit");
      project.write("src/generated/file.txt", "g");
      const ignore = ["vendor/**", "**/generated/**"];

      const vendor = await discoverInstructionFiles("vendor/lib/file.txt", project.dir, { ignore });
      expect(vendor.files).toEqual([]);
      const generated = await discoverInstructionFiles("src/generated/file.txt", project.dir, {
        ignore,
      });
      expect(generated.files.map((file) => file.displayPath)).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it("matches an exact instruction path without cascading to nested instructions", async () => {
    const project = makeProject();
    try {
      project.write("vendor/AGENTS.md", "vendor: vendored rules");
      project.write("vendor/lib/AGENTS.md", "vendor lib: internal");
      project.write("vendor/lib/file.txt", "v");

      const result = await discoverInstructionFiles("vendor/lib/file.txt", project.dir, {
        ignore: ["vendor/AGENTS.md"],
      });
      // The ignored parent is excluded, the nested file is not.
      expect(result.files.map((file) => file.displayPath)).toEqual(["vendor/lib/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });

  it("matches an exact nested instruction path", async () => {
    const project = makeProject();
    try {
      project.write("docs/AGENTS.md", "docs: general");
      project.write("docs/legacy/AGENTS.md", "legacy: outdated");
      project.write("docs/legacy/file.txt", "x");

      const result = await discoverInstructionFiles("docs/legacy/file.txt", project.dir, {
        ignore: ["docs/legacy/AGENTS.md"],
      });
      expect(result.files.map((file) => file.displayPath)).toEqual(["docs/AGENTS.md"]);
    } finally {
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Deletion reporting
// ---------------------------------------------------------------------------

describe("missing instruction files", () => {
  it("reports deleted instruction files as missing in scope", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      const before = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(before.files).toHaveLength(1);

      rmSync(project.path("tests/AGENTS.md"));
      const after = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(after.files).toEqual([]);
      expect(after.inactiveKeys).toContain(project.path("tests/AGENTS.md"));
    } finally {
      project.cleanup();
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports unreadable instructions as unverified rather than missing",
    async () => {
      const project = makeProject();
      try {
        const instructions = project.write("tests/AGENTS.md", "tests instructions");
        project.write("tests/file.txt", "x");
        chmodSync(instructions, 0o000);
        const result = await discoverInstructionFiles("tests/file.txt", project.dir);
        expect(result.files).toEqual([]);
        expect(result.inactiveKeys).toEqual([]);
        expect(result.unverifiedPaths).toEqual([instructions]);
        const ignored = await discoverInstructionFiles("tests/file.txt", project.dir, {
          ignore: ["tests/AGENTS.md"],
        });
        expect(ignored.unverifiedPaths).toEqual([]);
      } finally {
        project.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a directory unresolved when its higher-priority file is unreadable",
    async () => {
      const project = makeProject();
      try {
        const override = project.write("tests/AGENTS.override.md", "override rules");
        project.write("tests/CLAUDE.md", "fallback rules");
        project.write("tests/file.txt", "x");
        chmodSync(override, 0o000);
        const result = await discoverInstructionFiles("tests/file.txt", project.dir);
        expect(result.files).toEqual([]);
        expect(result.inactiveKeys).toEqual([]);
        expect(result.unverifiedPaths).toEqual([override]);
      } finally {
        project.cleanup();
      }
    },
  );

  it("reports an instruction path replaced by a directory as missing", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");
      rmSync(project.path("tests/AGENTS.md"));
      mkdirSync(project.path("tests/AGENTS.md"));

      const result = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(result.files).toEqual([]);
      expect(result.inactiveKeys).toContain(project.path("tests/AGENTS.md"));
    } finally {
      project.cleanup();
    }
  });

  it("reports only the walked scope, not sibling directories", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("other/AGENTS.md", "other instructions");
      project.write("tests/file.txt", "x");
      rmSync(project.path("tests/AGENTS.md"));

      const result = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(result.inactiveKeys).toContain(project.path("tests/AGENTS.md"));
      expect(result.inactiveKeys).not.toContain(project.path("other/AGENTS.md"));
    } finally {
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Explicit instruction targets
// ---------------------------------------------------------------------------

describe("resolveInstructionTarget", () => {
  it("resolves a nested instruction file with its scoped identity", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      const file = await resolveInstructionTarget("tests/AGENTS.md", project.dir);
      expect(file?.key).toBe(project.path("tests/AGENTS.md"));
      expect(file?.displayPath).toBe("tests/AGENTS.md");
      expect(file?.content).toBe("tests instructions");
      expect(file?.fingerprint.size).toBe("tests instructions".length);
    } finally {
      project.cleanup();
    }
  });

  it("resolves absolute and aliased paths to the same scoped file", async () => {
    const project = makeProject();
    try {
      project.write("tests/AGENTS.md", "tests instructions");
      symlinkSync(join(project.dir, "tests"), join(project.dir, "alias"), "dir");

      const direct = await resolveInstructionTarget("tests/AGENTS.md", project.dir);
      const aliased = await resolveInstructionTarget("alias/AGENTS.md", project.dir);
      expect(aliased?.key).toBe(direct?.key);
      expect(aliased?.content).toBe("tests instructions");
    } finally {
      project.cleanup();
    }
  });

  it("keeps a symlinked instruction file in its containing directory's scope", async () => {
    const project = makeProject();
    try {
      project.write("shared/AGENTS.md", "shared instructions");
      project.write("tests/file.txt", "x");
      symlinkSync(project.path("shared/AGENTS.md"), project.path("tests/AGENTS.md"));

      const explicit = await resolveInstructionTarget("tests/AGENTS.md", project.dir);
      expect(explicit?.key).toBe(project.path("tests/AGENTS.md"));
      const discovered = await discoverInstructionFiles("tests/AGENTS.md", project.dir);
      expect(discovered.files.map((file) => file.key)).toEqual([explicit?.key]);
      const beneath = await discoverInstructionFiles("tests/file.txt", project.dir);
      expect(beneath.files.map((file) => file.key)).toEqual([explicit?.key]);
    } finally {
      project.cleanup();
    }
  });

  it("returns undefined for the root file, non-instruction targets, and missing files", async () => {
    const project = makeProject();
    try {
      project.write("AGENTS.md", "root instructions");
      project.write("tests/AGENTS.md", "tests instructions");
      project.write("tests/file.txt", "x");

      expect(await resolveInstructionTarget("AGENTS.md", project.dir)).toBeUndefined();
      expect(await resolveInstructionTarget("CLAUDE.md", project.dir)).toBeUndefined();
      project.write("tests/CLAUDE.MD", "nested claude");
      expect((await resolveInstructionTarget("tests/CLAUDE.MD", project.dir))?.content).toBe(
        "nested claude",
      );
      expect(await resolveInstructionTarget("tests/file.txt", project.dir)).toBeUndefined();
      expect(await resolveInstructionTarget("tests/missing.md", project.dir)).toBeUndefined();
      expect(
        await resolveInstructionTarget(join(project.dir, "tests", "AGENTS.md"), project.dir),
      ).toBeDefined();
    } finally {
      project.cleanup();
    }
  });

  it("returns undefined for targets outside the working directory", async () => {
    const project = makeProject();
    const outside = makeProject();
    try {
      outside.write("AGENTS.md", "outside instructions");
      expect(
        await resolveInstructionTarget(outside.path("AGENTS.md"), project.dir),
      ).toBeUndefined();
    } finally {
      project.cleanup();
      outside.cleanup();
    }
  });
});
