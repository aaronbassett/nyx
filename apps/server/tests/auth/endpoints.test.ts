/**
 * Auth endpoint tests (T033) — driven through `app.inject()` against the real
 * `buildServer` wiring with an injected in-memory {@link SessionAuthStore}, so they
 * are fully deterministic with NO external Postgres and NO wallet.
 *
 * Coverage:
 *  - SC-018 nonce single-use / replay / expiry (absolute rejection);
 *  - account auto-create on first sign-in (D43/D44);
 *  - HttpOnly/Secure/SameSite/Max-Age session cookie on success;
 *  - key↔address mismatch and bad-signature rejection, with the nonce burned;
 *  - SC-019 session resume makes ZERO wallet/verify calls (store-only);
 *  - logout invalidates the session server-side and clears the cookie.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createMcpClients } from "../../src/mcp/index.js";
import type { McpSession } from "../../src/mcp/index.js";
import type { Queryable } from "../../src/db/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import { InMemoryAuthStore, makeIdentity, signMessage, siweMessage } from "./helpers.js";

const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/nyx_test",
  MCP_TOOLCHAIN_URL: "http://toolchain.test.local/mcp",
  MCP_TOME_URL: "http://tome.test.local/mcp",
  MCP_MNM_URL: "http://mnm.test.local/mcp",
  PROVER_URL: "http://prover.test.local",
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

const SESSION_LIFETIME_MS = 604_800_000; // 7 days (D44).
const NONCE_TTL_MS = 300_000; // 5 minutes.

function stubDb(): Queryable {
  return {
    query: <R extends QueryResultRow>(): Promise<QueryResult<R>> =>
      Promise.resolve({ command: "SELECT", rowCount: 1, oid: 0, rows: [], fields: [] }),
  };
}

const inertMcpSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: () => Promise.resolve(null),
  close: () => Promise.resolve(),
};

/** A mutable clock the in-memory store reads, so tests can advance time. */
interface Clock {
  now: number;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly store: InMemoryAuthStore;
  readonly clock: Clock;
}

async function boot(): Promise<Harness> {
  const config = loadConfig(TEST_ENV);
  const mcp = createMcpClients(config.mcp, () => Promise.resolve(inertMcpSession));
  const clock: Clock = { now: 1_000_000 };
  const store = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: NONCE_TTL_MS,
  });
  const app = await buildServer({ config, db: stubDb(), mcp, authStore: store });
  await app.ready();
  return { app, store, clock };
}

let h: Harness;

beforeEach(async () => {
  h = await boot();
});

afterEach(async () => {
  await h.app.close();
});

/** Extract the first `Set-Cookie` header for the session cookie as a string. */
function setCookieHeader(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
}

/**
 * The EFFECTIVE session `Set-Cookie` — the last one for the cookie name, since a
 * response may carry a slide-refresh from the middleware followed by a clear from
 * the handler and browsers apply same-name cookies in order (last wins).
 */
function effectiveSetCookieHeader(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)).at(-1);
}

/** Parse the session id out of a `Set-Cookie` header. */
function sessionIdFromSetCookie(raw: string | string[] | undefined): string | undefined {
  const header = setCookieHeader(raw);
  if (header === undefined) {
    return undefined;
  }
  const match = /nyx_session=([^;]*)/.exec(header);
  const value = match?.[1];
  return value === undefined || value === "" ? undefined : value;
}

/** Run the full nonce → sign → verify flow, returning the verify response. */
async function signIn(id = makeIdentity()): Promise<{
  readonly status: number;
  readonly setCookie: string | string[] | undefined;
  readonly sessionId: string | undefined;
  readonly identity: ReturnType<typeof makeIdentity>;
}> {
  const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
  const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
  const message = siweMessage(nonce);
  const signature = signMessage(id.signingKey, message);
  const verify = await h.app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { address: id.address, message, signature, verifyingKey: id.verifyingKey },
  });
  return {
    status: verify.statusCode,
    setCookie: verify.headers["set-cookie"],
    sessionId: sessionIdFromSetCookie(verify.headers["set-cookie"]),
    identity: id,
  };
}

describe("POST /auth/nonce (T035)", () => {
  it("issues a nonce with an epoch-ms expiry and no auth required", async () => {
    const response = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ nonce: string; expiresAt: number }>();
    expect(body.nonce.length).toBeGreaterThan(0);
    expect(body.expiresAt).toBe(h.clock.now + NONCE_TTL_MS);
  });
});

describe("POST /auth/verify — happy path (T035, D43/D44)", () => {
  it("verifies the signature, auto-creates the account, and sets a hardened session cookie", async () => {
    const result = await signIn();
    expect(result.status).toBe(200);

    // Account auto-created keyed by the unshielded address (D43).
    expect(h.store.accounts.has(result.identity.address)).toBe(true);

    // Session cookie is HttpOnly + Secure + SameSite=Lax + Path=/ + 7-day Max-Age (D44).
    const cookie = setCookieHeader(result.setCookie);
    expect(cookie).toBeDefined();
    const header = cookie ?? "";
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//i);
    expect(header).toMatch(/Max-Age=604800/i);
    expect(result.sessionId).toBeDefined();
    expect(h.store.isLive(result.sessionId ?? "")).toBe(true);
  });

  it("returns the authenticated address in the body but never the session id", async () => {
    const result = await signIn();
    // Re-run to read the body of a fresh sign-in.
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    const message = siweMessage(nonce);
    const signature = signMessage(result.identity.signingKey, message);
    const verify = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: result.identity.address,
        message,
        signature,
        verifyingKey: result.identity.verifyingKey,
      },
    });
    const body = verify.json<{ address: string }>();
    expect(body.address).toBe(result.identity.address);
    expect(JSON.stringify(body)).not.toContain(result.sessionId ?? "no-session");
  });
});

