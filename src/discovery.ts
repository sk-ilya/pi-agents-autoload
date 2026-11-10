/**
 * Filesystem discovery of nested AGENTS.md files: path normalization,
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

const FILE_NAME = "AGENTS.md";

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
  /** Existing instruction files in scope, shallowest first. */
  files: DiscoveredFile[];
  /**
   * Instruction paths in the walked scope that definitely do not exist as
   * usable instruction files: missing, replaced by a directory, or symlinked
   * outside the project. Registry entries for these keys should be removed.
   * Paths whose existence cannot be determined are reported separately.
   */
  missingKeys: string[];
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
  return dir === undefined ? undefined : path.join(dir, FILE_NAME);
}

/**
 * Find AGENTS.md files in every directory from the first subdirectory below
 * `cwd` down to the target's parent, shallowest first. The working directory
 * itself is skipped: Pi loads root and ancestor instruction files at startup.
 * Targets and instruction sources outside `cwd` are ignored; a symlinked
 * instruction file is identified by the directory it is linked from, so two
 * scopes can share one source file. Files matching `ignore` patterns are
 * excluded entirely.
 */
export async function discoverInstructionFiles(
  target: string,
  cwd: string,
  options?: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const files: DiscoveredFile[] = [];
  const missingKeys: string[] = [];
  const unverifiedPaths: string[] = [];
  const empty = { files, missingKeys, unverifiedPaths };
  const resolvedTarget = resolveToolPath(target, cwd);
  if (resolvedTarget === undefined) return empty;
  const cwdReal = (await realpathOrNull(cwd)) ?? path.resolve(cwd);
  const canonicalTarget =
    path.basename(resolvedTarget) === FILE_NAME
      ? await scopedInstructionPath(resolvedTarget, cwdReal)
      : await canonicalizeWithin(resolvedTarget, cwdReal);
  if (canonicalTarget === undefined) return empty;

  const relParent = path.relative(cwdReal, path.dirname(canonicalTarget));
  if (relParent === "") return empty;
  const segments = relParent.split(path.sep).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return empty;

  for (let depth = 1; depth <= segments.length; depth++) {
    const dir = path.join(cwdReal, ...segments.slice(0, depth));
    const instructionPath = path.join(dir, FILE_NAME);
    const displayPath = toPosix(path.relative(cwdReal, instructionPath));
    if (isIgnoredPath(displayPath, options?.ignore ?? [])) continue;
    let stats: Stats | undefined;
    try {
      stats = await fs.stat(instructionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingKeys.push(instructionPath);
      } else {
        unverifiedPaths.push(instructionPath);
      }
      continue;
    }
    if (!stats.isFile()) {
      missingKeys.push(instructionPath);
      continue;
    }
    // The instruction file may itself be a symlink. Its identity and scope are
    // the directory being walked; resolve the symlink only for the boundary
    // check, so sources outside the project are ignored.
    const sourcePath = await realpathOrNull(instructionPath);
    if (!sourcePath) {
      unverifiedPaths.push(instructionPath);
      continue;
    }
    if (!isWithin(cwdReal, sourcePath)) {
      missingKeys.push(instructionPath);
      continue;
    }
    const fingerprint = fingerprintOf(stats);
    const known = options?.known?.get(instructionPath);
    let content: string;
    if (known && sameFingerprint(known.fingerprint, fingerprint)) {
      // Metadata unchanged: reuse the cached content instead of re-reading.
      content = known.content;
    } else {
      try {
        content = stripBom(await fs.readFile(instructionPath, "utf8"));
      } catch {
        unverifiedPaths.push(instructionPath);
        continue;
      }
    }
    files.push({ key: instructionPath, displayPath, content, fingerprint });
  }
  return empty;
}

/**
 * Resolve the read target itself when it is a nested instruction file: the
 * same scoped key, display path, content, and fingerprint that discovery
 * would report for it. The directory holding a symlinked instruction file
 * defines its scope. Returns undefined for non-instruction targets, the root
 * instruction file (Pi loads it natively), targets outside the working
 * directory, and files that violate the symlink containment rules or cannot
 * be read.
 */
export async function resolveInstructionTarget(
  target: string,
  cwd: string,
): Promise<DiscoveredFile | undefined> {
  const resolvedTarget = resolveToolPath(target, cwd);
  if (resolvedTarget === undefined || path.basename(resolvedTarget) !== FILE_NAME) return undefined;
  const cwdReal = (await realpathOrNull(cwd)) ?? path.resolve(cwd);
  const canonicalTarget = await scopedInstructionPath(resolvedTarget, cwdReal);
  if (canonicalTarget === undefined || path.dirname(canonicalTarget) === cwdReal) return undefined;
  let stats: Stats | undefined;
  try {
    stats = await fs.stat(canonicalTarget);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  const sourcePath = await realpathOrNull(canonicalTarget);
  if (!sourcePath || !isWithin(cwdReal, sourcePath)) return undefined;
  let content: string;
  try {
    content = stripBom(await fs.readFile(canonicalTarget, "utf8"));
  } catch {
    return undefined;
  }
  return {
    key: canonicalTarget,
    displayPath: toPosix(path.relative(cwdReal, canonicalTarget)),
    content,
    fingerprint: fingerprintOf(stats),
  };
}

/** Project-relative where possible, `~` under the home directory, else absolute. */
export function formatDisplayPath(p: string, cwd: string, home: string): string {
  const absolute = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  if (isWithin(cwd, absolute)) return toPosix(path.relative(cwd, absolute));
  if (isWithin(home, absolute)) return `~/${toPosix(path.relative(home, absolute))}`;
  return toPosix(absolute);
}
