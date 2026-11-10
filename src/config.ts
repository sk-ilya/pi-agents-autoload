/**
 * Optional JSON configuration, read from
 * `~/.pi/agent/pi-agents-autoload.json` and the trusted project's
 * `.pi/pi-agents-autoload.json`. Each field resolves independently:
 * trusted project value over global value over the default, so a project
 * that sets only `ignore` inherits the global `mode`. An explicitly empty
 * project `ignore` array overrides the global one. Invalid files throw
 * errors naming the file; they surface through Pi's extension error
 * reporting.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-agents-autoload.json";

export type Mode = "auto" | "immediate" | "deferred";

/** Where the configured mode came from. */
export type ConfigOrigin = "project" | "global" | "default";

/** The effective extension configuration. */
export interface ExtensionConfig {
  mode: Mode;
  modeOrigin: ConfigOrigin;
  /** Glob patterns for project-relative instruction paths excluded from automatic loading. */
  ignore: string[];
}

/** Fields present in one configuration file. */
interface ConfigFileContents {
  mode?: Mode;
  ignore?: string[];
}

/** Parse and validate a configured mode value. */
export function parseMode(raw: string): Mode {
  if (raw === "auto" || raw === "immediate" || raw === "deferred") return raw;
  throw new Error(`Invalid mode "${raw}". Expected "auto", "immediate", or "deferred".`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Match a normalized, project-relative instruction path (for example
 * `vendor/lib/AGENTS.md`) against ignore patterns. Patterns use Node's
 * `path.matchesGlob`, which treats unparseable globs as non-matching.
 */
export function isIgnoredPath(displayPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => path.matchesGlob(displayPath, pattern));
}

/**
 * Read one configuration file. Returns the fields it sets. Malformed JSON,
 * a non-object document, invalid values, or an unreadable file throw an
 * error naming the file. Absent files and absent fields are undefined.
 */
export async function readConfigFile(file: string): Promise<ConfigFileContents> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`${file}: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: malformed JSON (${errorMessage(error)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object`);
  }
  const record = parsed as { mode?: unknown; ignore?: unknown };
  const contents: ConfigFileContents = {};
  if (record.mode !== undefined) {
    if (typeof record.mode !== "string") {
      throw new Error(`${file}: "mode" must be a string`);
    }
    try {
      contents.mode = parseMode(record.mode);
    } catch (error) {
      throw new Error(`${file}: ${errorMessage(error)}`);
    }
  }
  if (record.ignore !== undefined) {
    if (!Array.isArray(record.ignore)) {
      throw new Error(`${file}: "ignore" must be an array of glob patterns`);
    }
    for (const pattern of record.ignore) {
      if (typeof pattern !== "string") {
        throw new Error(`${file}: "ignore" entries must be strings`);
      }
      // matchesGlob never rejects string patterns, so only emptiness is
      // detectably invalid; other malformed globs simply never match.
      if (pattern.trim() === "") {
        throw new Error(`${file}: invalid ignore pattern "${pattern}"`);
      }
    }
    contents.ignore = record.ignore;
  }
  return contents;
}

/**
 * Resolve the effective configuration: per field, trusted project value
 * over global value over the default. Untrusted project configuration is
 * never read.
 */
export async function loadConfig(ctx: ExtensionContext): Promise<ExtensionConfig> {
  const project = ctx.isProjectTrusted()
    ? await readConfigFile(path.join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME))
    : {};
  const global = await readConfigFile(path.join(getAgentDir(), CONFIG_FILE_NAME));
  const mode = project.mode ?? global.mode;
  return {
    mode: mode ?? "auto",
    modeOrigin:
      project.mode !== undefined ? "project" : global.mode !== undefined ? "global" : "default",
    ignore: project.ignore ?? global.ignore ?? [],
  };
}
