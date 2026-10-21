import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveTelegramTransport } from "./fetch.js";
import { isSafeToRetrySendError, TelegramRequestNotStartedError } from "./network-errors.js";

beforeEach(() => {
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_URL",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["explicit", "refused"],
  ["environment", "refused"],
  ["explicit", "tunnel-reset"],
  ["environment", "tunnel-reset"],
  ["explicit", "accepted-then-reset"],
  ["environment", "accepted-then-reset"],
] as const)("%s proxy classifies %s at the real CONNECT boundary", async (mode, failure) => {
  const sockets = new Set<Socket>();
  let connects = 0;
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (_request, socket) => {
    connects += 1;
    if (failure === "refused") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
    } else if (failure === "tunnel-reset") {
      socket.destroy();
    } else {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      void setImmediate().then(() => socket.destroy());
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv(mode === "explicit" ? "OPENCLAW_PROXY_URL" : "HTTPS_PROXY", proxyUrl);
  const transport = resolveTelegramTransport(undefined, {
    network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
  });
  try {
    const caught = await transport
      .fetch("https://api.telegram.invalid/bot123:fixture/sendMessage")
      .then(
        () => {
          throw new Error("Expected the proxy fixture to reject the send");
        },
        (error: unknown) => error,
      );
    if (failure === "accepted-then-reset") {
      expect(caught).not.toBeInstanceOf(TelegramRequestNotStartedError);
      expect(isSafeToRetrySendError(caught)).toBe(false);
    } else {
      expect(caught).toBeInstanceOf(TelegramRequestNotStartedError);
      expect(isSafeToRetrySendError(caught)).toBe(true);
      expect((caught as Error).cause).toBeInstanceOf(Error);
    }
    expect(connects).toBe(1);
  } finally {
    await transport.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
