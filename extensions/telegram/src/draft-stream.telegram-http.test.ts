import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Bot } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";

type ApiCall = { method: string; payload: Record<string, unknown> };

async function createHttpHarness() {
  const calls: ApiCall[] = [];
  const visibleMessages = new Map<number, string>();
  let nextMessageId = 0;
  const faults: { reject?: (call: ApiCall) => number | undefined } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const call = {
      method: request.url?.split("/").at(-1) ?? "",
      payload: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    };
    calls.push(call);
    const errorCode = faults.reject?.(call);
    response.setHeader("content-type", "application/json");
    if (errorCode !== undefined) {
      response.statusCode = errorCode;
      response.end(
        JSON.stringify({ ok: false, error_code: errorCode, description: "Injected rejection" }),
      );
      return;
    }
    let result: unknown = true;
    if (call.method === "sendMessage") {
      const messageId = ++nextMessageId;
      visibleMessages.set(messageId, String(call.payload.text));
      result = {
        message_id: messageId,
        date: 0,
        chat: { id: 123, type: "private" },
        text: call.payload.text,
      };
    } else if (call.method === "editMessageText") {
      visibleMessages.set(Number(call.payload.message_id), String(call.payload.text));
    } else if (call.method === "deleteMessage") {
      visibleMessages.delete(Number(call.payload.message_id));
    }
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // A synthetic token and a loopback-only API root never contact Telegram.
  const bot = new Bot("123456:test-token", { client: { apiRoot: `http://127.0.0.1:${port}` } });
  const stream = createTelegramDraftStream({ api: bot.api, chatId: 123, throttleMs: 250 });
  return {
    calls,
    faults,
    visibleMessages,
    stream,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

describe("Telegram draft stream through the grammY HTTP transport", () => {
  let http: Awaited<ReturnType<typeof createHttpHarness>> | undefined;
  afterEach(async () => {
    await http?.stream.discard?.();
    await http?.close();
    http = undefined;
  });

  it.each([502, 503])(
    "keeps and completes the same preview after an HTTP %s edit rejection",
    async (errorCode) => {
      http = await createHttpHarness();
      const { stream, calls, faults, visibleMessages } = http;
      let rejected = false;
      faults.reject = (call) => {
        if (call.method === "editMessageText" && !rejected) {
          rejected = true;
          return errorCode;
        }
        return undefined;
      };
      stream.update("Visible initial answer");
      await stream.flush();
      stream.update("Visible completed answer");
      await stream.flush();
      expect(rejected).toBe(true);
      expect([...visibleMessages]).toEqual([[1, "Visible initial answer"]]);
      await stream.stop();
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
      expect([...visibleMessages]).toEqual([[1, "Visible completed answer"]]);
    },
  );

  it("does not replay an ambiguous HTTP 503 first send", async () => {
    http = await createHttpHarness();
    const { stream, calls, faults } = http;
    faults.reject = () => 503;
    stream.update("First preview");
    await stream.flush();
    await stream.stop();
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(stream.sendMayHaveLanded?.()).toBe(true);
  });

  it("preserves the only visible preview when a replacement is rejected and cleans up on clear", async () => {
    http = await createHttpHarness();
    const { stream, calls, faults, visibleMessages } = http;
    stream.update("Visible answer preview");
    await stream.flush();
    // Age only the dwell clock; actual HTTP and cleanup timers remain real.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10_000);
    try {
      stream.rotateToNewMessageDeferringDelete();
      faults.reject = (call) => (call.method === "sendMessage" ? 403 : undefined);
      stream.update("Replacement preview");
      await stream.flush();
      await stream.stop();
      await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
      expect([...visibleMessages]).toEqual([[1, "Visible answer preview"]]);
      expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);
      await stream.clear();
      await vi.waitFor(() => expect(visibleMessages.size).toBe(0), { timeout: 2_500 });
      expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
