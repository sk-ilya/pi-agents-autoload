/**
 * The active instruction registry: discovered files, their review and usage
 * state, snapshot persistence through `pi.appendEntry`, restoration from the
 * active session branch, and compaction aging.
 *
 * Three concepts stay separate per file:
 * - registered: the extension knows the file and its content;
 * - pending review: new or changed content still needs to reach the model
 *   before edits and writes under it may proceed;
 * - used since compaction: controls retention and expiry.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isIgnoredPath } from "./config";
import type { Delivery } from "./delivery";
import {
  type DiscoveredFile,
  type DiscoveryResult,
  type KnownFile,
  realpathOrNull,
} from "./discovery";

export const ENTRY_TYPE = "pi-agents-autoload";

/** One discovered instruction file, snapshotted for the current session branch. */
export interface InstructionFile {
  /**
   * Scoped path of the instruction file (its canonical directory plus
   * `AGENTS.md`); the deduplication key. Directory aliases collapse onto one
   * key, while symlinks in different scopes stay distinct even when they
   * share a source file.
   */
  key: string;
  /** Path relative to the working directory, with `/` separators; used for display. */
  displayPath: string;
  content: string;
  delivery: Delivery;
  /** Whether the file was discovered or used during the current compaction cycle. */
  usedSinceCompact: boolean;
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
  /** Absent in snapshots written before usage tracking; restored as `true`. */
  usedSinceCompact: boolean;
}

interface Snapshot {
  files: SnapshotFile[];
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
 * usage ages through `ageForCompaction`, and history restores through
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
  private lastSnapshotJson: string | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  /** Active instruction files, in discovery order. */
  files(): InstructionFile[] {
    return [...this.activeFiles.values()];
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
      files: [...this.activeFiles.values()].map(
        ({ displayPath, content, delivery, usedSinceCompact }) => ({
          path: displayPath,
          content,
          delivery,
          usedSinceCompact,
        }),
      ),
    };
  }

  private persistSnapshot(): void {
    const snapshot = this.buildSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshotJson) return;
    this.pi.appendEntry(ENTRY_TYPE, snapshot);
    this.lastSnapshotJson = json;
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
    this.lastSnapshotJson = undefined;
    let snapshot: Snapshot | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        snapshot = entry.data as Snapshot | undefined;
      }
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
        path.basename(relative) !== "AGENTS.md" ||
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
        // Snapshots from before usage tracking carry no flag; give those
        // files one full grace cycle.
        usedSinceCompact: file.usedSinceCompact !== false,
      });
    }
    this.lastSnapshotJson = JSON.stringify(this.buildSnapshot());
  }

  /**
   * Fold a discovery into the registry: register new files, renew retained
   * ones, refresh retained files whose content changed, and remove entries
   * for instruction files that no longer exist. Content freshness is
   * independent of the compaction lifecycle: a file can be registered and
   * unchanged while unused, or registered and used while its changed
   * content is pending review. Newly added or changed files stay pending
   * review until the next model request delivers them. Called after
   * asynchronous discovery, so it is the recheck point for concurrent tool
   * calls: files registered by another call in between are treated as
   * already known. Persists only when the registry changed; a fingerprint
   * refresh alone never produces a snapshot or any model-facing change.
   */
  observeDiscovered(result: DiscoveryResult, delivery: Delivery): ObservedFiles {
    const added: InstructionFile[] = [];
    const updated: InstructionFile[] = [];
    let changed = false;
    for (const file of result.files) {
      const existing = this.activeFiles.get(file.key);
      if (existing === undefined) {
        const record: InstructionFile = { ...file, delivery, usedSinceCompact: true };
        this.activeFiles.set(record.key, record);
        added.push(record);
        changed = true;
        continue;
      }
      if (!existing.usedSinceCompact) {
        existing.usedSinceCompact = true;
        changed = true;
      }
      existing.fingerprint = file.fingerprint;
      if (file.content !== existing.content) {
        existing.content = file.content;
        updated.push(existing);
        changed = true;
      }
    }
    for (const key of result.missingKeys) {
      const existing = this.activeFiles.get(key);
      if (existing === undefined) continue;
      this.activeFiles.delete(key);
      this.pendingReviewKeys.delete(key);
      changed = true;
    }
    for (const file of [...added, ...updated]) {
      this.pendingReviewKeys.add(file.key);
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
      existing.usedSinceCompact = true;
      existing.fingerprint = file.fingerprint;
      existing.content = file.content;
      this.persistSnapshot();
      return existing;
    }
    const record: InstructionFile = { ...file, delivery: "toolResult", usedSinceCompact: true };
    this.activeFiles.set(record.key, record);
    this.persistSnapshot();
    return record;
  }

  /**
   * Age every active file by one compaction cycle. Files used during the
   * cycle are retained and demoted to "unused" for the next one; files
   * that were already unused expire and return on the next file access in
   * their directory. Retained files are promoted to system delivery, since
   * the tool results that carried deferred instructions may be compacted
   * away while the registry entry lives on.
   */
  ageForCompaction(): void {
    for (const [key, file] of this.activeFiles) {
      if (!file.usedSinceCompact) {
        this.activeFiles.delete(key);
        continue;
      }
      file.usedSinceCompact = false;
      file.delivery = "system";
    }
    this.persistSnapshot();
  }
}
