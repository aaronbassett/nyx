/**
 * NYXT ledger service + store (T120, US6) — reserve-then-settle metering (D34).
 *
 * The ledger is an APPEND-ONLY log (`ledger_entries`, FR-043): every row carries a
 * strictly-positive magnitude and the KIND applies the sign in the balance fold
 * ("signed by kind"). Two balances are DERIVED, never stored (FR-070, SC-023):
 *
 *   reserved  = Σreserve − Σreserve_release
 *   available = Σdeposit_credit − Σreserve + Σreserve_release − Σsettlement
 *
 * so the invariant `available + reserved = Σdeposit_credit − Σsettlement`
 * (credits − settlements) holds BY CONSTRUCTION — see {@link foldBalance}.
 *
 * The metering lifecycle (D34) is reserve-then-settle with NO credit-backs, EVER:
 *  - after intent classification, an ACCEPTED prompt places a FLAT reserve
 *    ({@link LedgerStore.placeReserve}) gated on `available ≥ flatReserve` — a below-gate
 *    reserve rejects with {@link InsufficientAvailableError} (EC-01 top-up CTA); a
 *    DECLINED prompt places nothing ({@link LedgerStore.decline}, D25);
 *  - EVERY non-declined turn outcome (success, honest failure, infra failure) settles at
 *    ACTUAL consumption ({@link LedgerStore.settle}) — one transaction writing the
 *    `reserve_release` (the turn's full reserve) + `settlement` (actual) PAIR, which IS
 *    the spec's "one atomic ledger entry" (scenario 4). Overage is ALLOWED: an actual
 *    that exceeds `available` drives `available` NEGATIVE (D34) — never clamped, never
 *    refunded; the negative balance blocks future reserves until a deposit tops it up.
 *
 * Accounts are keyed by the wallet's unshielded `address` (D43). Amounts are `bigint`
 * NYXT base units. All store failures are promise REJECTIONS with named error classes
 * (mapped to HTTP statuses later by US1); the DB clock (`now()`) decides all timestamps,
 * and every value is a bound parameter — never interpolated into SQL.
 *
 * Turn creation + status transitions live here too: the ledger owns the `turns` table
 * (its `reserved`/`settled`/`declined` states are ledger-coupled). US1 calls
 * {@link LedgerStore.openTurn} at classification start, then either `placeReserve`
 * (accept) or `decline` (reject), and `settle` at turn end.
 */
import type { LedgerEntryKind } from "@nyx/protocol";
import type { Queryable } from "../db/index.js";

// --- Public types -----------------------------------------------------------

/**
 * Derived account balance (server-computed; the UI never folds this itself, SC-023).
 * `available` may be NEGATIVE on final-cycle overage (D34).
 */
export interface Balance {
  /** Spendable headroom: credits minus reserves-in-flight and settlements. */
  readonly available: bigint;
  /** Currently reserved (in-flight) across un-settled turns. */
  readonly reserved: bigint;
}

/** Turn lifecycle status (D21/D34): classifying → reserved → running → settled | declined. */
export type TurnStatus = "classifying" | "reserved" | "running" | "settled" | "declined";

/**
 * A turn row as the ledger owns it. `reserveEntry`/`settleEntry` reference the
 * `ledger_entries` rows the reserve/settlement wrote (`bigint` ids). Charging
 * invariants (D25/D34): a declined turn carries NEITHER link; a settled turn carries a
 * `settleEntry`.
 */
export interface Turn {
  readonly id: string;
  readonly projectId: string;
  readonly status: TurnStatus;
  /** OZ-simulator retry count, 0..3 (D35); the ledger does not drive it. */
  readonly cyclesUsed: number;
  readonly reserveEntry: bigint | null;
  readonly settleEntry: bigint | null;
  /** Epoch-ms turn start. */
  readonly startedAt: number;
  /** Epoch-ms turn end, set at settle/decline; `null` while in flight. */
  readonly endedAt: number | null;
}

/**
 * One append-only ledger row as the store reads it back. This is the store-level record
 * (it carries `createdAt`, which the audit trail and SC-003 need); the route layer
 * projects it to the wire `LedgerEntry` DTO in `@nyx/protocol`.
 */
