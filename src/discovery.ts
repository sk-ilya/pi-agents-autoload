/**
 * Filesystem discovery of nested instruction files: path normalization,
 * canonicalization within the project boundary, symlink containment checks,
 * the directory walk from the first subdirectory below the working
 * directory down to the accessed file's parent, and resolution of read
 * targets that are themselves instruction files.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isIgnoredPath } from "./config";

// Match Pi's context-file selection order within each directory.
const INSTRUCTION_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

export function isInstructionFileName(name: string): boolean {
  return INSTRUCTION_FILE_NAMES.some((candidate) => candidate === name);
}

/**
 * Lightweight filesystem metadata used to detect changes without
 * re-reading a file. A fingerprint match is treated as "content unchanged";
 * same-size rewrites that leave all three fields identical (possible with
 * coarse timestamp granularity) would go undetected.
 */
export interface FileFingerprint {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

/** Registry knowledge of an active file, used to skip re-reading unchanged content. */
export interface KnownFile {
  content: string;
  fingerprint: FileFingerprint;
}

export interface DiscoveredFile {
  key: string;
  displayPath: string;
  content: string;
  fingerprint: FileFingerprint;
}

export interface DiscoveryOptions {
  /** Glob patterns for project-relative instruction paths to exclude. */
  ignore?: readonly string[];
  /** Active files by key; their content is reused when the fingerprint is unchanged. */
  known?: ReadonlyMap<string, KnownFile>;
}

export interface DiscoveryResult {
  /** The selected instruction file in each walked directory, shallowest first. */
  files: DiscoveredFile[];
  /** Paths that are absent, ignored, or superseded by that directory's winner. */
  inactiveKeys: string[];
  /** Applicable instruction paths that could not be inspected reliably. */
  unverifiedPaths: string[];
}

/** Match the path forms accepted by Pi's built-in file tools. */
function resolveToolPath(target: string, cwd: string): string | undefined {
  let normalized = target.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "") return undefined;
  if (
    process.platform === "win32" &&
    normalized.startsWith("/") &&
    !normalized.startsWith("//") &&
    !normalized.includes("\\")
  ) {
    const match = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) normalized = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (normalized === "~") normalized = homedir();
  else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = path.join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return path.resolve(cwd, normalized);
}

function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function realpathOrNull(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
}

/**
 * Resolve the nearest existing ancestor so directory aliases share a scope
 * and writes to new paths can still be checked. Returns undefined when the
 * resulting path is outside `cwdReal`.
 */
