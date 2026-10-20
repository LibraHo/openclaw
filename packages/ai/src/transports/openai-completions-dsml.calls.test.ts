import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsChunk,
  streamChunks,
} from "./openai-completions.test-support.js";

const variants = [
  { marker: "｜｜DSML｜｜", wrapper: "calls" },
  { marker: "｜｜DSML｜｜ ", wrapper: "calls" },
  { marker: "｜｜DSML｜｜ ", wrapper: "tool_calls" },
];

function dsmlCall(marker: string, wrapper: string) {
  return `<${marker}${wrapper}><${marker}invoke name="read"><${marker}parameter name="path">/tmp/unexecuted</${marker}parameter></${marker}invoke></${marker}${wrapper}>`;
}

describe("DeepSeek calls markup recovery and direct filtering", () => {
  it.each(variants)(
    "recovers fragmented $marker $wrapper through the managed stream",
    async ({ marker, wrapper }) => {
      const model = createDeepSeekCompletionsModel();
      const output = createAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      await processCompletionsStream(
        streamChunks([
          ...Array.from(dsmlCall(marker, wrapper), (content) => makeCompletionsChunk({ content })),
          makeCompletionsChunk({}, "stop"),
        ]),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
      );
      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toEqual([
        {
          type: "toolCall",
          id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
          name: "read",
          arguments: { path: "/tmp/unexecuted" },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("DSML");
    },
  );

  it.each(variants)(
    "filters $marker $wrapper in direct mode without recovering calls",
    async ({ marker, wrapper }) => {
      const model = createDeepSeekCompletionsModel();
      const output = createAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      const text = `before ${dsmlCall(marker, wrapper)} after`;
      await processCompletionsStream(
        streamChunks([
          ...Array.from(text, (content) => makeCompletionsChunk({ content })),
          makeCompletionsChunk({}, "stop"),
        ]),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        { mode: "direct", beforeContentBlock() {}, provisionalCommentaryTags: new Map() },
      );
      expect(output.content).toEqual([{ type: "text", text: "before  after" }]);
      expect(output.stopReason).toBe("stop");
      expect(JSON.stringify(events)).not.toContain("DSML");
      expect(events.some((event) => event.type?.startsWith("toolcall_"))).toBe(false);
    },
  );

  it.each(["managed", "direct"] as const)(
    "hides slashless closing tags in %s mode without authorizing tools",
    async (mode) => {
      const model = createDeepSeekCompletionsModel();
      const output = createAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      const content =
        'before <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="write"><｜｜DSML｜｜ parameter name="path">/tmp/unexecuted<｜｜DSML｜｜ parameter><｜｜DSML｜｜ invoke><｜｜DSML｜｜ calls>';
      await processCompletionsStream(
        streamChunks([
          ...Array.from(content, (text) => makeCompletionsChunk({ content: text })),
          makeCompletionsChunk({}, "stop"),
        ]),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        mode === "direct"
          ? { mode, beforeContentBlock() {}, provisionalCommentaryTags: new Map() }
          : { mode },
      );
      expect(output.content).toEqual([{ type: "text", text: "before " }]);
      expect(output.stopReason).toBe("stop");
      expect(JSON.stringify(events)).not.toContain("DSML");
      expect(events.some((event) => event.type?.startsWith("toolcall_"))).toBe(false);
    },
  );

  it("does not authorize a fragmented calls block after cancellation", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const abort = new AbortController();
    const content = dsmlCall("｜｜DSML｜｜ ", "calls");
    async function* cancelledStream() {
      yield makeCompletionsChunk({ content: content.slice(0, 30) });
      abort.abort();
      yield makeCompletionsChunk({ content: content.slice(30) }, "stop");
    }
    await expect(
      processCompletionsStream(
        cancelledStream(),
        output,
        model,
        { push: (event) => events.push(event as CapturedStreamEvent) },
        { signal: abort.signal },
      ),
    ).rejects.toThrow();
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
    expect(events.some((event) => event.type?.startsWith("toolcall_"))).toBe(false);
  });
});
