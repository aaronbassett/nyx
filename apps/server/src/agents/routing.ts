/**
 * Per-agent model-routing loader (US1 — supervisor swarm, T136, D19/FR-001).
 *
 * The D19 routing table (`Config.modelRouting`, validated for shape in
 * `config/schema.ts`) maps each of the five agent roles to a `{provider, model,
 * baseUrl?}` route. This module is the LOADER that turns that static config into a
 * per-role Vercel AI SDK {@link LanguageModel}, using the v7 provider factories
 * (`createAnthropic`/`createOpenAI`/`createGoogle`/`createOpenRouter`/
 * `createOpenAICompatible`). Nothing here issues a network request — a provider
 * factory and a model handle are both pure object construction; a request is only
 * made when the caller drives generate/stream.
 *
 * Injectable seam (deterministic, key-free tests):
 *  - `apiKeys` supplies the per-provider credentials — the loader NEVER reads
 *    `process.env`; US1 wiring injects them from the resolved server secrets.
 *  - `providerFactories` overrides the five real SDK factories with fakes so tests
 *    assert build-count/caching and `baseUrl`/`apiKey` threading without the SDK.
 *  - `resolveModel` overrides the whole route → model step so tests can record the
 *    exact route each role is resolved for; when supplied it OWNS credential/route
 *    validation (the built-in key/baseUrl checks belong to the default pipeline).
 *
 * Fail-fast: every role's model is constructed at {@link createModelRouter} time
 * (like the config loader), so a used provider missing its key raises
 * {@link MissingProviderKeyError} — and an `openai-compatible` route missing its
 * `baseUrl` raises {@link MissingBaseUrlError} — at BUILD time, not first use.
 * Provider instances are cached per provider (per baseUrl for openai-compatible),
 * so two roles on one provider share a single factory build.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { MODEL_ROLES } from "../config/schema.js";
import type { ModelProvider, ModelRole, ModelRoute, ModelRoutingTable } from "../config/schema.js";

// ── Named errors ─────────────────────────────────────────────────────────────

/** Base for every routing-loader construction failure. Carries the offending role. */
export class ModelRoutingError extends Error {
  /** The agent role whose route could not be constructed. */
  readonly role: ModelRole;

  constructor(message: string, role: ModelRole) {
    super(message);
    this.name = "ModelRoutingError";
    this.role = role;
  }
}

/**
 * A role's provider requires an API key that was not supplied in `apiKeys`.
 * Raised at construction (fail-fast) so a misconfigured deployment never reaches
 * the first per-prompt call before failing.
 */
export class MissingProviderKeyError extends ModelRoutingError {
  /** The provider whose credential was absent. */
  readonly provider: ModelProvider;

  constructor(role: ModelRole, provider: ModelProvider) {
    super(`no API key supplied for provider "${provider}" (role "${role}")`, role);
    this.name = "MissingProviderKeyError";
    this.provider = provider;
  }
}

/**
 * An `openai-compatible` route did not carry the `baseUrl` its self-hosted /
 * OpenRouter endpoint requires. The config schema already guards this; this is
 * defence in depth for a table constructed by any other path.
 */
export class MissingBaseUrlError extends ModelRoutingError {
  constructor(role: ModelRole) {
    super(`the openai-compatible route for role "${role}" is missing a baseUrl`, role);
    this.name = "MissingBaseUrlError";
  }
}

// ── Injectable seam types ────────────────────────────────────────────────────

/**
 * Per-provider API keys. All optional: a provider is only required to have a key
 * when the routing table actually assigns a role to it. `google` backs the
 * `gemini` provider; `openaiCompatible` is optional even in use (a local vLLM /
 * Ollama endpoint may need none).
 */
export interface ModelApiKeys {
  readonly anthropic?: string;
  readonly openai?: string;
  readonly google?: string;
  readonly openrouter?: string;
  readonly openaiCompatible?: string;
}

