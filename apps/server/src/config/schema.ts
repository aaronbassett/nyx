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
  MCP_TOOLCHAIN_URL: z.string().url("must be a valid URL (toolchain compile MCP, .flycast)"),
  MCP_TOME_URL: z.string().url("must be a valid URL (Tome skill-routing MCP)"),
  MCP_MNM_URL: z.string().url("must be a valid URL (mnm docs MCP)"),
  PROVER_URL: z.string().url("must be a valid URL (interim D37 proof server)"),

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

  // R2 read placeholders (public, non-secret; optional until R2 is wired).
  R2_PUBLIC_BASE_URL: z.string().url("must be a valid URL").optional(),
  R2_BUCKET: z.string().min(1).optional(),

  // Server-only secrets — presence validated; NEVER routed to a client surface.
  // (DATABASE_URL, validated above, is also secret and lives under `secrets`.)
  DEPLOY_KEY: z.string().min(1, "must be present (server-only deploy key, D52)"),
  R2_ACCESS_KEY_ID: z.string().min(1, "must be present (server-only R2 write credential)"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "must be present (server-only R2 write credential)"),
  R2_ACCOUNT_ID: z.string().min(1, "must be present (server-only R2 account id)"),

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
  PROVER_RATE_LIMIT_MAX: positiveInt.default(60), // requests per window per session (D52)
  PROVER_RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000), // 1 min rate-limit window (D52)
  SESSION_LIFETIME_MS: positiveInt.default(604_800_000), // 7-day sliding session (D44)
  PROVING_TOKEN_LIFETIME_MS: positiveInt.default(300_000), // 5 min proving token (D52)
});
export type Env = z.infer<typeof EnvSchema>;

// ── Structured, frozen Config ────────────────────────────────────────────────

/** MCP endpoints + client tunables consumed by the mcp layer (T019). */
export interface McpConfig {
  readonly toolchainUrl: string;
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

/** R2 read-side placeholders (public, non-secret). */
export interface R2ReadConfig {
  readonly publicBaseUrl: string | undefined;
  readonly bucket: string | undefined;
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
}

/**
 * Server-only secrets. NEVER serialize onto any client-bound surface (WS frames,
 * HTTP response bodies, logs). Anything crossing the server boundary uses
 * `publicConfig`, which omits this field entirely (constitution III, D52).
 */
export interface ServerSecrets {
  readonly databaseUrl: string;
  readonly deployKey: string;
  readonly r2AccessKeyId: string;
  readonly r2SecretAccessKey: string;
  readonly r2AccountId: string;
}

/** The fully validated, frozen server configuration. */
export interface Config {
  readonly port: number;
  readonly network: NetworkConfig;
  readonly mcp: McpConfig;
  readonly prover: ProverConfig;
  readonly r2: R2ReadConfig;
  readonly tunables: Tunables;
  readonly modelRouting: ModelRoutingTable;
  readonly secrets: ServerSecrets;
}

/** Config view safe to expose beyond the server boundary — secrets omitted. */
export type PublicConfig = Omit<Config, "secrets">;
