/**
 * Ledger reconcile & settle job (T175, US10) — the LAZY on-chain leg of the token
 * economy (D13/D55/D56). Per-turn settlement is already off-chain (D34, US6); this job is
 * the daily, config-cadence (D56), NEVER-in-a-user-path (FR-066/SC-039) reconciliation that
 * keeps the off-chain NYXT ledger and the on-chain vault provably honest.
 *
 * Each run compares THREE sources (FR-067) as of a FINALIZED watermark (EC-50 — never
 * wall-clock now; the caller passes a finalized chain cursor):
 *  1. the append-only Postgres ledger — Σdeposit_credit (credits) + Σsettlement (consumed);
 *  2. the finalized on-chain deposit log — the same indexer feed that credits deposits;
 *  3. the vault's on-chain NYXT balance (mints − burns).
 *
 * The reconcile is honest, not corrective:
 *  - DRIFT between chain and ledger fires a LOUD operator alarm and is NEVER auto-corrected
 *    (scenario 3 / SC-038) — it can only mean a bug or tampering. Two drift signals are
 *    checked: credits-vs-chain (the off-chain ledger must not out-credit the chain, allowing
 *    a bounded deposit-observation lag) and vault-vs-expected (`vaultBalance` must equal
 *    `onchainDepositTotal − totalBurned` exactly).
 *  - On a CLEAN run the job burns vault NYXT matching consumed credit (Σsettlement) since the
 *    last successfully-burned watermark, EXACTLY ONCE per watermark (D55/FR-068). On-chain
 *    supply then approximates outstanding credit.
 *  - Deposits are ONE-WAY (D34): reconcile never returns funds.
 *
 * Exactly-once (SC-037) rests on a CANONICAL WATERMARK plus three backstops. The watermark
 * MUST be a canonical per-reconcile-PERIOD key (see {@link FinalizedWatermarkSource}):
 * identical across concurrent instances for the same period, and STABLE across ticks until
 * that period is cleanly reconciled — NOT a live per-instance chain cursor (two instances
 * reading cursors a block apart would burn the same delta under DIFFERENT watermarks, defeating
 * every backstop below — the C1 double-burn both reviewers flagged). Given a canonical
 * watermark, the backstops (mirroring the deposit D45 pattern) are:
 *  1. a `getRun(watermark)` short-circuit — a repeated watermark returns its recorded outcome
 *     and re-burns nothing;
 *  2. the `reconcile_runs.watermark` UNIQUE index — a concurrent insert of the same watermark
 *     23505s → already-done;
 *  3. the on-chain burn circuit's own `burnedWatermarks` idempotency ({@link BurnExecutor} MUST
 *     resolve a re-submitted watermark with the original txRef, never double-burn) — the
 *     ultimate backstop across a crash between the on-chain burn and the row insert.
 *
 * AMBIGUOUS BURNS ARE OPS-GATED, NOT AUTO-RETRIED. If a burn provably FAILS (EC-49) or its
 * report cannot be persisted after a landed burn (H1 `record-failed`), an `error` row is
 * written and every subsequent run BLOCKS (loud alarm) until an operator confirms the on-chain
 * state and clears/reconciles it. Auto-retrying an ambiguous burn under a fresh watermark would
 * bypass backstop 3 and could double-burn one-way NYXT — so we STOP, mirroring the deploy
 * pipeline's ops-gated ambiguous-outcome handling. The real {@link BurnExecutor} MUST therefore
 * REJECT only when the burn provably did not land (on an ambiguous submit it must re-query the
 * watermark-idempotent chain state and resolve, never reject).
 *
 * EVERY on-chain read/write is a NARROW, Nyx-INTERNAL seam (constitution I) — NOT any
 * `@midnight-ntwrk/*` indexer/SDK type; the real indexer/vault-balance/burn adapters are
 * OWNER-GATED (mirroring `deploy/wallet.ts` `BalanceQuery`) and reject until wired. The
 * ledger-totals seam is plain Postgres ({@link pgLedgerTotals}). This module owns NEITHER the
 * daily scheduler NOR config wiring — a follow-up wiring pass drives `runReconcile` on the
 * `reconcileCadenceMs` cadence with a finalized watermark and injects the real seams.
 */
import type { Queryable } from "../db/index.js";

// --- On-chain + ledger source seams (constitution I — Nyx-internal, owner-gated) --------

/** Vault-global ledger totals (Source 1): cumulative credits and consumed (settlements). */
export interface LedgerTotals {
  /** Σdeposit_credit across all accounts — the off-chain minted total (NYXT base units). */
  readonly credits: bigint;
  /** Σsettlement across all accounts — cumulative consumed credit (NYXT base units). */
  readonly settlements: bigint;
}

/**
 * Source 1 reader — the append-only Postgres ledger folded vault-globally. Plain Postgres
 * (NOT owner-gated); {@link pgLedgerTotals} provides the real query.
 */
export type LedgerTotalsQuery = () => Promise<LedgerTotals>;

/**
 * Source 2 reader — the finalized on-chain deposit-log total (Σ of the NyxtVault `deposits`
 * map). A NARROW owner-gated seam (constitution I — NOT an `@midnight-ntwrk/*` type); the
 * real indexer→total adapter is owner-gated and reads FINALIZED state only (EC-50). Rejects
 * when the indexer is unavailable → the run is SKIPPED (EC-48), never partially compared.
 */
