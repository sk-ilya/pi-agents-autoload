import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assistantText, createScriptedStream, fauxModel } from "./harness";

describe("scripted model", () => {
  it("fails when a request has no scripted response", () => {
    const { streamFn } = createScriptedStream([assistantText("done")]);
    const context = normalizeContext({ systemPrompt: "", tools: [], messages: [] });
    streamFn(fauxModel(), context);
    expect(() => streamFn(fauxModel(), context)).toThrow("Unexpected model request 2");
  });
});
