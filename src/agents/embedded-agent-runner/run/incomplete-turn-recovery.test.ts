import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text: "" }],
    ...overrides,
  });
}

function emptyAttempt(assistant = emptyAssistant()) {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

describe("incomplete-turn recovery policy", () => {
  it.each([
    {
      name: "zero-token Anthropic stop",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      modelApi: "messages",
      assistant: buildEmbeddedRunnerAssistant({
        provider: "anthropic",
        model: "claude-opus-4.7",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    },
    {
      name: "Anthropic-compatible positive-output stop",
      provider: "sub2api",
      modelId: "claude-opus-4-7",
      modelApi: "anthropic-messages",
      assistant: emptyAssistant({
        api: "anthropic-messages",
        provider: "sub2api",
        model: "claude-opus-4-7",
        usage: {
          input: 2048,
          output: 3100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5148,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    },
    {
      name: "generic empty Gemini turn",
      provider: "google-vertex",
      modelId: "google/gemini-3.1-flash",
      modelApi: undefined,
      assistant: emptyAssistant({
        stopReason: "stop",
        provider: "google-vertex",
        model: "gemini-3.1-flash",
      }),
    },
  ])(
    "returns the visible-answer prompt for $name",
    ({ provider, modelId, modelApi, assistant }) => {
      expect(
        resolveEmptyResponseRetryInstruction({
          provider,
          modelId,
          modelApi,
          payloadCount: 0,
          aborted: false,
          timedOut: false,
          attempt: emptyAttempt(assistant),
        }),
      ).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    },
  );

  it("does not retry an empty turn after side effects", () => {
    const assistant = emptyAssistant({ stopReason: "stop", model: "gpt-5.4" });
    const attempt = emptyAttempt(assistant);
    attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };

    expect(
      resolveEmptyResponseRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("returns the reasoning continuation for Kimi Anthropic reasoning-only output", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "kimi",
      model: "kimi-for-coding",
      content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
    });

    expect(
      resolveReasoningOnlyRetryInstruction({
        provider: "kimi",
        modelId: "kimi-for-coding",
        modelApi: "anthropic-messages",
        aborted: false,
        timedOut: false,
        attempt: emptyAttempt(assistant),
      }),
    ).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  const silentPostToolCases: Array<{
    name: string;
    attemptOverrides?: Partial<ReturnType<typeof makeEmbeddedRunnerAttempt>>;
    params?: Partial<Omit<Parameters<typeof shouldTreatEmptyAssistantReplyAsSilent>[0], "attempt">>;
    required?: boolean;
    optional?: boolean;
  }> = [
    { name: "successful explicit NO_REPLY", required: true, optional: true },
    {
      name: "explicit-only silence",
      params: { onlyExplicitSilentReply: true },
      required: true,
      optional: true,
    },
    { name: "silence disabled", params: { allowEmptyAssistantReplyAsSilent: false } },
    { name: "visible payload", params: { payloadCount: 1 } },
    { name: "visible final answer", attemptOverrides: { assistantTexts: ["Check completed."] } },
    {
      name: "mixed visible and silent text",
      attemptOverrides: { assistantTexts: [SILENT_REPLY_TOKEN, "Check completed."] },
    },
    {
      name: "genuine missing final answer",
      attemptOverrides: { assistantTexts: [] },
      optional: true,
    },
    {
      name: "explicit-only missing final answer",
      attemptOverrides: { assistantTexts: [] },
      params: { onlyExplicitSilentReply: true },
    },
    {
      name: "tool error",
      attemptOverrides: { lastToolError: { toolName: "exec", error: "command failed" } },
    },
    {
      name: "assistant error",
      attemptOverrides: { currentAttemptAssistant: emptyAssistant({ stopReason: "error" }) },
    },
    {
      name: "failed attempt",
      attemptOverrides: {
        terminal: { kind: "failed", source: "prompt", error: new Error("provider failed") },
      },
    },
    { name: "caller abort", params: { aborted: true } },
    { name: "timeout", params: { timedOut: true } },
    {
      name: "committed text delivery",
      attemptOverrides: { messagingToolSentTexts: ["Already sent."] },
    },
    {
      name: "committed media delivery",
      attemptOverrides: { messagingToolSentMediaUrls: ["https://example.com/test.png"] },
    },
    {
      name: "committed target delivery",
      attemptOverrides: {
        messagingToolSentTargets: [{ tool: "message", provider: "test", to: "test-target" }],
      },
    },
    {
      name: "accepted child spawn",
      attemptOverrides: {
        acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:test:child" }],
      },
    },
    {
      name: "pending client tools",
      attemptOverrides: { clientToolCalls: [{ name: "client-tool", params: {} }] },
    },
    { name: "yielded turn", attemptOverrides: { yieldDetected: true } },
    {
      name: "approval already requested",
      attemptOverrides: { didSendDeterministicApprovalPrompt: true },
    },
  ];

  it.each(silentPostToolCases)(
    "classifies $name without weakening required or optional post-tool guards",
    ({ attemptOverrides, params, required = false, optional = false }) => {
      const assistantTexts = attemptOverrides?.assistantTexts ?? [SILENT_REPLY_TOKEN];
      const assistant = emptyAssistant({
        content: [{ type: "text", text: assistantTexts.join("\n") }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts,
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "exec", toolCallId: "tool-1", replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        ...attemptOverrides,
      });
      for (const [terminalReplyExpectation, expected] of [
        ["required", required],
        ["optional", optional],
      ] as const) {
        expect(
          shouldTreatEmptyAssistantReplyAsSilent({
            allowEmptyAssistantReplyAsSilent: true,
            payloadCount: 0,
            aborted: false,
            timedOut: false,
            ...params,
            terminalReplyExpectation,
            attempt,
          }),
        ).toBe(expected);
      }
    },
  );

  it("treats reply-optional post-tool empty stops as silent after side effects", () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "required",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "tool failure",
      attempt: makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        toolMetas: [
          { toolName: "sessions", meta: "patch failed", replaySafe: false, isError: true },
        ],
        lastToolError: { toolName: "sessions", error: "patch failed" },
        lastAssistant: emptyAssistant(),
      }),
      aborted: false,
    },
    {
      name: "assistant error",
      attempt: emptyAttempt(emptyAssistant({ stopReason: "error" })),
      aborted: false,
    },
    {
      name: "caller abort",
      attempt: emptyAttempt(emptyAssistant({ stopReason: "error" })),
      aborted: true,
    },
  ])("does not treat $name as intentional silence", ({ attempt, aborted }) => {
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });
});
