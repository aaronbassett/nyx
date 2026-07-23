/**
 * Prover proxy tests (US6 — D37/D62) — the session-authenticated, same-origin
 * PROVER PROXY. Driven through `app.inject()` against a directly-wired Fastify
 * instance with an injected in-memory auth store (to mint a real session cookie)
 * and a FAKE {@link ProverClient}, so they are fully deterministic with NO
 * external Postgres, NO wallet, and NO real prover.
 *
 * Coverage:
 *  - AUTH GATES THE PROVER (constitution III): an unauthenticated request → 401
 *    and the fake `prove` is NEVER called (auth precedes any forward);
 *  - transparent forward: the exact opaque request bytes + content-type reach the
 *    client, and the prover's status + body + content-type round-trip back verbatim;
 *  - a prover HTTP error status is relayed as DATA (distinct from a transport 502);
 *  - a prover-client transport failure (the client rejects) → 502 with a structured
 *    error and no unhandled throw;
 *  - the injected per-session rate-limit SEAM: a denial → 429, prover not called,
 *    and the limiter receives the session identity;
 *  - the {@link createProverClient} HTTP seam: it POSTs the opaque body + content-type
 *    to the injected prover URL and maps the response, and a `fetch` throw becomes a
 *    named {@link ProverUnavailableError}.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequireSession } from "../../src/auth/index.js";
import { loadConfig } from "../../src/config/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import {
  createProverClient,
  ProverUnavailableError,
  registerProverRoutes,
} from "../../src/prover/proxy.js";
import type {
  ProverClient,
  ProverRateLimiter,
  ProxyRequest,
  ProxyResult,
  RateLimitContext,
} from "../../src/prover/proxy.js";
import { InMemoryAuthStore } from "../auth/helpers.js";

const SESSION_LIFETIME_MS = 604_800_000;
const NONCE_TTL_MS = 300_000;
const OWNER = "owner-address";

/** The minimal env `loadConfig` requires; mirrors the projects/auth test harness. */
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

/** How the fake prover client should respond to a `prove` call. */
interface FakeBehavior {
  /** Resolve with this opaque result. */
  readonly result?: ProxyResult;
  /** Reject with this error (a transport/gateway failure). */
  readonly reject?: Error;
}

/** A fake {@link ProverClient} that records every forwarded request. */
class FakeProverClient implements ProverClient {
  readonly calls: ProxyRequest[] = [];

  constructor(private readonly behavior: FakeBehavior) {}

  prove(request: ProxyRequest): Promise<ProxyResult> {
    this.calls.push(request);
    if (this.behavior.reject !== undefined) {
      return Promise.reject(this.behavior.reject);
    }
    if (this.behavior.result === undefined) {
      return Promise.reject(new Error("fake prover client has no configured result"));
    }
    return Promise.resolve(this.behavior.result);
  }
}

/** A trivially-successful proof response (opaque bytes + an opaque content-type). */
function okResult(): ProxyResult {
  return {
    status: 200,
    body: Buffer.from([0x01, 0x02, 0x03]),
    contentType: "application/x-midnight-proof",
  };
}