/** A credentialed provider: maps a model id to a concrete {@link LanguageModel}. */
export type ProviderInstance = (modelId: string) => LanguageModel;

/** Options handed to a keyed (default-endpoint) provider factory. */
export interface KeyedProviderOptions {
  /** The provider's API key (required — presence checked before the call). */
  readonly apiKey: string;
}

/** Options handed to the `openai-compatible` factory (endpoint is mandatory). */
export interface OpenAICompatibleProviderOptions {
  /** A stable provider label for SDK provider metadata. */
  readonly name: string;
  /** The self-hosted / OpenRouter OpenAI-compatible endpoint (required). */
  readonly baseURL: string;
  /** The API key, or `undefined` when the endpoint needs none. */
  readonly apiKey: string | undefined;
}

/**
 * The five provider factories, one per D19 provider. Each returns a credentialed
 * {@link ProviderInstance}. Overridable so tests inject fakes; the default map
 * ({@link DEFAULT_PROVIDER_FACTORIES}) wraps the real v7 AI SDK factories.
 */
export interface ProviderFactories {
  readonly anthropic: (options: KeyedProviderOptions) => ProviderInstance;
  readonly openai: (options: KeyedProviderOptions) => ProviderInstance;
  readonly gemini: (options: KeyedProviderOptions) => ProviderInstance;
  readonly openrouter: (options: KeyedProviderOptions) => ProviderInstance;
  readonly "openai-compatible": (options: OpenAICompatibleProviderOptions) => ProviderInstance;
}

/** Dependencies for {@link createModelRouter}. */
export interface ModelRouterDeps {
  /** The D19 routing table (`Config.modelRouting`). */
  readonly routing: ModelRoutingTable;
  /** Per-provider API keys, injected from the resolved server secrets. */
  readonly apiKeys: ModelApiKeys;
  /** Optional override for the provider-factory map (default = real SDK). */
  readonly providerFactories?: Partial<ProviderFactories>;
  /**
   * Optional override for the whole route → model step. When supplied, the loader
   * uses it verbatim for every role and the built-in credential/baseUrl checks and
   * provider cache are bypassed — the resolver owns them.
   */
  readonly resolveModel?: (route: ModelRoute) => LanguageModel;
}

/** The loaded router: a per-role {@link LanguageModel} lookup. */
export interface ModelRouter {
  /** The configured, cached {@link LanguageModel} for `role` (D19). */
  model(role: ModelRole): LanguageModel;
}

// ── Default provider factories (real v7 AI SDK) ──────────────────────────────

/** A stable provider-metadata label for every Nyx openai-compatible endpoint. */
const OPENAI_COMPATIBLE_PROVIDER_NAME = "nyx-openai-compatible";

/**
 * The real v7 provider factories. Each call constructs a provider bound to its
 * credentials and returns its model-id callable — no network I/O occurs here.
 */
export const DEFAULT_PROVIDER_FACTORIES: ProviderFactories = {
  anthropic: ({ apiKey }) => createAnthropic({ apiKey }),
  openai: ({ apiKey }) => createOpenAI({ apiKey }),
  gemini: ({ apiKey }) => createGoogle({ apiKey }),
  openrouter: ({ apiKey }) => createOpenRouter({ apiKey }),
  "openai-compatible": ({ name, baseURL, apiKey }) =>
    // `exactOptionalPropertyTypes`: only pass `apiKey` when the endpoint has one.
    createOpenAICompatible(apiKey === undefined ? { name, baseURL } : { name, baseURL, apiKey }),
};

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Build the per-role model router from the D19 routing table (T136, FR-001).
 *
 * Constructs and caches every role's {@link LanguageModel} eagerly so any
 * misconfiguration surfaces at build time (fail-fast). Provider instances are
 * cached per provider — per baseUrl for `openai-compatible` — so roles sharing a
 * provider share one factory build. Pass `resolveModel` to bypass the default
 * factory + cache pipeline entirely (tests inject a recording resolver).
 *
 * @throws {MissingProviderKeyError} a used keyed provider has no API key.
 * @throws {MissingBaseUrlError} an `openai-compatible` route has no `baseUrl`.
 */
