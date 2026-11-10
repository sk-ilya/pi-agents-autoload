/**
 * Active instructions, pending review, hit counts, and session-branch
 * persistence. Compaction selects from the current cycle's hits.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExtensionConfig, isIgnoredPath } from "./config";
import { type Delivery, fileSectionName, renderInstructionBlocks } from "./delivery";
import {
  type DiscoveredFile,
  type DiscoveryResult,
  isInstructionFileName,
  type KnownFile,
  realpathOrNull,
} from "./discovery";

export const ENTRY_TYPE = "pi-agents-autoload";
export const HITS_ENTRY_TYPE = "pi-agents-autoload-hits";
export const PATCH_ENTRY_TYPE = "pi-agents-autoload-sections";
export const MIN_HITS = 4;

export interface SectionPatch {
  afterId: string;
  sections: Record<string, string | null>;
}

function sectionValue(file: Pick<InstructionFile, "displayPath" | "content">): string {
  const name = fileSectionName(file.displayPath);
  return `<${name}>\n${renderInstructionBlocks([file])}\n</${name}>`;
}

/** One discovered instruction file, snapshotted for the current session branch. */
export interface InstructionFile {
  /**
   * Scoped path of the instruction file (its canonical directory plus
   * selected filename); the deduplication key. Directory aliases share one
   * key, while symlinks in different scopes stay distinct even when they
   * share a source file.
   */
  key: string;
  /** Path relative to the working directory, with `/` separators; used for display. */
  displayPath: string;
  content: string;
  delivery: Delivery;
  /**
   * Filesystem metadata for change detection; absent until the first
   * relevant access after a restore. Never persisted in snapshots.
   */
  fingerprint?: DiscoveredFile["fingerprint"];
}

/** Shape persisted with `pi.appendEntry` and restored from the active branch. */
interface SnapshotFile {
  path: string;
  content: string;
  delivery: Delivery;
}

interface Snapshot {
  files: SnapshotFile[];
}

interface HitsSnapshot {
  counts: Array<[string, number]>;
}

export function selectCarryOver(
  files: readonly InstructionFile[],
  hits: ReadonlyMap<string, number>,
  limits: Pick<ExtensionConfig, "maxBytes" | "maxFiles">,
): InstructionFile[] {
  const byDirectory = new Map(files.map((file) => [path.dirname(file.key), file]));
  const selected = new Set<string>();
  const kept: InstructionFile[] = [];
  let bytes = 0;
  const ranked = [...files]
    .filter((file) => (hits.get(file.key) ?? 0) >= MIN_HITS)
    .sort((a, b) => {
      const count = (hits.get(b.key) ?? 0) - (hits.get(a.key) ?? 0);
      if (count !== 0) return count;
      const depth = a.displayPath.split("/").length - b.displayPath.split("/").length;
      return depth || a.displayPath.localeCompare(b.displayPath);
    });
  for (const file of ranked) {
    if (selected.has(file.key)) continue;
    const parents: InstructionFile[] = [];
    let directory = path.dirname(file.key);
    while (path.dirname(directory) !== directory) {
      directory = path.dirname(directory);
      const parent = byDirectory.get(directory);
      if (parent && !selected.has(parent.key)) parents.unshift(parent);
    }
    if (parents.some((parent) => (hits.get(parent.key) ?? 0) < MIN_HITS)) continue;
    const additions = [...parents, file];
    const size = additions.reduce(
      (total, entry) => total + Buffer.byteLength(entry.content, "utf8"),
      0,
    );
    if (limits.maxFiles !== 0 && kept.length + additions.length > limits.maxFiles) continue;
    if (limits.maxBytes !== 0 && bytes + size > limits.maxBytes) continue;
    for (const entry of additions) {
      selected.add(entry.key);
      kept.push(entry);
    }
    bytes += size;
  }
  return kept;
}

export interface ObservedFiles {
  /** Newly registered files, in discovery order. */
  added: InstructionFile[];
  /** Retained files whose content changed. */
  updated: InstructionFile[];
}

/**
 * Registry of active instruction files for one extension instance. State
 * transitions are explicit: discovery folds in through `observeDiscovered`,
 * hits reset through `ageForCompaction`, and history restores through
 * `restoreFromBranch`.
 */