interface ProverHarness {
  readonly app: FastifyInstance;
  readonly client: FakeProverClient;
  /** Mint a real session for `address` and return the `Cookie` header value. */
  readonly seedSession: (address: string) => Promise<string>;
}

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/** Boot a Fastify app wired only with the prover routes + a session gate (no DB). */
async function bootProver(options: {
  readonly client: FakeProverClient;
  readonly rateLimiter?: ProverRateLimiter;
}): Promise<ProverHarness> {
  const config = loadConfig(TEST_ENV);
  const clock = { now: 1_000_000 };
  const authStore = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: NONCE_TTL_MS,
  });
  const requireSession = createRequireSession({ store: authStore, config });

  const app = Fastify({ logger: false });
  registerProverRoutes(app, {
    proverClient: options.client,
    requireSession,
    ...(options.rateLimiter === undefined ? {} : { rateLimiter: options.rateLimiter }),
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

  return { app, client: options.client, seedSession };
}

describe("POST /prover/prove — auth gates the prover (constitution III)", () => {
  it("rejects an unauthenticated prove with 401 and never reaches the prover", async () => {
    const client = new FakeProverClient({ result: okResult() });
    const h = await bootProver({ client });

    const response = await h.app.inject({
      method: "POST",
      url: "/prover/prove",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("serialized-proof-request"),
    });

    expect(response.statusCode).toBe(401);
    // The prover is NEVER contacted for an unauthenticated caller.
    expect(client.calls).toHaveLength(0);
  });
});

describe("POST /prover/prove — transparent same-origin forward", () => {
  it("forwards the opaque request body + content-type and relays status/body/content-type", async () => {
    const proofBytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f]);
    const client = new FakeProverClient({
      result: { status: 200, body: proofBytes, contentType: "application/x-midnight-proof" },
    });
    const h = await bootProver({ client });
    const cookie = await h.seedSession(OWNER);
    const requestBytes = Buffer.from("serialized-proof-request-bytes");

    const response = await h.app.inject({
      method: "POST",
      url: "/prover/prove",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: requestBytes,
    });

    // The EXACT request bytes + content-type reached the prover client.
    expect(client.calls).toHaveLength(1);
    const forwarded = client.calls[0];
    expect(forwarded?.body.equals(requestBytes)).toBe(true);
    expect(forwarded?.contentType).toBe("application/octet-stream");

    // The prover's status, body, and content-type round-trip back verbatim.
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-midnight-proof");
    expect(response.rawPayload.equals(proofBytes)).toBe(true);
  });

  it("relays a prover error STATUS as data (distinct from a transport 502)", async () => {
    const body = Buffer.from('{"error":"invalid request"}');
    const client = new FakeProverClient({
      result: { status: 400, body, contentType: "application/json" },
    });
    const h = await bootProver({ client });
    const cookie = await h.seedSession(OWNER);

    const response = await h.app.inject({
      method: "POST",
      url: "/prover/prove",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("req"),
    });

    // A prover HTTP response (even a 4xx) is DATA relayed unchanged, not our 502.
    expect(response.statusCode).toBe(400);
    expect(response.rawPayload.equals(body)).toBe(true);
    expect(client.calls).toHaveLength(1);
  });
});

describe("POST /prover/prove — transport failure maps to a 5xx (never leaks internals)", () => {
  it("maps a prover-client rejection to a 502 with a structured error", async () => {
    const client = new FakeProverClient({ reject: new ProverUnavailableError("prover.internal") });
    const h = await bootProver({ client });
    const cookie = await h.seedSession(OWNER);

    const response = await h.app.inject({
      method: "POST",
      url: "/prover/prove",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("req"),
    });

    expect(response.statusCode).toBe(502);
    const body = response.json<{ error: string }>();
    expect(body.error).toBeTypeOf("string");
    // The forward WAS attempted (the failure came from the prover client, not auth).
    expect(client.calls).toHaveLength(1);
  });
});

describe("POST /prover/prove — per-session rate-limit seam (S9/D52)", () => {
  it("returns 429 and never forwards when the injected limiter denies", async () => {
    const seen: RateLimitContext[] = [];
    const rateLimiter: ProverRateLimiter = {
      check: (context) => {
        seen.push(context);
        return { allowed: false, retryAfterMs: 2_000 };
      },
    };
    const client = new FakeProverClient({ result: okResult() });
    const h = await bootProver({ client, rateLimiter });
    const cookie = await h.seedSession(OWNER);

    const response = await h.app.inject({
      method: "POST",
      url: "/prover/prove",
      headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.from("req"),
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    // A denied caller never reaches the prover.
    expect(client.calls).toHaveLength(0);
    // The limiter was handed the authenticated session identity.
    expect(seen[0]?.address).toBe(OWNER);
    expect(seen[0]?.sessionId).toBeTypeOf("string");
  });
});

describe("createProverClient — transparent HTTP forward to the interim prover", () => {
  it("POSTs the opaque body + content-type to the prover URL and maps the response", async () => {
    const proofBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      new Response(proofBytes, {
        status: 200,
        headers: { "content-type": "application/x-midnight-proof" },
      }),
    );

    const client = createProverClient({
      baseUrl: "http://prover.internal/prove-tx",
      fetch: fetchMock,
    });
    const requestBytes = Buffer.from("proof-request");
    const result = await client.prove({
      body: requestBytes,
      contentType: "application/octet-stream",
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/x-midnight-proof");
    expect(result.body.equals(proofBytes)).toBe(true);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("http://prover.internal/prove-tx");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(Buffer.from(init?.body as Uint8Array).equals(requestBytes)).toBe(true);
  });

  it("maps a fetch transport throw to a named ProverUnavailableError", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const client = createProverClient({
      baseUrl: "http://prover.internal/prove-tx",
      fetch: fetchMock,
    });

    await expect(
      client.prove({ body: Buffer.from("req"), contentType: undefined }),
    ).rejects.toBeInstanceOf(ProverUnavailableError);
  });
});
