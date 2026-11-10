import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function changeInstructionsAfterRead(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "read" && event.input.path === "tests/AGENTS.md" && !event.isError) {
      await writeFile(join(ctx.cwd, "tests/AGENTS.md"), "tests: updated rules", "utf8");
    }
  });
}
