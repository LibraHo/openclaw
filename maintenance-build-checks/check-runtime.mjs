import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

assert.equal(JSON.parse(fs.readFileSync("/app/package.json", "utf8")).version, "2026.8.35");
assert.equal(process.version, "v24.15.0", "Keep the user's existing Node 24.15 runtime");
const buildInfo = JSON.parse(fs.readFileSync("/app/dist/build-info.json", "utf8"));
assert.ok(buildInfo.buildId.startsWith("2026.8.35-E-"), "Missing custom E build identity");
const openAIManifest = JSON.parse(
  fs.readFileSync("/app/dist/extensions/openai/openclaw.plugin.json", "utf8"),
);
const terra = openAIManifest.modelCatalog.providers.openai.models.find(
  (model) => model.id === "gpt-6.1-terra",
);
assert.ok(terra, "Terra must be packaged in its owning provider manifest");
assert.equal(terra.contextWindow, 1_050_000);
assert.equal(terra.maxTokens, 128_000);
assert.deepEqual(terra.compat.supportedReasoningEfforts, [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
assert.equal(terra.thinkingLevelMap.off, "none");
const html = fs.readFileSync("/app/dist/control-ui/index.html", "utf8");
const styles = [...html.matchAll(/href="([^"]+\.css)"/gu)].map((match) => match[1]);
assert.equal(styles.length, 1, "Preserve the existing main UI stylesheet");
const uiStyleSha256 = createHash("sha256")
  .update(fs.readFileSync(`/app/dist/control-ui/${styles[0]}`))
  .digest("hex");
assert.equal(
  uiStyleSha256,
  "7260d6cd5c7ca5d18b78711646afdb0ecb7ee2c1f1a49d37316540f2670f70e3",
  "Do not replace the running C UI's stylesheet",
);
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
    node: process.version,
    terra: "packaged",
    uiStyleSha256,
    policyCases: 30,
  }),
);