export interface LedgerEntryRecord {
  /** `bigserial` primary key — `bigint` to survive int53 overflow. */
  readonly id: bigint;
  readonly accountAddress: string;
  readonly kind: LedgerEntryKind;
  /** Always a strictly-positive magnitude; the sign is applied by kind in the fold. */
  readonly amount: bigint;
  /** deposit_ref (deposit_credit) or turn_id (reserve/reserve_release/settlement) linkage. */
  readonly ref: string | null;
  /** Epoch-ms creation time (DB clock). */
  readonly createdAt: number;
}

/**
 * The write + read surface US6 depends on. All methods reject (never throw
 * synchronously) so callers see one uniform failure channel.
 */
export interface LedgerStore {
  /** Open a turn at `classifying` (US1 calls this at classification start). */
  openTurn(projectId: string): Promise<Turn>;
  /** Load a turn by id, or `null` if absent (a malformed id reads as absent). */
  getTurn(turnId: string): Promise<Turn | null>;
  /**
   * Credit a finalized deposit, IDEMPOTENT by `ref` (exactly-once for the deposit
   * watcher: a second observation of the same ref is a no-op, never a double-credit).
   * Returns the resulting balance.
   */
  creditDeposit(address: string, ref: string, amount: bigint): Promise<Balance>;
  /**
   * Place the flat pre-turn reserve for an ACCEPTED prompt (D34), transitioning the turn
   * `classifying → reserved`. Rejects with {@link InsufficientAvailableError} when
   * `available < flatReserve` (EC-01). `flatReserve` defaults to the store's configured
   * value (D47). Returns the resulting balance.
   */
  placeReserve(address: string, turnId: string, flatReserve?: bigint): Promise<Balance>;
  /**
   * Settle a turn at ACTUAL consumption (D34): writes `reserve_release` (the turn's full
   * reserve) + `settlement` (actual) in ONE transaction and transitions
   * `reserved|running → settled`. NO credit-back exists; overage is allowed (`available`
   * may go negative). Returns the resulting balance.
   */
  settle(address: string, turnId: string, actualConsumption: bigint): Promise<Balance>;
  /** Mark a turn `declined` with NO ledger entries (D25) — the post-classification hook. */
  decline(turnId: string): Promise<Turn>;
  /** Server-derived balance for `GET /ledger` (never computed client-side, SC-023). */
  getBalance(address: string): Promise<Balance>;
  /** The append-only entry log for an account, oldest first (Story 12 audit trail). */
  getEntries(address: string): Promise<LedgerEntryRecord[]>;
}

/**
 * Ledger store construction config (D47 tunables, injectable — never hardcoded).
 * The tNIGHT→NYXT exchange rate and minimum deposit live at the DEPOSIT layer, not here.
 */
export interface LedgerStoreOptions {
  /**
   * Flat per-turn reserve in NYXT base units (D34). Wired from
   * `config.tunables.flatReserveNyxt` in production; defaults to {@link DEFAULT_FLAT_RESERVE}.
   * Overridable per call via `placeReserve(..., flatReserve)`.
   */
  readonly flatReserve?: bigint;
}

/**
 * Default flat reserve — mirrors the `FLAT_RESERVE` config default (D47). Real
 * deployments inject `config.tunables.flatReserveNyxt`; this constant only backs a
 * store constructed without options (tests, tooling).
 */
export const DEFAULT_FLAT_RESERVE = 100n;

/** A pooled DB handle that can also open a transaction (a real `Db` satisfies this). */
export type LedgerDb = Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

// --- Named errors (mapped to HTTP statuses by US1) --------------------------

/**
 * A reserve blocked by the pre-turn gate: `available < flatReserve` (D34/EC-01 top-up
 * call-to-action). A prior turn's overage can drive `available` negative and hold new
 * reserves until the account tops up.
 */
export class InsufficientAvailableError extends Error {
  constructor(
    readonly address: string,
    readonly available: bigint,
    readonly required: bigint,
  ) {
    super(
      `insufficient available balance: ${String(available)} < required reserve ${String(required)}`,
    );
    this.name = "InsufficientAvailableError";
  }
}

/** A turn id that resolved to nothing (missing, purged, or malformed). */
export class TurnNotFoundError extends Error {
  constructor(readonly turnId: string) {
    super(`turn not found: ${turnId}`);
    this.name = "TurnNotFoundError";
  }
}

