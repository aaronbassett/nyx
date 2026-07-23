/**
 * Network-profile config tests (network module, DS-003 fail-fast).
 *
 * Fully deterministic: no external services, no process exit. Drives the whole
 * chokepoint through `loadConfig` so the schema + loader wiring is exercised end
 * to end:
 *  - the DEFAULT profile (`local-devnet`) pins the Lace "Undeployed" node/proof
 *    ports and the remapped indexer port;
 *  - `NYX_NETWORK=preprod` selects the public-release profile;
 *  - an unknown `NYX_NETWORK` fails fast with a NAMED `NYX_NETWORK` issue;
 *  - a per-field override (`NYX_NODE_URL`) overrides ONLY that field.
 */
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../../src/config/index.js";

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

/** A complete, valid env; overrides may replace or unset (undefined) any key. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/nyx",
    MCP_TOME_URL: "https://tome.example/mcp",
    MCP_MNM_URL: "https://mnm.example/mcp",
    PROVER_URL: "https://prover.example",
    DEPLOY_KEY: "deploy-secret-value",
    MODEL_ROUTING: JSON.stringify(baseRouting()),
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

describe("network profile — resolution", () => {
  it("defaults to local-devnet with Lace-pinned node/proof/indexer", () => {
    const config = loadConfig(validEnv());

    expect(config.network.id).toBe("local-devnet");
    expect(config.network.networkId).toBe("Undeployed");
    expect(config.network.nodeUrl).toBe("http://localhost:9944");
    expect(config.network.proofServerUrl).toBe("http://localhost:6300");
    expect(config.network.indexerUrl).toBe("http://localhost:8088");
  });

  it("selects the preprod profile when NYX_NETWORK=preprod", () => {
    const config = loadConfig(validEnv({ NYX_NETWORK: "preprod" }));
    expect(config.network.id).toBe("preprod");
  });

  it("applies a single per-field override and leaves the rest of the profile", () => {
    const config = loadConfig(validEnv({ NYX_NODE_URL: "http://localhost:29944" }));

    expect(config.network.id).toBe("local-devnet");
    expect(config.network.nodeUrl).toBe("http://localhost:29944");
    // Untouched fields keep the local-devnet defaults.
    expect(config.network.proofServerUrl).toBe("http://localhost:6300");
    expect(config.network.indexerUrl).toBe("http://localhost:8088");
    expect(config.network.networkId).toBe("Undeployed");
  });

  it("network URLs flow into the public config (never secret)", () => {
    const config = loadConfig(validEnv());
    expect(config.network.nodeUrl).toBe("http://localhost:9944");
    // `network` is not under `secrets`, so it survives the public projection.
    expect(Object.isFrozen(config.network)).toBe(true);
  });
});

describe("network profile — invalid NYX_NETWORK (DS-003 fail-fast)", () => {
  it("throws ConfigValidationError naming NYX_NETWORK for an unknown network", () => {
    const vars = issuesFor(validEnv({ NYX_NETWORK: "bogus" }));
    expect(vars).toContain("NYX_NETWORK");
  });
});
