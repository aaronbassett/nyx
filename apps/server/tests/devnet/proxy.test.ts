/**
 * Devnet forwarding-proxy tests (P3 Task 1) — the session-authenticated,
 * same-origin DEVNET PROXY that lets the isolated (COOP/COEP) browser reach the
 * local devnet node/indexer through the Nyx server. Structurally mirrors the
 * prover-proxy tests: driven through `app.inject()` (HTTP) and a real ephemeral
 * `listen()` + `ws` client (the WS relay), with an in-memory auth store to mint a
 * real session cookie and FAKE forwarders/echo servers — fully deterministic,
 * NO external Postgres, NO wallet, NO live devnet.
 *
 * Coverage (constitution I — the proxy is a TRANSPARENT byte/frame relay; it
 * never parses node/indexer payloads as SDK shapes; constitution III — auth
 * GATES every forward and every upgrade):
 *  - createDevnetForwarder: method/subpath/query/body/content-type relayed
 *    verbatim to `<baseUrl><subpath>?<query>`, response mapped back; a `fetch`
 *    throw becomes a named {@link DevnetUnavailableError}; GET sends no body.
 *  - routes: unauthenticated → 401 no forward; authenticated relay verbatim;
 *    forwarder throw → 502 `{"error":"devnet unreachable"}`; sibling JSON routes
 *    still parse JSON (buffer parser stayed encapsulated); subpath+query join.
 *  - WS relay: unauthenticated upgrade rejected (no session); frames relayed both
 *    directions against a local `ws` echo server; close propagation both ways.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { AddressInfo } from "node:net";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequireSession } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import {
  createDevnetForwarder,
  createDevnetWsRelay,
  DevnetUnavailableError,
  httpToWs,
  registerDevnetRoutes,
} from "../../src/devnet/index.js";
import type {
  DevnetForwarder,
  DevnetWsRelay,
  ForwardRequest,
  ForwardResult,
} from "../../src/devnet/index.js";
import { InMemoryAuthStore } from "../auth/helpers.js";

const SESSION_LIFETIME_MS = 604_800_000;
const NONCE_TTL_MS = 300_000;
const OWNER = "owner-address";

/** The minimal env `loadConfig` requires; mirrors the prover/auth test harness. */
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

/** How a fake forwarder should respond to a `forward` call. */
interface FakeBehavior {
  readonly result?: ForwardResult;
  readonly reject?: Error;
}

/** A fake {@link DevnetForwarder} that records every relayed request. */
class FakeForwarder implements DevnetForwarder {
  readonly calls: ForwardRequest[] = [];

  constructor(private readonly behavior: FakeBehavior) {}

  forward(request: ForwardRequest): Promise<ForwardResult> {
    this.calls.push(request);
    if (this.behavior.reject !== undefined) {
      return Promise.reject(this.behavior.reject);
    }
    if (this.behavior.result === undefined) {
      return Promise.reject(new Error("fake forwarder has no configured result"));
    }
    return Promise.resolve(this.behavior.result);
  }
}

function okResult(): ForwardResult {
  return { status: 200, body: Buffer.from([0x01, 0x02, 0x03]), contentType: "application/scale" };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly node: FakeForwarder;
  readonly indexer: FakeForwarder;
  readonly seedSession: (address: string) => Promise<string>;
}

const started: FastifyInstance[] = [];
const openSockets: WsWebSocket[] = [];
const wsServers: WebSocketServer[] = [];

