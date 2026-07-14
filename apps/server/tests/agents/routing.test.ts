/**
 * Per-agent model-routing loader tests (T136, D19/FR-001) — deterministic, no
 * network, no real API keys.
 *
 * These pin the ROUTING LOGIC of {@link createModelRouter} through two injectable
 * seams so no test ever imports real provider network behaviour:
 *  - `resolveModel` — a recording resolver captures the exact `{provider, model,
 *    baseUrl}` route each role is resolved for (and proves per-role caching);
 *  - `providerFactories` — fake factories count how often each provider is built,
 *    proving provider instances are cached per provider (and per baseUrl for the
 *    openai-compatible provider) and that `baseUrl`/`apiKey` thread through.
 *
 * Construction-time validation is fail-fast: a used provider whose key is absent
 * raises {@link MissingProviderKeyError}, and an `openai-compatible` route with no
 * `baseUrl` raises {@link MissingBaseUrlError} — both at build time, not first use.
 * A single test exercises the REAL default factories (with throwaway keys) to prove
 * the production wiring constructs models without a network call.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { LanguageModel } from "ai";
import { MODEL_ROLES } from "../../src/config/schema.js";
import type { ModelRoute, ModelRoutingTable } from "../../src/config/schema.js";
import {
  createModelRouter,
  MissingBaseUrlError,
  MissingProviderKeyError,
} from "../../src/agents/routing.js";
import type {
  KeyedProviderOptions,
  OpenAICompatibleProviderOptions,
  ProviderFactories,
  ProviderInstance,
} from "../../src/agents/routing.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** One route per role, each on a distinct provider (covers all five). */
const FULL_TABLE: ModelRoutingTable = {
  supervisor: { provider: "anthropic", model: "claude-sonnet-4-5" },
  scaffolding: { provider: "openai", model: "gpt-5.1" },
  planning: { provider: "gemini", model: "gemini-2.5-pro" },
  implementation: { provider: "openrouter", model: "meta-llama/llama-3.1-70b" },
  review: {
    provider: "openai-compatible",
    model: "qwen2.5-coder",
    baseUrl: "http://localhost:11434/v1",
  },
};

/** anthropic used by three roles, openai by two — for provider-instance caching. */
const SHARED_TABLE: ModelRoutingTable = {
  supervisor: { provider: "anthropic", model: "claude-super" },
  scaffolding: { provider: "openai", model: "gpt-scaffold" },
  planning: { provider: "openai", model: "gpt-plan" },
  implementation: { provider: "anthropic", model: "claude-impl" },
  review: { provider: "anthropic", model: "claude-review" },
};

/** Five openai-compatible routes across two baseUrls — for per-baseUrl caching. */
const COMPAT_TABLE: ModelRoutingTable = {
  supervisor: { provider: "openai-compatible", model: "m-super", baseUrl: "http://alpha/v1" },
  scaffolding: { provider: "openai-compatible", model: "m-scaffold", baseUrl: "http://alpha/v1" },
  planning: { provider: "openai-compatible", model: "m-plan", baseUrl: "http://beta/v1" },
  implementation: { provider: "openai-compatible", model: "m-impl", baseUrl: "http://beta/v1" },
  review: { provider: "openai-compatible", model: "m-review", baseUrl: "http://beta/v1" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

type KeyedProviderKind = "anthropic" | "openai" | "gemini" | "openrouter";

/** A fake factory map that records every build call and returns tagged mocks. */
interface RecordingFactories {
  readonly factories: ProviderFactories;
  readonly keyedCalls: Record<KeyedProviderKind, readonly KeyedProviderOptions[]>;
  readonly compatCalls: readonly OpenAICompatibleProviderOptions[];
}

/** Build fake provider factories that count builds and thread the model id. */
function makeRecordingFactories(): RecordingFactories {
  const keyedCalls: Record<KeyedProviderKind, KeyedProviderOptions[]> = {
    anthropic: [],
    openai: [],
    gemini: [],
    openrouter: [],
  };
  const compatCalls: OpenAICompatibleProviderOptions[] = [];

  const keyed =
    (kind: KeyedProviderKind) =>
    (options: KeyedProviderOptions): ProviderInstance => {
      keyedCalls[kind].push(options);
      return (modelId) => new MockLanguageModelV4({ modelId, provider: kind });
    };

  const factories: ProviderFactories = {
    anthropic: keyed("anthropic"),
    openai: keyed("openai"),
    gemini: keyed("gemini"),
    openrouter: keyed("openrouter"),
    "openai-compatible": (options: OpenAICompatibleProviderOptions): ProviderInstance => {
      compatCalls.push(options);
      return (modelId) => new MockLanguageModelV4({ modelId, provider: options.name });
    },
  };

  return { factories, keyedCalls, compatCalls };
}

/** Read the route a recording `resolveModel` mock was called with at `index`. */
function routeAt(mock: Mock<(route: ModelRoute) => LanguageModel>, index: number): ModelRoute {
  const call = mock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`expected a resolveModel call at index ${String(index)}`);
  }
  return call[0];
}

/** Narrow a resolved `LanguageModel` to its mock model id, or fail loudly. */
function mockModelId(model: LanguageModel): string {
  if (!(model instanceof MockLanguageModelV4)) {
    throw new Error("expected a MockLanguageModelV4");
  }
  return model.modelId;
}

