/**
 * Live-Postgres integration test for {@link PgLedgerStore} (T120, US6).
 *
 * Gated on `DATABASE_URL`: the authoritative check that the REAL SQL behaves against a
 * real database clock — the balance fold (SC-023), reserve-then-settle at actual (D34),
 * overage driving `available` negative + the pre-turn gate, `creditDeposit` idempotency
 * (exactly-once), declined-never-charged (D25), and the atomic `reserve_release` +
 * `settlement` pair (a fault mid-settle rolls BOTH back, FR-047). The deterministic
 * suite covers the same semantics with an in-memory double; this proves the SQL itself.
 * Requires migration 0001 applied.
 *
 * The mid-settle crash is injected by wrapping the real `Db` so the transaction's
 * `settlement` INSERT rejects — the already-inserted `reserve_release` must roll back too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { createDb } from "../../src/db/index.js";
import type { Db, Queryable } from "../../src/db/index.js";
import { InsufficientAvailableError, PgLedgerStore } from "../../src/ledger/ledger.js";
import type { LedgerDb } from "../../src/ledger/ledger.js";

const DATABASE_URL = process.env.DATABASE_URL;
const runLive = DATABASE_URL !== undefined && DATABASE_URL !== "";
const LIVE_URL = DATABASE_URL ?? "";

const OWNER = `pgledger-owner-${String(Date.now())}`;
const MINUTE_MS = 60_000;

/** Wrap `db` so the transaction's `settlement` INSERT rejects (mid-settle crash sim). */
function faultingDb(db: Db): LedgerDb {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) =>
      db.transaction((tx) => {
        const proxied: Queryable = {
          query: (text, params) => {
            if (text.includes("INSERT INTO ledger_entries") && text.includes("'settlement'")) {
              return Promise.reject(new Error("injected mid-settle fault"));
            }
            return tx.query(text, params);
          },
        };
        return fn(proxied);
      }),
  };
}

/**
 * A {@link LedgerDb} that runs `creditDeposit` inside an ALREADY-open transaction on `client`
 * (it does NOT issue its own BEGIN). Used by the H2 backstop test to pin a REPEATABLE READ
 * connection whose snapshot was frozen BEFORE a concurrent credit committed — so the
 * FOR UPDATE + NOT EXISTS fast path is provably defeated and exactly-once must rest on the
 * `ledger_entries_deposit_credit_ref_key` partial unique index and `creditDeposit`'s 23505
 * handling. Commits/rolls back the pinned transaction when `fn` settles.
 */
function pinnedTxnDb(client: PoolClient): LedgerDb {
  const proxied: Queryable = {
    query: <R extends QueryResultRow>(text: string, params?: unknown[]) =>
      client.query<R>(text, params),
  };
  return {
    query: <R extends QueryResultRow>(text: string, params?: unknown[]) =>
      client.query<R>(text, params),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      try {
        const result = await fn(proxied);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Connection-level failure; the original error is the actionable one.
        }
        throw error;
      }
    },
  };
}

