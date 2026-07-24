/**
 * Deposit flow service + store (T120, US6) — finality-gated NYXT crediting (D45/D46).
 *
 * A deposit moves through two hops. FIRST the user PRE-REGISTERS a reference
 * ({@link DepositStore.preregister}, FR-042): the server mints a random `depositRef`,
 * binds it to the account + the intended `expected_amount`, and gives it a TTL. The wire
 * amount the UI selects is governed by the tNIGHT→NYXT exchange rate — but that rate lives
 * ONLY on the UI/expected-amount side; it NEVER enters the credit path (see EC-28 below).
 *
 * THEN a finality-gated observation of the on-chain deposit arrives
 * ({@link DepositStore.observeFinalized}, FR-041). We credit ONLY on a `finalized`
 * `success`; everything else is a no-op or a diagnostic:
 *  - a NON-finalized observation is IGNORED (we never credit before finality, SC-021);
 *  - a `failure` credits nothing and surfaces a `failed` outcome for the UI (scenario 6),
 *    and a KNOWN ref is NEVER orphaned on failure (D46) — the ref stays creditable so a
 *    later genuinely-finalized success can still land;
 *  - a `success` of a KNOWN, not-yet-credited ref credits the ON-CHAIN observed amount
 *    (EC-28: even when it differs from `expected_amount`, the difference is logged LOUDLY
 *    and the chain wins), then flips the ref → `credited`;
 *  - a `success` of an UNREGISTERED ref is ORPHANED for manual resolution and NEVER
 *    auto-credited (D46/FR-044/EC-31).
 *
 * Exactly-once (SC-021, EC-30 indexer catch-up) rests on BELT-AND-SUSPENDERS: the
 * deposit-ref status flip (the nonce-burn compare-and-swap pattern) AND `creditDeposit`'s
 * own ref-idempotency. The credit is written FIRST and the ref flipped SECOND, so a crash
 * between them never LOSES a credit (a replay re-credits idempotently, then flips the ref),
 * while `creditDeposit`'s ref-dedup prevents a DOUBLE credit. Replaying the indexer scan
 * from a cursor is therefore safe.
 *
 * The {@link DepositObservation} is a NARROW Nyx-INTERNAL seam (constitution I) — NOT any
 * `@midnight-ntwrk/*` indexer/SDK type; the real indexer→observation adapter is
 * owner-gated. All store failures are promise REJECTIONS with named error classes; the DB
 * clock (`now()`) decides every timestamp, and every value is a bound parameter.
 *
 * Config tunables (D47, injectable — never hardcoded): the minimum accepted deposit and
 * the deposit-ref TTL. US1 wires the real values from `config.tunables.minimumDepositNyxt`
 * and `config.tunables.depositRefTtlMs`; the {@link DEFAULT_MINIMUM_DEPOSIT} /
 * {@link DEFAULT_DEPOSIT_REF_TTL_MS} constants (mirroring the shipped config defaults) only
 * back a store constructed without options (tests, tooling). US1 owns the `POST /deposits`
 * + `GET /deposits/:ref` route wiring; this module is the service those routes call.
 */
import { randomBytes } from "node:crypto";
import type { Queryable } from "../db/index.js";
import type { Balance, LedgerStore } from "./ledger.js";

// --- Public types -----------------------------------------------------------

/**
 * Deposit-ref lifecycle status. `preregistered` → `seen` (observed pending finality) →
 * `credited` (terminal), or `preregistered` → `expired` (swept, EC-29). This union is a
 * SUPERSET of what `deposit_refs.status` currently persists: the migrated CHECK allows
 * `preregistered|seen|credited|expired` only, so `getDeposit` returns one of those four.
 * `failed` is carried here for the GET /deposits/:ref wire contract but is NOT persisted
 * under the current schema — a finalized failure is surfaced via the {@link CreditOutcome}
 * `failed` variant instead (a future migration would make it a durable ref status).
 */
