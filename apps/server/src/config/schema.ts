/**
 * Boot-config schemas and defaults for the Nyx orchestrator (T015, DS-003).
 *
 * Two shapes live here:
 *  - `EnvSchema` — a flat zod object keyed by the ACTUAL environment variable
 *    names, so every zod issue path is the offending variable (used to build the
 *    named error). All numeric/bigint/URL coercion and documented defaults live
 *    on these fields (D47 tunables pattern).
 *  - `ModelRoutingTableSchema` — the D19 per-agent routing table, validated for
 *    SHAPE and PRESENCE only (no provider clients are built here — that is T136).
 *
 * Monetary tunables are NYXT base-unit `bigint`s — the same units the wire
 * protocol (`@nyx/protocol` `NyxtAmount`) uses; kept as a local `bigint` here
 * because that package does not yet declare `exports`/`types` for tsc
 * consumption (it is not modifiable from this task). Durations are milliseconds
 * (matching the wire protocol's epoch-ms convention). Concrete numbers are
 * placeholders tuned at implementation against real model costs (D47) — the
 * mechanism is what is pinned, not the values.
 */
import { z } from "zod";
import { NETWORK_IDS } from "./network.js";
import type { NetworkProfile } from "./network.js";

/**
 * A NYXT base-unit amount (same units as `@nyx/protocol`'s `NyxtAmount`).
 * Signed at the ledger, but every config tunable using it is strictly positive.
 */
export type NyxtAmount = bigint;

/** A positive NYXT base-unit amount, supplied as a decimal string in the env. */
const positiveNyxtAmount = z.coerce
  .bigint()
  .refine((value) => value > 0n, { message: "must be a positive integer NYXT amount" });

/** A positive integer, supplied as a decimal string in the env. */
const positiveInt = z.coerce.number().int().positive();

// ── Model routing (D19) ──────────────────────────────────────────────────────

/**
 * Providers required by D19. `openai-compatible` covers owner-hosted inference
 * (vLLM/Ollama/TGI) and OpenRouter, both of which speak the OpenAI API.
 */
export const ModelProviderSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "openai-compatible",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/** The agent roles the supervisor swarm routes for (D19). */
export const MODEL_ROLES = [
  "supervisor",
  "scaffolding",
  "planning",
  "implementation",
  "review",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * One role's provider + model assignment. `baseUrl` is required for the
 * `openai-compatible` provider (self-hosted / OpenRouter endpoint) and rejected
 * otherwise. Shape only — no client is constructed (T136 owns that).
 */
export const ModelRouteSchema = z
  .object({
    provider: ModelProviderSchema,
    model: z.string().min(1, "must be a non-empty model identifier"),
    baseUrl: z.string().url("must be a valid URL").optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.provider === "openai-compatible" && route.baseUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "is required for the openai-compatible provider",
      });
    }
    if (route.provider !== "openai-compatible" && route.baseUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "is only valid for the openai-compatible provider",
      });
    }
  });
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

/** The full D19 routing table: every role must be present. */
export const ModelRoutingTableSchema = z
  .object({
    supervisor: ModelRouteSchema,
    scaffolding: ModelRouteSchema,
    planning: ModelRouteSchema,
    implementation: ModelRouteSchema,
    review: ModelRouteSchema,
  })
  .strict();
export type ModelRoutingTable = z.infer<typeof ModelRoutingTableSchema>;

// ── Flat environment schema ──────────────────────────────────────────────────

/**
 * Keyed by real env var names so zod issue paths map 1:1 to the offending
 * variable. `MODEL_ROUTING` is validated here only for presence (non-empty
 * string); its JSON body is parsed and shape-checked separately in `load.ts` so
 * routing-table errors carry `MODEL_ROUTING.<role>.<field>` paths.
 */
