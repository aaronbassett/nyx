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
    DEPLOY_KEY: "deploy-secret-value",
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
    expect(config.secrets.databaseUrl).toContain("postgres://");

    const pub = publicConfig(config);
    expect("secrets" in pub).toBe(false);
    // bigint tunables are not JSON-serializable; stringify them for the scan.
    const serialized = JSON.stringify(pub, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("deploy-secret-value");
    expect(serialized).not.toContain("r2-secret-key");
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
