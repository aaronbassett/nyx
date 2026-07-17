/**
 * Live-Postgres integration test for {@link PgReconcileStore} + {@link pgLedgerTotals} (T175,
 * US10).
 *
 * Gated on `DATABASE_URL`: proves the REAL SQL — the vault-global ledger fold (Source 1), the
 * `reconcile_runs` insert/read round-trip with `numeric(40,0)` drift/burn_amount (migration
 * 0004) spanning values PAST 2^63-1, the `watermark` UNIQUE exactly-once backstop (SC-037:
 * a duplicate insert returns `{ inserted: false }`, never an error), and `lastReconciled` /
 * `totalBurned`. The deterministic suite (reconcile.test.ts) covers the job semantics with an
 * in-memory double; this proves the SQL itself. Runs `migrateUp` first (idempotent).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateUp } from "../../src/db/index.js";
import type { Db } from "../../src/db/index.js";
import {
  PgReconcileStore,
  pgLedgerTotals,
  type ReconcileRunInsert,
  type ReconcileSnapshot,
} from "../../src/ledger/reconcile.js";

const DATABASE_URL = process.env.DATABASE_URL;
const runLive = DATABASE_URL !== undefined && DATABASE_URL !== "";
const LIVE_URL = DATABASE_URL ?? "";

const ACCOUNT = `pgreconcile-acct-${String(Date.now())}`;
// A value beyond 2^63-1 (bigint max) but within Uint128 — proves the numeric(40,0) widths on
// the freely-deletable `reconcile_runs` rows.
const HUGE = 20_000_000_000_000_000_000n;
// Two individually-bigint-safe credits whose SUM exceeds 2^63-1. Used for the Source-1 fold so
// the `SUM(...)::text` overflow-safety is proven WITHOUT writing an un-narrowable value into the
// append-only `ledger_entries` (which would poison schema.test.ts's down-migration, per review).
const HALF_CREDIT = 5_000_000_000_000_000_000n; // < 2^63-1; two of them = 1e19 > int8 max.

function snapshot(over: Partial<ReconcileSnapshot> = {}): ReconcileSnapshot {
  return {
    ledgerCredits: 1_000n,
    ledgerSettlements: 300n,
    onchainDepositTotal: 1_000n,
    vaultBalance: 1_000n,
    ...over,
  };
}

function run(over: Partial<ReconcileRunInsert> & { watermark: string }): ReconcileRunInsert {
  return {
    outcome: "reconciled",
    snapshot: snapshot(),
    drift: 0n,
    burnAmount: 300n,
    burnTx: `tx-${over.watermark}`,
    ...over,
  };
}

describe.skipIf(!runLive)("PgReconcileStore against live Postgres (US10)", () => {
  let db: Db;
  let store: PgReconcileStore;
  const watermarks: string[] = [];

  const wm = (name: string): string => {
    const full = `${ACCOUNT}-${name}`;
    watermarks.push(full);
    return full;
  };

  beforeAll(async () => {
    await migrateUp(LIVE_URL);
    db = createDb({ connectionString: LIVE_URL });
    store = new PgReconcileStore(db);
  });

  afterAll(async () => {
    // reconcile_runs is freely deletable; ledger_entries is append-only (left in place, keyed
    // to this per-run ACCOUNT so it never collides with other suites).
    if (watermarks.length > 0) {
      await db.query(`DELETE FROM reconcile_runs WHERE watermark = ANY($1::text[])`, [watermarks]);
    }
    await db.end();
  });

  it("folds vault-global ledger totals (Source 1) via numeric SUM past the bigint boundary", async () => {
    await db.query(`INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING`, [ACCOUNT]);
    // Two individually-bigint-safe credits whose SUM (1e19) exceeds int8 max — proves the
    // `SUM(amount)::text → BigInt()` fold never overflows, without any single un-narrowable row.
    await db.query(
      `INSERT INTO ledger_entries (account_address, kind, amount) VALUES
         ($1, 'deposit_credit', $2::numeric), ($1, 'deposit_credit', $2::numeric)`,
      [ACCOUNT, HALF_CREDIT.toString()],
    );
    await db.query(
      `INSERT INTO ledger_entries (account_address, kind, amount) VALUES ($1, 'settlement', $2::numeric)`,
      [ACCOUNT, "700"],
    );
    const totals = await pgLedgerTotals(db)();
    // Vault-global sums include this account's rows (>= the values we inserted; other suites
    // may add their own — assert our contributions are present, not exact global equality).
    expect(totals.credits).toBeGreaterThanOrEqual(HALF_CREDIT * 2n); // 1e19 > 2^63-1
    expect(totals.settlements).toBeGreaterThanOrEqual(700n);
  });

  it("round-trips a run with numeric(40,0) drift + burn past the bigint range", async () => {
    const watermark = wm("huge");
    const insert = run({
      watermark,
      drift: -HUGE,
      burnAmount: HUGE,
      snapshot: snapshot({ ledgerSettlements: HUGE, vaultBalance: HUGE }),
    });
    expect(await store.insertRun(insert)).toEqual({ inserted: true });

    const row = await store.getRun(watermark);
    expect(row?.drift).toBe(-HUGE);
    expect(row?.burnAmount).toBe(HUGE);
    expect(row?.snapshot.ledgerSettlements).toBe(HUGE);
    expect(row?.outcome).toBe("reconciled");
  });

  it("enforces watermark exactly-once: a duplicate insert reports { inserted: false }", async () => {
    const watermark = wm("dup");
    expect(await store.insertRun(run({ watermark }))).toEqual({ inserted: true });
    // The SC-037 structural backstop: the UNIQUE index rejects the second, surfaced as a
    // benign already-done rather than a thrown 23505.
    expect(await store.insertRun(run({ watermark, burnTx: "tx-other" }))).toEqual({
      inserted: false,
    });
    // The original row is untouched.
    expect((await store.getRun(watermark))?.burnTx).toBe(`tx-${watermark}`);
  });

  it("reports lastReconciled + totalBurned over reconciled runs only", async () => {
    const a = wm("acc-a");
    const b = wm("acc-b");
    const d = wm("acc-drift");
    await store.insertRun(run({ watermark: a, burnAmount: 100n }));
    await store.insertRun(run({ watermark: d, outcome: "drift", burnAmount: null, burnTx: null }));
    await store.insertRun(run({ watermark: b, burnAmount: 250n }));

    const last = await store.lastReconciled();
    expect(last?.watermark).toBe(b); // most-recent reconciled (the drift row is skipped)
    // totalBurned sums only reconciled burn_amounts (>= our two; other suites' rows may add).
    expect(await store.totalBurned()).toBeGreaterThanOrEqual(350n);
  });

  it("surfaces the most recent unresolved error row (the ambiguous-burn block gate)", async () => {
    const err = wm("acc-err");
    await store.insertRun(run({ watermark: err, outcome: "error", burnTx: null }));
    const unresolved = await store.latestUnresolvedError();
    expect(unresolved?.watermark).toBe(err);
    expect(unresolved?.outcome).toBe("error");
  });

  it("returns null for an unknown watermark", async () => {
    expect(await store.getRun(`${ACCOUNT}-never`)).toBeNull();
  });
});