describe("POST /auth/verify — SC-018 nonce single-use / replay / expiry", () => {
  it("rejects a replayed (nonce, signature) pair — single-use is absolute", async () => {
    const id = makeIdentity();
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    const message = siweMessage(nonce);
    const signature = signMessage(id.signingKey, message);
    const payload = { address: id.address, message, signature, verifyingKey: id.verifyingKey };

    const first = await h.app.inject({ method: "POST", url: "/auth/verify", payload });
    expect(first.statusCode).toBe(200);

    const replay = await h.app.inject({ method: "POST", url: "/auth/verify", payload });
    expect(replay.statusCode).toBe(401);
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a fresh signature over an already-burned nonce", async () => {
    const id = makeIdentity();
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    const message = siweMessage(nonce);

    const first = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: id.address,
        message,
        signature: signMessage(id.signingKey, message),
        verifyingKey: id.verifyingKey,
      },
    });
    expect(first.statusCode).toBe(200);

    // Re-sign the SAME nonce/message: signature is valid but the nonce is spent.
    const second = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: id.address,
        message,
        signature: signMessage(id.signingKey, message),
        verifyingKey: id.verifyingKey,
      },
    });
    expect(second.statusCode).toBe(401);
  });

  it("rejects an expired nonce", async () => {
    const id = makeIdentity();
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    h.clock.now += NONCE_TTL_MS + 1; // Advance past the nonce TTL.
    const message = siweMessage(nonce);
    const verify = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: id.address,
        message,
        signature: signMessage(id.signingKey, message),
        verifyingKey: id.verifyingKey,
      },
    });
    expect(verify.statusCode).toBe(401);
  });

  it("rejects a signed message whose nonce was never issued", async () => {
    const id = makeIdentity();
    const message = siweMessage("never-issued-nonce");
    const verify = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: id.address,
        message,
        signature: signMessage(id.signingKey, message),
        verifyingKey: id.verifyingKey,
      },
    });
    expect(verify.statusCode).toBe(401);
  });
});

describe("POST /auth/verify — rejection burns the nonce (EC-27, constitution III)", () => {
  it("rejects a bad signature AND burns the nonce so a later good signature also fails", async () => {
    const id = makeIdentity();
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    const message = siweMessage(nonce);

    const badAttempt = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: id.address,
        message,
        signature: "deadbeef", // Not a valid signature for this message.
        verifyingKey: id.verifyingKey,
      },
    });
    expect(badAttempt.statusCode).toBe(401);

    // The nonce was burned on the failed attempt; a correct signature now fails too.
    const goodAttempt = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: id.address,
        message,
        signature: signMessage(id.signingKey, message),
        verifyingKey: id.verifyingKey,
      },
    });
    expect(goodAttempt.statusCode).toBe(401);
  });

  it("rejects a key↔address mismatch (key-substitution auth bypass)", async () => {
    const signer = makeIdentity();
    const victim = makeIdentity();
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    const message = siweMessage(nonce);
    const verify = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        address: victim.address, // Victim's account…
        message,
        signature: signMessage(signer.signingKey, message), // …signed by the attacker's key.
        verifyingKey: signer.verifyingKey,
      },
    });
    expect(verify.statusCode).toBe(401);
    expect(h.store.accounts.has(victim.address)).toBe(false);
  });

  it("rejects a body missing the verifying key with 400", async () => {
    const id = makeIdentity();
    const nonceResponse = await h.app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = nonceResponse.json<{ nonce: string; expiresAt: number }>();
    const message = siweMessage(nonce);
    const verify = await h.app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: id.address, message, signature: signMessage(id.signingKey, message) },
    });
    expect(verify.statusCode).toBe(400);
  });
});

describe("session resume — SC-019 zero wallet calls", () => {
  it("resumes a valid session from the cookie alone, touching only the session store", async () => {
    const result = await signIn();
    const issueCallsAfterSignIn = h.store.issueCalls;
    const cookie = `${SESSION_COOKIE_NAME}=${result.sessionId ?? ""}`;

    // A cookie-authenticated request carries NO signature/verifyingKey — a pure resume.
    const resume = await h.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie },
    });
    expect(resume.statusCode).toBe(200);

    // The resume ran the session store's slide path and NEVER the verify/signing path.
    expect(h.store.slideCalls).toBeGreaterThan(0);
    expect(h.store.issueCalls).toBe(issueCallsAfterSignIn);
  });
});

describe("POST /auth/logout (T035/T036)", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const result = await signIn();
    const cookie = `${SESSION_COOKIE_NAME}=${result.sessionId ?? ""}`;

    const logout = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);

    // The effective (last) session cookie clears it (Max-Age=0) and the session is
    // dead server-side. (Logout runs the middleware, which slide-refreshes the cookie,
    // then the handler clears it — the clear is last and therefore wins.)
    const cleared = effectiveSetCookieHeader(logout.headers["set-cookie"]) ?? "";
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(h.store.isLive(result.sessionId ?? "")).toBe(false);

    // A second logout with the now-revoked cookie is rejected by the session middleware.
    const second = await h.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(second.statusCode).toBe(401);
  });

  it("rejects logout without a session cookie", async () => {
    const logout = await h.app.inject({ method: "POST", url: "/auth/logout" });
    expect(logout.statusCode).toBe(401);
  });
});
