import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { isAmbiguousDeliveryTransportError } from "../delivery-recovery.shared.js";
import { OutboundDeliveryError } from "./deliver-types.js";
import {
  matrixOutboundForQueueTest,
  drainMatrixReconnect,
} from "./deliver.queue-integration.test-support.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import * as queueStorage from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));
vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;
const networkError = () => Object.assign(new Error("socket reset"), { code: "ECONNRESET" });

describe("saved ordinary final text delivery", () => {
  const state = installDeliveryQueueTmpDirHooks();
  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir());
    sleepMock.mockReset().mockResolvedValue(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });
  function deliver(
    send: ReturnType<typeof vi.fn>,
    overrides: Partial<Parameters<typeof deliverOutboundPayloads>[0]> = {},
  ) {
    return deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Saved **answer**" }],
      deps: { matrix: send },
      queuePolicy: "required",
      retryAmbiguousFinalText: true,
      ...overrides,
    });
  }
  it.each(["startup", "reconnect"] as const)(
    "%s scan leaves the producer claim alone while enqueue reply is pending",
    async (mode) => {
      const admitted = createDeferredCore();
      const writerReply = createDeferredCore();
      const inspected = createDeferredCore();
      const releaseInspection = createDeferredCore();
      const enqueue = queueStorage.enqueueDelivery;
      const load = queueStorage.loadUnfinishedDelivery;
      const enqueueSpy = vi
        .spyOn(queueStorage, "enqueueDelivery")
        .mockImplementation(async (...args) => {
          const id = await enqueue(...args);
          admitted.resolve();
          await writerReply.promise;
          return id;
        });
      const loadSpy = vi
        .spyOn(queueStorage, "loadUnfinishedDelivery")
        .mockImplementation(async (...args) => {
          const row = await load(...args);
          inspected.resolve();
          await releaseInspection.promise;
          return row;
        });
      const send = vi.fn().mockResolvedValue({ messageId: "live" });
      const delivery = deliver(send, { retryAmbiguousFinalText: undefined });
      const observed = delivery.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await admitted.promise;
      const replay = vi.fn(async () => []);
      const recovery =
        mode === "startup"
          ? recoverPendingDeliveries({
              cfg: {},
              stateDir: state.tmpDir(),
              deliver: replay,
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            })
          : drainMatrixReconnect({ stateDir: state.tmpDir(), deliver: replay });
      try {
        await Promise.race([inspected.promise, recovery]);
        writerReply.resolve();
        expect(await observed).toMatchObject({ value: [{ messageId: "live" }] });
        expect(send).toHaveBeenCalledTimes(1);
        expect(replay).not.toHaveBeenCalled();
      } finally {
        writerReply.resolve();
        releaseInspection.resolve();
        await Promise.allSettled([delivery, recovery]);
        enqueueSpy.mockRestore();
        loadSpy.mockRestore();
      }
    },
  );
  it("keeps the caller pending until one saved-text retry finishes", async () => {
    const started = createDeferredCore();
    const result = createDeferredCore<{ messageId: string }>();
    const send = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockImplementationOnce(async () => {
        started.resolve();
        return await result.promise;
      });
    const delivery = deliver(send);
    const observed = delivery.then(
      () => "settled",
      () => "settled",
    );
    try {
      expect(await Promise.race([started.promise.then(() => "retry"), observed])).toBe("retry");
      expect(await loadPendingDeliveries(state.tmpDir())).toMatchObject([{ attemptCount: 2 }]);
      expect(send.mock.calls.map((call) => call[1])).toEqual([
        "Saved **answer**",
        "Saved **answer**",
      ]);
    } finally {
      result.resolve({ messageId: "retry-final" });
    }
    await expect(delivery).resolves.toMatchObject([{ messageId: "retry-final" }]);
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });
  it("recovers the same saved text after the live owner stops, within the original budget", async () => {
    const controller = new AbortController();
    sleepMock.mockImplementationOnce(async () => {
      controller.abort();
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({ messageId: "after-restart" });
    await expect(deliver(send, { abortSignal: controller.signal })).rejects.toThrow("socket reset");
    const [pending] = await loadPendingDeliveries(state.tmpDir());
    expect(pending).toMatchObject({
      retryAmbiguousFinalText: true,
      ambiguousTransportError: true,
      attemptCount: 1,
    });
    setQueuedEntryState(state.tmpDir(), pending.id, {
      retryCount: 1,
      lastAttemptAt: Date.now() - 60_000,
    });
    const summary = await recoverPendingDeliveries({
      cfg: {},
      stateDir: state.tmpDir(),
      deliver: (params) => deliverOutboundPayloads({ ...params, deps: { matrix: send } }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(summary.recovered).toBe(1);
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "Saved **answer**",
      "Saved **answer**",
    ]);
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });
  it("exhausts two total attempts without a later restart replay", async () => {
    const send = vi.fn().mockRejectedValue(networkError());
    await expect(deliver(send)).rejects.toThrow("socket reset");
    expect(send).toHaveBeenCalledTimes(2);
    const replay = vi.fn(async () => []);
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: state.tmpDir(),
      deliver: replay,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(replay).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });
  it.each([
    { name: "no opt-in", payloads: [{ text: "plain" }], retryAmbiguousFinalText: undefined },
    {
      name: "media",
      payloads: [{ text: "photo", mediaUrl: "https://example.com/photo.png" }],
      retryAmbiguousFinalText: true,
    },
    {
      name: "controls",
      payloads: [{ text: "choose", channelData: { buttons: [["yes"]] } }],
      retryAmbiguousFinalText: true,
    },
    {
      name: "multiple payloads",
      payloads: [{ text: "one" }, { text: "two" }],
      retryAmbiguousFinalText: true,
    },
  ] as const)("does not replay $name", async ({ payloads, retryAmbiguousFinalText }) => {
    const send = vi.fn().mockRejectedValue(networkError());
    await expect(
      deliver(send, { payloads: [...payloads] as ReplyPayload[], retryAmbiguousFinalText }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("refuses typed resets with accepted partial or identityless evidence", () => {
    expect(isAmbiguousDeliveryTransportError(networkError())).toBe(true);
    expect(
      isAmbiguousDeliveryTransportError(
        new OutboundDeliveryError("partial", {
          cause: networkError(),
          results: [{ channel: "matrix", messageId: "accepted" }],
        }),
      ),
    ).toBe(false);
    expect(
      isAmbiguousDeliveryTransportError(
        new OutboundDeliveryError("identityless", {
          cause: networkError(),
          payloadOutcomes: [
            { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          ],
        }),
      ),
    ).toBe(false);
  });
  it("does not infer a network failure from prose", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Network request failed for sendMessage"));
    await expect(deliver(send)).rejects.toThrow("Network request failed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rechecks live authority after recovery backoff", async () => {
    let admitted = true;
    sleepMock.mockImplementationOnce(async () => {
      admitted = false;
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({ messageId: "wrong" });
    await expect(
      deliver(send, {
        assertDirectAdapterHandoff: () => {
          if (!admitted) {
            throw new Error("runtime changed");
          }
        },
      }),
    ).rejects.toThrow("runtime changed");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
