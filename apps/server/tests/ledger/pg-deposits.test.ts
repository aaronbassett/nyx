/**
 * Live-Postgres integration test for {@link PgDepositStore} (T120, US6).
 *
 * Gated on `DATABASE_URL`: the authoritative check that the REAL SQL behaves against a real
 * database clock — the data-modifying-CTE account-upsert + ref insert (FR-042), the
 * finalized-success credit (delegating to a real {@link PgLedgerStore}, EC-28), the
 * status compare-and-swap exactly-once under duplicate/reorg (SC-021/EC-30), the orphan
 * `ON CONFLICT (ref) DO NOTHING` idempotency (D46/FR-044/EC-31), a finalized-failure no-op
 * (scenario 6), and the `expireStale` sweep against `now()` (EC-29). The deterministic
 * suite covers the same semantics with an in-memory double; this proves the SQL itself.
 * Requires migration 0001 applied.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/index.js";
import type { Db } from "../../src/db/index.js";
import {
  DepositAboveMaximumError,
  MAXIMUM_DEPOSIT,
  PgDepositStore,
  DepositBelowMinimumError,
} from "../../src/ledger/deposits.js";
import type { DepositObservation } from "../../src/ledger/deposits.js";
import { PgLedgerStore } from "../../src/ledger/ledger.js";

const DATABASE_URL = process.env.DATABASE_URL;
const runLive = DATABASE_URL !== undefined && DATABASE_URL !== "";
const LIVE_URL = DATABASE_URL ?? "";

const OWNER = `pgdeposit-owner-${String(Date.now())}`;
const TTL_MS = 1_800_000; // 30-minute test TTL.

interface CountRow {
  readonly count: string;
}

/** Build a finalized on-chain observation seam value. */
function observe(overrides: Partial<DepositObservation> & { ref: string }): DepositObservation {
  return {
    amount: 5_000n,
    txRef: `tx-${overrides.ref}`,
    outcome: "success",
    finalized: true,
    ...overrides,
  };
}

