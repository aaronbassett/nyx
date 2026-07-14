/**
 * Foundation integration test (T024).
 *
 * Exercises the REAL running system (constitution IV): it boots `buildServer`
 * with an in-memory {@link SessionStore} + stub db/mcp, `listen`s on an ephemeral
 * port, and drives it with a real `ws` client. Asserts authenticated connect,
 * the typed round-trip, D40 takeover, and DB-free readiness.
 *
 * Fully deterministic with NO external Postgres: the session store is in-memory
 * and the db is a stub that answers the readiness SELECT.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildServer } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";
import { createMcpClients } from "../src/mcp/index.js";
import type { McpSession } from "../src/mcp/index.js";
import type { Queryable } from "../src/db/index.js";
import { SESSION_COOKIE_NAME, WS_CLOSE, createWsHandler } from "../src/protocol/index.js";
import type { Session, SessionStore } from "../src/protocol/index.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A complete, valid env so `loadConfig` returns a real Config (no secrets leak). */
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
  MODEL_ROUTING: JSON.stringify({
    supervisor: { provider: "anthropic", model: "claude" },
    scaffolding: { provider: "anthropic", model: "claude" },
    planning: { provider: "anthropic", model: "claude" },
    implementation: { provider: "anthropic", model: "claude" },
    review: { provider: "anthropic", model: "claude" },
  }),
};

/** Stub db: answers the readiness SELECT, needs no Postgres. */
function stubDb(): Queryable {
  return {
    query: <R extends QueryResultRow>(): Promise<QueryResult<R>> =>
      Promise.resolve({
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        rows: [{ ok: 1 } as unknown as R],
        fields: [],
      }),
  };
}

/** An MCP session that never touches the network (never probed in this suite). */
const inertMcpSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: () => Promise.resolve(null),
  close: () => Promise.resolve(),
};

/**
 * In-memory SessionStore. A session id maps to an entry flagged valid or not;
 * invalid entries model expired/revoked (both resolve to `null`, exactly the WS
 * layer's view — the DB decides *why* they are invalid, covered in session.test).
 */
interface SeedEntry {
  readonly session: Session;
  readonly valid: boolean;
}

const SEED: ReadonlyMap<string, SeedEntry> = new Map([
  ["sess-valid", { session: { accountAddress: "addrA" }, valid: true }],
  ["sess-expired", { session: { accountAddress: "addrA" }, valid: false }],
  ["sess-revoked", { session: { accountAddress: "addrB" }, valid: false }],
]);

const memoryStore: SessionStore = {
  get: (sessionId) => {
    const entry = SEED.get(sessionId);
    return Promise.resolve(entry?.valid === true ? entry.session : null);
  },
};

// ── Boot + client helpers ────────────────────────────────────────────────────

interface Booted {
  readonly app: FastifyInstance;
  readonly port: number;
  /** Client → server `console:log` messages the server handler received. */
  readonly received: string[];
}

async function boot(): Promise<Booted> {
  const config = loadConfig(TEST_ENV);
  const mcp = createMcpClients(config.mcp, () => Promise.resolve(inertMcpSession));
  const received: string[] = [];

  const wsHandler = createWsHandler({
    sessionStore: memoryStore,
    config,
    now: () => 1,
    handlers: (router) => {
      router.on("console:log", (event, ctx) => {
        received.push(event.payload.message);
        ctx.send({
          type: "deploy:status",
          payload: { requestId: "r1", phase: "proving" },
          ts: 1,
        });
      });
    },
  });

  const app = await buildServer({ config, db: stubDb(), mcp, wsHandler });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  return { app, port: address.port, received };
}

let current: Booted;
const clients: WebSocket[] = [];

function connect(opts: { cookie?: string; projectId?: string }): WebSocket {
  const query =
    opts.projectId === undefined ? "" : `?projectId=${encodeURIComponent(opts.projectId)}`;
  const headers = opts.cookie === undefined ? {} : { cookie: opts.cookie };
  const ws = new WebSocket(`ws://127.0.0.1:${String(current.port)}/ws${query}`, { headers });
  clients.push(ws);
  return ws;
}

function decode(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function waitMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data: RawData) => {
      const parsed: unknown = JSON.parse(decode(data));
      resolve(parsed as Record<string, unknown>);
    });
  });
}

const validCookie = `${SESSION_COOKIE_NAME}=sess-valid`;

beforeEach(async () => {
  current = await boot();
});

afterEach(async () => {
  for (const ws of clients.splice(0)) {
    ws.removeAllListeners();
    ws.terminate();
  }
  await current.app.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("foundation: authenticated connect + typed round-trip (T024)", () => {
  it("accepts a valid session + projectId and round-trips a typed event", async () => {
    const ws = connect({ cookie: validCookie, projectId: "proj1" });
    await waitOpen(ws);

    const reply = waitMessage(ws);
    ws.send(JSON.stringify({ type: "console:log", payload: { message: "ping" }, ts: 1 }));
    const event = await reply;

    // Server handler received the correctly-typed client → server payload.
    expect(current.received).toEqual(["ping"]);
    // Client received the server → client event the handler emitted.
    expect(event.type).toBe("deploy:status");
    expect(event.payload).toEqual({ requestId: "r1", phase: "proving" });
  });

  it("serves readiness with no external Postgres", async () => {
    const response = await current.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", db: "up" });
  });
});

describe("foundation: unauthenticated connects are rejected (T024)", () => {
  it("closes a connect with no session cookie", async () => {
    const ws = connect({ projectId: "proj1" });
    expect((await waitClose(ws)).code).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it("closes a connect with an unknown session cookie", async () => {
    const ws = connect({ cookie: `${SESSION_COOKIE_NAME}=sess-bogus`, projectId: "proj1" });
    expect((await waitClose(ws)).code).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it("closes a connect with an expired session cookie", async () => {
    const ws = connect({ cookie: `${SESSION_COOKIE_NAME}=sess-expired`, projectId: "proj1" });
    expect((await waitClose(ws)).code).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it("closes a connect with a revoked session cookie", async () => {
    const ws = connect({ cookie: `${SESSION_COOKIE_NAME}=sess-revoked`, projectId: "proj1" });
    expect((await waitClose(ws)).code).toBe(WS_CLOSE.UNAUTHENTICATED);
  });

  it("closes a connect that omits projectId", async () => {
    const ws = connect({ cookie: validCookie });
    expect((await waitClose(ws)).code).toBe(WS_CLOSE.BAD_REQUEST);
  });
});

describe("foundation: single-live-session takeover (D40, T024)", () => {
  it("displaces the first connection when a second arrives for the same (account, project)", async () => {
    const first = connect({ cookie: validCookie, projectId: "proj1" });
    await waitOpen(first);

    const takeover = waitMessage(first);
    const closed = waitClose(first);

    const second = connect({ cookie: validCookie, projectId: "proj1" });
    await waitOpen(second);

    expect((await takeover).type).toBe("session:takeover");
    expect((await closed).code).toBe(WS_CLOSE.SESSION_TAKEOVER);
  });
});