describe.skipIf(!runLive)("PgLedgerStore against live Postgres (US6)", () => {
  let db: Db;
  let store: PgLedgerStore;
  let projectId: string;

  beforeAll(async () => {
    db = createDb({ connectionString: LIVE_URL });
    store = new PgLedgerStore(db, { flatReserve: 100n });
    await db.query(`INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING`, [OWNER]);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO projects (owner_address, name) VALUES ($1, 'ledger-test') RETURNING id`,
      [OWNER],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("failed to create test project");
    }
    projectId = row.id;
  });

  afterAll(async () => {
    // Turns cascade from the project; the account's ledger entries are removed explicitly
    // (the append-only trigger forbids DELETE, so drop them by disabling is not an option —
    // instead delete the account after clearing dependents via a fresh connection-role bypass
    // is unnecessary: entries FK the account, so we remove the project + entries in order).
    await db.query(`DELETE FROM turns WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE owner_address = $1`, [OWNER]);
    // ledger_entries is append-only (trigger blocks DELETE); leave the account + its
    // entries in place — OWNER is unique per run, so this does not affect other tests.
    await db.end();
  });

  it("credits idempotently by ref and folds the balance (SC-023)", async () => {
    const first = await store.creditDeposit(OWNER, `dep-${OWNER}-1`, 1_000n);
    expect(first).toEqual({ available: 1_000n, reserved: 0n });

    // Same ref again → no double-credit (exactly-once for the deposit watcher).
    const second = await store.creditDeposit(OWNER, `dep-${OWNER}-1`, 1_000n);
    expect(second).toEqual({ available: 1_000n, reserved: 0n });

    const entries = await store.getEntries(OWNER);
    const credits = entries.filter((entry) => entry.kind === "deposit_credit");
    expect(credits).toHaveLength(1);
  });

  it("reserves then settles at actual, netting available -= actual and reserved → 0", async () => {
    const turn = await store.openTurn(projectId);
    const afterReserve = await store.placeReserve(OWNER, turn.id, 100n);
    expect(afterReserve.reserved).toBe(100n);

    const balanceBefore = await store.getBalance(OWNER);
    const afterSettle = await store.settle(OWNER, turn.id, 250n);
    expect(afterSettle.reserved).toBe(0n);
    // available fell by exactly the actual consumption relative to pre-reserve headroom.
    expect(afterSettle.available).toBe(balanceBefore.available + 100n - 250n);

    const settled = await store.getTurn(turn.id);
    expect(settled?.status).toBe("settled");
    expect(settled?.settleEntry).not.toBeNull();

    // SC-003: the settlement entry lands within 60s of the turn-end timestamp (same tx now()).
    const entries = await store.getEntries(OWNER);
    const settlement = entries.findLast((entry) => entry.kind === "settlement");
    if (settlement === undefined || settled?.endedAt === undefined || settled.endedAt === null) {
      throw new Error("expected a settled turn with a settlement entry");
    }
    expect(Math.abs(settlement.createdAt - settled.endedAt)).toBeLessThanOrEqual(MINUTE_MS);
  });

  it("drives available negative on overage and blocks the next reserve (D34)", async () => {
    // Fresh account so the arithmetic is isolated from the shared OWNER above.
    const address = `${OWNER}-overage`;
    await store.creditDeposit(address, `dep-${address}`, 100n);
    const t1 = await store.openTurn(projectId);
    await store.placeReserve(address, t1.id, 100n);

    const afterSettle = await store.settle(address, t1.id, 300n);
    expect(afterSettle).toEqual({ available: -200n, reserved: 0n });

    const t2 = await store.openTurn(projectId);
    await expect(store.placeReserve(address, t2.id, 100n)).rejects.toBeInstanceOf(
      InsufficientAvailableError,
    );
    // The rejected reserve rolled back — the turn is still classifying.
    expect((await store.getTurn(t2.id))?.status).toBe("classifying");

    await store.creditDeposit(address, `dep-${address}-top`, 400n);
    const afterReserve = await store.placeReserve(address, t2.id, 100n);
    expect(afterReserve).toEqual({ available: 100n, reserved: 100n });
  });

  it("declines a turn with no ledger entries (D25, declined-never-charged)", async () => {
    const address = `${OWNER}-declined`;
    await store.creditDeposit(address, `dep-${address}`, 500n);
    const turn = await store.openTurn(projectId);

    const declined = await store.decline(turn.id);
    expect(declined.status).toBe("declined");
    expect(declined.reserveEntry).toBeNull();
    expect(declined.settleEntry).toBeNull();

    // The DB constraint turns_declined_never_charged holds; only the deposit entry exists.
    const entries = await store.getEntries(address);
    expect(entries.map((entry) => entry.kind)).toEqual(["deposit_credit"]);
    expect(await store.getBalance(address)).toEqual({ available: 500n, reserved: 0n });
  });

  it("rolls back BOTH the reserve_release and settlement on a mid-settle fault (FR-047)", async () => {
    const address = `${OWNER}-atomic`;
    await store.creditDeposit(address, `dep-${address}`, 1_000n);
    const turn = await store.openTurn(projectId);
    await store.placeReserve(address, turn.id, 100n);

    const faultStore = new PgLedgerStore(faultingDb(db), { flatReserve: 100n });
    await expect(faultStore.settle(address, turn.id, 250n)).rejects.toThrow(/mid-settle fault/);

    // Neither entry survived; the reserve still stands and the turn is still 'reserved'.
    const entries = await store.getEntries(address);
    expect(entries.map((entry) => entry.kind)).toEqual(["deposit_credit", "reserve"]);
    expect(await store.getBalance(address)).toEqual({ available: 900n, reserved: 100n });
    expect((await store.getTurn(turn.id))?.status).toBe("reserved");

    // A clean retry succeeds — the failed attempt left no residue.
    const afterSettle = await store.settle(address, turn.id, 250n);
    expect(afterSettle).toEqual({ available: 750n, reserved: 0n });
  });

  // --- H1: amount column width (numeric(40,0), migration 0002) ----------------

  it("credits a single amount above 2^63-1 without overflow (H1 numeric width)", async () => {
    // 2^63 is one past the old bigint max (2^63-1); the on-chain mint cap is 2^64-1. On a
    // bigint column this INSERT would raise 22003 and strand the funds.
    const address = `${OWNER}-wide`;
    const big = 9_223_372_036_854_775_808n;
    const balance = await store.creditDeposit(address, `dep-${address}`, big);
    expect(balance).toEqual({ available: big, reserved: 0n });

    const entries = await store.getEntries(address);
    const credit = entries.find((entry) => entry.kind === "deposit_credit");
    expect(credit?.amount).toBe(big);
  });

  it("folds a cumulative deposit sum beyond 2^63-1 (H1 fold ::text, no int8 overflow)", async () => {
    // Each credit is below 2^63-1, but their SUM (1.8e19) is not — a ::bigint fold cast would
    // 22003-overflow and freeze every balance read; the ::text fold parses the full magnitude.
    const address = `${OWNER}-wide-sum`;
    const near = 9_000_000_000_000_000_000n;
    await store.creditDeposit(address, `dep-${address}-a`, near);
    await store.creditDeposit(address, `dep-${address}-b`, near);
    const balance = await store.getBalance(address);
    expect(balance).toEqual({ available: near * 2n, reserved: 0n });
  });

  // --- H2: deposit-credit exactly-once (partial unique index) -----------------

  it("credits the SAME ref exactly once under concurrent observation (H2 exactly-once)", async () => {
    const address = `${OWNER}-concurrent`;
    const ref = `dep-${address}-race`;
    // Under READ COMMITTED the account FOR UPDATE serializes the pair; the loser re-reads the
    // winner's committed credit and inserts nothing. Neither call rejects.
    const [a, b] = await Promise.all([
      store.creditDeposit(address, ref, 1_000n),
      store.creditDeposit(address, ref, 1_000n),
    ]);
    expect(a.available).toBe(1_000n);
    expect(b.available).toBe(1_000n);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ledger_entries
        WHERE kind = 'deposit_credit' AND ref = $1`,
      [ref],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("swallows a 23505 from a stale REPEATABLE READ snapshot as already-credited (H2 backstop)", async () => {
    // Deterministic race: the "loser" freezes a REPEATABLE READ snapshot BEFORE any credit
    // exists, then the "winner" credits + commits the same ref on another connection. The
    // loser's stale NOT EXISTS then lets the insert through, the partial unique index rejects
    // it (23505), and creditDeposit swallows it (idempotent no-op) — proving exactly-once is
    // structural, not dependent on lock ordering / isolation level.
    const pool = new pg.Pool({ connectionString: LIVE_URL, max: 4 });
    const loser = await pool.connect();
    try {
      const address = `${OWNER}-rr`;
      const ref = `dep-${address}-rr`;
      await pool.query(`INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        address,
      ]);

      // Freeze the loser's snapshot now — before the ref is credited.
      await loser.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await loser.query("SELECT 1");

      // The winner credits + commits on the shared pool (READ COMMITTED).
      const winner = await store.creditDeposit(address, ref, 2_000n);
      expect(winner).toEqual({ available: 2_000n, reserved: 0n });

      // The loser now credits the SAME ref on its stale snapshot: its NOT EXISTS misses the
      // winner's row, the insert hits the unique index (23505), and creditDeposit returns
      // WITHOUT rejecting (the 23505 was handled, not propagated).
      const loserStore = new PgLedgerStore(pinnedTxnDb(loser), { flatReserve: 100n });
      await expect(loserStore.creditDeposit(address, ref, 2_000n)).resolves.toBeDefined();

      // Exactly one credit row survived; a fresh committed read confirms a single credit.
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries
          WHERE kind = 'deposit_credit' AND ref = $1`,
        [ref],
      );
      expect(rows[0]?.count).toBe("1");
      expect(await store.getBalance(address)).toEqual({ available: 2_000n, reserved: 0n });
    } finally {
      loser.release();
      await pool.end();
    }
  });
});