async function canonicalizeWithin(resolved: string, cwdReal: string): Promise<string | undefined> {
  let current = resolved;
  const suffix: string[] = [];
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== undefined) {
      const canonical = suffix.length === 0 ? real : path.join(real, ...suffix);
      return isWithin(cwdReal, canonical) ? canonical : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

function fingerprintOf(stats: Stats): FileFingerprint {
  return { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size };
}

async function scopedInstructionPath(
  resolvedTarget: string,
  cwdReal: string,
): Promise<string | undefined> {
  const dir = await canonicalizeWithin(path.dirname(resolvedTarget), cwdReal);
  return dir === undefined ? undefined : path.join(dir, path.basename(resolvedTarget));
}

type InspectedFile =
  | { kind: "found"; file: DiscoveredFile }
  | { kind: "missing" }
  | { kind: "unverified" };

async function inspectInstructionFile(
  instructionPath: string,
  cwdReal: string,
  known?: KnownFile,
): Promise<InspectedFile> {
  let stats: Stats;
  try {
    stats = await fs.stat(instructionPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unverified" };
  }
  if (!stats.isFile()) return { kind: "missing" };
  // A linked file belongs to its containing directory, provided its source stays in the project.
  const sourcePath = await realpathOrNull(instructionPath);
  if (!sourcePath) return { kind: "unverified" };
  if (!isWithin(cwdReal, sourcePath)) return { kind: "missing" };
  const fingerprint = fingerprintOf(stats);
  let content: string;
  if (known && sameFingerprint(known.fingerprint, fingerprint)) {
    content = known.content;
  } else {
    try {
      content = stripBom(await fs.readFile(instructionPath, "utf8"));
    } catch {
      return { kind: "unverified" };
    }
  }
  return {
    kind: "found",
    file: {
      key: instructionPath,
      displayPath: toPosix(path.relative(cwdReal, instructionPath)),
      content,
      fingerprint,
    },
  };
}

/**
 * Select Pi's first eligible context file in every directory below `cwd`
 * through the target's parent, shallowest first. Pi owns root and ancestor
 * instructions. Symlinked files keep their containing directory's scope;
 * ignored candidates are skipped so the next candidate can apply.
 */
export async function discoverInstructionFiles(
  target: string,
  cwd: string,
  options?: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const files: DiscoveredFile[] = [];
  const inactiveKeys: string[] = [];
  const unverifiedPaths: string[] = [];
  const result = { files, inactiveKeys, unverifiedPaths };
  const resolvedTarget = resolveToolPath(target, cwd);
  if (resolvedTarget === undefined) return result;
  const cwdReal = (await realpathOrNull(cwd)) ?? path.resolve(cwd);
  const canonicalTarget = isInstructionFileName(path.basename(resolvedTarget))
    ? await scopedInstructionPath(resolvedTarget, cwdReal)
    : await canonicalizeWithin(resolvedTarget, cwdReal);
  if (canonicalTarget === undefined) return result;

  const relParent = path.relative(cwdReal, path.dirname(canonicalTarget));
  if (relParent === "") return result;
  const segments = relParent.split(path.sep).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return result;

  for (let depth = 1; depth <= segments.length; depth++) {
    const dir = path.join(cwdReal, ...segments.slice(0, depth));
    const candidates = INSTRUCTION_FILE_NAMES.map((name) => path.join(dir, name));
    let winner: DiscoveredFile | undefined;
    let unverified = false;
    for (const instructionPath of candidates) {
      const displayPath = toPosix(path.relative(cwdReal, instructionPath));
      if (isIgnoredPath(displayPath, options?.ignore ?? [])) continue;
      const inspected = await inspectInstructionFile(
        instructionPath,
        cwdReal,
        options?.known?.get(instructionPath),
      );
      if (inspected.kind === "unverified") {
        unverifiedPaths.push(instructionPath);
        unverified = true;
        break;
      }
      if (inspected.kind === "found") {
        winner = inspected.file;
        files.push(winner);
        break;
      }
    }
    // An uncertain higher-priority candidate leaves this directory's active state intact.
    if (!unverified) {
      inactiveKeys.push(...candidates.filter((candidate) => candidate !== winner?.key));
    }
  }
  return result;
}

/**
 * Inspect a directly read nested context file using the same scoped identity
 * as discovery. Root and ancestor files remain Pi's responsibility.
 */
export async function resolveInstructionTarget(
  target: string,
  cwd: string,
): Promise<DiscoveredFile | undefined> {
  const resolvedTarget = resolveToolPath(target, cwd);
  if (resolvedTarget === undefined || !isInstructionFileName(path.basename(resolvedTarget))) {
    return undefined;
  }
  const cwdReal = (await realpathOrNull(cwd)) ?? path.resolve(cwd);
  const canonicalTarget = await scopedInstructionPath(resolvedTarget, cwdReal);
  if (canonicalTarget === undefined || path.dirname(canonicalTarget) === cwdReal) return undefined;
  const inspected = await inspectInstructionFile(canonicalTarget, cwdReal);
  return inspected.kind === "found" ? inspected.file : undefined;
}

/** Project-relative where possible, `~` under the home directory, else absolute. */
export function formatDisplayPath(p: string, cwd: string, home: string): string {
  const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  if (isWithin(cwd, absolute)) return toPosix(path.relative(cwd, absolute));
  if (isWithin(home, absolute)) return `~/${toPosix(path.relative(home, absolute))}`;
  return toPosix(absolute);
}
