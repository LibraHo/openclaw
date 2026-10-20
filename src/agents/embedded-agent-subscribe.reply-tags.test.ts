// Reply-tag tests cover streaming directive parsing for reply_to markers across
// block replies and partial reply chunks.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession reply tags", () => {
  type ReplyPayload = { text?: string; replyToCurrent?: boolean; replyToTag?: boolean };

  function replyPayloadAt(mock: ReturnType<typeof vi.fn>, index: number): ReplyPayload {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected reply payload at index ${index}`);
    }
    return call[0] as ReplyPayload;
  }

  function replyTexts(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map(([payload]) => (payload as ReplyPayload).text ?? "");
  }

  function lastReplyPayload(mock: ReturnType<typeof vi.fn>): ReplyPayload {
    return replyPayloadAt(mock, mock.mock.calls.length - 1);
  }

  function createBlockReplyHarness() {
    // Small chunk sizes force directive-only and text chunks through the block
    // reply path where reply metadata must be preserved.
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    return { emit, onBlockReply, subscription };
  }

  it("carries reply_to_current across tag-only block chunks", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_current]]\nHello" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]\nHello" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = replyPayloadAt(onBlockReply, 0);
    expect(payload.text).toBe("Hello");
    expect(payload.replyToCurrent).toBe(true);
    expect(payload.replyToTag).toBe(true);
  });

  it("flushes trailing directive tails on stream end", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello [[" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello [[" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(replyTexts(onBlockReply)).toEqual(["Hello", " [["]);
    expect(replyTexts(onBlockReply).join("")).toBe("Hello [[");
  });

  it("streams partial replies past reply_to tags split across chunks", () => {
    // Split tags are buffered until complete so partial replies never expose raw
    // directive syntax.
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to:1897" });
    emitAssistantTextDelta({ emit, delta: "]] Hello" });
    emitAssistantTextDelta({ emit, delta: " world" });
    emitAssistantTextEnd({ emit });

    expect(lastReplyPayload(onPartialReply).text).toBe("Hello world");
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });

  it("strips a malformed reply prefix when the stream ends", () => {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_" });
    emitAssistantTextDelta({ emit, delta: "current] Visible reply" });
    emitAssistantTextEnd({ emit });

    const payload = lastReplyPayload(onPartialReply);
    expect(payload.text).toBe("Visible reply");
    expect(payload.replyToCurrent).toBeUndefined();
    expect(payload.replyToTag).toBeUndefined();
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });

  it("strips a malformed reply prefix from the final block reply", async () => {
    const { emit, onBlockReply, subscription } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_" });
    emitAssistantTextDelta({ emit, delta: "current] Visible reply" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current] Visible reply" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = replyPayloadAt(onBlockReply, 0);
    expect(payload.text).toBe("Visible reply");
    expect(payload.replyToCurrent).toBeFalsy();
    expect(payload.replyToTag).toBeFalsy();
    expect(payload.text).not.toContain("[[reply_to");
  });

  it.each([
    { suffix: " More [[reply_to_current]] text.", expected: "Intro. More text." },
    {
      suffix: "\n\n[label]: https://example.com",
      expected: "Intro.\n\n[label]: https://example.com",
    },
    { suffix: "\nMEDIA:/tmp/example.png\n", expected: "Intro." },
    {
      suffix: "\n\n```text\n[[reply_to_current]] literal\n```",
      expected: "Intro.\n\n```text\n[[reply_to_current]] literal\n```",
    },
  ])("keeps canonical reply parsing after a settled tag: $suffix", ({ suffix, expected }) => {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "tagged-stream-context",
      onPartialReply,
    });
    try {
      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta({ emit, delta: "[[reply_to_current]] Intro." });
      for (let start = 0; start < suffix.length; start += 4) {
        emitAssistantTextDelta({ emit, delta: suffix.slice(start, start + 4) });
      }
      emitAssistantTextEnd({ emit });
      expect(lastReplyPayload(onPartialReply).text).toBe(expected);
    } finally {
      subscription.unsubscribe();
    }
  });

  it("streams a long reply-tagged answer without blocking delivery", () => {
    const body = `${"Paragraph with `code` and **bold** text.\n\n- item `one`\n- item two\n\n".repeat(100)}\`\`\`ts\nconst x = 1;\n\`\`\`\n\nDone.`;
    const text = `[[reply_to_current]] Intro.\n\n${body}`;
    const { session, emit } = createStubSessionHarness();
    let lastText = "";
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "tagged-stream-performance",
      onPartialReply: (payload) => {
        lastText = payload.text ?? "";
      },
    });
    try {
      emit({ type: "message_start", message: { role: "assistant" } });
      const started = performance.now();
      for (let start = 0; start < text.length; start += 40) {
        emitAssistantTextDelta({ emit, delta: text.slice(start, start + 40) });
      }
      const elapsed = performance.now() - started;
      console.log(
        JSON.stringify({
          benchmark: "reply-tagged-stream",
          chars: text.length,
          elapsedMs: elapsed,
          rssBytes: process.memoryUsage().rss,
        }),
      );
      expect(lastText).toBe(`Intro.\n\n${body}`);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      subscription.unsubscribe();
    }
  });
});