export class InstructionRegistry {
  /** Active instruction files, in discovery order. */
  private readonly activeFiles = new Map<string, InstructionFile>();
  /**
   * Keys of instructions added or changed by the current tool batch that
   * have not yet reached the model. Edit and write calls under them stay
   * blocked until the next model request is prepared.
   */
  private readonly pendingReviewKeys = new Set<string>();
  private readonly hitCounts = new Map<string, number>();
  private readonly pendingSections = new Map<string, string | null>();
  private lastSnapshotJson: string | undefined;
  private lastHitsJson: string | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  /** Active instruction files, in discovery order. */
  files(): InstructionFile[] {
    return [...this.activeFiles.values()];
  }

  hits(): ReadonlyMap<string, number> {
    return this.hitCounts;
  }

  carryOver(limits: Pick<ExtensionConfig, "maxBytes" | "maxFiles">): InstructionFile[] {
    return selectCarryOver(this.files(), this.hitCounts, limits);
  }

  recordHits(keys: readonly string[]): void {
    let changed = false;
    for (const key of new Set(keys)) {
      if (!this.activeFiles.has(key)) continue;
      this.hitCounts.set(key, (this.hitCounts.get(key) ?? 0) + 1);
      changed = true;
    }
    if (changed) this.persistHits();
  }

  /** Collect the section changes made by the completed tool batch. */
  takePendingSections(): Record<string, string | null> {
    const sections = Object.fromEntries(this.pendingSections);
    this.pendingSections.clear();
    return sections;
  }

  /** System-delivered files in their current discovery order. */
  systemSections(): Record<string, string> {
    return Object.fromEntries(
      this.systemFiles().map((file) => [fileSectionName(file.displayPath), sectionValue(file)]),
    );
  }

  /** Whether the file's latest content still needs to reach the model. */
  isPendingReview(key: string): boolean {
    return this.pendingReviewKeys.has(key);
  }

  /**
   * Preparing a model request ends the review window: the tool results of
   * the batch that discovered the instructions are part of the context the
   * model is about to see, with or without a section patch.
   */
  endReviewWindow(): void {
    this.pendingReviewKeys.clear();
  }

  /** System-delivered active files, in discovery order. */
  systemFiles(): InstructionFile[] {
    return [...this.activeFiles.values()].filter((file) => file.delivery === "system");
  }

  /**
   * Registry knowledge for discovery's unchanged-content fast path. Files
   * without a fingerprint (restored from a snapshot) are excluded, so their
   * first access re-reads and reconstructs the metadata.
   */
  knownFiles(): Map<string, KnownFile> {
    const known = new Map<string, KnownFile>();
    for (const [key, file] of this.activeFiles) {
      if (file.fingerprint !== undefined) {
        known.set(key, { content: file.content, fingerprint: file.fingerprint });
      }
    }
    return known;
  }

  private buildSnapshot(): Snapshot {
    return {
      files: [...this.activeFiles.values()].map(({ displayPath, content, delivery }) => ({
        path: displayPath,
        content,
        delivery,
      })),
    };
  }

