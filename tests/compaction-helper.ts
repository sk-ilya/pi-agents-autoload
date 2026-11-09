/**
 * Test-only extension: provides a canned compaction summary so tests exercise
 * the real compaction entry, checkpoint, and `session_compact` event without
 * calling a model. Writing a `cancel-compaction` file into the project
 * directory makes the next compaction cancel, to exercise the failed path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CANCEL_MARKER = "cancel-compaction";

export default function cannedCompaction(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    if (existsSync(join(ctx.cwd, CANCEL_MARKER))) {
      return { cancel: true };
    }
    return {
      compaction: {
        summary: "Canned compaction summary for tests.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}
