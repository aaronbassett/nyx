/**
 * Artifact HTTP route tests (P2 — browser-compile artifact upload + serve, Task 6) —
 * driven through `app.inject()` against the real `buildServer` wiring with injected
 * in-memory auth + project + artifact stores, so they are fully deterministic with NO
 * external Postgres, NO wallet, and NO browser upload.
 *
 * Coverage:
 *  - owner PUT + commit + GET round-trip: a file uploads (204), the manifest-last commit
 *    marks the prefix complete (204), and the session-less public GET serves the manifest
 *    and the file with its stored content-type (200);
 *  - SC-027 ownership: a non-owner PUT answers 404 (never 403 — existence never leaks);
 *    an unauthenticated PUT answers 401;
 *  - verify-before-serve: a GET against an un-committed prefix answers 404 (never serves a
 *    half-uploaded prefix), even though the file bytes are staged;
 *  - store-error mapping: an oversize PUT → 413; a commit whose manifest lists a file that
 *    was never uploaded → 422 carrying the offending `path`; an invalid source hash → 400;
 *  - HEAD on a listed file → 200 (Fastify serves HEAD for a GET route).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import type { Project } from "@nyx/protocol";
import type { ArtifactManifest } from "../../src/compile/index.js";
import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createMcpClients } from "../../src/mcp/index.js";
import type { McpSession } from "../../src/mcp/index.js";
import type { Queryable } from "../../src/db/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import { createInMemoryArtifactStore } from "../../src/artifacts/index.js";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import { InMemoryAuthStore } from "../auth/helpers.js";
import { InMemoryProjectStore, makeInMemoryStore } from "../projects/helpers.js";

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

const SESSION_LIFETIME_MS = 604_800_000;
const NONCE_TTL_MS = 300_000;

const OWNER = "owner-address";
const OTHER = "other-address";

/** A syntactically-valid lowercase-hex SHA-256 `sourceHash` (the immutable prefix key). */
const SOURCE_HASH = "a".repeat(64);
const FILE_PATH = "keys/increment.prover";
const FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const FILE_CONTENT_TYPE = "application/octet-stream";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A complete manifest for {@link FILE_PATH}. */
function completeManifest(): ArtifactManifest {
  return {
    sourceHash: SOURCE_HASH,
    compilerVersion: "0.31.1",
    circuits: [{ name: "increment", proof: true }],
    files: [
      {
        path: FILE_PATH,
        sha256: sha256Hex(FILE_BYTES),
        bytes: FILE_BYTES.byteLength,
        contentType: FILE_CONTENT_TYPE,
      },
    ],
  };
}

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

interface ArtifactHarness {
  readonly app: FastifyInstance;
  readonly store: InMemoryProjectStore;
  readonly artifacts: ArtifactStore;
  readonly seedSession: (address: string) => Promise<string>;
}

/** Boot the real server wiring with in-memory auth + project + artifact stores. */
async function bootArtifacts(artifacts?: ArtifactStore): Promise<ArtifactHarness> {
  const config = loadConfig(TEST_ENV);
  const mcp = createMcpClients(config.mcp, () => Promise.resolve(inertMcpSession));
  const clock = { now: 1_000_000 };
  const authStore = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: NONCE_TTL_MS,
  });
  const store = makeInMemoryStore(clock);
  const artifactStore = artifacts ?? createInMemoryArtifactStore();
  const app = await buildServer({
    config,
    db: stubDb(),
    mcp,
    authStore,
    projectStore: store,
    artifactStore,
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

  return { app, store, artifacts: artifactStore, seedSession };
}

let h: ArtifactHarness;
let ownerCookie: string;
let otherCookie: string;

beforeEach(async () => {
  h = await bootArtifacts();
  ownerCookie = await h.seedSession(OWNER);
  otherCookie = await h.seedSession(OTHER);
});

afterEach(async () => {
  await h.app.close();
});

/** Create a project owned by the owner session and return its DTO. */
async function createOwned(): Promise<Project> {
  const response = await h.app.inject({
    method: "POST",
    url: "/projects",
    headers: { cookie: ownerCookie },
    payload: { name: "demo" },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Project>();
}

/** PUT the fixture file for `projectId`, returning the raw inject response. */
async function putFixtureFile(projectId: string, cookie: string | undefined) {
  return h.app.inject({
    method: "PUT",
    url: `/projects/${projectId}/artifacts/${SOURCE_HASH}/files/${FILE_PATH}`,
    ...(cookie === undefined ? {} : { headers: { cookie, "content-type": FILE_CONTENT_TYPE } }),
    payload: Buffer.from(FILE_BYTES),
  });
}

describe("artifact upload + serve round-trip", () => {
  it("PUTs a file, commits the manifest, and serves both over the public GET", async () => {
    const project = await createOwned();

    const put = await putFixtureFile(project.id, ownerCookie);
    expect(put.statusCode).toBe(204);

    const commit = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/commit`,
      headers: { cookie: ownerCookie },
      payload: completeManifest(),
    });
    expect(commit.statusCode).toBe(204);

    // Session-LESS public read: the manifest.
    const manifest = await h.app.inject({
      method: "GET",
      url: `/artifacts/${project.id}/${SOURCE_HASH}/manifest.json`,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json<ArtifactManifest>().sourceHash).toBe(SOURCE_HASH);

    // Session-less public read: the file, served with its stored content-type.
    const file = await h.app.inject({
      method: "GET",
      url: `/artifacts/${project.id}/${SOURCE_HASH}/${FILE_PATH}`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain(FILE_CONTENT_TYPE);
    expect(new Uint8Array(file.rawPayload)).toEqual(FILE_BYTES);
  });

  it("serves HEAD for a listed file with 200 and no body", async () => {
    const project = await createOwned();
    expect((await putFixtureFile(project.id, ownerCookie)).statusCode).toBe(204);
    await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/commit`,
      headers: { cookie: ownerCookie },
      payload: completeManifest(),
    });

    const head = await h.app.inject({
      method: "HEAD",
      url: `/artifacts/${project.id}/${SOURCE_HASH}/${FILE_PATH}`,
    });
    expect(head.statusCode).toBe(200);
  });
});

describe("ownership + auth (SC-027)", () => {
  it("answers 404 (never 403) for a non-owner PUT", async () => {
    const project = await createOwned();
    const put = await putFixtureFile(project.id, otherCookie);
    expect(put.statusCode).toBe(404);
  });

  it("answers 401 for an unauthenticated PUT", async () => {
    const project = await createOwned();
    const put = await h.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/files/${FILE_PATH}`,
      headers: { "content-type": FILE_CONTENT_TYPE },
      payload: Buffer.from(FILE_BYTES),
    });
    expect(put.statusCode).toBe(401);
  });

  it("answers 404 for a commit against a project the caller does not own", async () => {
    const project = await createOwned();
    const commit = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/commit`,
      headers: { cookie: otherCookie },
      payload: completeManifest(),
    });
    expect(commit.statusCode).toBe(404);
  });
});