afterEach(async () => {
  for (const sock of openSockets.splice(0)) {
    sock.removeAllListeners();
    sock.terminate();
  }
  await Promise.all(
    wsServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/** Boot a Fastify app wired with the devnet routes + a session gate + a JSON probe. */
async function boot(options: {
  readonly node: FakeForwarder;
  readonly indexer: FakeForwarder;
  readonly nodeWsRelay?: DevnetWsRelay;
  readonly indexerWsRelay?: DevnetWsRelay;
}): Promise<Harness> {
  const config = loadConfig(TEST_ENV);
  const clock = { now: 1_000_000 };
  const authStore = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: NONCE_TTL_MS,
  });
  const requireSession = createRequireSession({ store: authStore, config });

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  // Sibling JSON route on the ROOT scope: proves the devnet buffer parser stayed
  // encapsulated (this route must still parse JSON bodies).
  app.post("/probe", (request) => ({ echo: request.body }));

  const nullRelay: DevnetWsRelay = { relay: () => undefined };
  registerDevnetRoutes(app, {
    nodeForwarder: options.node,
    indexerForwarder: options.indexer,
    requireSession,
    nodeWsRelay: options.nodeWsRelay ?? nullRelay,
    indexerWsRelay: options.indexerWsRelay ?? nullRelay,
  });
  await app.ready();
  started.push(app);

  const seedSession = async (address: string): Promise<string> => {
    const { nonce } = await authStore.issueNonce();
    const result = await authStore.issue({ nonce, accountAddress: address, verify: () => true });
    if (!result.ok) {
      throw new Error("failed to seed session");
    }
    return `${SESSION_COOKIE_NAME}=${result.sessionId}`;
  };

  return { app, node: options.node, indexer: options.indexer, seedSession };
}

// ── createDevnetForwarder (HTTP seam, injected fetch) ────────────────────────

describe("createDevnetForwarder", () => {
  it("relays method, subpath, query, body and content-type verbatim", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = ((url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response(Buffer.from("ok-bytes"), {
          status: 201,
          headers: { "content-type": "application/scale" },
        }),
      );
    }) as typeof fetch;

    const forwarder = createDevnetForwarder({ baseUrl: "http://node:9944", fetch: fakeFetch });
    const result = await forwarder.forward({
      method: "POST",
      subpath: "/api/foo",
      query: "x=1",
      body: Buffer.from([1, 2, 3]),
      contentType: "application/json",
    });

    expect(calls[0]?.url).toBe("http://node:9944/api/foo?x=1");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(Buffer.from(calls[0]?.init.body as Uint8Array).equals(Buffer.from([1, 2, 3]))).toBe(
      true,
    );
    expect(result.status).toBe(201);
    expect(result.contentType).toBe("application/scale");
    expect(Buffer.compare(result.body, Buffer.from("ok-bytes"))).toBe(0);
  });

  it("joins a trailing-slash baseUrl and a slashless subpath without doubling", async () => {
    const calls: string[] = [];
    const fakeFetch = ((url: unknown) => {
      calls.push(String(url));
      return Promise.resolve(new Response(Buffer.alloc(0), { status: 200 }));
    }) as typeof fetch;

    const forwarder = createDevnetForwarder({ baseUrl: "http://node:9944/", fetch: fakeFetch });
    await forwarder.forward({
      method: "GET",
      subpath: "api/foo",
      query: "",
      body: undefined,
      contentType: undefined,
    });

    expect(calls[0]).toBe("http://node:9944/api/foo");
  });

  it("sends no body on a GET", async () => {
    let seenBody: unknown = "SENTINEL";
    const fakeFetch = ((_url: unknown, init?: RequestInit) => {
      seenBody = init?.body;
      return Promise.resolve(new Response(Buffer.alloc(0), { status: 200 }));
    }) as typeof fetch;

    const forwarder = createDevnetForwarder({ baseUrl: "http://node:9944", fetch: fakeFetch });
    await forwarder.forward({
      method: "GET",
      subpath: "/health",
      query: "",
      body: undefined,
      contentType: undefined,
    });

    expect(seenBody).toBeUndefined();
  });

  it("maps a fetch transport throw to a named DevnetUnavailableError", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const forwarder = createDevnetForwarder({ baseUrl: "http://node:9944", fetch: fetchMock });

    await expect(
      forwarder.forward({
        method: "GET",
        subpath: "/x",
        query: "",
        body: undefined,
        contentType: undefined,
      }),
    ).rejects.toBeInstanceOf(DevnetUnavailableError);
  });
});

