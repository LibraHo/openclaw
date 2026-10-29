import { calculateCost } from "openclaw/plugin-sdk/llm";
import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { OPENAI_DEFAULT_MODEL } from "./default-models.js";
import { isOpenAIDualRouteModelId } from "./model-route-contract.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

const id = "gpt-6.1-terra";
const efforts = ["none", "low", "medium", "high", "xhigh", "max"];
const registry: ProviderResolveDynamicModelContext["modelRegistry"] = {
  find: () => undefined,
  getAll: () => [],
  getAvailable: () => [],
  hasConfiguredAuth: () => false,
};

describe("GPT-6.1 Terra", () => {
  it("declares its own capabilities without replacing existing model defaults", () => {
    const models = manifest.modelCatalog.providers.openai.models;
    expect(models.find((model) => model.id === id)).toMatchObject({
      name: "GPT-6.1 Terra",
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
      compat: { supportedReasoningEfforts: efforts, supportsTemperature: false },
    });
    expect(models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(OPENAI_DEFAULT_MODEL).toBe("openai/gpt-5.6-sol");
    expect(manifest.modelCatalog.providers.openai.defaultUtilityModel).toBe("gpt-5.6-luna");
  });

  it("offers distinct Responses API and subscription routes", () => {
    expect(isOpenAIDualRouteModelId(id)).toBe(true);
    const routes = resolveModelRoutes({ provider: "openai", modelId: id, env: {} });
    expect(routes.kind === "routes" ? routes.routes.map((route) => route.api) : []).toEqual([
      "openai-responses",
      "openai-chatgpt-responses",
    ]);
  });

  it.each(["openai-responses", "openai-chatgpt-responses"] as const)(
    "resolves the exact model metadata over %s without borrowing Sol pricing",
    (api) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: id,
        providerConfig: {
          api,
          baseUrl:
            api === "openai-responses"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api/codex",
          models: [],
        },
        modelRegistry: registry,
      });
      expect(model).toMatchObject({
        id,
        api,
        reasoning: true,
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
        compat: { supportedReasoningEfforts: efforts },
      });
    },
  );

  it.each([
    {
      promptTokens: 272_000,
      inputRate: 1,
      output: 0.005,
      cacheRead: 0.000025,
      cacheWrite: 0.000625,
    },
    {
      promptTokens: 272_001,
      inputRate: 2,
      output: 0.0075,
      cacheRead: 0.00005,
      cacheWrite: 0.00125,
    },
  ])(
    "prices the full request at $promptTokens prompt tokens",
    ({ promptTokens, inputRate, ...expected }) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: id,
        modelRegistry: registry,
      });
      expect(model).toBeDefined();
      if (!model) {
        throw new Error("Terra must resolve before pricing");
      }
      const usage = {
        input: promptTokens - 1_000,
        output: 1_000,
        cacheRead: 500,
        cacheWrite: 500,
        totalTokens: promptTokens + 1_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const cost = calculateCost(model, usage);
      expect(cost).toMatchObject(expected);
      expect(cost.input).toBeCloseTo((usage.input * inputRate) / 1_000_000);
    },
  );

  it.each(["openclaw", "codex", "auto"])("advertises only supported efforts on %s", (runtime) => {
    expect(resolveUnifiedOpenAIThinkingProfile(id, runtime)).toEqual({
      levels: ["off", "low", "medium", "high", "xhigh", "max"].map((level) => ({ id: level })),
      defaultLevel: "medium",
    });
  });

  it.each([
    { observed: [], expected: ["off"] },
    { observed: ["low", "high"], expected: ["off", "low", "high"] },
  ])("honors the explicit account effort list $observed", ({ observed, expected }) => {
    expect(
      resolveUnifiedOpenAIThinkingProfile(id, "codex", { supportedReasoningEfforts: observed }),
    ).toEqual({
      levels: expected.map((level) => ({ id: level })),
    });
  });

  it.each([{ observed: [] }, { observed: ["low", "high"] }])(
    "retains live registry limits and efforts $observed",
    ({ observed }) => {
      const registered = {
        id,
        name: "Account Terra",
        provider: "openai",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
        input: ["text" as const],
        cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
        compat: { supportedReasoningEfforts: observed },
      };
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: id,
        providerConfig: { api: "openai-chatgpt-responses", models: [] },
        modelRegistry: { ...registry, find: () => registered },
      });
      expect(model).toMatchObject({
        contextWindow: 200_000,
        maxTokens: 64_000,
        input: ["text"],
        compat: { supportedReasoningEfforts: observed },
      });
    },
  );
});