export const EnvSchema = z.object({
  // Connection / infra (validated here, consumed by the db + proxy layers).
  DATABASE_URL: z.string().min(1, "must be a non-empty Postgres connection string"),
  PORT: positiveInt.default(8080),
  // Absolute public origin the browser-compile artifact URLs are built under (P2). OPTIONAL:
  // when unset it derives from PORT (`http://localhost:<PORT>`), so no NEW required env var is
  // introduced (that would break every server test fixture). Only the origin is load-bearing —
  // the in-process artifact `fetch` adapter parses the path and ignores the host.
  PUBLIC_ORIGIN: z
    .string()
    .url("must be a valid absolute origin (P2 browser-compile artifact URLs)")
    .optional(),
  MCP_TOME_URL: z.string().url("must be a valid URL (Tome skill-routing MCP)"),
  MCP_MNM_URL: z.string().url("must be a valid URL (mnm docs MCP)"),
  PROVER_URL: z.string().url("must be a valid URL (interim D37 proof server)"),

  // Durable artifact store (P2 browser-compile). The server now stores compile artifacts
  // itself (the Compile Service + R2-write path is retired), so these size caps + on-disk
  // root replace the R2 config. All OPTIONAL with sane defaults — no NEW required env var
  // (adding one would break every server test fixture, the US1 lesson).
  ARTIFACT_STORE_ROOT: z.string().min(1).default("./data/artifacts"),
  ARTIFACT_MAX_FILE_BYTES: positiveInt.default(16_777_216), // 16 MB/file
  ARTIFACT_MAX_BUNDLE_BYTES: positiveInt.default(134_217_728), // 128 MB/prefix
  // Bounded per-cycle CHECK + green FULL browser-compile waits (D42 no-hang backstops).
  COMPILE_CHECK_TIMEOUT_MS: positiveInt.default(30_000),
  COMPILE_FULL_TIMEOUT_MS: positiveInt.default(300_000),
  // Optional local SRS pre-fetch cache served read-only at `GET /srs/*` (demo prove speed).
  SRS_CACHE_DIR: z.string().min(1).optional(),

  // Network profile selection + optional per-field endpoint overrides. The
  // profile bundles PUBLIC endpoints (node/indexer/proof) + the connector's
  // `networkId`; overrides repoint a single endpoint without a new profile.
  NYX_NETWORK: z.enum(NETWORK_IDS).default("local-devnet"),
  NYX_NODE_URL: z.string().url("must be a valid URL (network node override)").optional(),
  NYX_INDEXER_URL: z.string().url("must be a valid URL (network indexer override)").optional(),
  NYX_PROOF_SERVER_URL: z
    .string()
    .url("must be a valid URL (network proof-server override)")
    .optional(),
  NYX_NETWORK_ID: z.string().min(1, "must be a non-empty networkId override").optional(),

  // MCP client tunables (D31: bounded concurrency, no silent timeouts).
  MCP_TIMEOUT_MS: positiveInt.default(10_000),
  MCP_HEALTH_TIMEOUT_MS: positiveInt.default(5_000),
  MCP_MAX_CONCURRENCY: positiveInt.default(4),

  // Server-only secrets — presence validated; NEVER routed to a client surface.
  // (DATABASE_URL, validated above, is also secret and lives under `secrets`.)
  DEPLOY_KEY: z.string().min(1, "must be present (server-only deploy key, D52)"),

  // Per-provider LLM API keys (D19 model routing). OPTIONAL server-only secrets:
  // a deployment supplies a key only for the providers its MODEL_ROUTING table
  // actually uses, and the routing loader (agents/routing.ts) fails fast at
  // construction if a routed provider's key is missing. `GOOGLE_API_KEY` backs the
  // `gemini` provider; `OPENAI_COMPATIBLE_API_KEY` is optional even in use (a local
  // vLLM/Ollama endpoint may need none). `.min(1)` rejects an explicitly empty key.
  OPENAI_API_KEY: z.string().min(1, "must be a non-empty OpenAI API key").optional(),
  ANTHROPIC_API_KEY: z.string().min(1, "must be a non-empty Anthropic API key").optional(),
  GOOGLE_API_KEY: z.string().min(1, "must be a non-empty Google (gemini) API key").optional(),
  OPENROUTER_API_KEY: z.string().min(1, "must be a non-empty OpenRouter API key").optional(),
  OPENAI_COMPATIBLE_API_KEY: z
    .string()
    .min(1, "must be a non-empty OpenAI-compatible API key")
    .optional(),

  // Model routing table (D19) — JSON, required; body validated in load.ts.
  MODEL_ROUTING: z
    .string()
    .min(1, "must be a JSON object mapping each agent role to { provider, model }"),

  // Economic + operational tunables (D47) — documented defaults, env-overridable.
  NYXT_EXCHANGE_RATE: positiveNyxtAmount.default(1_000n), // NYXT base units minted per tNIGHT unit
  FLAT_RESERVE: positiveNyxtAmount.default(100n), // per-prompt reserve (D34)
  MINIMUM_DEPOSIT: positiveNyxtAmount.default(1_000n), // smallest accepted deposit (D45)
  LOW_BALANCE_THRESHOLD: positiveNyxtAmount.default(500n), // UI low-balance warning (S6)
  MAX_FILE_BYTES: positiveInt.default(1_048_576), // 1 MB/file (D49)
  MAX_PROJECT_BYTES: positiveInt.default(52_428_800), // 50 MB/project (D49)
  PROJECT_QUOTA_PER_ACCOUNT: positiveInt.default(20), // per-account project cap (D49)
  VERSION_RETENTION_COUNT: positiveInt.default(50), // versions retained (D48)
  VERSION_RETENTION_DAYS: positiveInt.default(30), // days retained (D48)
  DEPOSIT_REF_TTL_MS: positiveInt.default(3_600_000), // 1 h deposit-ref TTL (D45)
  RECONCILE_CADENCE_MS: positiveInt.default(86_400_000), // daily reconcile (D56)
  // Clone/handoff git-HTTP rate limit (US13/EC-55) — a token/IP token bucket. All three
  // are OPTIONAL with sane defaults, so no NEW required env var (adding one would break
  // every server test fixture). A ~30-attempt burst refilling 30/min throttles a token
  // brute-force cheaply while never blocking an ordinary `git clone`.
  CLONE_RATE_CAPACITY: positiveInt.default(30), // burst of clone-auth attempts before throttling
  CLONE_RATE_REFILL: positiveInt.default(30), // attempts replenished per interval
  CLONE_RATE_INTERVAL_MS: positiveInt.default(60_000), // 1 min refill window
  PROVER_RATE_LIMIT_MAX: positiveInt.default(60), // requests per window per session (D52)
  PROVER_RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000), // 1 min rate-limit window (D52)
  SESSION_LIFETIME_MS: positiveInt.default(604_800_000), // 7-day sliding session (D44)
  PROVING_TOKEN_LIFETIME_MS: positiveInt.default(300_000), // 5 min proving token (D52)
});
export type Env = z.infer<typeof EnvSchema>;

