/**
 * Session-middleware tests (T033 for T036).
 *
 * Drives `createRequireSession` as a real Fastify `preHandler` on a throwaway
 * protected route, so the resume/slide/reject behaviour is exercised end-to-end
 * with an injected in-memory {@link SessionAuthStore} and an injected clock:
 *  - a valid cookie resumes the session, exposes the account, and REFRESHES the
 *    cookie Max-Age (client-side sliding);
 *  - the 7-day window SLIDES on activity (not a fixed lifetime) and expires after
 *    an idle window;
 *  - missing / invalid / revoked cookies are rejected 401 and the stale cookie is
 *    cleared;
 *  - resume touches only the session store, never the signing path (SC-019).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config/index.js";
import type { Config } from "../../src/config/index.js";
import { createRequireSession } from "../../src/auth/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import { InMemoryAuthStore } from "./helpers.js";

const SESSION_LIFETIME_MS = 604_800_000; // 7 days (D44).

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

interface Clock {
  now: number;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly store: InMemoryAuthStore;
  readonly clock: Clock;
  /** Seed a live session and return its id. */
  readonly seedSession: (address: string) => Promise<string>;
}

async function boot(): Promise<Harness> {
  const config: Config = loadConfig(TEST_ENV);
  const clock: Clock = { now: 5_000_000 };
  const store = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: 300_000,
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  const requireSession = createRequireSession({ store, config });
  app.get("/whoami", { preHandler: requireSession }, (request) => ({
    address: request.auth?.address ?? null,
  }));
  await app.ready();

  const seedSession = async (address: string): Promise<string> => {
    // Issue a nonce and drive `issue` with a passing verifier to mint a real session.
    const { nonce } = await store.issueNonce();
    const result = await store.issue({ nonce, accountAddress: address, verify: () => true });
    if (!result.ok) {
      throw new Error("failed to seed session");
    }
    return result.sessionId;
  };

  return { app, store, clock, seedSession };
}

let h: Harness;

beforeEach(async () => {
  h = await boot();
});

afterEach(async () => {
  await h.app.close();
});

function cookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}`;
}

describe("createRequireSession — resume (T036)", () => {
  it("resumes a valid session, exposes the account, and refreshes the cookie", async () => {
    const sessionId = await h.seedSession("mn_addr_preprod1resume");
    const issueCallsBefore = h.store.issueCalls;

    const response = await h.app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookie(sessionId) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ address: string | null }>().address).toBe("mn_addr_preprod1resume");

    // Cookie refreshed with a fresh 7-day Max-Age (client-side slide).
    const setCookie = response.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
    expect(header).toMatch(/Max-Age=604800/i);

    // Resume touched only the store's slide path — never the verify/signing path (SC-019).
    expect(h.store.slideCalls).toBeGreaterThan(0);
    expect(h.store.issueCalls).toBe(issueCallsBefore);
  });
});

describe("createRequireSession — 7-day sliding lifetime (T036, D44)", () => {
  it("keeps the session alive across repeated activity inside the window", async () => {
    const sessionId = await h.seedSession("mn_addr_preprod1slide");

    // Activity at +6 days: still valid, and slides the expiry to now+7d.
    h.clock.now += 6 * 24 * 60 * 60 * 1000;
    const first = await h.app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookie(sessionId) },
    });
    expect(first.statusCode).toBe(200);

    // A further +6 days (12 total, > a fixed 7-day lifetime) is still valid BECAUSE it slid.
    h.clock.now += 6 * 24 * 60 * 60 * 1000;
    const second = await h.app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookie(sessionId) },
    });
    expect(second.statusCode).toBe(200);
  });

  it("expires the session after a full idle window with no activity (fresh sign-in required)", async () => {
    const sessionId = await h.seedSession("mn_addr_preprod1idle");
    h.clock.now += SESSION_LIFETIME_MS + 1; // 7 idle days elapse.
    const response = await h.app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookie(sessionId) },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("createRequireSession — rejection paths (T036)", () => {
  it("rejects a request with no session cookie", async () => {
    const response = await h.app.inject({ method: "GET", url: "/whoami" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown session cookie and clears it", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookie("does-not-exist") },
    });
    expect(response.statusCode).toBe(401);
    const setCookie = response.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
    expect(header).toMatch(/Max-Age=0/i);
  });

  it("rejects a revoked session cookie", async () => {
    const sessionId = await h.seedSession("mn_addr_preprod1revoked");
    await h.store.revoke(sessionId);
    const response = await h.app.inject({
      method: "GET",
      url: "/whoami",
      headers: { cookie: cookie(sessionId) },
    });
    expect(response.statusCode).toBe(401);
  });
});