/** A turn in the wrong state for the requested transition (D34 lifecycle guard). */
export class InvalidTurnStateError extends Error {
  constructor(
    readonly turnId: string,
    readonly status: TurnStatus,
    readonly expected: readonly TurnStatus[],
  ) {
    super(`turn ${turnId} is '${status}', expected one of: ${expected.join(", ")}`);
    this.name = "InvalidTurnStateError";
  }
}

/** A non-positive amount — the ledger stores only strictly-positive magnitudes (FR-043). */
export class NonPositiveAmountError extends Error {
  constructor(
    readonly field: string,
    readonly value: bigint,
  ) {
    super(`amount must be positive: ${field} = ${String(value)}`);
    this.name = "NonPositiveAmountError";
  }
}

// --- The pure balance fold (FR-070/SC-023) ----------------------------------

/** The minimal shape {@link foldBalance} folds over: kind carries the sign, amount the magnitude. */
export interface BalanceContribution {
  readonly kind: LedgerEntryKind;
  readonly amount: bigint;
}

/**
 * Derive `{ available, reserved }` from an account's append-only entries (FR-070).
 * This is the CANONICAL fold; the Postgres store computes the identical result as a SQL
 * aggregate. Kept pure + exported so both stores and their tests share one definition.
 *
 * The invariant `available + reserved = Σdeposit_credit − Σsettlement` holds by
 * construction — the ±Σreserve and ±Σreserve_release terms cancel across the two folds.
 */
export function foldBalance(entries: Iterable<BalanceContribution>): Balance {
  let depositCredit = 0n;
  let reserve = 0n;
  let reserveRelease = 0n;
  let settlement = 0n;
  for (const entry of entries) {
    switch (entry.kind) {
      case "deposit_credit":
        depositCredit += entry.amount;
        break;
      case "reserve":
        reserve += entry.amount;
        break;
      case "reserve_release":
        reserveRelease += entry.amount;
        break;
      case "settlement":
        settlement += entry.amount;
        break;
    }
  }
  return {
    reserved: reserve - reserveRelease,
    available: depositCredit - reserve + reserveRelease - settlement,
  };
}

// --- Postgres store ---------------------------------------------------------

/**
 * The balance fold expressed as a SQL aggregate — the SQL form of {@link foldBalance}.
 *
 * The `amount` column is `numeric(40,0)` (migration 0002, H1), so each `SUM(...)` and the
 * whole signed sum are `numeric`. The result is cast `::text` — NOT `::bigint` — so a
 * cumulative Σdeposit_credit past 2^63-1 never overflows an int8 and freezes balance reads;
 * {@link balanceWithin} parses the decimal string with `BigInt()` (no `Number()` coercion).
 */
const BALANCE_FOLD = `
  (COALESCE(SUM(amount) FILTER (WHERE kind = 'reserve'), 0)
     - COALESCE(SUM(amount) FILTER (WHERE kind = 'reserve_release'), 0))::text AS reserved,
  (COALESCE(SUM(amount) FILTER (WHERE kind = 'deposit_credit'), 0)
     - COALESCE(SUM(amount) FILTER (WHERE kind = 'reserve'), 0)
     + COALESCE(SUM(amount) FILTER (WHERE kind = 'reserve_release'), 0)
     - COALESCE(SUM(amount) FILTER (WHERE kind = 'settlement'), 0))::text AS available`;

/** Standard turn projection: bigints and timestamps arrive as strings, mapped below. */
const TURN_COLUMNS = `id, project_id, status, cycles_used,
  reserve_entry::text AS reserve_entry,
  settle_entry::text AS settle_entry,
  (extract(epoch from started_at) * 1000)::bigint AS started_at_ms,
  (extract(epoch from ended_at) * 1000)::bigint AS ended_at_ms`;

interface BalanceRow {
  readonly reserved: string;
  readonly available: string;
}

interface TurnRow {
  readonly id: string;
  readonly project_id: string;
  readonly status: TurnStatus;
  readonly cycles_used: number;
  readonly reserve_entry: string | null;
  readonly settle_entry: string | null;
  readonly started_at_ms: string;
  readonly ended_at_ms: string | null;
}