// ── Structured, frozen Config ────────────────────────────────────────────────

/** MCP endpoints + client tunables consumed by the mcp layer (T019). */
export interface McpConfig {
  readonly tomeUrl: string;
  readonly mnmUrl: string;
  /** Strict per-request timeout (connect + call); no call may hang (D31). */
  readonly timeoutMs: number;
  /** Shorter timeout for health probes. */
  readonly healthTimeoutMs: number;
  /** Bounded concurrency per client (D31). */
  readonly maxConcurrency: number;
}

/** Interim prover config (D37/D52). The URL is internal; not client-bound. */
export interface ProverConfig {
  readonly url: string;
  readonly rateLimit: { readonly max: number; readonly windowMs: number };
  readonly tokenLifetimeMs: number;
}

/**
 * Durable artifact store config (P2 browser-compile). The server now stores compile
 * artifacts itself — the retired Compile Service + R2-write path is gone — so these are
 * the on-disk root + size caps `index.ts` hands {@link createLocalArtifactStore}, plus the
 * optional local SRS pre-fetch cache served read-only at `GET /srs/*`. All are local
 * endpoints/paths, not credentials, so this flows into {@link PublicConfig}.
 */
export interface ArtifactStoreConfig {
  readonly rootDir: string;
  readonly maxFileBytes: number;
  readonly maxBundleBytes: number;
  readonly srsCacheDir: string | undefined;
}

/**
 * Resolved network endpoints (public, non-secret). Alias of {@link NetworkProfile}
 * so callers can depend on the config-level name; the URLs are endpoints, not
 * credentials, so this flows into `PublicConfig` and never under `secrets`.
 */
export type NetworkConfig = NetworkProfile;

/** Economic + operational tunables (D47/D48/D49/D44/D56). */
export interface Tunables {
  readonly exchangeRateNyxtPerTnight: NyxtAmount;
  readonly flatReserveNyxt: NyxtAmount;
  readonly minimumDepositNyxt: NyxtAmount;
  readonly lowBalanceThresholdNyxt: NyxtAmount;
  readonly maxFileBytes: number;
  readonly maxProjectBytes: number;
  readonly projectQuotaPerAccount: number;
  readonly versionRetentionCount: number;
  readonly versionRetentionDays: number;
  readonly depositRefTtlMs: number;
  readonly reconcileCadenceMs: number;
  readonly sessionLifetimeMs: number;
  /** Bounded per-cycle browser CHECK wait (D42 no-hang backstop), in ms. */
  readonly compileCheckTimeoutMs: number;
  /** Bounded green FULL browser-compile wait (D42 no-hang backstop), in ms. */
  readonly compileFullTimeoutMs: number;
  /** Clone/handoff git-HTTP rate-limit bucket capacity (burst) (EC-55). */
  readonly cloneRateCapacity: number;
  /** Clone/handoff attempts replenished per {@link Tunables.cloneRateIntervalMs} (EC-55). */
  readonly cloneRateRefill: number;
  /** Clone/handoff rate-limit refill window, in ms (EC-55). */
  readonly cloneRateIntervalMs: number;
}

