/**
 * Deploy buildServer wiring tests (T158/US8, D49/FR-052, scenario 8).
 *
 * These pin the buildServer-level back-fill the deploy loop adds to US7's soft-delete cascade:
 * when a `deployRegistry` is present, the D49 deletion cascade's contract-teardown seam (a US7
 * no-op stub) is wired to `deployRegistry.teardownProject` — so DELETEing a project tears down its
 * deploy registry rows (OFF-CHAIN, T155: the on-chain contracts persist; the app just stops
 * pointing at them). With NO registry the cascade stays a no-op (US7 behaviour, optional DI).
 *
 * Driven through `app.inject()` against the REAL `buildServer` wiring with in-memory doubles — no
 * Postgres, no wallet, no chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeployRegistryRow, Project } from "@nyx/protocol";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import type { Queryable } from "../../src/db/index.js";
import type { DeployRegistry } from "../../src/deploy/registry.js";
import { createMcpClients } from "../../src/mcp/index.js";
import type { McpSession } from "../../src/mcp/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import { InMemoryAuthStore } from "../auth/helpers.js";
import { InMemoryProjectStore } from "../projects/helpers.js";

// --- Harness ----------------------------------------------------------------

const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/nyx_test",
  MCP_TOOLCHAIN_URL: "http://toolchain.test.local/mcp",
  MCP_TOME_URL: "http://tome.test.local/mcp",
  MCP_MNM_URL: "http://mnm.test.local/mcp",
  PROVER_URL: "http://prover.test.local",
  COMPILE_SERVICE_URL: "http://compile.test.local",
  COMPILE_SERVICE_TOKEN: "test-compile-token",
  DEPLOY_KEY: "test-deploy-key",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_ACCOUNT_ID: "test-account-id",
  SESSION_LIFETIME_MS: "604800000",
  MODEL_ROUTING: JSON.stringify({
    supervisor: { provider: "anthropic", model: "claude" },
    scaffolding: { provider: "anthropic", model: "claude" },
    planning: { provider: "anthropic", model: "claude" },
    implementation: { provider: "anthropic", model: "claude" },
    review: { provider: "anthropic", model: "claude" },
  }),
};

const inertMcpSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: () => Promise.resolve(null),
  close: () => Promise.resolve(),
};

function stubDb(): Queryable {
  return {
    query: <R extends QueryResultRow>(): Promise<QueryResult<R>> =>
      Promise.resolve({ command: "SELECT", rowCount: 1, oid: 0, rows: [], fields: [] }),
  };
}

/** A deploy registry double that RECORDS each `teardownProject` call (scenario-8 assertion). */
class SpyDeployRegistry implements Pick<DeployRegistry, "listDeploys" | "teardownProject"> {
  readonly torndown: string[] = [];
  private readonly rows = new Map<string, DeployRegistryRow[]>();

  seed(projectId: string, rows: DeployRegistryRow[]): void {
    this.rows.set(projectId, rows);
  }

  listDeploys(projectId: string): Promise<DeployRegistryRow[]> {
    return Promise.resolve([...(this.rows.get(projectId) ?? [])]);
  }

  teardownProject(projectId: string): Promise<number> {
    this.torndown.push(projectId);
    const count = this.rows.get(projectId)?.length ?? 0;
    this.rows.delete(projectId);
    return Promise.resolve(count);
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly registry?: SpyDeployRegistry;
  readonly seedSession: (address: string) => Promise<string>;
  readonly createProject: (cookie: string, name?: string) => Promise<Project>;
}

async function boot(opts: { withRegistry: boolean } = { withRegistry: true }): Promise<Harness> {
  const config = loadConfig(TEST_ENV);
  const mcp = createMcpClients(config.mcp, () => Promise.resolve(inertMcpSession));
  const now = 1_000_000;
  const authStore = new InMemoryAuthStore({
    clock: () => now,
    sessionLifetimeMs: 604_800_000,
    nonceTtlMs: 300_000,
  });
  const projectStore = new InMemoryProjectStore({
    clock: () => now,
    maxFileBytes: 64,
    maxProjectBytes: 256,
    projectQuotaPerAccount: 5,
    versionRetentionCount: 2,
    versionRetentionDays: 30,
    deletionRecoveryDays: 30,
  });
  const registry = opts.withRegistry ? new SpyDeployRegistry() : undefined;
  const app = await buildServer({
    config,
    db: stubDb(),
    mcp,
    authStore,
    projectStore,
    ...(registry === undefined ? {} : { deployRegistry: registry }),
  });
  await app.ready();

  const seedSession = async (address: string): Promise<string> => {
    const { nonce } = await authStore.issueNonce();
    const result = await authStore.issue({ nonce, accountAddress: address, verify: () => true });
    if (!result.ok) {
      throw new Error("failed to seed session");
    }
    return `${SESSION_COOKIE_NAME}=${result.sessionId}`;
  };

  const createProject = async (cookie: string, name = "demo"): Promise<Project> => {
    const response = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { name },
    });
    if (response.statusCode !== 201) {
      throw new Error(`create project failed: ${String(response.statusCode)}`);
    }
    return response.json<Project>();
  };

  return { app, ...(registry === undefined ? {} : { registry }), seedSession, createProject };
}

const OWNER = "owner-address";

let h: Harness;

afterEach(async () => {
  await h.app.close();
});

// --- Tests ------------------------------------------------------------------

describe("buildServer: deletion cascade contract-teardown back-fill (D49/T158/scenario 8)", () => {
  beforeEach(async () => {
    h = await boot({ withRegistry: true });
  });

  it("tears down the project's deploy registry rows on DELETE (OFF-CHAIN, T155)", async () => {
    const cookie = await h.seedSession(OWNER);
    const project = await h.createProject(cookie);
    h.registry?.seed(project.id, []);

    const response = await h.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    // The cascade's contract-teardown seam fired against the deploy registry (was a US7 no-op).
    expect(h.registry?.torndown).toEqual([project.id]);
  });
});

describe("buildServer: no deploy registry ⇒ cascade teardown stays a no-op (optional DI)", () => {
  beforeEach(async () => {
    h = await boot({ withRegistry: false });
  });

  it("soft-deletes a project without a registry, cascade teardown a no-op (US7 behaviour)", async () => {
    const cookie = await h.seedSession(OWNER);
    const project = await h.createProject(cookie);

    const response = await h.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Project>().deletedAt).toBeGreaterThan(0);
    expect(h.registry).toBeUndefined();
  });
});