export type OnchainDepositTotalQuery = () => Promise<bigint>;

/**
 * Source 3 reader — the vault's on-chain NYXT balance (mints − burns). A NARROW owner-gated
 * seam (constitution I); rejects when unavailable → SKIP (EC-48).
 */
export type VaultBalanceQuery = () => Promise<bigint>;

/** Input to {@link BurnExecutor}: the batch amount and the watermark it is bound to. */
export interface BurnRequest {
  /** NYXT base units to burn — the consumed-credit delta since the last burned watermark. */
  readonly amount: bigint;
  /**
   * The canonical-period watermark this burn is bound to (the on-chain idempotency key). The
   * NyxtVault `burn` circuit takes a `Bytes<32>` watermark; the owner-gated executor MUST fix
   * the string→`Bytes<32>` encoding (e.g. a 32-byte hex digest of this key) so it round-trips
   * deterministically — a mismatch is exactly the hand-written-SDK-shape hazard constitution I
   * warns against, so it is pinned when the real executor is written, never guessed here.
   */
  readonly watermark: string;
}

/** Result of a burn: the on-chain transaction reference for the audit report. */
export interface BurnReceipt {
  readonly txRef: string;
}

/**
 * Executes the on-chain batched burn (D55) via the NyxtVault `burn` circuit (T172). A NARROW
 * owner-gated seam (constitution I — the real executor holds the deploy/orchestrator key and
 * drives the D37 prover; it is owner-gated and rejects until wired).
 *
 * CONTRACT (both halves are load-bearing for exactly-once):
 *  - IDEMPOTENT by watermark (mirrors the on-chain `burnedWatermarks` dedup, FR-068): a
 *    re-submission of an already-burned watermark RESOLVES with the original `txRef` — it does
 *    NOT reject and does NOT burn a second time. This holds SC-037 across a crash between the
 *    on-chain burn and the `reconcile_runs` insert.
 *  - REJECT ONLY WHEN THE BURN PROVABLY DID NOT LAND (M2). On an AMBIGUOUS submit (RPC timeout,
 *    dropped connection, restart mid-broadcast — the burn may have landed), the executor MUST
 *    re-query the watermark-idempotent chain state and RESOLVE with the landed receipt; it MUST
 *    NOT reject. A rejection is treated by the job as "no on-chain effect" (EC-49 → block on the
 *    error row), so an executor that rejects an ambiguous-but-landed burn would strand the run
 *    into a manual ops reconcile — never a double-burn, but avoidable ops toil.
 */
export type BurnExecutor = (request: BurnRequest) => Promise<BurnReceipt>;

// --- Report + alarm types ---------------------------------------------------

/** Run outcome, matching the `reconcile_runs.outcome` CHECK. A SKIP persists nothing. */
export type ReconcileOutcome = "reconciled" | "drift" | "error";

/** The three-source snapshot a run computed from — the audit report `inputs` (FR-069). */
export interface ReconcileSnapshot {
  /** Source 1a — Σdeposit_credit (vault-global). */
  readonly ledgerCredits: bigint;
  /** Source 1b — Σsettlement (vault-global consumed credit). */
  readonly ledgerSettlements: bigint;
  /** Source 2 — finalized on-chain deposit-log total. */
  readonly onchainDepositTotal: bigint;
  /** Source 3 — on-chain vault NYXT balance. */
  readonly vaultBalance: bigint;
}

/** A persisted reconcile report row (FR-069) with bigint amounts re-branded at the boundary. */
export interface ReconcileRunRow {
  readonly watermark: string;
  readonly outcome: ReconcileOutcome;
  readonly snapshot: ReconcileSnapshot;
  /** Signed credits-vs-chain drift (`onchainDepositTotal − ledgerCredits`); null when N/A. */
  readonly drift: bigint | null;
  /** NYXT burned this run; null on drift/error (no burn recorded). */
  readonly burnAmount: bigint | null;
  /** On-chain burn tx ref; null when nothing was burned. */
  readonly burnTx: string | null;
  /** Epoch-ms run time (the store's clock). */
  readonly ranAt: number;
}

/** The insert payload for a run (the store stamps `ranAt`). */
export interface ReconcileRunInsert {
  readonly watermark: string;
  readonly outcome: ReconcileOutcome;
  readonly snapshot: ReconcileSnapshot;
  readonly drift: bigint | null;
  readonly burnAmount: bigint | null;
  readonly burnTx: string | null;
}

/**
 * A LOUD operator-facing alarm (FR-067). Fired on DRIFT (never auto-corrected), after N
 * consecutive skips (EC-48), and when reconcile is BLOCKED on an unresolved prior burn
 * failure (the ambiguous-burn ops gate). Operator-facing only — sessions unaffected (EC-51).
 */
export interface ReconcileAlarm {
  readonly reason: "drift" | "consecutive-skips" | "burn-unresolved";
  readonly watermark: string;
  readonly message: string;
  /** Present on `drift`: the full three-source snapshot and both drift signals. */
  readonly snapshot?: ReconcileSnapshot;
  readonly creditsVsChainDrift?: bigint;
  readonly vaultVsExpectedDrift?: bigint;
  /** Present on `consecutive-skips`: how many consecutive runs were skipped. */
  readonly consecutiveSkips?: number;
  /** Present on `burn-unresolved`: the watermark of the prior burn that must be ops-reconciled. */
  readonly unresolvedWatermark?: string;
}

