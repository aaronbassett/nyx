/**
 * Live-Postgres integration test for {@link PgSessionAuthStore} (T033/T036).
 *
 * Gated on `DATABASE_URL`: this is the authoritative check that the REAL SQL —
 * the atomic single-use nonce burn (SC-018), the sliding session expiry, and
 * logout revocation — behaves against a real database clock and under concurrency.
 * The deterministic suite covers the same semantics with an in-memory double; this
 * proves the SQL itself. Requires migration 0001 applied to the target database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/index.js";
import type { Db } from "../../src/db/index.js";
import { PgSessionAuthStore } from "../../src/auth/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const runLive = DATABASE_URL !== undefined && DATABASE_URL !== "";
/** Non-undefined connection string; only read when `runLive` is true (suite otherwise skipped). */
const LIVE_URL = DATABASE_URL ?? "";

const SESSION_LIFETIME_MS = 604_800_000;
const NONCE_TTL_MS = 300_000;

describe.skipIf(!runLive)("PgSessionAuthStore against live Postgres (SC-018)", () => {
  let db: Db;
  let store: PgSessionAuthStore;
  const testAddresses: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: LIVE_URL });
    store = new PgSessionAuthStore(db, {
      sessionLifetimeMs: SESSION_LIFETIME_MS,
      nonceTtlMs: NONCE_TTL_MS,
    });
  });

  afterAll(async () => {
    // Clean up rows this suite created (sessions cascade from accounts).
    for (const address of testAddresses) {
      await db.query("DELETE FROM sessions WHERE account_address = $1", [address]);
      await db.query("DELETE FROM accounts WHERE address = $1", [address]);
    }
    await db.query("DELETE FROM auth_nonces WHERE nonce LIKE 'pgtest-%'");
    await db.end();
  });

  it("issues a nonce with a future expiry", async () => {
    const before = Date.now();
    const nonce = await store.issueNonce();
    expect(nonce.nonce.length).toBeGreaterThan(0);
    expect(nonce.expiresAt).toBeGreaterThan(before);
  });

  it("burns a nonce exactly once, auto-creates the account, and issues a session", async () => {
    const address = `pgtest-addr-${String(Date.now())}`;
    testAddresses.push(address);
    const nonceValue = `pgtest-${String(Date.now())}-a`;
    await db.query(
      "INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, now() + interval '5 min')",
      [nonceValue],
    );

    const ok = await store.issue({
      nonce: nonceValue,
      accountAddress: address,
      verify: () => true,
    });
    expect(ok.ok).toBe(true);

    const account = await db.query("SELECT address FROM accounts WHERE address = $1", [address]);
    expect(account.rowCount).toBe(1);

    // Replay of the burned nonce is rejected.
    const replay = await store.issue({
      nonce: nonceValue,
      accountAddress: address,
      verify: () => true,
    });
    expect(replay).toEqual({ ok: false, reason: "nonce" });
  });

  it("keeps the nonce burned even when verification fails", async () => {
    const address = `pgtest-addr-fail-${String(Date.now())}`;
    testAddresses.push(address);
    const nonceValue = `pgtest-${String(Date.now())}-fail`;
    await db.query(
      "INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, now() + interval '5 min')",
      [nonceValue],
    );

    const rejected = await store.issue({
      nonce: nonceValue,
      accountAddress: address,
      verify: () => false,
    });
    expect(rejected).toEqual({ ok: false, reason: "signature" });

    // The failed attempt consumed the nonce (FR-039): a retry cannot use it.
    const retry = await store.issue({
      nonce: nonceValue,
      accountAddress: address,
      verify: () => true,
    });
    expect(retry).toEqual({ ok: false, reason: "nonce" });
  });

  it("admits exactly one of two concurrent issues for the same nonce", async () => {
    const address = `pgtest-addr-race-${String(Date.now())}`;
    testAddresses.push(address);
    const nonceValue = `pgtest-${String(Date.now())}-race`;
    await db.query(
      "INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, now() + interval '5 min')",
      [nonceValue],
    );

    const [a, b] = await Promise.all([
      store.issue({ nonce: nonceValue, accountAddress: address, verify: () => true }),
      store.issue({ nonce: nonceValue, accountAddress: address, verify: () => true }),
    ]);
    const successes = [a, b].filter((r) => r.ok).length;
    expect(successes).toBe(1);
  });

  it("slides a live session and revokes it on logout", async () => {
    const address = `pgtest-addr-slide-${String(Date.now())}`;
    testAddresses.push(address);
    const nonceValue = `pgtest-${String(Date.now())}-slide`;
    await db.query(
      "INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, now() + interval '5 min')",
      [nonceValue],
    );
    const issued = await store.issue({
      nonce: nonceValue,
      accountAddress: address,
      verify: () => true,
    });
    if (!issued.ok) {
      throw new Error("expected session to issue");
    }

    const slid = await store.slide(issued.sessionId);
    expect(slid).toEqual({ accountAddress: address });

    await store.revoke(issued.sessionId);
    expect(await store.get(issued.sessionId)).toBeNull();
    expect(await store.slide(issued.sessionId)).toBeNull();
  });
});