  private persistSnapshot(): void {
    const snapshot = this.buildSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshotJson) return;
    this.pi.appendEntry(ENTRY_TYPE, snapshot);
    this.lastSnapshotJson = json;
  }

  private buildHitsSnapshot(): HitsSnapshot {
    const counts: HitsSnapshot["counts"] = [];
    for (const file of this.activeFiles.values()) {
      const hits = this.hitCounts.get(file.key);
      if (hits) counts.push([file.displayPath, hits]);
    }
    return { counts };
  }

  private persistHits(): void {
    const snapshot = this.buildHitsSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastHitsJson) return;
    this.pi.appendEntry(HITS_ENTRY_TYPE, snapshot);
    this.lastHitsJson = json;
  }

  /**
   * Rebuild the active files from the latest snapshot on the active branch.
   * Files matching the configured ignore patterns are left out: a
   * configuration reload that introduces a pattern stops the extension from
   * managing the matching instructions. Historical messages that still
   * contain them are not rewritten.
   */
  async restoreFromBranch(ctx: ExtensionContext, ignore: readonly string[]): Promise<void> {
    this.activeFiles.clear();
    this.pendingReviewKeys.clear();
    this.hitCounts.clear();
    this.pendingSections.clear();
    this.lastSnapshotJson = undefined;
    this.lastHitsJson = undefined;
    let snapshot: Snapshot | undefined;
    let hits: HitsSnapshot | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === ENTRY_TYPE) snapshot = entry.data as Snapshot | undefined;
      if (entry.customType === HITS_ENTRY_TYPE) hits = entry.data as HitsSnapshot | undefined;
    }
    if (!snapshot || !Array.isArray(snapshot.files)) return;
    // Reconstruct the scoped keys the same way discovery builds them,
    // so a resumed session deduplicates against fresh discoveries.
    const cwdReal = (await realpathOrNull(ctx.cwd)) ?? path.resolve(ctx.cwd);
    for (const file of snapshot.files) {
      if (typeof file?.path !== "string" || typeof file?.content !== "string") continue;
      const key = path.resolve(cwdReal, file.path);
      const relative = path.relative(cwdReal, key);
      if (
        path.isAbsolute(file.path) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        path.dirname(relative) === "." ||
        !isInstructionFileName(path.basename(relative)) ||
        file.path !== relative.split(path.sep).join("/") ||
        isIgnoredPath(file.path, ignore) ||
        this.activeFiles.has(key)
      )
        continue;
      this.activeFiles.set(key, {
        key,
        displayPath: file.path,
        content: file.content,
        delivery: file.delivery === "toolResult" ? "toolResult" : "system",
      });
    }
    this.lastSnapshotJson = JSON.stringify(this.buildSnapshot());
    if (Array.isArray(hits?.counts)) {
      const byPath = new Map(this.files().map((file) => [file.displayPath, file.key]));
      for (const [displayPath, count] of hits.counts) {
        const key = byPath.get(displayPath);
        if (key && Number.isSafeInteger(count) && count >= 0) this.hitCounts.set(key, count);
      }
    }
    this.lastHitsJson = JSON.stringify(this.buildHitsSnapshot());
  }

  /**
   * Fold discovery into the registry: add or refresh files, drop missing
   * files, and require review for new content before edits and writes. Only
   * changes to the active files produce a full-content snapshot.
   */
  observeDiscovered(result: DiscoveryResult, delivery: Delivery): ObservedFiles {
    const added: InstructionFile[] = [];
    const updated: InstructionFile[] = [];
    let changed = false;
    for (const file of result.files) {
      const existing = this.activeFiles.get(file.key);
      if (existing === undefined) {
        const record: InstructionFile = { ...file, delivery };
        this.activeFiles.set(record.key, record);
        added.push(record);
        changed = true;
        continue;
      }
      existing.fingerprint = file.fingerprint;
      if (file.content !== existing.content) {
        existing.content = file.content;
        updated.push(existing);
        changed = true;
      }
    }
    for (const key of result.inactiveKeys) {
      const existing = this.activeFiles.get(key);
      if (existing === undefined) continue;
      if (existing.delivery === "system") {
        this.pendingSections.set(fileSectionName(existing.displayPath), null);
      }
      this.activeFiles.delete(key);
      this.pendingReviewKeys.delete(key);
      this.hitCounts.delete(key);
      changed = true;
    }
    for (const file of [...added, ...updated]) {
      this.pendingReviewKeys.add(file.key);
      if (file.delivery === "system") {
        this.pendingSections.set(fileSectionName(file.displayPath), sectionValue(file));
      }
    }
    if (changed) this.persistSnapshot();
    return { added, updated };
  }

  /**
   * Register an explicitly read instruction file as already delivered: the
   * read result itself carried the full content to the model, so the file
   * is not pending review and later results do not append a second copy.
   * The content delivered this way is the tool-result kind; compaction
   * promotes it like any other tool-result delivery.
   */
  registerDelivered(file: DiscoveredFile): InstructionFile {
    const existing = this.activeFiles.get(file.key);
    if (existing !== undefined) {
      existing.fingerprint = file.fingerprint;
      if (existing.content !== file.content && existing.delivery === "system") {
        this.pendingSections.set(fileSectionName(existing.displayPath), sectionValue(file));
      }
      existing.content = file.content;
      this.persistSnapshot();
      return existing;
    }
    const record: InstructionFile = { ...file, delivery: "toolResult" };
    this.activeFiles.set(record.key, record);
    this.persistSnapshot();
    return record;
  }

  /**
   * Retain the ranked, budgeted files and start a fresh hit cycle. Selected
   * tool-result files move to system delivery because their tool results may
   * be compacted away.
   */
  ageForCompaction(limits: Pick<ExtensionConfig, "maxBytes" | "maxFiles">): void {
    const kept = new Set(this.carryOver(limits).map((file) => file.key));
    for (const [key, file] of this.activeFiles) {
      if (!kept.has(key)) {
        this.activeFiles.delete(key);
        this.pendingReviewKeys.delete(key);
        continue;
      }
      file.delivery = "system";
    }
    this.hitCounts.clear();
    this.pendingSections.clear();
    this.persistSnapshot();
    this.persistHits();
  }
}
