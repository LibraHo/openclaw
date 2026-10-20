import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

assert.equal(JSON.parse(fs.readFileSync("/app/package.json", "utf8")).version, "2026.8.35");
const buildInfo = JSON.parse(fs.readFileSync("/app/dist/build-info.json", "utf8"));
assert.ok(buildInfo.buildId.startsWith("2026.8.35-C-"), "Missing custom C build identity");
fs.accessSync("/usr/local/bin/docker-entrypoint-custom.sh", fs.constants.X_OK);

const codexRoot = "/app/dist/extensions/codex/";
assert.equal(JSON.parse(fs.readFileSync(`${codexRoot}package.json`, "utf8")).version, "2026.8.35");

// Inspect the actual compiled policy, without adding a production export or mounting user state.
const modules = fs
  .readdirSync("/app/dist")
  .filter(
    (name) =>
      name.endsWith(".js") &&
      fs
        .readFileSync(`/app/dist/${name}`, "utf8")
        .includes("function shouldTreatEmptyAssistantReplyAsSilent("),
  );
assert.equal(modules.length, 1, "Locate unique compiled recovery policy");
const target = pathToFileURL(`/app/dist/${modules[0]}`).href;
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    return url === target
      ? {
          ...result,
          source: `${result.source}\nexport {shouldTreatEmptyAssistantReplyAsSilent as customBuildPolicy};`,
        }
      : result;
  },
});
const { customBuildPolicy: policy } = await import(target);
const assistant = { stopReason: "stop", content: [{ type: "text", text: "NO_REPLY" }] };
const base = () => ({
  allowEmptyAssistantReplyAsSilent: true,
  onlyExplicitSilentReply: true,
  terminalReplyExpectation: "required",
  payloadCount: 0,
  aborted: false,
  timedOut: false,
  attempt: {
    assistantTexts: ["NO_REPLY"],
    currentAttemptAssistant: assistant,
    lastAssistant: assistant,
    terminal: { kind: "completed" },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    acceptedSessionSpawns: [],
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
  },
});
for (const expectation of ["required", "optional"]) {
  const params = base();
  params.terminalReplyExpectation = expectation;
  assert.equal(policy(params), true, `${expectation}: tool-following NO_REPLY remains silent`);
  for (const [label, edit] of [
    [
      "abort",
      (p) => {
        p.aborted = true;
      },
    ],
    [
      "timeout",
      (p) => {
        p.timedOut = true;
      },
    ],
    [
      "disabled",
      (p) => {
        p.allowEmptyAssistantReplyAsSilent = false;
      },
    ],
    [
      "payload",
      (p) => {
        p.payloadCount = 1;
      },
    ],
    [
      "visible",
      (p) => {
        p.attempt.assistantTexts = ["Visible"];
      },
    ],
    [
      "missing",
      (p) => {
        p.attempt.assistantTexts = [];
      },
    ],
    [
      "tool-error",
      (p) => {
        p.attempt.lastToolError = { toolName: "exec", error: "failed" };
      },
    ],
    [
      "assistant-error",
      (p) => {
        p.attempt.currentAttemptAssistant = { ...assistant, stopReason: "error" };
      },
    ],
    [
      "failed",
      (p) => {
        p.attempt.terminal = { kind: "failed" };
      },
    ],
    [
      "delivery",
      (p) => {
        p.attempt.messagingToolSentTexts = ["Already sent"];
      },
    ],
    [
      "spawn",
      (p) => {
        p.attempt.acceptedSessionSpawns = [{ runId: "child", childSessionKey: "agent:main:test" }];
      },
    ],
    [
      "pending-client-tool",
      (p) => {
        p.attempt.clientToolCalls = [{}];
      },
    ],
    [
      "yield",
      (p) => {
        p.attempt.yieldDetected = true;
      },
    ],
    [
      "approval",
      (p) => {
        p.attempt.didSendDeterministicApprovalPrompt = true;
      },
    ],
  ]) {
    const protectedParams = base();
    protectedParams.terminalReplyExpectation = expectation;
    edit(protectedParams);
    assert.equal(policy(protectedParams), false, `${expectation}: ${String(label)} protection`);
  }
}
const { default: plugin } = await import(`${codexRoot}index.js`);
assert.equal(plugin.id, "codex");
assert.ok(plugin.reload?.noopPrefixes?.includes("plugins.entries.codex.config.codexPlugins"));
console.log(
  JSON.stringify({
    check: "custom-runtime",
    version: buildInfo.version,
    buildId: buildInfo.buildId,
    codex: "imported",
    policyCases: 30,
  }),
);