interface EntryRow {
  readonly id: string;
  readonly account_address: string;
  readonly kind: LedgerEntryKind;
  readonly amount: string;
  readonly ref: string | null;
  readonly created_at_ms: string;
}

interface EntryIdRow {
  readonly id: string;
}

interface AmountRow {
  readonly amount: string;
}

/** Re-brand a DB row into the {@link Turn} shape at the store boundary. */
function mapTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    cyclesUsed: row.cycles_used,
    reserveEntry: row.reserve_entry === null ? null : BigInt(row.reserve_entry),
    settleEntry: row.settle_entry === null ? null : BigInt(row.settle_entry),
    startedAt: Number(row.started_at_ms),
    endedAt: row.ended_at_ms === null ? null : Number(row.ended_at_ms),
  };
}

/** Re-brand a DB row into the {@link LedgerEntryRecord} shape at the store boundary. */
function mapEntry(row: EntryRow): LedgerEntryRecord {
  return {
    id: BigInt(row.id),
    accountAddress: row.account_address,
    kind: row.kind,
    amount: BigInt(row.amount),
    ref: row.ref,
    createdAt: Number(row.created_at_ms),
  };
}

/** Postgres `invalid_text_representation` — a malformed (non-uuid) turn id from a route. */
function isInvalidUuidError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "22P02";
}

/**
 * Postgres `unique_violation` (23505) — a concurrent insert already landed the row. On the
 * `ledger_entries_deposit_credit_ref_key` partial unique index this is the H2 backstop for
 * exactly-once deposit crediting under REPEATABLE READ / SERIALIZABLE (see {@link
 * PgLedgerStore.creditDeposit}).
 */
function isUniqueViolationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Postgres-backed {@link LedgerStore}. The append-only invariant is enforced at the DB
 * layer (triggers block UPDATE/DELETE on `ledger_entries`), so the store only ever
 * INSERTs entries. Every balance-affecting mutation locks the account row `FOR UPDATE`
 * to serialize concurrent reserves/settlements, computes the balance via the SQL fold,
 * and writes inside `db.transaction` so a failure rolls the whole pair back.
 *
 * Money-path widths (migration 0002): `ledger_entries.amount` is `numeric(40,0)`, so a
 * single credit up to the contract's 2^64-1 mint cap and any cumulative Σ beyond 2^63-1 are
 * represented exactly. Amount params are written `$N::numeric` and read back `::text` →
 * `BigInt()` (never `::bigint`, never `Number()`), preserving full precision on the wire.
 * Deposit crediting is exactly-once under ANY isolation level: the `FOR UPDATE` + NOT EXISTS
 * fast path plus the `ledger_entries_deposit_credit_ref_key` partial unique index backstop.
 */
export class PgLedgerStore implements LedgerStore {
  private readonly flatReserve: bigint;

  constructor(
    private readonly db: LedgerDb,
    options: LedgerStoreOptions = {},
  ) {
    this.flatReserve = options.flatReserve ?? DEFAULT_FLAT_RESERVE;
  }