// ── HTTP routes ──────────────────────────────────────────────────────────────

describe("devnet routes — auth gates every forward (constitution III)", () => {
  it("rejects an unauthenticated node request with 401 and never forwards", async () => {
    const node = new FakeForwarder({ result: okResult() });
    const h = await boot({ node, indexer: new FakeForwarder({ result: okResult() }) });

    const response = await h.app.inject({
      method: "POST",
      url: "/devnet/node/api/foo",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("req"),
    });

    expect(response.statusCode).toBe(401);
    expect(node.calls).toHaveLength(0);
  });
});

describe("devnet routes — transparent same-origin forward", () => {
  it("relays the POST body + content-type and round-trips status/body/content-type", async () => {
    const respBytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f]);
    const node = new FakeForwarder({
      result: { status: 200, body: respBytes, contentType: "application/scale" },
    });
    const h = await boot({ node, indexer: new FakeForwarder({ result: okResult() }) });
    const cookie = await h.seedSession(OWNER);
    const reqBytes = Buffer.from("serialized-tx-bytes");

    const response = await h.app.inject({
      method: "POST",
      url: "/devnet/node/api/submit",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: reqBytes,
    });

    expect(node.calls).toHaveLength(1);
    const forwarded = node.calls[0];
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.body?.equals(reqBytes)).toBe(true);
    expect(forwarded?.contentType).toBe("application/octet-stream");

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/scale");
    expect(response.rawPayload.equals(respBytes)).toBe(true);
  });

  it("preserves the subpath and query when forwarding (GET, indexer prefix)", async () => {
    const indexer = new FakeForwarder({ result: okResult() });
    const h = await boot({ node: new FakeForwarder({ result: okResult() }), indexer });
    const cookie = await h.seedSession(OWNER);

    const response = await h.app.inject({
      method: "GET",
      url: "/devnet/indexer/api/v4/graphql?x=1&y=2",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(indexer.calls).toHaveLength(1);
    const forwarded = indexer.calls[0];
    expect(forwarded?.method).toBe("GET");
    expect(forwarded?.subpath).toBe("/api/v4/graphql");
    expect(forwarded?.query).toBe("x=1&y=2");
    expect(forwarded?.body).toBeUndefined();
  });

  it("maps a forwarder throw to a 502 with a structured error (no internals leaked)", async () => {
    const node = new FakeForwarder({ reject: new DevnetUnavailableError("http://node:9944/x") });
    const h = await boot({ node, indexer: new FakeForwarder({ result: okResult() }) });
    const cookie = await h.seedSession(OWNER);

    const response = await h.app.inject({
      method: "POST",
      url: "/devnet/node/x",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("req"),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "devnet unreachable" });
    expect(node.calls).toHaveLength(1);
  });
});

