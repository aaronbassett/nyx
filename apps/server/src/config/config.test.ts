/**
 * Boot-config tests (T015, DS-003).
 *
 * Fully deterministic: no external services, no process exit. Valid env yields a
 * typed frozen Config (defaults + overrides); invalid/missing vars throw a named
 * ConfigValidationError that lists every offender. Co-located under src/ to
 * match the db layer's schema.test.ts and the package's rootDir.
 */
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig, publicConfig } from "./index.js";
import { providerApiKeys } from "./schema.js";

interface TestRoute {
  provider: string;
  model: string;
  baseUrl?: string;
}
type TestRouting = Record<string, TestRoute>;

function baseRouting(): TestRouting {
  return {
    supervisor: { provider: "anthropic", model: "model-supervisor" },
    scaffolding: { provider: "openai", model: "model-scaffolding" },
    planning: { provider: "gemini", model: "model-planning" },
    implementation: { provider: "openrouter", model: "vendor/model-impl" },
    review: {
      provider: "openai-compatible",
      model: "local-review",
      baseUrl: "https://infer.internal/v1",
    },
  };
}

function routingJson(routing: TestRouting = baseRouting()): string {
  return JSON.stringify(routing);
}

/** A complete, valid env; overrides may replace or unset (undefined) any key. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/nyx",
    MCP_TOOLCHAIN_URL: "http://nyx-toolchain.flycast:8080/mcp",
    MCP_TOME_URL: "https://tome.example/mcp",
    MCP_MNM_URL: "https://mnm.example/mcp",
    PROVER_URL: "https://prover.example",
    COMPILE_SERVICE_URL: "https://compile.internal/v1",
    DEPLOY_KEY: "deploy-secret-value",
    COMPILE_SERVICE_TOKEN: "compile-service-secret-token",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
    R2_ACCOUNT_ID: "r2-account-id",
    MODEL_ROUTING: routingJson(),
    ...overrides,
  };
}

function issuesFor(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.issues.map((issue) => issue.variable);
    }
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig — valid env", () => {
  it("returns a typed, frozen Config with documented defaults", () => {
    const config = loadConfig(validEnv());

    expect(config.port).toBe(8080);
    expect(config.mcp.timeoutMs).toBe(10_000);
    expect(config.mcp.healthTimeoutMs).toBe(5_000);
    expect(config.mcp.maxConcurrency).toBe(4);
    expect(config.tunables.flatReserveNyxt).toBe(100n);
    expect(config.tunables.exchangeRateNyxtPerTnight).toBe(1_000n);
    expect(config.tunables.maxFileBytes).toBe(1_048_576);
    expect(config.tunables.maxProjectBytes).toBe(52_428_800);
    expect(config.tunables.sessionLifetimeMs).toBe(604_800_000);
    expect(config.tunables.reconcileCadenceMs).toBe(86_400_000);
    expect(config.prover.tokenLifetimeMs).toBe(300_000);

    expect(config.modelRouting.supervisor.provider).toBe("anthropic");
    expect(config.modelRouting.review.baseUrl).toBe("https://infer.internal/v1");

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.tunables)).toBe(true);
    expect(Object.isFrozen(config.modelRouting)).toBe(true);
  });

  it("carries the Compile Service base URL as a public (non-secret) field", () => {
    const config = loadConfig(validEnv());
    expect(config.compileService.url).toBe("https://compile.internal/v1");
  });

  it("derives publicOrigin from PORT when PUBLIC_ORIGIN is unset (P2 browser-compile artifact URLs)", () => {
    const config = loadConfig(validEnv({ PORT: "3000" }));
    // Optional-with-derivation: no new required env var, but always a parseable absolute origin
    // the browser-compile artifact URLs (`<publicOrigin>/artifacts/...`) are built under.
    expect(config.publicOrigin).toBe("http://localhost:3000");
    expect(() => new URL(config.publicOrigin)).not.toThrow();
  });

  it("honours an explicit PUBLIC_ORIGIN override", () => {
    const config = loadConfig(validEnv({ PUBLIC_ORIGIN: "https://nyx.example.com" }));
    expect(config.publicOrigin).toBe("https://nyx.example.com");
  });

  it("applies env overrides over defaults (numbers, bigints, urls)", () => {
    const config = loadConfig(
      validEnv({
        PORT: "3000",
        FLAT_RESERVE: "250",
        MCP_MAX_CONCURRENCY: "8",
        MCP_TIMEOUT_MS: "2500",
      }),
    );
    expect(config.port).toBe(3000);
    expect(config.tunables.flatReserveNyxt).toBe(250n);
    expect(config.mcp.maxConcurrency).toBe(8);
    expect(config.mcp.timeoutMs).toBe(2500);
  });

  it("treats empty / whitespace env values as unset so defaults apply", () => {
    const config = loadConfig(validEnv({ PORT: "", R2_BUCKET: "   " }));
    expect(config.port).toBe(8080);
    expect(config.r2.bucket).toBeUndefined();
  });

  it("carries server-only secrets but keeps them out of publicConfig", () => {
    const config = loadConfig(validEnv());
    expect(config.secrets.deployKey).toBe("deploy-secret-value");
    expect(config.secrets.compileServiceToken).toBe("compile-service-secret-token");
    expect(config.secrets.databaseUrl).toContain("postgres://");

    const pub = publicConfig(config);
    expect("secrets" in pub).toBe(false);
    // The Compile Service endpoint is server-internal; it never crosses the
    // server boundary (constitution III), so it is absent from publicConfig too.
    expect("compileService" in pub).toBe(false);
    // bigint tunables are not JSON-serializable; stringify them for the scan.
    const serialized = JSON.stringify(pub, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("deploy-secret-value");
    expect(serialized).not.toContain("compile-service-secret-token");
    expect(serialized).not.toContain("r2-secret-key");
  });

  it("carries supplied per-provider LLM API keys, leaving unset ones undefined", () => {
    const config = loadConfig(
      validEnv({
        OPENAI_API_KEY: "sk-openai",
        ANTHROPIC_API_KEY: "sk-anthropic",
        GOOGLE_API_KEY: "sk-google",
        // OPENROUTER_API_KEY + OPENAI_COMPATIBLE_API_KEY intentionally absent.
      }),
    );
    expect(config.secrets.openaiApiKey).toBe("sk-openai");
    expect(config.secrets.anthropicApiKey).toBe("sk-anthropic");
    expect(config.secrets.googleApiKey).toBe("sk-google");
    expect(config.secrets.openrouterApiKey).toBeUndefined();
    expect(config.secrets.openaiCompatibleApiKey).toBeUndefined();
  });

  it("leaves every provider API key undefined when none are supplied (optional secrets)", () => {
    const config = loadConfig(validEnv());
    expect(config.secrets.openaiApiKey).toBeUndefined();
    expect(config.secrets.anthropicApiKey).toBeUndefined();
    expect(config.secrets.googleApiKey).toBeUndefined();
    expect(config.secrets.openrouterApiKey).toBeUndefined();
    expect(config.secrets.openaiCompatibleApiKey).toBeUndefined();
  });

  it("keeps provider API keys out of publicConfig (server-only, constitution III)", () => {
    const config = loadConfig(
      validEnv({
        OPENAI_API_KEY: "sk-openai-leak",
        ANTHROPIC_API_KEY: "sk-anthropic-leak",
        GOOGLE_API_KEY: "sk-google-leak",
        OPENROUTER_API_KEY: "sk-openrouter-leak",
        OPENAI_COMPATIBLE_API_KEY: "sk-compat-leak",
      }),
    );
    const pub = publicConfig(config);
    expect("secrets" in pub).toBe(false);
    const serialized = JSON.stringify(pub, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("sk-openai-leak");
    expect(serialized).not.toContain("sk-anthropic-leak");
    expect(serialized).not.toContain("sk-google-leak");
    expect(serialized).not.toContain("sk-openrouter-leak");
    expect(serialized).not.toContain("sk-compat-leak");
  });
});

describe("providerApiKeys — routing-loader credential mapping", () => {
  it("maps each supplied secret to its ModelApiKeys provider id", () => {
    const config = loadConfig(
      validEnv({
        OPENAI_API_KEY: "k-openai",
        ANTHROPIC_API_KEY: "k-anthropic",
        GOOGLE_API_KEY: "k-google",
        OPENROUTER_API_KEY: "k-openrouter",
        OPENAI_COMPATIBLE_API_KEY: "k-compat",
      }),
    );
    expect(providerApiKeys(config.secrets)).toEqual({
      anthropic: "k-anthropic",
      openai: "k-openai",
      google: "k-google",
      openrouter: "k-openrouter",
      openaiCompatible: "k-compat",
    });
  });

  it("backs the gemini provider with GOOGLE_API_KEY", () => {
    const config = loadConfig(validEnv({ GOOGLE_API_KEY: "k-google" }));
    expect(providerApiKeys(config.secrets).google).toBe("k-google");
  });

  it("omits providers whose key is unset (no undefined-valued entries)", () => {
    const config = loadConfig(validEnv({ ANTHROPIC_API_KEY: "k-anthropic" }));
    const keys = providerApiKeys(config.secrets);
    expect(keys).toEqual({ anthropic: "k-anthropic" });
    expect("openai" in keys).toBe(false);
    expect("google" in keys).toBe(false);
    expect("openrouter" in keys).toBe(false);
    expect("openaiCompatible" in keys).toBe(false);
  });

  it("returns an empty object when no provider keys are supplied", () => {
    const config = loadConfig(validEnv());
    expect(providerApiKeys(config.secrets)).toEqual({});
  });
});

describe("loadConfig — invalid env (DS-003 fail-fast)", () => {
  it("throws ConfigValidationError naming every missing variable", () => {
    const vars = issuesFor(validEnv({ DATABASE_URL: undefined, DEPLOY_KEY: undefined }));
    expect(vars).toContain("DATABASE_URL");
    expect(vars).toContain("DEPLOY_KEY");
  });

  it("reports an empty required value as missing", () => {
    const vars = issuesFor(validEnv({ DATABASE_URL: "" }));
    expect(vars).toContain("DATABASE_URL");
  });

  it("names invalid URLs, non-positive ports, and non-positive amounts together", () => {
    const vars = issuesFor(validEnv({ MCP_TOME_URL: "not-a-url", PORT: "-1", FLAT_RESERVE: "-5" }));
    expect(vars).toContain("MCP_TOME_URL");
    expect(vars).toContain("PORT");
    expect(vars).toContain("FLAT_RESERVE");
  });

  it("rejects a non-URL PUBLIC_ORIGIN (must be an absolute origin)", () => {
    const vars = issuesFor(validEnv({ PUBLIC_ORIGIN: "not-a-url" }));
    expect(vars).toContain("PUBLIC_ORIGIN");
  });

  it("names COMPILE_SERVICE_URL when the Compile Service base URL is missing", () => {
    const vars = issuesFor(validEnv({ COMPILE_SERVICE_URL: undefined }));
    expect(vars).toContain("COMPILE_SERVICE_URL");
  });

  it("names COMPILE_SERVICE_URL when the Compile Service base URL is not a URL", () => {
    const vars = issuesFor(validEnv({ COMPILE_SERVICE_URL: "not-a-url" }));
    expect(vars).toContain("COMPILE_SERVICE_URL");
  });

  it("names COMPILE_SERVICE_TOKEN when the server-only bearer token is absent", () => {
    const vars = issuesFor(validEnv({ COMPILE_SERVICE_TOKEN: undefined }));
    expect(vars).toContain("COMPILE_SERVICE_TOKEN");
  });

  it("names all server-only secrets when absent (zero-trust presence check)", () => {
    const vars = issuesFor(
      validEnv({
        R2_ACCESS_KEY_ID: undefined,
        R2_SECRET_ACCESS_KEY: undefined,
        R2_ACCOUNT_ID: undefined,
      }),
    );
    expect(vars).toEqual(
      expect.arrayContaining(["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID"]),
    );
  });
});

describe("loadConfig — model routing (D19)", () => {
  it("reports MODEL_ROUTING when the JSON is malformed", () => {
    const vars = issuesFor(validEnv({ MODEL_ROUTING: "{not valid json" }));
    expect(vars).toContain("MODEL_ROUTING");
  });

  it("reports the missing role with a nested path", () => {
    const routing = baseRouting();
    delete routing.review;
    const vars = issuesFor(validEnv({ MODEL_ROUTING: routingJson(routing) }));
    expect(vars).toContain("MODEL_ROUTING.review");
  });

  it("requires baseUrl for the openai-compatible provider", () => {
    const routing = baseRouting();
    routing.review = { provider: "openai-compatible", model: "local-review" };
    const vars = issuesFor(validEnv({ MODEL_ROUTING: routingJson(routing) }));
    expect(vars).toContain("MODEL_ROUTING.review.baseUrl");
  });

  it("rejects baseUrl on a non-openai-compatible provider", () => {
    const routing = baseRouting();
    routing.supervisor = { provider: "anthropic", model: "m", baseUrl: "https://x.example" };
    const vars = issuesFor(validEnv({ MODEL_ROUTING: routingJson(routing) }));
    expect(vars).toContain("MODEL_ROUTING.supervisor.baseUrl");
  });

  it("rejects an unknown provider", () => {
    const routing = baseRouting();
    routing.planning = { provider: "cohere", model: "m" };
    const vars = issuesFor(validEnv({ MODEL_ROUTING: routingJson(routing) }));
    expect(vars).toContain("MODEL_ROUTING.planning.provider");
  });
});