export type DepositStatus = "preregistered" | "seen" | "credited" | "expired" | "failed";

/** The result of {@link DepositStore.preregister} — a fresh ref and its epoch-ms expiry. */
export interface DepositRegistration {
  /** The random, single-use deposit reference to embed in the on-chain deposit. */
  readonly ref: string;
  /** Epoch-ms TTL after which an unfulfilled pre-registration is swept (EC-29). */
  readonly expiresAt: number;
}

/**
 * A still-open deposit ref the observation adapter must keep watching (Task 7). "Open" =
 * a watchable status (`preregistered`/`seen`) OR an `expired` ref still inside the
 * late-deposit grace window (D46/EC-30 — a deposit that lands after TTL still credits, so
 * a recently-expired ref must stay watched until the grace window closes).
 */
export interface OpenDepositRef {
  /** The deposit reference to watch on the indexer. */
  readonly ref: string;
}

/** A read projection for `GET /deposits/:ref` (the pre-registered ref lifecycle). */
export interface DepositView {
  readonly status: DepositStatus;
  /**
   * The on-chain transaction reference, when known. NOT populated under the current
   * schema (`deposit_refs` has no `tx_ref` column) — reserved for a future migration.
   */
  readonly txRef?: string;
}

/**
 * A NARROW, Nyx-INTERNAL finality-gated deposit observation (constitution I). This is the
 * shape the (owner-gated) indexer→Nyx adapter produces — it is deliberately NOT any
 * `@midnight-ntwrk/*` indexer/SDK type. We act on an observation ONLY when `finalized` is
 * true, and credit ONLY on a finalized `success`.
 */
export interface DepositObservation {
  /** The deposit reference carried by the on-chain deposit. */
  readonly ref: string;
  /**
   * The ON-CHAIN observed amount in NYXT base units — this, not `expected_amount`, is what
   * gets credited (EC-28). Always the authoritative minted magnitude.
   */
  readonly amount: bigint;
  /** The on-chain transaction reference (diagnostics + orphan resolution). */
  readonly txRef: string;
  /** Whether the on-chain deposit succeeded or failed. */
  readonly outcome: "success" | "failure";
  /**
   * Whether the observation is at/after finality. `false` → IGNORED (never credit before
   * finality). Widened from a literal `true` so the ignore path is reachable/testable.
   */
  readonly finalized: boolean;
}

/**
 * The discriminated outcome of {@link DepositStore.observeFinalized}, so callers (US1's
 * route + WS relay) and tests can assert EXACTLY what happened:
 *  - `credited` — a known ref credited the on-chain amount (carries the new balance);
 *  - `already-credited` — a duplicate/reorg of an already-credited ref (no-op, SC-021);
 *  - `failed` — a finalized failure; nothing credited (scenario 6 diagnostic);
 *  - `orphaned` — an unregistered success recorded for manual resolution (D46);
 *  - `ignored-unfinalized` — a pre-finality observation (never credited).
 */
export type CreditOutcome =
  | {
      readonly kind: "credited";
      readonly ref: string;
      readonly address: string;
      readonly amount: bigint;
      readonly balance: Balance;
    }
  | { readonly kind: "already-credited"; readonly ref: string }
  | {
      readonly kind: "failed";
      readonly ref: string;
      readonly txRef: string;
      readonly amount: bigint;
      /** The depositor's account, when the ref is known (so US1 can route the diagnostic). */
      readonly address?: string;
    }
  | {
      readonly kind: "orphaned";
      readonly ref: string;
      readonly txRef: string;
      readonly amount: bigint;
    }
  | { readonly kind: "ignored-unfinalized"; readonly ref: string };

/**
 * The write + read surface US6 depends on. All methods reject (never throw synchronously)
 * so callers see one uniform failure channel.
 */
