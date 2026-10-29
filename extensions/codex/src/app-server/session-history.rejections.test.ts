import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { embeddedAgentLog, type AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexMirroredSessionHistory } from "./session-history.js";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-history-rejection-"));
  dirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  const messages: AgentMessage[] = [
    attachCodexMirrorIdentity(
      { role: "user", content: "Check once.", timestamp: 1 },
      "turn:prompt",
    ),
    attachCodexMirrorIdentity(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "exec", arguments: {} }],
        timestamp: 2,
      } as AgentMessage,
      "turn:tool:call:call",
    ),
    attachCodexMirrorIdentity(
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "exec",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 3,
      },
      "turn:tool:call:result",
    ),
  ];
  await fs.writeFile(
    sessionFile,
    [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session",
        cwd: dir,
        timestamp: "2026-10-29T00:00:00Z",
      },
      ...messages.map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index ? String(index - 1) : null,
        timestamp: "2026-10-29T00:00:00Z",
        message,
      })),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  return {
    sessionFile,
    sessionId: "session",
    mirroredMessages: messages,
    settledMessages: messages,
    turnId: "turn",
  };
}

describe("safe Codex history rejection diagnostics", () => {
  it("leaves an actually missing transcript empty without a failure diagnostic", async () => {
    const target = await fixture();
    await fs.unlink(target.sessionFile);
    const rejected = vi.fn();
    await expect(
      readCodexMirroredSessionHistory(
        target,
        (messages) => Array.from(messages),
        undefined,
        "native-evidence",
        rejected,
      ),
    ).resolves.toEqual([]);
    expect(rejected).not.toHaveBeenCalled();
  });

  it("does not trust a rejection reason attached to an unknown exception", async () => {
    const target = await fixture();
    const rejected = vi.fn();
    await expect(
      readCodexMirroredSessionHistory(
        target,
        () => {
          throw Object.assign(new Error("private-token"), { reason: "field_limit" });
        },
        undefined,
        "native-evidence",
        rejected,
      ),
    ).resolves.toBeUndefined();
    expect(rejected).toHaveBeenCalledExactlyOnceWith("history_read_failed");
  });

  it("distinguishes an actual access refusal without exposing its path", async () => {
    const target = await fixture();
    const rejected = vi.fn();
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("private-path/private-token"), { code: "EACCES" }),
    );
    await expect(
      readCodexMirroredSessionHistory(target, () => [], undefined, "native-evidence", rejected),
    ).resolves.toBeUndefined();
    expect(rejected).toHaveBeenCalledExactlyOnceWith("history_access_denied");
  });

  it("rejects malformed session headers separately from foreign history", async () => {
    const target = await fixture();
    await fs.writeFile(target.sessionFile, JSON.stringify({ type: "session", id: 42 }) + "\n");
    const rejected = vi.fn();
    await expect(
      readCodexMirroredSessionHistory(target, () => [], undefined, "native-evidence", rejected),
    ).resolves.toBeUndefined();
    expect(rejected).toHaveBeenCalledExactlyOnceWith("malformed_history");
  });
  it.each([
    { reason: "field_limit", messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] },
    {
      reason: "item_limit",
      messages: Array.from({ length: 201 }, () => ({ role: "user", content: "x" })),
    },
    {
      reason: "projection_limit",
      messages: Array.from({ length: 9 }, () => ({ role: "user", content: "x".repeat(64 * 1024) })),
    },
    {
      reason: "tool_pairing_rejected",
      messages: [{ role: "toolResult", toolCallId: "orphan", toolName: "exec", content: [] }],
    },
    {
      reason: "unsupported_content",
      messages: [{ role: "user", content: [{ type: "private-marker" }] }],
    },
  ])("retains the bounded $reason rejection", ({ reason, messages }) => {
    let failure: unknown;
    try {
      projectSettledCodexMessages(messages as AgentMessage[]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ reason });
  });

  it("does not mistake a consumer ENOENT for a missing transcript", async () => {
    const target = await fixture();
    const consume = vi.fn(() => {
      throw Object.assign(new Error("private-path/private-token"), { code: "ENOENT" });
    });
    const rejected = vi.fn();
    await expect(
      readCodexMirroredSessionHistory(target, consume, undefined, "native-evidence", rejected),
    ).resolves.toBeUndefined();
    expect(consume).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledExactlyOnceWith("history_read_failed");
  });

  it("logs an allowlisted provenance reason without raw exception or transcript data", async () => {
    const target = await fixture();
    const persisted = await fs.readFile(target.sessionFile, "utf8");
    await fs.writeFile(
      target.sessionFile,
      persisted.replace('"text":"done"', '"text":"private-token/provenance-drift"'),
    );
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    await expect(captureCodexSettledTurnFinalizationContext(target)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("codex settled-turn finalization context capture failed", {
      reason: "provenance_rejected",
      turnId: "turn",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(target.sessionFile);
  });
});