/**
 * Server-only secrets. NEVER serialize onto any client-bound surface (WS frames,
 * HTTP response bodies, logs). Anything crossing the server boundary uses
 * `publicConfig`, which omits this field entirely (constitution III, D52).
 */
export interface ServerSecrets {
  readonly databaseUrl: string;
  readonly deployKey: string;
  /**
   * Per-provider LLM API keys for the D19 model-routing loader — all OPTIONAL:
   * a key is present only for providers a deployment's `MODEL_ROUTING` actually
   * routes to (the loader fails fast if a routed provider's key is absent).
   * Server-only like {@link ServerSecrets.deployKey}; NEVER a client/`VITE_`
   * surface. Project them into the loader's shape with {@link providerApiKeys}.
   */
  readonly openaiApiKey?: string;
  readonly anthropicApiKey?: string;
  /** Backs the `gemini` provider (env var `GOOGLE_API_KEY`). */
  readonly googleApiKey?: string;
  readonly openrouterApiKey?: string;
  /** Optional even when the `openai-compatible` provider is used (local vLLM/Ollama). */
  readonly openaiCompatibleApiKey?: string;
}

/** The fully validated, frozen server configuration. */
export interface Config {
  readonly port: number;
  /**
   * Absolute public origin (scheme + host + optional port) the P2 browser-compile artifact
   * URLs are built under, e.g. `http://localhost:8080`. Public, non-secret (an endpoint, not a
   * credential) — flows into {@link PublicConfig}. Derived from {@link Config.port} when the
   * `PUBLIC_ORIGIN` env var is unset.
   */
  readonly publicOrigin: string;
  readonly network: NetworkConfig;
  readonly mcp: McpConfig;
  readonly prover: ProverConfig;
  /** Durable artifact store root + size caps + optional SRS cache (P2 browser-compile). */
  readonly artifacts: ArtifactStoreConfig;
  readonly tunables: Tunables;
  readonly modelRouting: ModelRoutingTable;
  readonly secrets: ServerSecrets;
}

/**
 * Config view safe to expose beyond the server boundary. `secrets` is dropped entirely
 * (constitution III), so deploy keys can never be serialized to a client surface.
 */
export type PublicConfig = Omit<Config, "secrets">;

// ── Model-routing credential projection ──────────────────────────────────────

/**
 * Per-provider LLM API keys in exactly the shape the model-routing loader
 * consumes (`agents/routing.ts` `ModelApiKeys`, fed to `createModelRouter({
 * apiKeys })`). It is declared structurally HERE, rather than imported, on
 * purpose: `agents/routing.ts` already imports this module, so a back-edge from
 * config → agents would cycle. This interface is the deliberate structural
 * bridge — `providerApiKeys(secrets)` is assignable to the loader's `apiKeys`
 * parameter. Every key is optional (see {@link ServerSecrets}).
 */
export interface ProviderApiKeys {
  readonly anthropic?: string;
  readonly openai?: string;
  /** The `gemini` provider's key (from `GOOGLE_API_KEY`). */
  readonly google?: string;
  readonly openrouter?: string;
  readonly openaiCompatible?: string;
}

/**
 * Project {@link ServerSecrets} down to the {@link ProviderApiKeys} the D19
 * routing loader expects, keeping the US1 wiring DRY:
 * `createModelRouter({ apiKeys: providerApiKeys(config.secrets) })`.
 *
 * `GOOGLE_API_KEY` (`secrets.googleApiKey`) backs the `gemini` provider. Every
 * UNSET key is OMITTED from the result — never emitted as an `undefined`-valued
 * entry — so the loader's "does this provider have a key?" test is a plain
 * presence check and `exactOptionalPropertyTypes` stays satisfied.
 */
export function providerApiKeys(secrets: ServerSecrets): ProviderApiKeys {
  const keys: {
    anthropic?: string;
    openai?: string;
    google?: string;
    openrouter?: string;
    openaiCompatible?: string;
  } = {};
  if (secrets.anthropicApiKey !== undefined) {
    keys.anthropic = secrets.anthropicApiKey;
  }
  if (secrets.openaiApiKey !== undefined) {
    keys.openai = secrets.openaiApiKey;
  }
  if (secrets.googleApiKey !== undefined) {
    keys.google = secrets.googleApiKey;
  }
  if (secrets.openrouterApiKey !== undefined) {
    keys.openrouter = secrets.openrouterApiKey;
  }
  if (secrets.openaiCompatibleApiKey !== undefined) {
    keys.openaiCompatible = secrets.openaiCompatibleApiKey;
  }
  return keys;
}