export interface DepositStore {
  /**
   * Pre-register a deposit intent (FR-042): mint a random ref bound to `address` +
   * `amount` (the expected amount) with a TTL, auto-creating the account (D43). Rejects a
   * below-minimum `amount` with {@link DepositBelowMinimumError} (D45/D47), and an amount
   * above the contract mint cap with {@link DepositAboveMaximumError} ({@link MAXIMUM_DEPOSIT}).
   */
  preregister(address: string, amount: bigint): Promise<DepositRegistration>;
  /**
   * Process a finality-gated on-chain observation (FR-041). Credits ONLY on a finalized
   * `success`; see {@link CreditOutcome} for every branch. Exactly-once under
   * reorg/duplicate/catch-up (SC-021, EC-30).
   */
  observeFinalized(observation: DepositObservation): Promise<CreditOutcome>;
  /**
   * Sweep `preregistered` refs past their TTL → `expired` (EC-29) so an abandoned top-up
   * leaves no dangling pending state. Expiry is decided by the store's clock (the DB
   * `now()` for {@link PgDepositStore}) — never a caller-supplied timestamp. Returns the
   * number of refs expired.
   */
  expireStale(): Promise<number>;
  /** Read the deposit-ref lifecycle status for `GET /deposits/:ref`, or `null` if unknown. */
  getDeposit(ref: string): Promise<DepositView | null>;
  /**
   * List the refs the observation adapter must still watch (Task 7): every `preregistered`
   * or `seen` ref, plus every `expired` ref whose expiry is less than `graceMs` ago (the
   * late-deposit grace window, D46/EC-30). Expiry is decided by the store's clock (the DB
   * `now()` for {@link PgDepositStore}) — never a caller-supplied timestamp.
   */
  listOpenRefs(graceMs: number): Promise<readonly OpenDepositRef[]>;
}

/**
 * A minimal structured-logger seam (a subset of Fastify's `request.log`). Injected so the
 * EC-28 amount mismatch + late-deposit warnings are emitted LOUDLY and assertable in
 * tests. Defaults to a no-op; US1 injects the request/app logger.
 */
export interface DepositLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

/** Deposit store construction config (D47 tunables + injectable seams — never hardcoded). */
export interface DepositStoreOptions {
  /**
   * Smallest accepted deposit in NYXT base units (D45/D47). Wired from
   * `config.tunables.minimumDepositNyxt`; defaults to {@link DEFAULT_MINIMUM_DEPOSIT}.
   */
  readonly minimumDeposit?: bigint;
  /**
   * Deposit-ref TTL in ms (D45/D47). Wired from `config.tunables.depositRefTtlMs`;
   * defaults to {@link DEFAULT_DEPOSIT_REF_TTL_MS}.
   */
  readonly depositRefTtlMs?: number;
  /** Deposit-ref source; defaults to {@link randomDepositRef}. Injected for determinism. */
  readonly generateRef?: () => string;
  /** Structured logger for loud EC-28 / late-deposit warnings; defaults to a no-op. */
  readonly logger?: DepositLogger;
}

/** Bytes of entropy in a deposit ref — 32 bytes (256 bits) hex-encoded (FR-042). */
export const DEPOSIT_REF_BYTES = 32;

/**
 * Default minimum deposit — mirrors the shipped `MINIMUM_DEPOSIT` config default (D45/D47).
 * Real deployments inject `config.tunables.minimumDepositNyxt`; this only backs a store
 * constructed without options (tests, tooling).
 */
export const DEFAULT_MINIMUM_DEPOSIT = 1_000n;

/**
 * The contract's per-deposit mint cap: 2^64-1 NYXT base units. The NyxtVault contract
 * (`packages/nyxt-vault/src/nyxt-vault.compact`) mints NYXT 1:1 with a `Uint<64>` value and
 * asserts `amount <= 18446744073709551615` on-chain, so a larger deposit can NEVER be minted.
 * This is a fixed CONTRACT property (not a D47 tunable): we reject an above-cap amount at
 * pre-registration so a user never funds tNIGHT that can never be credited (fund safety).
 */
