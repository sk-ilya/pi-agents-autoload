import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function nestedReadHelper(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "nested_reads",
      label: "Nested reads",
      description: "Exercise reads called by another tool",
      parameters: Type.Object({ paths: Type.Array(Type.String()) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        for (const path of params.paths) {
          const call = await ctx.executeTool("read", { path });
          if (call.isError) throw new Error(`Nested read failed: ${path}`);
        }
        return { content: [{ type: "text", text: "Nested reads completed" }], details: {} };
      },
    }),
  );
}
