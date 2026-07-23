/**
 * Deploy read route tests (T156/US8, FR-057) — `GET /projects/:id/deploys`, driven through
 * `app.inject()` against the REAL `buildServer` wiring with injected in-memory auth + project
 * stores + an in-memory deploy registry, so they are deterministic with NO Postgres, NO wallet,
 * NO chain.
 *
 * Coverage (SC-027 ownership matrix + wire encoding):
 *  - OWNED — the owner gets the registry rows, newest-first, `version` as a decimal STRING on the
 *    wire (JSON-safe via `encodeDeployRegistryRow`);
 *  - NOT OWNED — a different account 404s (existence never leaks, SC-027);
 *  - UNKNOWN — a project that does not exist 404s (same 404 as not-owned);
 *  - ANON — no session 401s.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeployRegistryRowSchema, encodeDeployRegistryRow } from "@nyx/protocol";
import type { DeployRegistryRow, DeployRegistryRowWire, Project } from "@nyx/protocol";
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
  MCP_TOME_URL: "http://tome.test.local/mcp",
  MCP_MNM_URL: "http://mnm.test.local/mcp",
  PROVER_URL: "http://prover.test.local",
  DEPLOY_KEY: "test-deploy-key",
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

/** In-memory {@link DeployRegistry} slice the route + cascade use (seeded per project). */
class InMemoryDeployRegistry implements Pick<DeployRegistry, "listDeploys" | "teardownProject"> {
  private readonly rows = new Map<string, DeployRegistryRow[]>();

  seed(projectId: string, rows: DeployRegistryRow[]): void {
    this.rows.set(projectId, rows);
  }

  listDeploys(projectId: string): Promise<DeployRegistryRow[]> {
    return Promise.resolve([...(this.rows.get(projectId) ?? [])]);
  }

  teardownProject(projectId: string): Promise<number> {
    const count = this.rows.get(projectId)?.length ?? 0;
    this.rows.delete(projectId);
    return Promise.resolve(count);
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly registry: InMemoryDeployRegistry;
  readonly seedSession: (address: string) => Promise<string>;
  readonly createProject: (cookie: string, name?: string) => Promise<Project>;
}

async function boot(): Promise<Harness> {
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
  const registry = new InMemoryDeployRegistry();
  const app = await buildServer({
    config,
    db: stubDb(),
    mcp,
    authStore,
    projectStore,
    deployRegistry: registry,
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

  return { app, registry, seedSession, createProject };
}

/** Build a valid registry row for `projectId` (version in on-code `bigint`, wire is via encode). */
function makeRow(projectId: string, version: string, status = "active"): DeployRegistryRow {
  return DeployRegistryRowSchema.parse({
    projectId,
    address: `contract-${version}`,
    version,
    status,
    deployedAt: 1_700_000_000_000 + Number(version),
    txRef: `tx-${version}`,
  });
}

const OWNER = "owner-address";
const OTHER = "other-address";

let h: Harness;
let ownerCookie: string;
let otherCookie: string;

beforeEach(async () => {
  h = await boot();
  ownerCookie = await h.seedSession(OWNER);
  otherCookie = await h.seedSession(OTHER);
});

afterEach(async () => {
  await h.app.close();
});

// --- Tests ------------------------------------------------------------------

describe("GET /projects/:id/deploys (US8, T156)", () => {
  it("returns the registry rows (newest-first, string version on the wire) for an OWNED project", async () => {
    const project = await h.createProject(ownerCookie);
    const rows: DeployRegistryRow[] = [
      makeRow(project.id, "2", "active"),
      makeRow(project.id, "1", "superseded"),
    ];
    h.registry.seed(project.id, rows);

    const response = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/deploys`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<DeployRegistryRowWire[]>();
    // Wire form: `version` is a decimal STRING, order preserved as the registry returned it.
    expect(body).toEqual(rows.map(encodeDeployRegistryRow));
    expect(body.map((row) => row.version)).toEqual(["2", "1"]);
    expect(typeof body[0]?.version).toBe("string");
  });

  it("returns an empty array for an owned project with no deploys yet", async () => {
    const project = await h.createProject(ownerCookie);
    const response = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/deploys`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<DeployRegistryRowWire[]>()).toEqual([]);
  });

  it("404s a project owned by a DIFFERENT account (existence never leaks, SC-027)", async () => {
    const project = await h.createProject(ownerCookie);
    h.registry.seed(project.id, [makeRow(project.id, "1")]);

    const response = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/deploys`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("project not found");
  });

  it("404s an UNKNOWN project (same 404 as not-owned)", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/projects/does-not-exist/deploys",
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("401s an unauthenticated request", async () => {
    const project = await h.createProject(ownerCookie);
    const response = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/deploys`,
    });
    expect(response.statusCode).toBe(401);
  });
});