export const MAXIMUM_DEPOSIT = 18_446_744_073_709_551_615n;

/**
 * Default deposit-ref TTL — 1 hour, mirroring the shipped `DEPOSIT_REF_TTL_MS` config
 * default (D45/D47). Chosen to match the already-wired config default rather than the
 * 30-min sketch, so the store's fallback and production agree.
 */
export const DEFAULT_DEPOSIT_REF_TTL_MS = 3_600_000;

/** Mint a fresh, collision-free deposit ref: 32 random bytes, hex-encoded (FR-042). */
export function randomDepositRef(): string {
  return randomBytes(DEPOSIT_REF_BYTES).toString("hex");
}

/** No-op logger backing a store constructed without an explicit logger. */
const NOOP_LOGGER: DepositLogger = {
  warn: () => {
    // Intentionally silent: production injects the Fastify request/app logger.
  },
};

/** Deposit-ref statuses from which a finalized success may still credit (the CAS set). */
const CREDITABLE_STATUSES = ["preregistered", "seen", "expired"] as const;

// --- Named errors (mapped to HTTP statuses by US1) --------------------------

/**
 * A pre-registration below the configured minimum deposit (D45/D47). Rejecting loudly
 * (never silently accepting) keeps the top-up CTA honest.
 */
export class DepositBelowMinimumError extends Error {
  constructor(
    readonly address: string,
    readonly amount: bigint,
    readonly minimum: bigint,
  ) {
    super(`deposit below minimum: ${String(amount)} < required minimum ${String(minimum)}`);
    this.name = "DepositBelowMinimumError";
  }
}

/**
 * A pre-registration above the contract's per-deposit mint cap ({@link MAXIMUM_DEPOSIT},
 * 2^64-1). Such a deposit can never be minted on-chain (the NyxtVault `Uint<64>` mint cap),
 * so accepting it would let a user fund tNIGHT that strands forever uncredited. Rejecting
 * loudly up front (never silently accepting) is the fund-safety counterpart to
 * {@link DepositBelowMinimumError}.
 */
export class DepositAboveMaximumError extends Error {
  constructor(
    readonly address: string,
    readonly amount: bigint,
    readonly maximum: bigint,
  ) {
    super(`deposit above maximum: ${String(amount)} > per-deposit mint cap ${String(maximum)}`);
    this.name = "DepositAboveMaximumError";
  }
}

// --- Postgres store ---------------------------------------------------------

interface ExpiresRow {
  readonly expires_at_ms: string;
}

interface DepositRefRow {
  readonly account_address: string;
  readonly expected_amount: string;
  readonly status: DepositStatus;
}

interface StatusRow {
  readonly status: DepositStatus;
}

interface RefRow {
  readonly ref: string;
}

/** A `deposit_refs` row re-branded at the store boundary. */
interface DepositRefRecord {
  readonly accountAddress: string;
  readonly expectedAmount: bigint;
  readonly status: DepositStatus;
}

/**
 * Postgres-backed {@link DepositStore}. Pre-registration ensures the account (FK) and
 * inserts the ref in ONE atomic statement (a data-modifying CTE). The credit path leans on
 * the injected {@link LedgerStore} for the actual `deposit_credit` (idempotent by ref) and
 * a status compare-and-swap on `deposit_refs` for exactly-once — the DB `now()` decides
 * every timestamp and every value is a bound parameter (never interpolated).
 */
export class PgDepositStore implements DepositStore {
  private readonly minimumDeposit: bigint;
  private readonly depositRefTtlMs: number;
  private readonly generateRef: () => string;
  private readonly logger: DepositLogger;