/** The loud alarm sink (FR-067). Injected; the wiring pass routes it to ops alerting. */
export type ReconcileAlerter = (alarm: ReconcileAlarm) => void;

// --- Run result -------------------------------------------------------------

/**
 * The discriminated outcome of {@link ReconcileJob.runReconcile}, so the scheduler + tests
 * can assert EXACTLY what happened:
 *  - `reconciled` — clean; the batched burn ran (or was zero) and the report persisted;
 *  - `drift` — a discrepancy alarmed loudly; NO burn, NO auto-correct (scenario 3);
 *  - `burn-failed` — a clean comparison but the on-chain burn provably FAILED (EC-49): an
 *    `error` report is recorded and reconcile BLOCKS on it (below) until ops resolves it;
 *  - `record-failed` — the burn LANDED on-chain but the reconciled report could not be
 *    persisted after bounded retries; a best-effort `error` row is written so the next run
 *    blocks (never re-burns) and ops reconciles the ambiguous state;
 *  - `blocked` — a PRIOR burn failure is unresolved: reconcile refuses to read/burn until ops
 *    confirms the on-chain state of `unresolvedWatermark` (the ambiguous-burn safety gate —
 *    an auto-retry under a NEW watermark would defeat the on-chain watermark dedup and could
 *    double-burn, so we STOP instead, mirroring the deploy pipeline's ops-gated failure);
 *  - `skipped` — an on-chain read was unavailable (EC-48): nothing recorded, reschedule;
 *  - `already-done` — a replay of a recorded watermark (SC-037): no re-burn, no re-record.
 */
export type ReconcileResult =
  | {
      readonly kind: "reconciled";
      readonly watermark: string;
      readonly snapshot: ReconcileSnapshot;
      readonly burnAmount: bigint;
      readonly burnTx: string | null;
      readonly drift: bigint;
    }
  | {
      readonly kind: "drift";
      readonly watermark: string;
      readonly snapshot: ReconcileSnapshot;
      readonly creditsVsChainDrift: bigint;
      readonly vaultVsExpectedDrift: bigint;
    }
  | {
      readonly kind: "burn-failed";
      readonly watermark: string;
      readonly snapshot: ReconcileSnapshot;
      readonly attemptedBurn: bigint;
      readonly error: string;
    }
  | {
      readonly kind: "record-failed";
      readonly watermark: string;
      readonly attemptedBurn: bigint;
      readonly burnTx: string;
      readonly error: string;
    }
  | {
      readonly kind: "blocked";
      readonly watermark: string;
      readonly unresolvedWatermark: string;
    }
  | {
      readonly kind: "skipped";
      readonly watermark: string;
      readonly reason: string;
      readonly consecutiveSkips: number;
    }
  | {
      readonly kind: "already-done";
      readonly watermark: string;
      readonly outcome: ReconcileOutcome;
    };

// --- Store ------------------------------------------------------------------

/** Result of {@link ReconcileStore.insertRun} — `false` when the watermark already existed. */
export interface InsertRunResult {
  readonly inserted: boolean;
}

/**
 * Persistence for the `reconcile_runs` audit table (FR-069). All methods reject (never throw
 * synchronously) so callers see one uniform failure channel. Unlike `ledger_entries`,
 * `reconcile_runs` is freely queryable + deletable (vault-global accounting, not per-account).
 */
export interface ReconcileStore {
  /** The recorded run for `watermark`, or `null` — the SC-037 replay short-circuit. */
  getRun(watermark: string): Promise<ReconcileRunRow | null>;
  /**
   * The most recent successfully-reconciled (burned) run, or `null` if none. Its snapshot's
   * `ledgerSettlements` is the burned high-water — the base for the next burn delta. A
   * `drift`/`error` run is NOT reconciled and does NOT advance this high-water (EC-49).
   */
  lastReconciled(): Promise<ReconcileRunRow | null>;
  /** Σ burn_amount over all reconciled runs — for the vault-vs-expected drift check. */
  totalBurned(): Promise<bigint>;
  /**
   * The most recent `error` (burn-failed / record-failed) run still UNRESOLVED, or `null`.
   * An error row means a burn whose on-chain effect is AMBIGUOUS (it may or may not have
   * landed); until an operator confirms and clears it, reconcile must not burn again (a burn
   * under a fresh watermark could double-burn). Resolution is owner-gated ops tooling (mark
   * the row `reconciled` if it landed, or delete it if it did not) — not part of this module.
   */
  latestUnresolvedError(): Promise<ReconcileRunRow | null>;
  /**
   * Insert a run keyed by `watermark` (UNIQUE). A duplicate watermark returns
   * `{ inserted: false }` (already-done, SC-037 structural backstop), never an error.
   */
  insertRun(run: ReconcileRunInsert): Promise<InsertRunResult>;
}

// --- Job --------------------------------------------------------------------