describe("devnet routes — the buffer parser stays encapsulated", () => {
  it("leaves sibling JSON routes parsing JSON", async () => {
    const h = await boot({
      node: new FakeForwarder({ result: okResult() }),
      indexer: new FakeForwarder({ result: okResult() }),
    });

    const response = await h.app.inject({
      method: "POST",
      url: "/probe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ hello: "world" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ echo: { hello: "world" } });
  });
});

// ── httpToWs helper ──────────────────────────────────────────────────────────

describe("httpToWs", () => {
  it("maps http→ws and https→wss, preserving host/port/path", () => {
    expect(httpToWs("http://localhost:9944")).toBe("ws://localhost:9944");
    expect(httpToWs("https://indexer.example:8088/api/v4/graphql")).toBe(
      "wss://indexer.example:8088/api/v4/graphql",
    );
  });
});

// ── WS relay ─────────────────────────────────────────────────────────────────

/** A local `ws` echo server; on the literal frame "close" it closes its side. */
function startEchoServer(): Promise<{ url: string; connections: WsWebSocket[] }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const connections: WsWebSocket[] = [];
    wsServers.push(server);
    server.on("connection", (socket) => {
      connections.push(socket);
      socket.on("message", (data: RawData, isBinary: boolean) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!isBinary && buf.toString("utf8") === "close") {
          socket.close(1000, "echo-close");
          return;
        }
        socket.send(data, { binary: isBinary });
      });
    });
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${String(port)}`, connections });
    });
  });
}

function connectWs(url: string, cookie?: string): WsWebSocket {
  const headers = cookie === undefined ? {} : { cookie };
  const sock = new WsWebSocket(url, { headers });
  openSockets.push(sock);
  return sock;
}

function waitOpen(sock: WsWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.once("open", () => {
      resolve();
    });
    sock.once("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function waitMessage(sock: WsWebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    sock.once("message", (data: RawData) => {
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
  });
}

function waitClose(sock: WsWebSocket): Promise<number> {
  return new Promise((resolve) => {
    sock.once("close", (code: number) => {
      resolve(code);
    });
  });
}

async function bootWs(
  nodeTargetUrl: string,
): Promise<{ port: number; seedSession: (a: string) => Promise<string> }> {
  const node = new FakeForwarder({ result: okResult() });
  const indexer = new FakeForwarder({ result: okResult() });
  const nodeWsRelay = createDevnetWsRelay({ targetUrl: nodeTargetUrl });
  const h = await boot({ node, indexer, nodeWsRelay });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = h.app.server.address() as AddressInfo;
  return { port, seedSession: h.seedSession };
}

describe("devnet WS relay — auth gates the upgrade (constitution III)", () => {
  it("rejects an unauthenticated upgrade (no session cookie)", async () => {
    const echo = await startEchoServer();
    const { port } = await bootWs(echo.url);

    const sock = connectWs(`ws://127.0.0.1:${String(port)}/devnet/node/`);
    await expect(waitOpen(sock)).rejects.toThrow();
  });
});

describe("devnet WS relay — transparent frame relay against a local echo server", () => {
  it("relays frames from browser → upstream → browser verbatim", async () => {
    const echo = await startEchoServer();
    const { port, seedSession } = await bootWs(echo.url);
    const cookie = await seedSession(OWNER);

    const sock = connectWs(`ws://127.0.0.1:${String(port)}/devnet/node/`, cookie);
    await waitOpen(sock);

    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const echoed = waitMessage(sock);
    sock.send(payload);
    expect((await echoed).equals(payload)).toBe(true);
  });

  it("propagates an upstream close to the browser socket", async () => {
    const echo = await startEchoServer();
    const { port, seedSession } = await bootWs(echo.url);
    const cookie = await seedSession(OWNER);

    const sock = connectWs(`ws://127.0.0.1:${String(port)}/devnet/node/`, cookie);
    await waitOpen(sock);

    const closed = waitClose(sock);
    sock.send("close"); // the echo server closes its side on this literal frame
    expect(await closed).toBe(1000);
  });

  it("propagates a browser close to the upstream socket", async () => {
    const echo = await startEchoServer();
    const { port, seedSession } = await bootWs(echo.url);
    const cookie = await seedSession(OWNER);

    const sock = connectWs(`ws://127.0.0.1:${String(port)}/devnet/node/`, cookie);
    await waitOpen(sock);
    // Wait until the upstream connection has actually been accepted before closing.
    await vi.waitFor(() => {
      expect(echo.connections.length).toBe(1);
    });
    const upstream = echo.connections[0];
    if (upstream === undefined) {
      throw new Error("no upstream connection");
    }
    const upstreamClosed = waitClose(upstream);
    sock.close(1000, "bye");
    expect(await upstreamClosed).toBe(1000);
  });
});
