/**
 * Pure boot-config loader for the Nyx orchestrator (T015, DS-003).
 *
 * `loadConfig(env)` validates the environment and returns a typed, deeply-frozen
 * `Config`, THROWING `ConfigValidationError` (listing every offender) on invalid
 * input. It never exits the process — the bootstrap (index.ts) owns fail-fast.
 */
import type { ZodError } from "zod";
import { ConfigValidationError } from "./errors.js";
import type { ConfigIssue } from "./errors.js";
import { resolveNetworkProfile } from "./network.js";
import { EnvSchema, ModelRoutingTableSchema } from "./schema.js";
import type { Config, Env, ModelRoutingTable, ServerSecrets } from "./schema.js";

/** Treat empty / whitespace-only env values as unset so defaults apply. */
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = typeof value === "string" && value.trim() === "" ? undefined : value;
  }
  return out;
}

/**
 * Flatten a ZodError into config issues. When `prefix` is empty the path IS the
 * variable name (flat env schema); otherwise paths nest under the prefix (the
 * MODEL_ROUTING JSON body).
 */
function collectIssues(error: ZodError, prefix: string): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    let variable: string;
    if (prefix === "") {
      variable = path === "" ? "(root)" : path;
    } else {
      variable = path === "" ? prefix : `${prefix}.${path}`;
    }
    return { variable, reason: issue.message };
  });
}

/** Parse and shape-check the `MODEL_ROUTING` JSON body (D19). */
function parseModelRouting(
  raw: string | undefined,
  issues: ConfigIssue[],
): ModelRoutingTable | undefined {
  if (raw === undefined || raw.trim() === "") {
    // Absence is reported by EnvSchema (MODEL_ROUTING is required); nothing to add.
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    issues.push({ variable: "MODEL_ROUTING", reason: `must be valid JSON (${detail})` });
    return undefined;
  }
  const result = ModelRoutingTableSchema.safeParse(json);
  if (!result.success) {
    for (const issue of collectIssues(result.error, "MODEL_ROUTING")) {
      issues.push(issue);
    }
    return undefined;
  }
  return result.data;
}

/** Recursively freeze a config object so callers cannot mutate it after boot. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Assemble the server-only {@link ServerSecrets}, including the OPTIONAL
 * per-provider LLM API keys (D19). Each absent key is OMITTED via conditional
 * spread — never assigned `undefined` — so `exactOptionalPropertyTypes` holds and
 * {@link providerApiKeys} sees a plain presence signal.
 */
function assembleSecrets(env: Env): ServerSecrets {
  return {
    databaseUrl: env.DATABASE_URL,
    deployKey: env.DEPLOY_KEY,
    ...(env.OPENAI_API_KEY !== undefined ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
    ...(env.ANTHROPIC_API_KEY !== undefined ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.GOOGLE_API_KEY !== undefined ? { googleApiKey: env.GOOGLE_API_KEY } : {}),
    ...(env.OPENROUTER_API_KEY !== undefined ? { openrouterApiKey: env.OPENROUTER_API_KEY } : {}),
    ...(env.OPENAI_COMPATIBLE_API_KEY !== undefined
      ? { openaiCompatibleApiKey: env.OPENAI_COMPATIBLE_API_KEY }
      : {}),
  };
}

function assemble(env: Env, modelRouting: ModelRoutingTable): Config {
  return {
    port: env.PORT,
    // Derive the public origin from PORT when unset — keeps PUBLIC_ORIGIN optional (no new
    // required env var) while always yielding a parseable absolute origin for artifact URLs.
    publicOrigin: env.PUBLIC_ORIGIN ?? `http://localhost:${String(env.PORT)}`,
    network: resolveNetworkProfile(env),
    mcp: {
      tomeUrl: env.MCP_TOME_URL,
      mnmUrl: env.MCP_MNM_URL,
      timeoutMs: env.MCP_TIMEOUT_MS,
      healthTimeoutMs: env.MCP_HEALTH_TIMEOUT_MS,
      maxConcurrency: env.MCP_MAX_CONCURRENCY,
    },
    prover: {
      url: env.PROVER_URL,
      rateLimit: { max: env.PROVER_RATE_LIMIT_MAX, windowMs: env.PROVER_RATE_LIMIT_WINDOW_MS },
      tokenLifetimeMs: env.PROVING_TOKEN_LIFETIME_MS,
    },
    artifacts: {
      rootDir: env.ARTIFACT_STORE_ROOT,
      maxFileBytes: env.ARTIFACT_MAX_FILE_BYTES,
      maxBundleBytes: env.ARTIFACT_MAX_BUNDLE_BYTES,
      maxStagedBytesPerProject: env.ARTIFACT_MAX_STAGED_BYTES_PER_PROJECT,
      maxStagedPrefixesPerProject: env.ARTIFACT_MAX_STAGED_PREFIXES_PER_PROJECT,
      // Conditional so `exactOptionalPropertyTypes` holds — a `string | undefined` field is
      // fine to assign directly, but keep the explicit value for the optional SRS cache dir.
      srsCacheDir: env.SRS_CACHE_DIR,
    },
    tunables: {
      exchangeRateNyxtPerTnight: env.NYXT_EXCHANGE_RATE,
      flatReserveNyxt: env.FLAT_RESERVE,
      minimumDepositNyxt: env.MINIMUM_DEPOSIT,
      lowBalanceThresholdNyxt: env.LOW_BALANCE_THRESHOLD,
      maxFileBytes: env.MAX_FILE_BYTES,
      maxProjectBytes: env.MAX_PROJECT_BYTES,
      projectQuotaPerAccount: env.PROJECT_QUOTA_PER_ACCOUNT,
      versionRetentionCount: env.VERSION_RETENTION_COUNT,
      versionRetentionDays: env.VERSION_RETENTION_DAYS,
      depositRefTtlMs: env.DEPOSIT_REF_TTL_MS,
      reconcileCadenceMs: env.RECONCILE_CADENCE_MS,
      sessionLifetimeMs: env.SESSION_LIFETIME_MS,
      compileCheckTimeoutMs: env.COMPILE_CHECK_TIMEOUT_MS,
      compileFullTimeoutMs: env.COMPILE_FULL_TIMEOUT_MS,
      cloneRateCapacity: env.CLONE_RATE_CAPACITY,
      cloneRateRefill: env.CLONE_RATE_REFILL,
      cloneRateIntervalMs: env.CLONE_RATE_INTERVAL_MS,
    },
    modelRouting,
    secrets: assembleSecrets(env),
  };
}

/**
 * Validate `env` and return a frozen {@link Config}. Throws
 * {@link ConfigValidationError} naming every missing/invalid variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issues: ConfigIssue[] = [];
  const normalized = normalizeEnv(env);

  const parsed = EnvSchema.safeParse(normalized);
  if (!parsed.success) {
    for (const issue of collectIssues(parsed.error, "")) {
      issues.push(issue);
    }
  }

  const rawRouting =
    typeof normalized.MODEL_ROUTING === "string" ? normalized.MODEL_ROUTING : undefined;
  const modelRouting = parseModelRouting(rawRouting, issues);

  if (issues.length > 0 || !parsed.success || modelRouting === undefined) {
    // If issues is somehow empty here the inputs were still incomplete; surface
    // an explicit issue rather than returning a half-built config.
    const finalIssues =
      issues.length > 0
        ? issues
        : [{ variable: "(configuration)", reason: "failed to assemble a complete config" }];
    throw new ConfigValidationError(finalIssues);
  }

  return deepFreeze(assemble(parsed.data, modelRouting));
}