/** Construction deps for {@link createReconcileJob} — every seam injectable (constitution I). */
export interface ReconcileJobDeps {
  /** Source 1 (Postgres ledger totals). */
  readonly ledgerTotals: LedgerTotalsQuery;
  /** Source 2 (finalized on-chain deposit total; owner-gated). */
  readonly onchainDepositTotal: OnchainDepositTotalQuery;
  /** Source 3 (on-chain vault balance; owner-gated). */
  readonly vaultBalance: VaultBalanceQuery;
  /** The on-chain batched-burn executor (owner-gated; idempotent by watermark). */
  readonly executeBurn: BurnExecutor;
  /** The reconcile report store. */
  readonly store: ReconcileStore;
  /** The loud operator alarm sink (FR-067). */
  readonly alert: ReconcileAlerter;
  /**
   * Bounded credits-vs-chain lag tolerance (NYXT base units). A finalized on-chain deposit
   * may be observed a run before it is credited off-chain, so the chain may lead credits by
   * up to this much and still be CLEAN. The ledger out-crediting the chain (credits > chain)
   * is ALWAYS drift regardless of tolerance (tampering/bug). Defaults to 0n (strict equality).
   */
  readonly lagTolerance?: bigint;
  /** Consecutive-skip threshold before alarming (EC-48). Defaults to 3. */
  readonly maxConsecutiveSkips?: number;
  /**
   * Backoff between record retries in ms (H1 resilience — a transient DB blip often needs a
   * beat to recover). Defaults to {@link DEFAULT_RECORD_RETRY_BACKOFF_MS}.
   */
  readonly retryBackoffMs?: number;
  /** Sleep seam for the retry backoff; injected as a no-op in tests. Defaults to a real timer. */
  readonly retrySleep?: (ms: number) => Promise<void>;
}

/** The reconcile job — a stateful object (it tracks the consecutive-skip streak, EC-48). */
export interface ReconcileJob {
  /**
   * Reconcile as of a FINALIZED `watermark` (EC-50). Idempotent by watermark (SC-037);
   * never rejects for an expected condition (skip/drift/burn-failure are all typed results).
   * A property function type (not a method) so callers may pass the reference unbound.
   */
  readonly runReconcile: (watermark: string) => Promise<ReconcileResult>;
}

/** Default consecutive-skip alarm threshold (EC-48) when unconfigured. */
export const DEFAULT_MAX_CONSECUTIVE_SKIPS = 3;

/** How many times to retry persisting the reconciled report after a landed burn (H1). */
export const RECORD_RETRY_ATTEMPTS = 3;

/** Default backoff between record retries (H1) — a beat for a transient DB fault to recover. */
export const DEFAULT_RECORD_RETRY_BACKOFF_MS = 100;

/** Default real sleep for the retry backoff (tests inject a no-op). */
function defaultRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the reconcile job over injected seams. The returned object holds the consecutive-skip
 * streak across calls (the scheduler keeps ONE instance) so EC-48's "alert after N
 * consecutive skips" is honoured without a wall-clock or external counter.
 */