  async openTurn(projectId: string): Promise<Turn> {
    const { rows } = await this.db.query<TurnRow>(
      `INSERT INTO turns (project_id, status) VALUES ($1, 'classifying')
       RETURNING ${TURN_COLUMNS}`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("turn insert returned no row");
    }
    return mapTurn(row);
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    try {
      const { rows } = await this.db.query<TurnRow>(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE id = $1`,
        [turnId],
      );
      const row = rows[0];
      return row === undefined ? null : mapTurn(row);
    } catch (error) {
      // A malformed (non-uuid) id from an untrusted route is "not found", not a 500.
      if (isInvalidUuidError(error)) {
        return null;
      }
      throw error;
    }
  }

  creditDeposit(address: string, ref: string, amount: bigint): Promise<Balance> {
    if (amount <= 0n) {
      return Promise.reject(new NonPositiveAmountError("amount", amount));
    }
    return this.db.transaction(async (tx) => {
      // Ensure the account exists (FK) and lock it so concurrent same-ref credits
      // serialize — the second waits, then sees the first via the NOT EXISTS guard.
      await tx.query(
        `INSERT INTO accounts (address) VALUES ($1) ON CONFLICT (address) DO NOTHING`,
        [address],
      );
      await tx.query(`SELECT address FROM accounts WHERE address = $1 FOR UPDATE`, [address]);
      // Exactly-once by ref (H2), STRUCTURAL under ANY isolation level:
      //  - fast path (READ COMMITTED): the FOR UPDATE serializes the two writers and the
      //    second re-reads the first's committed credit, so NOT EXISTS inserts nothing;
      //  - backstop (REPEATABLE READ / SERIALIZABLE): the second's frozen snapshot misses
      //    the concurrent credit, NOT EXISTS is stale, and the insert would double-credit —
      //    the `ledger_entries_deposit_credit_ref_key` partial unique index rejects it (23505).
      // A 23505 is treated as "already credited" (idempotent no-op), never propagated. The
      // insert runs inside a SAVEPOINT so the failure rolls back JUST the insert, leaving the
      // transaction usable for the balance read below (a raw 23505 would abort the whole tx).
      // The amount param is cast `$2::numeric` (not `::bigint`) so a value in (2^63-1, 2^64-1]
      // — mintable on-chain per the NyxtVault Uint<64> cap — inserts without 22003 overflow.
      await tx.query(`SAVEPOINT deposit_credit_insert`);
      try {
        await tx.query(
          `INSERT INTO ledger_entries (account_address, kind, amount, ref)
           SELECT $1, 'deposit_credit', $2::numeric, $3
            WHERE NOT EXISTS (
                    SELECT 1 FROM ledger_entries WHERE kind = 'deposit_credit' AND ref = $3
                  )`,
          [address, amount.toString(), ref],
        );
        await tx.query(`RELEASE SAVEPOINT deposit_credit_insert`);
      } catch (error) {
        if (!isUniqueViolationError(error)) {
          throw error;
        }
        // Already credited by a concurrent transaction — undo the failed insert only.
        await tx.query(`ROLLBACK TO SAVEPOINT deposit_credit_insert`);
      }
      return this.balanceWithin(tx, address);
    });
  }

  placeReserve(
    address: string,
    turnId: string,
    flatReserve: bigint = this.flatReserve,
  ): Promise<Balance> {
    if (flatReserve <= 0n) {
      return Promise.reject(new NonPositiveAmountError("flatReserve", flatReserve));
    }
    return this.db.transaction(async (tx) => {
      const turn = await this.lockTurn(tx, turnId);
      if (turn === null) {
        throw new TurnNotFoundError(turnId);
      }
      if (turn.status !== "classifying") {
        throw new InvalidTurnStateError(turnId, turn.status, ["classifying"]);
      }
      // Lock the account row so the gate + reserve is atomic w.r.t. concurrent reserves.
      // An absent account has zero balance and fails the gate below.
      await tx.query(`SELECT address FROM accounts WHERE address = $1 FOR UPDATE`, [address]);
      const balance = await this.balanceWithin(tx, address);
      if (balance.available < flatReserve) {
        throw new InsufficientAvailableError(address, balance.available, flatReserve);
      }
      const inserted = await tx.query<EntryIdRow>(
        `INSERT INTO ledger_entries (account_address, kind, amount, ref)
         VALUES ($1, 'reserve', $2::numeric, $3)
         RETURNING id::text AS id`,
        [address, flatReserve.toString(), turnId],
      );
      const reserveId = inserted.rows[0]?.id;
      if (reserveId === undefined) {
        throw new Error("reserve insert returned no row");
      }
      await tx.query(
        `UPDATE turns SET status = 'reserved', reserve_entry = $2::bigint WHERE id = $1`,
        [turnId, reserveId],
      );
      return this.balanceWithin(tx, address);
    });
  }

  settle(address: string, turnId: string, actualConsumption: bigint): Promise<Balance> {
    if (actualConsumption <= 0n) {
      return Promise.reject(new NonPositiveAmountError("actualConsumption", actualConsumption));
    }
    return this.db.transaction(async (tx) => {
      const turn = await this.lockTurn(tx, turnId);
      if (turn === null) {
        throw new TurnNotFoundError(turnId);
      }
      if ((turn.status !== "reserved" && turn.status !== "running") || turn.reserveEntry === null) {
        throw new InvalidTurnStateError(turnId, turn.status, ["reserved", "running"]);
      }
      // Release the FULL reserve that was placed for THIS turn (looked up, not re-derived,
      // so a later `flatReserve` config change cannot mis-release a live turn).
      const reserveRow = await tx.query<AmountRow>(
        `SELECT amount::text AS amount FROM ledger_entries WHERE id = $1`,
        [turn.reserveEntry.toString()],
      );
      const reserveAmount = reserveRow.rows[0]?.amount;
      if (reserveAmount === undefined) {
        throw new Error(`reserve entry missing for turn ${turnId}`);
      }
      await tx.query(`SELECT address FROM accounts WHERE address = $1 FOR UPDATE`, [address]);
      // The reserve_release + settlement PAIR (scenario 4's "one atomic ledger entry"):
      // one transaction, so a failure between them rolls BOTH back. `now()` is the same
      // instant across the transaction, so settlement.created_at == turns.ended_at (SC-003).
      await tx.query(
        `INSERT INTO ledger_entries (account_address, kind, amount, ref)
         VALUES ($1, 'reserve_release', $2::numeric, $3)`,
        [address, reserveAmount, turnId],
      );
      const settlement = await tx.query<EntryIdRow>(
        `INSERT INTO ledger_entries (account_address, kind, amount, ref)
         VALUES ($1, 'settlement', $2::numeric, $3)
         RETURNING id::text AS id`,
        [address, actualConsumption.toString(), turnId],
      );
      const settleId = settlement.rows[0]?.id;
      if (settleId === undefined) {
        throw new Error("settlement insert returned no row");
      }
      await tx.query(
        `UPDATE turns SET status = 'settled', settle_entry = $2::bigint, ended_at = now()
          WHERE id = $1`,
        [turnId, settleId],
      );
      return this.balanceWithin(tx, address);
    });
  }

  decline(turnId: string): Promise<Turn> {
    return this.db.transaction(async (tx) => {
      const turn = await this.lockTurn(tx, turnId);
      if (turn === null) {
        throw new TurnNotFoundError(turnId);
      }
      if (turn.status !== "classifying") {
        throw new InvalidTurnStateError(turnId, turn.status, ["classifying"]);
      }
      // D25: declined turns are charged nothing — status flip only, no ledger entries.
      const { rows } = await tx.query<TurnRow>(
        `UPDATE turns SET status = 'declined', ended_at = now()
          WHERE id = $1 RETURNING ${TURN_COLUMNS}`,
        [turnId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new TurnNotFoundError(turnId);
      }
      return mapTurn(row);
    });
  }

  getBalance(address: string): Promise<Balance> {
    return this.balanceWithin(this.db, address);
  }

  async getEntries(address: string): Promise<LedgerEntryRecord[]> {
    const { rows } = await this.db.query<EntryRow>(
      `SELECT id::text AS id, account_address, kind, amount::text AS amount, ref,
              (extract(epoch from created_at) * 1000)::bigint AS created_at_ms
         FROM ledger_entries
        WHERE account_address = $1
        ORDER BY id`,
      [address],
    );
    return rows.map(mapEntry);
  }

  /** Compute the derived balance via the SQL fold (usable on the pool or inside a tx). */
  private async balanceWithin(queryable: Queryable, address: string): Promise<Balance> {
    const { rows } = await queryable.query<BalanceRow>(
      `SELECT ${BALANCE_FOLD} FROM ledger_entries WHERE account_address = $1`,
      [address],
    );
    const row = rows[0];
    // The aggregate always returns exactly one row; guard for the type-checker only.
    return row === undefined
      ? { available: 0n, reserved: 0n }
      : { available: BigInt(row.available), reserved: BigInt(row.reserved) };
  }

  /** Lock + read a turn `FOR UPDATE`, mapping a missing/malformed id to `null`. */
  private async lockTurn(tx: Queryable, turnId: string): Promise<Turn | null> {
    try {
      const { rows } = await tx.query<TurnRow>(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE id = $1 FOR UPDATE`,
        [turnId],
      );
      const row = rows[0];
      return row === undefined ? null : mapTurn(row);
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return null;
      }
      throw error;
    }
  }
}

/** Construct the Postgres-backed ledger store (US1 wires this from `config.tunables`). */
export function createLedgerStore(db: LedgerDb, options: LedgerStoreOptions = {}): LedgerStore {
  return new PgLedgerStore(db, options);
}