/** Run `fn`, returning whatever it threw (or failing if it did not throw). */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the function to throw");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createModelRouter", () => {
  it("resolves each role to the LanguageModel its config specifies", () => {
    const produced: LanguageModel[] = [];
    const resolveModel = vi.fn<(route: ModelRoute) => LanguageModel>((route) => {
      const model = new MockLanguageModelV4({ modelId: route.model });
      produced.push(model);
      return model;
    });

    const router = createModelRouter({ routing: FULL_TABLE, apiKeys: {}, resolveModel });

    // The resolver is asked once per role, in MODEL_ROLES order, with the exact
    // {provider, model, baseUrl} route configured for that role.
    expect(resolveModel).toHaveBeenCalledTimes(MODEL_ROLES.length);
    MODEL_ROLES.forEach((role, index) => {
      expect(routeAt(resolveModel, index)).toEqual(FULL_TABLE[role]);
    });

    // Each role returns exactly the model produced for its route (cached identity).
    MODEL_ROLES.forEach((role, index) => {
      expect(router.model(role)).toBe(produced[index]);
    });

    // Reading a role again does not re-resolve — the model is cached.
    router.model("supervisor");
    expect(resolveModel).toHaveBeenCalledTimes(MODEL_ROLES.length);
  });

  it("caches one provider instance per keyed provider", () => {
    const { factories, keyedCalls } = makeRecordingFactories();

    const router = createModelRouter({
      routing: SHARED_TABLE,
      apiKeys: { anthropic: "ka", openai: "ko" },
      providerFactories: factories,
    });

    // Three anthropic roles + two openai roles build exactly one provider each.
    expect(keyedCalls.anthropic).toHaveLength(1);
    expect(keyedCalls.openai).toHaveLength(1);
    expect(keyedCalls.gemini).toHaveLength(0);
    expect(keyedCalls.openrouter).toHaveLength(0);

    // The single injected key reaches the factory.
    expect(keyedCalls.anthropic[0]?.apiKey).toBe("ka");

    // Model ids still thread per role even though the provider is shared.
    expect(mockModelId(router.model("supervisor"))).toBe("claude-super");
    expect(mockModelId(router.model("implementation"))).toBe("claude-impl");

    // Repeated access does not rebuild the provider.
    router.model("review");
    expect(keyedCalls.anthropic).toHaveLength(1);
  });

  it("threads the openai-compatible baseUrl through and caches per baseUrl", () => {
    const { factories, compatCalls } = makeRecordingFactories();

    const router = createModelRouter({
      routing: COMPAT_TABLE,
      apiKeys: { openaiCompatible: "kc" },
      providerFactories: factories,
    });

    // One factory build per distinct baseUrl (alpha, beta) — not one per role.
    expect(compatCalls.map((call) => call.baseURL)).toEqual(["http://alpha/v1", "http://beta/v1"]);
    // The injected openai-compatible key threads into every build.
    expect(compatCalls.every((call) => call.apiKey === "kc")).toBe(true);

    // Every role still resolves to its own model id through the shared instance.
    expect(mockModelId(router.model("supervisor"))).toBe("m-super");
    expect(mockModelId(router.model("review"))).toBe("m-review");
  });

  it("allows an openai-compatible route with no api key", () => {
    const { factories, compatCalls } = makeRecordingFactories();

    const router = createModelRouter({
      routing: COMPAT_TABLE,
      apiKeys: {},
      providerFactories: factories,
    });

    expect(compatCalls.every((call) => call.apiKey === undefined)).toBe(true);
    expect(mockModelId(router.model("planning"))).toBe("m-plan");
  });

  it("throws MissingProviderKeyError at construction when a used provider key is absent", () => {
    const { factories } = makeRecordingFactories();

    const build = (): unknown =>
      createModelRouter({
        routing: SHARED_TABLE,
        apiKeys: { openai: "ko" }, // anthropic (supervisor, first role) is missing
        providerFactories: factories,
      });

    expect(build).toThrow(MissingProviderKeyError);
    const error = captureError(build);
    expect(error).toBeInstanceOf(MissingProviderKeyError);
    if (error instanceof MissingProviderKeyError) {
      expect(error.provider).toBe("anthropic");
      expect(error.role).toBe("supervisor");
    }
  });

  it("throws MissingBaseUrlError when an openai-compatible route has no baseUrl", () => {
    const { factories } = makeRecordingFactories();
    const table: ModelRoutingTable = {
      ...COMPAT_TABLE,
      supervisor: { provider: "openai-compatible", model: "m-super" }, // baseUrl omitted
    };

    const build = (): unknown =>
      createModelRouter({
        routing: table,
        apiKeys: { openaiCompatible: "kc" },
        providerFactories: factories,
      });

    expect(build).toThrow(MissingBaseUrlError);
    const error = captureError(build);
    expect(error).toBeInstanceOf(MissingBaseUrlError);
    if (error instanceof MissingBaseUrlError) {
      expect(error.role).toBe("supervisor");
    }
  });

  it("builds real provider models through the default factories without a network call", () => {
    const router = createModelRouter({
      routing: FULL_TABLE,
      apiKeys: {
        anthropic: "sk-ant-test",
        openai: "sk-oai-test",
        google: "goog-test",
        openrouter: "or-test",
        openaiCompatible: "compat-test",
      },
    });

    for (const role of MODEL_ROLES) {
      // Constructing a real provider model is object construction only — no
      // request is issued until generate/stream, so this is deterministic.
      expect(router.model(role)).toBeTypeOf("object");
    }
  });
});