export function createReconcileJob(deps: ReconcileJobDeps): ReconcileJob {
  const lagTolerance = deps.lagTolerance ?? 0n;
  // A negative tolerance would make the clean-credits check STRICTER than equality in a
  // confusing way — reject it at construction (a config error, not a money-path condition).
  if (lagTolerance < 0n) {
    throw new RangeError(`reconcile lagTolerance must be >= 0 (got ${String(lagTolerance)})`);
  }
  const maxConsecutiveSkips = deps.maxConsecutiveSkips ?? DEFAULT_MAX_CONSECUTIVE_SKIPS;
  const retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RECORD_RETRY_BACKOFF_MS;
  const retrySleep = deps.retrySleep ?? defaultRetrySleep;
  let consecutiveSkips = 0;

  async function runReconcile(watermark: string): Promise<ReconcileResult> {
    // 1. Idempotency short-circuit (SC-037): a recorded watermark re-burns/re-records nothing.
    const existing = await deps.store.getRun(watermark);
    if (existing !== null) {
      return { kind: "already-done", watermark, outcome: existing.outcome };
    }

    // 1b. AMBIGUOUS-BURN GATE (money safety — both reviewers, C1/EC-49): if a prior burn
    //     FAILED or its report could not be persisted, the vault's on-chain state is ambiguous
    //     (the burn may or may not have landed). Burning again — necessarily under a NEW
    //     watermark — would defeat the on-chain `burnedWatermarks` dedup and could DOUBLE-BURN
    //     real NYXT (which is one-way, D34). So we STOP and alarm every tick until an operator
    //     confirms the on-chain state and resolves the error row (owner-gated ops), mirroring
    //     the deploy pipeline's ops-gated ambiguous-outcome handling.
    const unresolved = await deps.store.latestUnresolvedError();
    if (unresolved !== null) {
      deps.alert({
        reason: "burn-unresolved",
        watermark,
        unresolvedWatermark: unresolved.watermark,
        message:
          `RECONCILE BLOCKED — a prior burn at watermark ${unresolved.watermark} is unresolved ` +
          `(on-chain effect ambiguous). No further burn will run until ops confirms the chain ` +
          `state and clears the error row. Auto-retrying under a new watermark could double-burn.`,
      });
      return { kind: "blocked", watermark, unresolvedWatermark: unresolved.watermark };
    }

    // 2. Three-source snapshot as of the finalized watermark. If ANY on-chain read is
    //    unavailable (EC-48) we SKIP entirely — never a partial comparison, never a
    //    watermark advance. `ledgerTotals` is Postgres (not owner-gated), but a rejection
    //    there is treated identically (skip beats a half-read comparison).
    let snapshot: ReconcileSnapshot;
    try {
      const [totals, onchainDepositTotal, vaultBalance] = await Promise.all([
        deps.ledgerTotals(),
        deps.onchainDepositTotal(),
        deps.vaultBalance(),
      ]);
      snapshot = {
        ledgerCredits: totals.credits,
        ledgerSettlements: totals.settlements,
        onchainDepositTotal,
        vaultBalance,
      };
    } catch (error) {
      consecutiveSkips += 1;
      const reason = errorMessage(error);
      // EC-48: reschedule (the scheduler re-fires next cadence); alarm only after N in a row.
      if (consecutiveSkips >= maxConsecutiveSkips) {
        deps.alert({
          reason: "consecutive-skips",
          watermark,
          consecutiveSkips,
          message: `reconcile skipped ${String(consecutiveSkips)} consecutive runs — on-chain source unavailable: ${reason}`,
        });
      }
      return { kind: "skipped", watermark, reason, consecutiveSkips };
    }
    // A full snapshot succeeded — the skip streak is broken.
    consecutiveSkips = 0;

    // 3. Drift detection (SC-038) — two signals, both against on-chain truth.
    const lastReconciled = await deps.store.lastReconciled();
    const burnedHighWater = lastReconciled?.snapshot.ledgerSettlements ?? 0n;
    const totalBurned = await deps.store.totalBurned();

    const creditsVsChainDrift = snapshot.onchainDepositTotal - snapshot.ledgerCredits;
    const expectedVault = snapshot.onchainDepositTotal - totalBurned;
    const vaultVsExpectedDrift = snapshot.vaultBalance - expectedVault;

    // Clean = the chain leads credits by no more than the lag tolerance (and never trails —
    // the ledger out-crediting the chain is tampering), AND the vault balance exactly equals
    // mints−burns. Anything else is drift.
    const creditsClean = creditsVsChainDrift >= 0n && creditsVsChainDrift <= lagTolerance;
    const vaultClean = vaultVsExpectedDrift === 0n;
    if (!creditsClean || !vaultClean) {
      deps.alert({
        reason: "drift",
        watermark,
        snapshot,
        creditsVsChainDrift,
        vaultVsExpectedDrift,
        message:
          `LEDGER DRIFT at watermark ${watermark} — NOT auto-corrected. ` +
          `credits=${String(snapshot.ledgerCredits)} vs onchainDeposits=${String(snapshot.onchainDepositTotal)} ` +
          `(drift ${String(creditsVsChainDrift)}); vault=${String(snapshot.vaultBalance)} vs expected ${String(expectedVault)} ` +
          `(drift ${String(vaultVsExpectedDrift)})`,
      });
      // Persist the drift report; NO burn. `getRun` already ruled out a replay, but honour the
      // UNIQUE backstop anyway (a concurrent run may have recorded first).
      await persistBestEffort({
        watermark,
        outcome: "drift",
        snapshot,
        drift: creditsVsChainDrift,
        burnAmount: null,
        burnTx: null,
      });
      return { kind: "drift", watermark, snapshot, creditsVsChainDrift, vaultVsExpectedDrift };
    }

    // 4. Clean → batched burn of consumed credit since the last burned watermark (D55).
    const burnAmount = snapshot.ledgerSettlements - burnedHighWater;
    if (burnAmount < 0n) {
      // Settlements are append-only and monotonic, so this can only mean corruption/tampering.
      // Treat defensively as drift: alarm, record, never burn a negative.
      deps.alert({
        reason: "drift",
        watermark,
        snapshot,
        creditsVsChainDrift,
        vaultVsExpectedDrift,
        message:
          `LEDGER DRIFT at watermark ${watermark} — settlements went BACKWARD ` +
          `(${String(snapshot.ledgerSettlements)} < burned high-water ${String(burnedHighWater)}); NOT auto-corrected`,
      });
      await persistBestEffort({
        watermark,
        outcome: "drift",
        snapshot,
        drift: creditsVsChainDrift,
        burnAmount: null,
        burnTx: null,
      });
      return { kind: "drift", watermark, snapshot, creditsVsChainDrift, vaultVsExpectedDrift };
    }

    if (burnAmount === 0n) {
      // Nothing consumed since the last burn — record equality, no on-chain burn. Best-effort:
      // no burn landed, so a dropped audit row on a failing store is tolerable (never rejects).
      await persistBestEffort({
        watermark,
        outcome: "reconciled",
        snapshot,
        drift: creditsVsChainDrift,
        burnAmount: 0n,
        burnTx: null,
      });
      return {
        kind: "reconciled",
        watermark,
        snapshot,
        burnAmount: 0n,
        burnTx: null,
        drift: creditsVsChainDrift,
      };
    }

    // Execute the burn EXACTLY ONCE per watermark. The executor is idempotent by watermark
    // (backstop 3 — a re-submission of an already-burned watermark resolves with the original
    // txRef, never double-burns), and a genuine REJECTION means the burn PROVABLY did not land
    // (M2 contract). The `blocked` gate above guarantees no prior burn is ambiguous when we
    // reach here.
    let burnTx: string;
    try {
      const receipt = await deps.executeBurn({ amount: burnAmount, watermark });
      burnTx = receipt.txRef;
    } catch (error) {
      // EC-49: the on-chain burn provably FAILED (no effect). Record an `error` report carrying
      // the ATTEMPTED amount (so an ops resolution to `reconciled` — burn confirmed landed —
      // counts it in `totalBurned`); the ambiguous-burn gate (step 1b) then BLOCKS every
      // subsequent run until ops resolves it, so nothing re-burns under a fresh watermark.
      // `lastReconciled()`/`totalBurned()` exclude `error` rows, so the burned high-water stays
      // UNMOVED while unresolved (the eventual ops-driven retry, or a clear if it never landed).
      await recordErrorBestEffort(watermark, snapshot, creditsVsChainDrift, burnAmount);
      // Alarm IMMEDIATELY (review H#1): the ops gate must not stay silent until the next daily
      // tick's `burn-unresolved` check — a money-critical burn fault needs a same-tick alarm.
      deps.alert({
        reason: "burn-unresolved",
        watermark,
        unresolvedWatermark: watermark,
        message:
          `BURN FAILED at watermark ${watermark} (attempted ${String(burnAmount)} NYXT) — recorded ` +
          `as an error; reconcile is now BLOCKED until ops confirms the on-chain state. ` +
          `Error: ${errorMessage(error)}`,
      });
      return {
        kind: "burn-failed",
        watermark,
        snapshot,
        attemptedBurn: burnAmount,
        error: errorMessage(error),
      };
    }

    // The burn LANDED. Record the reconciled report with a BOUNDED retry (H1): a transient DB
    // blip AFTER a successful on-chain burn must not strand it. If every retry fails, the burn
    // still happened but is unrecorded — fall back to a best-effort `error` row (carrying the
    // burned amount) so the NEXT run BLOCKS (never re-burns under a new watermark) and ops
    // reconciles the ambiguous state.
    try {
      await persistWithRetry({
        watermark,
        outcome: "reconciled",
        snapshot,
        drift: creditsVsChainDrift,
        burnAmount,
        burnTx,
      });
    } catch (error) {
      await recordErrorBestEffort(watermark, snapshot, creditsVsChainDrift, burnAmount);
      // Alarm IMMEDIATELY (review H#1): the burn LANDED but couldn't be recorded — the most
      // ambiguous state, so ops must be paged this tick, not on the next cadence.
      deps.alert({
        reason: "burn-unresolved",
        watermark,
        unresolvedWatermark: watermark,
        message:
          `BURN LANDED but its report could not be persisted at watermark ${watermark} ` +
          `(tx ${burnTx}, amount ${String(burnAmount)} NYXT) — wrote a best-effort error row; ` +
          `reconcile is now BLOCKED until ops confirms. Error: ${errorMessage(error)}`,
      });
      return {
        kind: "record-failed",
        watermark,
        attemptedBurn: burnAmount,
        burnTx,
        error: errorMessage(error),
      };
    }
    return {
      kind: "reconciled",
      watermark,
      snapshot,
      burnAmount,
      burnTx,
      drift: creditsVsChainDrift,
    };
  }

  /**
   * Insert a run, retrying a transient store failure up to {@link RECORD_RETRY_ATTEMPTS} times.
   * A `{ inserted: false }` (duplicate watermark) is a benign no-op (a concurrent run recorded
   * first) and is NOT retried. Throws only after the attempts are exhausted.
   */
  async function persistWithRetry(run: ReconcileRunInsert): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RECORD_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await retrySleep(retryBackoffMs); // a beat for a transient fault to recover (H1)
      }
      try {
        await deps.store.insertRun(run);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Persist a NON-burn run (drift / zero-burn / equality) best-effort: retry a transient fault,
   * then SWALLOW (never reject out of `runReconcile`, honouring the "typed results only"
   * contract — review #4). Safe because no burn landed on these paths, and drift alarms fire
   * BEFORE the persist, so a lost audit row never means a silently-lost alarm.
   */
  async function persistBestEffort(run: ReconcileRunInsert): Promise<void> {
    try {
      await persistWithRetry(run);
    } catch {
      // Swallowed by design (non-burn path): the run's outcome is already returned + (for
      // drift) already alarmed; a dropped audit row on a genuinely-failing store is tolerable.
    }
  }

  /**
   * Best-effort write of an `error` row (carrying the ATTEMPTED burn amount) so a subsequent run
   * BLOCKS on the ambiguous burn. A failure here is swallowed (there is nothing safer to do) —
   * the caller already returns a failed result and the ambiguity is surfaced via the result kind
   * + the tick log. The recorded `attemptedBurn` lets an ops resolution to `reconciled` (burn
   * confirmed landed) count the amount in `totalBurned`; a `clear` (never landed) drops the row.
   */
  async function recordErrorBestEffort(
    watermark: string,
    snapshot: ReconcileSnapshot,
    creditsVsChainDrift: bigint,
    attemptedBurn: bigint,
  ): Promise<void> {
    try {
      await persistWithRetry({
        watermark,
        outcome: "error",
        snapshot,
        drift: creditsVsChainDrift,
        burnAmount: attemptedBurn,
        burnTx: null,
      });
    } catch {
      // Swallowed by design: the burn ambiguity is already reported via the result kind.
    }
  }

  return { runReconcile };
}

/** Normalize an unknown thrown value to a message string for typed results/logging. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Owner-gated seam stubs (mirroring index.ts's deploy-wallet balance stub) ------------

/**
 * A rejecting stub for an owner-gated on-chain seam. The wiring pass installs the real
 * indexer/vault-balance/burn adapters; until then reconcile SKIPS (EC-48) rather than
 * fabricating a comparison. `name` identifies the unwired seam in the rejection.
 */
export function ownerGatedReconcileSeam(name: string): () => Promise<never> {
  return () =>
    Promise.reject(new Error(`owner-gated: reconcile ${name} not wired (constitution I)`));
}

// --- Postgres ledger-totals reader (Source 1 — NOT owner-gated) --------------------------

interface LedgerTotalsRow {
  readonly credits: string;
  readonly settlements: string;
}

/**
 * Build the Source-1 reader over Postgres — the vault-global form of the ledger balance fold
 * ({@link foldBalance}), summing every account's deposit credits and settlements. Amounts are
 * `numeric(40,0)` (migration 0002), read `::text` → `BigInt()` (never `::bigint`/`Number()`)
 * so a cumulative Σ past 2^63-1 never overflows or loses precision.
 */
export function pgLedgerTotals(db: Queryable): LedgerTotalsQuery {
  return async () => {
    const { rows } = await db.query<LedgerTotalsRow>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'deposit_credit'), 0)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'settlement'), 0)::text AS settlements
         FROM ledger_entries`,
    );
    const row = rows[0];
    // The aggregate always returns exactly one row; guard for the type-checker only.
    return row === undefined
      ? { credits: 0n, settlements: 0n }
      : { credits: BigInt(row.credits), settlements: BigInt(row.settlements) };
  };
}

// --- Postgres reconcile store ------------------------------------------------

interface ReconcileInputsJson {
  readonly ledgerCredits: string;
  readonly ledgerSettlements: string;
  readonly onchainDepositTotal: string;
  readonly vaultBalance: string;
}

interface ReconcileRunDbRow {
  readonly watermark: string;
  readonly outcome: ReconcileOutcome;
  readonly inputs: ReconcileInputsJson;
  readonly drift: string | null;
  readonly burn_amount: string | null;
  readonly burn_tx: string | null;
  readonly ran_at_ms: string;
}

interface BurnSumRow {
  readonly total: string;
}

/** Serialize a snapshot to the `inputs` jsonb (bigints as decimal strings). */
function inputsJson(snapshot: ReconcileSnapshot): ReconcileInputsJson {
  return {
    ledgerCredits: snapshot.ledgerCredits.toString(),
    ledgerSettlements: snapshot.ledgerSettlements.toString(),
    onchainDepositTotal: snapshot.onchainDepositTotal.toString(),
    vaultBalance: snapshot.vaultBalance.toString(),
  };
}

/** Re-brand a `reconcile_runs` row into {@link ReconcileRunRow} at the store boundary. */
function mapRun(row: ReconcileRunDbRow): ReconcileRunRow {
  return {
    watermark: row.watermark,
    outcome: row.outcome,
    snapshot: {
      ledgerCredits: BigInt(row.inputs.ledgerCredits),
      ledgerSettlements: BigInt(row.inputs.ledgerSettlements),
      onchainDepositTotal: BigInt(row.inputs.onchainDepositTotal),
      vaultBalance: BigInt(row.inputs.vaultBalance),
    },
    drift: row.drift === null ? null : BigInt(row.drift),
    burnAmount: row.burn_amount === null ? null : BigInt(row.burn_amount),
    burnTx: row.burn_tx,
    ranAt: Number(row.ran_at_ms),
  };
}

const RUN_COLUMNS = `watermark, outcome, inputs,
  drift::text AS drift,
  burn_amount::text AS burn_amount,
  burn_tx,
  (extract(epoch from ran_at) * 1000)::bigint AS ran_at_ms`;

/** Postgres `unique_violation` (23505) — a concurrent/replayed watermark insert. */
function isUniqueViolationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Postgres-backed {@link ReconcileStore}. `drift`/`burn_amount` are `numeric(40,0)` (migration
 * 0004 — widened from `bigint` for the same money-width reason as `ledger_entries.amount`: a
 * cumulative burn/drift can exceed 2^63-1), written `$N::numeric` and read `::text` →
 * `BigInt()`. The `watermark` UNIQUE index is the exactly-once backstop (SC-037): a duplicate
 * insert 23505s and is reported as `{ inserted: false }`, never propagated.
 */
export class PgReconcileStore implements ReconcileStore {
  constructor(private readonly db: Queryable) {}

  async getRun(watermark: string): Promise<ReconcileRunRow | null> {
    const { rows } = await this.db.query<ReconcileRunDbRow>(
      `SELECT ${RUN_COLUMNS} FROM reconcile_runs WHERE watermark = $1`,
      [watermark],
    );
    const row = rows[0];
    return row === undefined ? null : mapRun(row);
  }

  async lastReconciled(): Promise<ReconcileRunRow | null> {
    const { rows } = await this.db.query<ReconcileRunDbRow>(
      `SELECT ${RUN_COLUMNS} FROM reconcile_runs WHERE outcome = 'reconciled'
        ORDER BY id DESC LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? null : mapRun(row);
  }

  async totalBurned(): Promise<bigint> {
    const { rows } = await this.db.query<BurnSumRow>(
      `SELECT COALESCE(SUM(burn_amount), 0)::text AS total
         FROM reconcile_runs WHERE outcome = 'reconciled'`,
    );
    const row = rows[0];
    return row === undefined ? 0n : BigInt(row.total);
  }

  async latestUnresolvedError(): Promise<ReconcileRunRow | null> {
    // Any `error` row is unresolved until ops clears/reconciles it (owner-gated). Most-recent
    // first mirrors `lastReconciled`.
    const { rows } = await this.db.query<ReconcileRunDbRow>(
      `SELECT ${RUN_COLUMNS} FROM reconcile_runs WHERE outcome = 'error'
        ORDER BY id DESC LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? null : mapRun(row);
  }

  async insertRun(run: ReconcileRunInsert): Promise<InsertRunResult> {
    try {
      await this.db.query(
        `INSERT INTO reconcile_runs (inputs, drift, burn_amount, burn_tx, watermark, outcome)
         VALUES ($1::jsonb, $2::numeric, $3::numeric, $4, $5, $6)`,
        [
          JSON.stringify(inputsJson(run.snapshot)),
          run.drift === null ? null : run.drift.toString(),
          run.burnAmount === null ? null : run.burnAmount.toString(),
          run.burnTx,
          run.watermark,
          run.outcome,
        ],
      );
      return { inserted: true };
    } catch (error) {
      // The watermark UNIQUE backstop (SC-037): a concurrent/replayed run already recorded it.
      // FOLLOW-UP (review #2, owner-gated): this swallows the 23505 without checking which
      // outcome actually landed, so under a TRUE multi-instance race on the SAME canonical
      // watermark (not possible until `executeBurn`/`watermarkSource` are wired) a caller could
      // see `reconciled` while the persisted row is `error`. Resolves correctly (totalBurned
      // counts only reconciled) but the log/row could diverge — reconcile the winning outcome
      // here when the real multi-instance seams land.
      if (isUniqueViolationError(error)) {
        return { inserted: false };
      }
      throw error;
    }
  }
}

/** Construct the Postgres-backed reconcile store (the wiring pass calls this). */
export function createReconcileStore(db: Queryable): ReconcileStore {
  return new PgReconcileStore(db);
}

// --- In-memory store (deterministic tests + tooling) -------------------------

/**
 * An in-memory {@link ReconcileStore} modelling the `reconcile_runs` table with an injected
 * clock. Insertion order stands in for the `bigserial` id, so `lastReconciled` returns the
 * most recently inserted reconciled row. Enforces the `watermark` UNIQUE (a duplicate insert
 * returns `{ inserted: false }`), so the deterministic SC-037 test exercises the same
 * exactly-once contract as {@link PgReconcileStore}.
 */
export class InMemoryReconcileStore implements ReconcileStore {
  private readonly runs: ReconcileRunRow[] = [];

  constructor(private readonly clock: () => number = () => 0) {}

  getRun(watermark: string): Promise<ReconcileRunRow | null> {
    const found = this.runs.find((r) => r.watermark === watermark);
    return Promise.resolve(found ?? null);
  }

  lastReconciled(): Promise<ReconcileRunRow | null> {
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      const run = this.runs[i];
      if (run === undefined) {
        continue;
      }
      if (run.outcome === "reconciled") {
        return Promise.resolve(run);
      }
    }
    return Promise.resolve(null);
  }

  totalBurned(): Promise<bigint> {
    let total = 0n;
    for (const run of this.runs) {
      if (run.outcome === "reconciled" && run.burnAmount !== null) {
        total += run.burnAmount;
      }
    }
    return Promise.resolve(total);
  }

  latestUnresolvedError(): Promise<ReconcileRunRow | null> {
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      const run = this.runs[i];
      if (run === undefined) {
        continue;
      }
      if (run.outcome === "error") {
        return Promise.resolve(run);
      }
    }
    return Promise.resolve(null);
  }

  insertRun(run: ReconcileRunInsert): Promise<InsertRunResult> {
    if (this.runs.some((r) => r.watermark === run.watermark)) {
      return Promise.resolve({ inserted: false });
    }
    this.runs.push({
      watermark: run.watermark,
      outcome: run.outcome,
      snapshot: run.snapshot,
      drift: run.drift,
      burnAmount: run.burnAmount,
      burnTx: run.burnTx,
      ranAt: this.clock(),
    });
    return Promise.resolve({ inserted: true });
  }

  /**
   * Test/tooling helper: simulate the owner-gated ops RESOLUTION of an ambiguous burn error —
   * either the burn landed (`outcome: "reconciled"`, advancing the high-water) or it did not
   * (`resolution: "clear"`, removing the row). Returns whether a matching error row was found.
   */
  resolveError(watermark: string, resolution: "reconciled" | "clear"): boolean {
    const index = this.runs.findIndex((r) => r.watermark === watermark && r.outcome === "error");
    if (index === -1) {
      return false;
    }
    if (resolution === "clear") {
      this.runs.splice(index, 1);
      return true;
    }
    const existing = this.runs[index];
    if (existing === undefined) {
      return false;
    }
    this.runs[index] = { ...existing, outcome: "reconciled" };
    return true;
  }

  /** Test/tooling helper: every recorded run, oldest first. */
  all(): readonly ReconcileRunRow[] {
    return this.runs;
  }
}