  constructor(
    private readonly db: Queryable,
    private readonly ledger: LedgerStore,
    options: DepositStoreOptions = {},
  ) {
    this.minimumDeposit = options.minimumDeposit ?? DEFAULT_MINIMUM_DEPOSIT;
    this.depositRefTtlMs = options.depositRefTtlMs ?? DEFAULT_DEPOSIT_REF_TTL_MS;
    this.generateRef = options.generateRef ?? randomDepositRef;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  preregister(address: string, amount: bigint): Promise<DepositRegistration> {
    if (amount < this.minimumDeposit) {
      return Promise.reject(new DepositBelowMinimumError(address, amount, this.minimumDeposit));
    }
    // Above the contract's Uint<64> mint cap the deposit can never be minted on-chain
    // (H1 — fund safety): reject it rather than accept a ref that can never credit.
    if (amount > MAXIMUM_DEPOSIT) {
      return Promise.reject(new DepositAboveMaximumError(address, amount, MAXIMUM_DEPOSIT));
    }
    return this.registerRef(address, this.generateRef(), amount);
  }

  private async registerRef(
    address: string,
    ref: string,
    amount: bigint,
  ): Promise<DepositRegistration> {
    // One atomic statement: the data-modifying CTE ensures the account (FK) before the
    // ref insert; both see the same DB snapshot, so no explicit transaction is needed.
    const { rows } = await this.db.query<ExpiresRow>(
      `WITH ensure_account AS (
         INSERT INTO accounts (address) VALUES ($1) ON CONFLICT (address) DO NOTHING
       )
       INSERT INTO deposit_refs (ref, account_address, expected_amount, expires_at)
       VALUES ($2, $1, $3::numeric, now() + ($4::text || ' milliseconds')::interval)
       RETURNING (extract(epoch from expires_at) * 1000)::bigint AS expires_at_ms`,
      [address, ref, amount.toString(), this.depositRefTtlMs],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("deposit_ref insert returned no row");
    }
    return { ref, expiresAt: Number(row.expires_at_ms) };
  }

  observeFinalized(observation: DepositObservation): Promise<CreditOutcome> {
    // Credit ONLY on a finalized observation — a pre-finality event is ignored (SC-021).
    if (!observation.finalized) {
      return Promise.resolve({ kind: "ignored-unfinalized", ref: observation.ref });
    }
    if (observation.outcome === "failure") {
      return this.recordFailure(observation);
    }
    return this.creditSuccess(observation);
  }

  private async recordFailure(observation: DepositObservation): Promise<CreditOutcome> {
    // A known ref is NEVER orphaned on failure (D46); look it up only to route the
    // diagnostic to the depositor. The ref's status is left untouched so a later genuine
    // success can still credit it.
    const record = await this.readRef(observation.ref);
    this.logger.warn(
      {
        ref: observation.ref,
        txRef: observation.txRef,
        amount: observation.amount.toString(),
      },
      "deposit finalized as FAILURE — not credited (scenario 6)",
    );
    if (record === null) {
      return {
        kind: "failed",
        ref: observation.ref,
        txRef: observation.txRef,
        amount: observation.amount,
      };
    }
    return {
      kind: "failed",
      ref: observation.ref,
      txRef: observation.txRef,
      amount: observation.amount,
      address: record.accountAddress,
    };
  }

  private async creditSuccess(observation: DepositObservation): Promise<CreditOutcome> {
    const record = await this.readRef(observation.ref);
    if (record === null) {
      // Unregistered → orphan for manual resolution; NEVER auto-credit (D46/FR-044/EC-31).
      // Idempotent by the UNIQUE `ref` (a duplicate observation records nothing new).
      await this.db.query(
        `INSERT INTO orphan_deposits (ref, amount, tx_ref) VALUES ($1, $2::numeric, $3)
         ON CONFLICT (ref) DO NOTHING`,
        [observation.ref, observation.amount.toString(), observation.txRef],
      );
      return {
        kind: "orphaned",
        ref: observation.ref,
        txRef: observation.txRef,
        amount: observation.amount,
      };
    }
    if (record.status === "credited") {
      // A duplicate/reorg of an already-credited ref is a no-op (SC-021 exactly-once).
      return { kind: "already-credited", ref: observation.ref };
    }
    if (record.status === "expired") {
      // A confirmed on-chain success is authoritative over our local TTL bookkeeping —
      // never drop finalized funds (fund safety). Logged loudly.
      this.logger.warn(
        { ref: observation.ref, txRef: observation.txRef },
        "deposit finalized SUCCESS after TTL expiry — crediting confirmed on-chain funds (fund safety)",
      );
    }
    if (record.expectedAmount !== observation.amount) {
      // EC-28: credit the ON-CHAIN amount, even when it differs from the expected amount.
      this.logger.warn(
        {
          ref: observation.ref,
          expected: record.expectedAmount.toString(),
          observed: observation.amount.toString(),
          txRef: observation.txRef,
        },
        "deposit amount mismatch (EC-28) — crediting the ON-CHAIN observed amount",
      );
    }
    // Credit FIRST (idempotent by ref): a crash before the CAS below never LOSES the
    // credit (a replay re-credits idempotently), and creditDeposit's ref-dedup prevents a
    // DOUBLE credit — so replaying the indexer scan from a cursor is safe (EC-30).
    const balance = await this.ledger.creditDeposit(
      record.accountAddress,
      observation.ref,
      observation.amount,
    );
    // Then flip the ref → credited (the nonce-burn CAS): a replay reads `credited` above
    // and short-circuits to `already-credited`.
    await this.db.query(
      `UPDATE deposit_refs SET status = 'credited'
        WHERE ref = $1 AND status = ANY($2::text[])`,
      [observation.ref, [...CREDITABLE_STATUSES]],
    );
    return {
      kind: "credited",
      ref: observation.ref,
      address: record.accountAddress,
      amount: observation.amount,
      balance,
    };
  }

  async expireStale(): Promise<number> {
    // The DB clock decides expiry (never the process clock). Only `preregistered` refs
    // expire — a `seen` ref has an on-chain observation pending and must not be swept.
    const result = await this.db.query(
      `UPDATE deposit_refs SET status = 'expired'
        WHERE status = 'preregistered' AND expires_at <= now()`,
    );
    return result.rowCount ?? 0;
  }

  async getDeposit(ref: string): Promise<DepositView | null> {
    const { rows } = await this.db.query<StatusRow>(
      `SELECT status FROM deposit_refs WHERE ref = $1`,
      [ref],
    );
    const row = rows[0];
    return row === undefined ? null : { status: row.status };
  }

  async listOpenRefs(graceMs: number): Promise<readonly OpenDepositRef[]> {
    // The DB clock decides the grace window (never the process clock): a watchable ref
    // (`preregistered`/`seen`) OR an `expired` ref whose expiry is less than `graceMs` ago
    // (late-deposit grace, D46/EC-30). `graceMs` is a bound parameter, never interpolated.
    const { rows } = await this.db.query<RefRow>(
      `SELECT ref FROM deposit_refs
        WHERE status IN ('preregistered', 'seen')
           OR (status = 'expired'
               AND expires_at > now() - ($1::bigint * interval '1 millisecond'))`,
      [graceMs],
    );
    return rows.map((row) => ({ ref: row.ref }));
  }

  /** Read a `deposit_refs` row, or `null` if the ref is unknown. */
  private async readRef(ref: string): Promise<DepositRefRecord | null> {
    const { rows } = await this.db.query<DepositRefRow>(
      `SELECT account_address, expected_amount::text AS expected_amount, status
         FROM deposit_refs WHERE ref = $1`,
      [ref],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          accountAddress: row.account_address,
          expectedAmount: BigInt(row.expected_amount),
          status: row.status,
        };
  }
}

/** Construct the Postgres-backed deposit store (US1 wires this from `config.tunables`). */
export function createDepositStore(
  db: Queryable,
  ledger: LedgerStore,
  options: DepositStoreOptions = {},
): DepositStore {
  return new PgDepositStore(db, ledger, options);
}