export function createModelRouter(deps: ModelRouterDeps): ModelRouter {
  // A custom resolver is adapted to the role-aware shape (it ignores the role);
  // otherwise the default factory + cache pipeline owns credential/route checks.
  const custom = deps.resolveModel;
  const resolve: RoleAwareResolver =
    custom !== undefined
      ? (route) => custom(route)
      : createDefaultResolver(deps.apiKeys, deps.providerFactories);

  const models = new Map<ModelRole, LanguageModel>();
  for (const role of MODEL_ROLES) {
    models.set(role, resolve(deps.routing[role], role));
  }

  return {
    model(role) {
      const model = models.get(role);
      if (model === undefined) {
        // Unreachable: MODEL_ROLES is the exhaustive key domain, populated above.
        throw new ModelRoutingError(`no model configured for role "${role}"`, role);
      }
      return model;
    },
  };
}

/**
 * A role-aware route resolver: builds (and caches) the provider, then the model.
 * The extra `role` param over the public `resolveModel` seam lets the fail-fast
 * errors name the offending role.
 */
type RoleAwareResolver = (route: ModelRoute, role: ModelRole) => LanguageModel;

/**
 * The default resolver: validates credentials/endpoint, caches one provider
 * instance per provider (per baseUrl for openai-compatible), and threads the
 * route's model id through it. A custom `deps.resolveModel` replaces this whole
 * unit, so key/baseUrl validation lives here rather than in the loader.
 */
function createDefaultResolver(
  apiKeys: ModelApiKeys,
  overrides: Partial<ProviderFactories> | undefined,
): RoleAwareResolver {
  const factories: ProviderFactories = { ...DEFAULT_PROVIDER_FACTORIES, ...overrides };
  const providerCache = new Map<string, ProviderInstance>();

  /** Build `key`'s provider once, memoising the instance for later roles. */
  const cached = (key: string, build: () => ProviderInstance): ProviderInstance => {
    const existing = providerCache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const instance = build();
    providerCache.set(key, instance);
    return instance;
  };

  /** Require a keyed provider's API key, else fail fast with the role named. */
  const requireKey = (
    role: ModelRole,
    provider: ModelProvider,
    key: string | undefined,
  ): string => {
    if (key === undefined || key.length === 0) {
      throw new MissingProviderKeyError(role, provider);
    }
    return key;
  };

  /** Resolve (and cache) the credentialed provider for one route. */
  const resolveProvider = (route: ModelRoute, role: ModelRole): ProviderInstance => {
    switch (route.provider) {
      case "anthropic": {
        const apiKey = requireKey(role, "anthropic", apiKeys.anthropic);
        return cached("anthropic", () => factories.anthropic({ apiKey }));
      }
      case "openai": {
        const apiKey = requireKey(role, "openai", apiKeys.openai);
        return cached("openai", () => factories.openai({ apiKey }));
      }
      case "gemini": {
        const apiKey = requireKey(role, "gemini", apiKeys.google);
        return cached("gemini", () => factories.gemini({ apiKey }));
      }
      case "openrouter": {
        const apiKey = requireKey(role, "openrouter", apiKeys.openrouter);
        return cached("openrouter", () => factories.openrouter({ apiKey }));
      }
      case "openai-compatible": {
        const baseURL = route.baseUrl;
        if (baseURL === undefined) {
          throw new MissingBaseUrlError(role);
        }
        return cached(`openai-compatible:${baseURL}`, () =>
          factories["openai-compatible"]({
            name: OPENAI_COMPATIBLE_PROVIDER_NAME,
            baseURL,
            apiKey: apiKeys.openaiCompatible,
          }),
        );
      }
    }
  };

  return (route, role) => resolveProvider(route, role)(route.model);
}