describe("verify-before-serve", () => {
  it("answers 404 for a GET against a staged-but-uncommitted prefix", async () => {
    const project = await createOwned();
    // File bytes are staged, but there is NO commit → the prefix is not complete.
    expect((await putFixtureFile(project.id, ownerCookie)).statusCode).toBe(204);

    const file = await h.app.inject({
      method: "GET",
      url: `/artifacts/${project.id}/${SOURCE_HASH}/${FILE_PATH}`,
    });
    expect(file.statusCode).toBe(404);

    const manifest = await h.app.inject({
      method: "GET",
      url: `/artifacts/${project.id}/${SOURCE_HASH}/manifest.json`,
    });
    expect(manifest.statusCode).toBe(404);
  });

  it("answers 404 for a GET against an entirely unknown prefix", async () => {
    const project = await createOwned();
    const file = await h.app.inject({
      method: "GET",
      url: `/artifacts/${project.id}/${SOURCE_HASH}/does/not/exist`,
    });
    expect(file.statusCode).toBe(404);
  });
});

describe("store-error mapping", () => {
  it("answers 413 for an oversize PUT", async () => {
    const capped = await bootArtifacts(createInMemoryArtifactStore({ maxFileBytes: 4 }));
    const cookie = await capped.seedSession(OWNER);
    const created = await capped.app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { name: "demo" },
    });
    const project = created.json<Project>();
    const put = await capped.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/files/${FILE_PATH}`,
      headers: { cookie, "content-type": FILE_CONTENT_TYPE },
      payload: Buffer.from(FILE_BYTES),
    });
    expect(put.statusCode).toBe(413);
    await capped.app.close();
  });

  it("answers 422 with the offending path for a commit missing an uploaded file", async () => {
    const project = await createOwned();
    // No PUT — the manifest lists a file that was never uploaded.
    const commit = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/commit`,
      headers: { cookie: ownerCookie },
      payload: completeManifest(),
    });
    expect(commit.statusCode).toBe(422);
    expect(commit.json<{ path: string }>().path).toBe(FILE_PATH);
  });

  it("answers 422 with the offending path for a commit whose hash mismatches", async () => {
    const project = await createOwned();
    expect((await putFixtureFile(project.id, ownerCookie)).statusCode).toBe(204);
    const manifest = completeManifest();
    const commit = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/commit`,
      headers: { cookie: ownerCookie },
      payload: { ...manifest, files: [{ ...manifest.files[0], sha256: "deadbeef" }] },
    });
    expect(commit.statusCode).toBe(422);
    expect(commit.json<{ path: string }>().path).toBe(FILE_PATH);
  });

  it("answers 400 for an invalid source hash on PUT", async () => {
    const project = await createOwned();
    const put = await h.app.inject({
      method: "PUT",
      url: `/projects/${project.id}/artifacts/not-a-hash/files/${FILE_PATH}`,
      headers: { cookie: ownerCookie, "content-type": FILE_CONTENT_TYPE },
      payload: Buffer.from(FILE_BYTES),
    });
    expect(put.statusCode).toBe(400);
  });

  it("answers 400 for a malformed manifest body on commit", async () => {
    const project = await createOwned();
    const commit = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/artifacts/${SOURCE_HASH}/commit`,
      headers: { cookie: ownerCookie },
      payload: { not: "a manifest" },
    });
    expect(commit.statusCode).toBe(400);
  });
});