describe.skipIf(!runLive)("PgDepositStore against live Postgres (US6)", () => {
  let db: Db;
  let store: PgDepositStore;
  const refs: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: LIVE_URL });
    store = new PgDepositStore(db, new PgLedgerStore(db), {
      minimumDeposit: 1_000n,
      depositRefTtlMs: TTL_MS,
    });
  });

  afterAll(async () => {
    // deposit_refs + orphan_deposits are freely deletable; ledger_entries is append-only
    // (trigger blocks DELETE), so its rows for this per-run OWNER are left in place.
    if (refs.length > 0) {
      await db.query(`DELETE FROM deposit_refs WHERE ref = ANY($1::text[])`, [refs]);
      await db.query(`DELETE FROM orphan_deposits WHERE ref = ANY($1::text[])`, [refs]);
    }
    await db.query(`DELETE FROM deposit_refs WHERE account_address = $1`, [OWNER]);
    await db.end();
  });

  it("pre-registers a TTL-bound ref, auto-creating the account (FR-042)", async () => {
    const registration = await store.preregister(OWNER, 5_000n);
    refs.push(registration.ref);
    expect(registration.ref).toMatch(/^[0-9a-f]{64}$/);
    // The DB clock set the expiry ~TTL_MS in the future.
    expect(registration.expiresAt).toBeGreaterThan(Date.now());

    const view = await store.getDeposit(registration.ref);
    expect(view).toEqual({ status: "preregistered" });
  });

  it("rejects a below-minimum deposit with a named error (D45)", async () => {
    await expect(store.preregister(OWNER, 999n)).rejects.toBeInstanceOf(DepositBelowMinimumError);
  });

  it("rejects an above-cap deposit and accepts one at the cap (H1 mint-cap gate)", async () => {
    // Above the contract's Uint<64> mint cap (2^64-1) → never mintable on-chain → rejected.
    await expect(store.preregister(OWNER, MAXIMUM_DEPOSIT + 1n)).rejects.toBeInstanceOf(
      DepositAboveMaximumError,
    );
    // Exactly at the cap → accepted; expected_amount persists in the widened numeric column.
    const registration = await store.preregister(OWNER, MAXIMUM_DEPOSIT);
    refs.push(registration.ref);
    expect((await store.getDeposit(registration.ref))?.status).toBe("preregistered");
  });

  it("credits an on-chain amount above 2^63-1 end-to-end (H1 numeric width)", async () => {
    // 2^63 is one past the old bigint max (2^63-1) — the credit would 22003-overflow on bigint.
    const big = 9_223_372_036_854_775_808n;
    const { ref } = await store.preregister(OWNER, big);
    refs.push(ref);

    const outcome = await store.observeFinalized(observe({ ref, amount: big }));
    expect(outcome.kind).toBe("credited");

    const { rows } = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM ledger_entries
        WHERE kind = 'deposit_credit' AND ref = $1`,
      [ref],
    );
    expect(rows[0]?.amount).toBe(big.toString());
  });

  it("credits a finalized success exactly once and short-circuits a reorg (SC-021)", async () => {
    const { ref } = await store.preregister(OWNER, 5_000n);
    refs.push(ref);

    const first = await store.observeFinalized(observe({ ref, amount: 5_000n }));
    expect(first.kind).toBe("credited");
    expect((await store.getDeposit(ref))?.status).toBe("credited");

    // Duplicate/reorg observation of the same ref → no-op.
    const replay = await store.observeFinalized(observe({ ref, amount: 5_000n }));
    expect(replay).toEqual({ kind: "already-credited", ref });

    // Exactly-once: the append-only ledger holds a SINGLE deposit_credit for this ref.
    const { rows } = await db.query<CountRow>(
      `SELECT count(*)::text AS count FROM ledger_entries
        WHERE kind = 'deposit_credit' AND ref = $1`,
      [ref],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("EC-28: credits the ON-CHAIN amount when it differs from expected", async () => {
    const { ref } = await store.preregister(OWNER, 5_000n); // expected 5000
    refs.push(ref);

    const outcome = await store.observeFinalized(observe({ ref, amount: 4_200n }));
    expect(outcome.kind).toBe("credited");

    const { rows } = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM ledger_entries
        WHERE kind = 'deposit_credit' AND ref = $1`,
      [ref],
    );
    expect(rows[0]?.amount).toBe("4200"); // the observed on-chain amount, not 5000.
  });

  it("orphans an unregistered success idempotently, never crediting (D46)", async () => {
    const ref = `orphan-${OWNER}`;
    refs.push(ref);

    const first = await store.observeFinalized(observe({ ref, amount: 7_000n }));
    expect(first.kind).toBe("orphaned");
    const replay = await store.observeFinalized(observe({ ref, amount: 7_000n }));
    expect(replay.kind).toBe("orphaned");

    // Exactly one orphan row (UNIQUE ref), and no ledger credit ever.
    const orphanRows = await db.query<CountRow>(
      `SELECT count(*)::text AS count FROM orphan_deposits WHERE ref = $1`,
      [ref],
    );
    expect(orphanRows.rows[0]?.count).toBe("1");
    const creditRows = await db.query<CountRow>(
      `SELECT count(*)::text AS count FROM ledger_entries
        WHERE kind = 'deposit_credit' AND ref = $1`,
      [ref],
    );
    expect(creditRows.rows[0]?.count).toBe("0");
  });

  it("surfaces a finalized failure without crediting or orphaning (scenario 6)", async () => {
    const { ref } = await store.preregister(OWNER, 5_000n);
    refs.push(ref);

    const outcome = await store.observeFinalized(observe({ ref, outcome: "failure" }));
    expect(outcome.kind).toBe("failed");
    // The ref stays creditable; nothing landed in orphan_deposits.
    expect((await store.getDeposit(ref))?.status).toBe("preregistered");
    const orphanRows = await db.query<CountRow>(
      `SELECT count(*)::text AS count FROM orphan_deposits WHERE ref = $1`,
      [ref],
    );
    expect(orphanRows.rows[0]?.count).toBe("0");
  });

  it("lists open refs: watchable + graced-expired, excluding credited (Task 6)", async () => {
    const GRACE_MS = 3_600_000; // 1-hour grace window.

    // A fresh `preregistered` ref → open.
    const open = await store.preregister(OWNER, 5_000n);
    refs.push(open.ref);

    // A credited ref → NOT open.
    const credited = await store.preregister(OWNER, 5_000n);
    refs.push(credited.ref);
    await store.observeFinalized(observe({ ref: credited.ref, amount: 5_000n }));

    // A ref that expired just now (negative-TTL store) → within a wide grace window, open.
    const graceStore = new PgDepositStore(db, new PgLedgerStore(db), {
      minimumDeposit: 1_000n,
      depositRefTtlMs: -1_000, // expires_at = now() - 1s → already stale, but recently.
    });
    const graced = await graceStore.preregister(OWNER, 5_000n);
    refs.push(graced.ref);
    expect(await graceStore.expireStale()).toBeGreaterThanOrEqual(1);
    expect((await store.getDeposit(graced.ref))?.status).toBe("expired");

    const listed = new Set((await store.listOpenRefs(GRACE_MS)).map((entry) => entry.ref));
    expect(listed.has(open.ref)).toBe(true);
    expect(listed.has(graced.ref)).toBe(true); // expired 1s ago, well inside the 1h grace.
    expect(listed.has(credited.ref)).toBe(false);

    // With a zero grace window, the expired ref drops out; the fresh one stays.
    const zeroGrace = new Set((await store.listOpenRefs(0)).map((entry) => entry.ref));
    expect(zeroGrace.has(open.ref)).toBe(true);
    expect(zeroGrace.has(graced.ref)).toBe(false);
  });

  it("expires only past-TTL preregistered refs against the DB clock (EC-29)", async () => {
    // A ref that is ALREADY past its TTL (negative TTL store) is swept; a fresh one is not.
    const staleStore = new PgDepositStore(db, new PgLedgerStore(db), {
      minimumDeposit: 1_000n,
      depositRefTtlMs: -1_000, // expires_at = now() - 1s → immediately stale.
    });
    const stale = await staleStore.preregister(OWNER, 5_000n);
    refs.push(stale.ref);
    const fresh = await store.preregister(OWNER, 5_000n);
    refs.push(fresh.ref);

    const swept = await store.expireStale();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect((await store.getDeposit(stale.ref))?.status).toBe("expired");
    expect((await store.getDeposit(fresh.ref))?.status).toBe("preregistered");
  });
});
