/**
 * Indexer deposit-observation adapter + poller (P3 Task 7) — the server-side seam that watches
 * the devnet indexer for finalized NyxtVault deposits and feeds them into the EXISTING
 * exactly-once credit CAS ({@link DepositStore.observeFinalized}, `deposits.ts`).
 *
 * MONEY-CRITICAL — this is the on-chain→off-chain crediting bridge (a Fable review-escalation
 * surface). Two rules govern the whole module:
 *  1. The poller OBSERVES; the store CASes. {@link createObservationPoller} never classifies,
 *     never credits, and never dedups — it lists the open refs, queries the indexer for exactly
 *     those, and hands each returned {@link DepositObservation} VERBATIM to
 *     `observeFinalized`. All exactly-once guarantees (the deposit-ref status CAS +
 *     `creditDeposit`'s partial-unique-index/23505-swallow, Phase 8) live in the store; the
 *     poller must not duplicate or bypass them. Replaying a scan is safe because the store is
 *     idempotent by ref (EC-30).
 *  2. On-chain amounts are `bigint` end to end — parsed from the chain's native decoded value,
 *     NEVER `Number()`. The store credits the ON-CHAIN amount (EC-28: on a mismatch with the
 *     pre-registered expected amount, the chain wins and it is logged loudly).
 *
 * The poller mirrors `reconcile-scheduler.ts`: an injected timer seam, serial ticks (the next
 * is armed only after the current tick's store calls settle), and a `generation` counter bumped
 * on every `stop()` so a `stop()` mid-tick cannot re-arm (no double-timer). A tick fault is
 * reported to `onError` and SURVIVED — a failed tick never kills the loop; the next interval
 * still fires. `index.ts` (Task 8) wires the poller at boot and routes `onOutcome` to the WS
 * `ledger:update` push (P6's ledger UI depends on that push).
 *
 * {@link createDevnetDepositIndexerQuery} is the real indexer adapter behind the narrow
 * {@link DepositIndexerQuery} seam. Its raw GraphQL transport (the SPIKE-2-verified
 * `contractAction` query) is production code with an injectable `fetch`; the per-ref amount
 * DECODE ({@link DepositsStateReader}) is an OWNER-GATED SDK seam — see that function's header.
 */
import { encodeLedgerUpdateEvent } from "@nyx/protocol";
import type {
  DepositFailedEvent,
  LedgerEntry,
  LedgerUpdateEvent,
  LedgerUpdateEventWire,
  MidnightAddress,
} from "@nyx/protocol";
import type {
  CreditOutcome,
  DepositObservation,
  DepositStore,
  OpenDepositRef,
} from "./deposits.js";
import type { LedgerStore } from "./ledger.js";

// --- The narrow indexer seam ------------------------------------------------

/**
 * The narrow, Nyx-internal indexer query seam the poller drives. `findDeposits` maps the given
 * open refs to the on-chain {@link DepositObservation}s the indexer currently reports for them
 * (a ref with no landed deposit is simply absent from the result). It returns observations for
 * the store to judge — it does NOT itself decide finality or crediting. The real implementation
 * is {@link createDevnetDepositIndexerQuery}; tests inject a fake.
 */
export interface DepositIndexerQuery {
  /** Resolve the on-chain deposit observations currently visible for `refs`. */
  findDeposits(refs: readonly string[]): Promise<readonly DepositObservation[]>;
}

// --- The poller -------------------------------------------------------------

/** Cancels a pending scheduled tick. Returned by {@link ObservationPollerDeps.schedule}. */
export type CancelScheduled = () => void;

/** Construction deps for {@link createObservationPoller}. */
export interface ObservationPollerDeps {
  /**
   * The exactly-once credit chokepoint + the open-ref source (never bypassed) + the stale-ref
   * sweep. `expireStale` runs at the TOP of every tick (I2) so abandoned pre-registered refs age
   * out of `listOpenRefs` (EC-29) instead of growing the poller's work + `deposit_refs` forever.
   */
  readonly store: Pick<DepositStore, "observeFinalized" | "listOpenRefs" | "expireStale">;
  /** The indexer seam each tick queries for the open refs. */
  readonly query: DepositIndexerQuery;
  /** Poll cadence in ms between ticks. */
  readonly intervalMs: number;
  /** Late-deposit grace window passed to `listOpenRefs` (D46/EC-30). */
  readonly graceMs: number;
  /** Called with each store outcome (telemetry + Task 8's `ledger:update` push). */
  readonly onOutcome?: (outcome: CreditOutcome) => void;
  /** Called when a tick faults (list/query/store error) — reported, never rethrown. */
  readonly onError?: (error: unknown) => void;
  /**
   * Timer seam: schedule `fn` after `ms`, returning a canceller. Injected for determinism;
   * defaults to `setTimeout`/`clearTimeout`.
   */
  readonly schedule?: (fn: () => void, ms: number) => CancelScheduled;
}

/** A started/stoppable observation poller. */
export interface ObservationPoller {
  /** Arm the first tick (idempotent — a second `start` while running is a no-op). */
  start(): void;
  /** Cancel any pending tick and stop rescheduling (idempotent). */
  stop(): void;
}

/** Default timer seam over Node's `setTimeout`. */
function defaultSchedule(fn: () => void, ms: number): CancelScheduled {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * Build the deposit-observation poller. Ticks are serial (the next is armed only after the
 * current tick's store calls settle) and a `generation` counter, bumped on every `stop()`,
 * invalidates any in-flight tick's re-arm so a `stop()`→`start()` cannot leave two timers armed.
 * A tick fault is reported to `onError` and SURVIVED — the loop is never killed.
 */
export function createObservationPoller(deps: ObservationPollerDeps): ObservationPoller {
  const schedule = deps.schedule ?? defaultSchedule;
  let running = false;
  let generation = 0;
  let cancel: CancelScheduled | null = null;

  function clearPending(): void {
    if (cancel !== null) {
      cancel();
      cancel = null;
    }
  }

  /** Arm the next tick, but only if still running on the SAME generation that requested it. */
  function armAfter(gen: number, delayMs: number): void {
    if (!running || gen !== generation) {
      return;
    }
    clearPending();
    cancel = schedule(() => {
      void tick(gen);
    }, delayMs);
  }

  async function tick(gen: number): Promise<void> {
    try {
      // I2 — sweep abandoned pre-registered refs past their TTL → `expired` (EC-29) BEFORE
      // listing, so they leave `listOpenRefs` and stop accruing poller work / row growth. The
      // sweep is ISOLATED in its own try/catch (I4): a sweep rejection must NOT abort this tick's
      // listing/query/crediting (that only DELAYS a credit — money-safe, the store is idempotent —
      // but is avoidable). Report the sweep fault and carry on to the observations regardless.
      try {
        await deps.store.expireStale();
      } catch (error) {
        deps.onError?.(error);
      }
      const open: readonly OpenDepositRef[] = await deps.store.listOpenRefs(deps.graceMs);
      if (open.length > 0) {
        const observations = await deps.query.findDeposits(open.map((row) => row.ref));
        for (const observation of observations) {
          // I3 — per-observation isolation: one `observeFinalized` rejection must NOT skip every
          // later observation this tick (cross-user credit starvation). Report and continue.
          try {
            // OBSERVE — the store is the exactly-once CAS. The observation is passed through
            // untouched; the store decides credit/ignore/orphan/failure (EC-28/EC-30/D46).
            const outcome = await deps.store.observeFinalized(observation);
            deps.onOutcome?.(outcome);
          } catch (error) {
            deps.onError?.(error);
          }
        }
      }
    } catch (error) {
      // A list/query/expire fault must NOT kill the poll loop — report and carry on.
      deps.onError?.(error);
    } finally {
      // Reschedule — but only if this tick still belongs to the live generation (a `stop()`
      // mid-tick bumps the generation and suppresses the re-arm; ticks stay serial because the
      // finally runs only after every store call above has settled).
      armAfter(gen, deps.intervalMs);
    }
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      armAfter(generation, deps.intervalMs);
    },
    stop(): void {
      running = false;
      generation += 1;
      clearPending();
    },
  };
}

// --- The real devnet indexer adapter (raw GraphQL + owner-gated decode) ------

/** The indexer GraphQL path on the devnet indexer (`:8088`). SPIKE-1 risk 7 / SPIKE-2 §A. */
export const INDEXER_GRAPHQL_PATH = "/api/v4/graphql";

/**
 * One decoded on-chain deposit: the minted `amount` (base units, `bigint`) plus whether that
 * state is FINALIZED. Finality is the READER's responsibility — the seam MUST set `finalized`
 * true ONLY for state at/after finality (I1). This value flows straight into the
 * {@link DepositObservation}'s `finalized` field, which the store gates crediting on
 * ({@link DepositStore.observeFinalized} — SC-021), so a reader that reports a not-yet-final
 * amount as `finalized: true` would breach the off-chain-mint finality backbone.
 */
export interface DepositStateEntry {
  /** The ON-CHAIN minted amount in NYXT base units (native `bigint`, never `Number()`). */
  readonly amount: bigint;
  /** Whether this on-chain state is at/after finality — the reader's sole authority (I1). */
  readonly finalized: boolean;
}

/**
 * Decode the NyxtVault's on-chain `deposits` map for a contract address into
 * `refHex → { amount, finalized }`. This is the OWNER-GATED SDK seam (constitution I): the
 * verified recipe (SPIKE-2 §C/§D, `sdkwork/deposit-common.mjs`, executed 2026-07-23 against
 * indexer 4.2.1) is
 *
 *   const state   = await publicDataProvider.queryContractState(vaultAddress); // indexer read
 *   const decoded = mod.ledger(state.data);   // the compiled NyxtVault module's generated decode
 *   const amount  = decoded.deposits.lookup(refBytes); // Uint<128> → native bigint
 *
 * It CANNOT be hand-written here: `mod.ledger` is the NyxtVault-specific generated decoder from
 * the compiled contract module (`packages/nyxt-vault/build/.../contract/index.js`, gitignored per
 * SPIKE-1 §8) and `publicDataProvider` is `@midnight-ntwrk/midnight-js-indexer-public-data-provider`
 * (not installed in the server) — the same owner-gated boundary as the deploy executor + the web
 * top-up ceremony. Wiring it is a body-only change: install the packages, import the compiled
 * module, and return the decoded map.
 *
 * SEAM CONTRACT (I1/M4):
 *  - `amount` MUST be a native `bigint` (never `Number()`).
 *  - `finalized` MUST reflect ONLY finalized on-chain state — the store credits on it directly
 *    (see the finality note on {@link createDevnetDepositIndexerQuery}). The real reader
 *    determines finality (e.g. the contract-action's block vs the finalized head).
 *  - map KEYS MUST be lowercase hex, no `0x` prefix, 64 chars (the {@link randomDepositRef}
 *    format). `findDeposits` lowercases each requested ref before lookup (M4) so a casing skew
 *    on the request side can never silently strand a landed deposit.
 */
export type DepositsStateReader = (
  vaultAddress: string,
) => Promise<ReadonlyMap<string, DepositStateEntry>>;

/** Options for {@link createDevnetDepositIndexerQuery}. */
export interface DevnetDepositIndexerQueryOptions {
  /**
   * The devnet indexer URL — either the base (`http://localhost:8088`, from the
   * {@link NetworkProfile}) or the full GraphQL endpoint; {@link INDEXER_GRAPHQL_PATH} is
   * appended when absent.
   */
  readonly indexerUrl: string;
  /**
   * The deployed NyxtVault contract address to read the `deposits` map from (the config
   * chokepoint value, `VITE_NYXT_VAULT_ADDRESS` server-side). Recorded extension to the Task 7
   * brief's `{indexerUrl, fetch?}` sketch: `findDeposits` must know which contract to query
   * (mirrors P3 Task 5, which added `contractAddress` to `DevCeremonyDeps` for the same reason).
   */
  readonly vaultAddress: string;
  /** Injectable `fetch`; defaults to the global `fetch`. Tests inject a fake. */
  readonly fetch?: typeof fetch;
  /**
   * The OWNER-GATED on-chain `deposits`-map decode ({@link DepositsStateReader}). Omitted →
   * `findDeposits` rejects with {@link DepositIndexerNotWiredError} whenever the contract has
   * state to decode, so a stubbed adapter can never be mistaken for a working one.
   */
  readonly readDepositsState?: DepositsStateReader;
}

/** The indexer was unreachable or returned a malformed / error GraphQL response. */
export class IndexerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IndexerUnavailableError";
  }
}

/**
 * Thrown when {@link createDevnetDepositIndexerQuery} needs the owner-gated on-chain decode
 * ({@link DepositsStateReader}) but none was injected. Deliberately unmistakable so a stubbed
 * adapter can never be read as a working credit path.
 */
export class DepositIndexerNotWiredError extends Error {
  constructor() {
    super(
      "owner-gated: the on-chain deposits-map decode needs the compiled NyxtVault module + " +
        "@midnight-ntwrk/midnight-js-indexer-public-data-provider (inject readDepositsState)",
    );
    this.name = "DepositIndexerNotWiredError";
  }
}

/** The subset of the `contractAction` GraphQL response the adapter reads (verified shape). */
interface ContractActionEnvelope {
  readonly data?: {
    readonly contractAction: {
      readonly transaction?: {
        readonly hash?: string;
        readonly block?: { readonly height?: number };
      };
    } | null;
  };
  readonly errors?: readonly { readonly message?: string }[];
}

/** Resolve the base indexer URL to its GraphQL endpoint (append the path when absent). */
function graphqlEndpoint(indexerUrl: string): string {
  const trimmed = indexerUrl.replace(/\/+$/, "");
  return trimmed.endsWith(INDEXER_GRAPHQL_PATH) ? trimmed : `${trimmed}${INDEXER_GRAPHQL_PATH}`;
}

/**
 * Build the real devnet indexer query adapter.
 *
 * VERIFIED QUERY (constitution I, retrieval-sourced) — executed in SPIKE-2 against indexer
 * `4.2.1` at `/api/v4/graphql` (`sdkwork/deposit-common.mjs`, 2026-07-23):
 *
 *   { contractAction(address: "<vault>") {
 *       __typename address
 *       unshieldedBalances { tokenType amount }
 *       transaction { hash block { height } } } }
 *
 * `data.contractAction` returns the vault's latest contract-call tx (`transaction.hash` +
 * `block.height`) or `null` when the contract has no action yet. The per-ref amount is NOT in
 * this envelope — it is read from the contract's serialized `deposits` map via the owner-gated
 * {@link DepositsStateReader} (SPIKE-2 `queryContractState` + `mod.ledger(state).deposits.lookup`).
 *
 * FINALITY (I1 — structural, not a doc comment): the observation's `finalized` flag is the VALUE
 * the {@link DepositsStateReader} returns per ref ({@link DepositStateEntry.finalized}), NEVER
 * hardcoded here. SPIKE-1 §5 observed the on-chain state change via the indexer only AFTER
 * finalization on node 0.22.5; the precise finalized-vs-included semantics of the indexer's
 * contract-state read is an owner-gated live-schema confirmation (Task 7 Step 5), and it is the
 * READER's contract to surface only FINALIZED state (see {@link DepositsStateReader}). The store
 * gates crediting on `finalized`, so a reader that reports `finalized: false` never credits.
 *
 * `findDeposits`:
 *   1. GraphQL `contractAction(vaultAddress)` → tx hash (the diagnostic `txRef`) + existence.
 *      `null` / absent → `[]` (well-formed no-results; the decode seam is never reached).
 *   2. decode the on-chain `deposits` map (owner-gated) → `refHex → { amount, finalized }`.
 *   3. for each requested ref present in the map → a `success` observation carrying the ON-CHAIN
 *      amount and the reader's `finalized` flag. Refs absent from the map yield no observation
 *      (the store keeps watching).
 *
 * `txRef` is the vault's latest contract-action tx hash (adequate for diagnostics / orphan
 * resolution, EC-31); a precise per-deposit tx would need a per-ref transactions query — an
 * owner-gated refinement, not required for the money-authoritative fields (`ref` + `amount`).
 */
export function createDevnetDepositIndexerQuery(
  options: DevnetDepositIndexerQueryOptions,
): DepositIndexerQuery {
  const endpoint = graphqlEndpoint(options.indexerUrl);
  const doFetch = options.fetch ?? fetch;

  async function fetchContractAction(): Promise<{ txRef: string } | null> {
    // M1 — the vault address is a BOUND GraphQL variable (`$addr: HexEncoded!`), never
    // interpolated, matching the module's "every value is a bound parameter" rule. The variable
    // type is source-verified (constitution I): indexer `schema-v4.graphql`
    // `contractAction(address: HexEncoded!, offset: ContractActionOffset)`.
    const query =
      `query ($addr: HexEncoded!) { contractAction(address: $addr) ` +
      `{ __typename address unshieldedBalances { tokenType amount } ` +
      `transaction { hash block { height } } } }`;

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { addr: options.vaultAddress } }),
      });
    } catch (error) {
      throw new IndexerUnavailableError(`indexer request failed: ${endpoint}`, { cause: error });
    }

    if (!response.ok) {
      throw new IndexerUnavailableError(`indexer returned HTTP ${String(response.status)}`);
    }

    let envelope: ContractActionEnvelope;
    try {
      envelope = (await response.json()) as ContractActionEnvelope;
    } catch (error) {
      throw new IndexerUnavailableError("indexer returned a non-JSON body", { cause: error });
    }

    if (envelope.errors !== undefined && envelope.errors.length > 0) {
      const first = envelope.errors[0]?.message ?? "unknown GraphQL error";
      throw new IndexerUnavailableError(`indexer GraphQL error: ${first}`);
    }

    const action = envelope.data?.contractAction;
    if (action === null || action === undefined) {
      return null;
    }
    return { txRef: action.transaction?.hash ?? "" };
  }

  return {
    async findDeposits(refs: readonly string[]): Promise<readonly DepositObservation[]> {
      const action = await fetchContractAction();
      if (action === null) {
        // Well-formed no-results: the contract has no on-chain action, so nothing to decode.
        return [];
      }

      if (options.readDepositsState === undefined) {
        // The contract HAS state but the owner-gated decode is not wired — fail loudly rather
        // than silently drop finalized deposits (a stubbed adapter must never look successful).
        throw new DepositIndexerNotWiredError();
      }
      const deposits = await options.readDepositsState(options.vaultAddress);

      const observations: DepositObservation[] = [];
      for (const ref of refs) {
        // M4 — the seam's keys are lowercase hex; lowercase the requested ref before lookup so a
        // casing skew can never silently strand a landed deposit. The observation keeps the ref
        // as requested (the store's CAS matches the pre-registered ref).
        const state = deposits.get(ref.toLowerCase());
        if (state === undefined) {
          continue; // not landed on-chain yet — the store keeps watching this ref
        }
        observations.push({
          ref,
          amount: state.amount, // ON-CHAIN, native bigint (EC-28 authoritative) — never Number()
          txRef: action.txRef,
          outcome: "success",
          // I1 — finality is the READER's value, NOT hardcoded: the store's finality gate only
          // fires for this pipeline because this flag can be false (off-chain-mint safety).
          finalized: state.finalized,
        });
      }
      return observations;
    },
  };
}

// --- The credit-outcome → WS `ledger:update` push sink (Task 8) --------------

/**
 * One account-scoped outbound frame the boot layer routes to the depositor's live socket(s).
 * `event` is ALREADY wire-encoded — its monetary `bigint`s are decimal STRINGS (via
 * `encodeLedgerUpdateEvent`), so it is `JSON.stringify`-safe and the client never has to parse a
 * bigint. The `deposit:failed` variant carries no money at all (strings only). `address` is the
 * credit/failure's owning account, so the caller knows exactly whose connections to push to.
 */
export interface LedgerPush {
  /** The account whose live connections receive this frame. */
  readonly address: string;
  /** The already-wire-encoded server→client frame. */
  readonly event: LedgerUpdateEventWire | DepositFailedEvent;
}

/** Dependencies for {@link creditOutcomeToPush} — the ledger read seam + an event clock. */
export interface CreditOutcomePushDeps {
  /** Reads the account's entries to resolve the real `deposit_credit` row (its monotonic id). */
  readonly ledger: Pick<LedgerStore, "getEntries">;
  /** Event-timestamp clock; the boot layer passes `Date.now`. */
  readonly now: () => number;
  /**
   * Loud sink for the "impossible" case (M2): the store reported a `credited` outcome but the
   * matching `deposit_credit` row cannot be re-read. Rather than emit a synthetic `id: 0n` frame
   * the P13 client silently drops (hiding the invariant break), we LOG it and emit nothing.
   * Defaults to a no-op; the boot layer injects a stderr sink.
   */
  readonly onInvariantBreak?: (context: Record<string, unknown>, message: string) => void;
}

/**
 * Map one {@link CreditOutcome} to the single outbound frame it should push, or `null` when it
 * warrants none (logged-only outcomes). This is a RENDER signal only (FR-070): the client NEVER
 * computes a balance — it REPLACES both balances from the server payload verbatim. We only
 * surface what the store ALREADY decided; we never re-derive credit/settle/reserve semantics.
 *
 *  - `credited`   → one `ledger:update` carrying the resolved `deposit_credit` entry + the
 *                   server's authoritative `available`/`reserved` (both server-derived folds).
 *  - `failed`     → one `deposit:failed` diagnostic, but ONLY when the ref is known (the outcome
 *                   carries the depositor `address`); an unregistered failure has nobody to route
 *                   to, so it is a no-op here (the store already logged it).
 *  - `already-credited` / `orphaned` / `ignored-unfinalized` → NO frame (nothing changed on the
 *                   depositor's balance; the store's own logs/orphan table own those).
 */
export async function creditOutcomeToPush(
  outcome: CreditOutcome,
  deps: CreditOutcomePushDeps,
): Promise<LedgerPush | null> {
  switch (outcome.kind) {
    case "credited": {
      const entry = await resolveDepositCreditEntry(deps.ledger, outcome);
      if (entry === null) {
        // M2 — the store JUST wrote this credit, yet no matching row can be re-read. That is an
        // "impossible" state; a synthetic `id: 0n` frame would be silently dropped by the P13
        // client id-cursor guard and hide the invariant break. Log loudly and emit nothing.
        (deps.onInvariantBreak ?? (() => undefined))(
          { ref: outcome.ref, address: outcome.address, amount: outcome.amount.toString() },
          "credited outcome has no re-readable deposit_credit row — dropped (invariant break)",
        );
        return null;
      }
      const update: LedgerUpdateEvent = {
        type: "ledger:update",
        payload: {
          entry,
          available: outcome.balance.available,
          reserved: outcome.balance.reserved,
        },
        ts: deps.now(),
      };
      // Encode at the boundary: bigint money → decimal strings (the frame is JSON-safe).
      return { address: outcome.address, event: encodeLedgerUpdateEvent(update) };
    }
    case "failed": {
      if (outcome.address === undefined) {
        return null; // unregistered failure — no account to route to (store already logged it)
      }
      const event: DepositFailedEvent = {
        type: "deposit:failed",
        payload: {
          ref: outcome.ref,
          txRef: outcome.txRef,
          detail: `deposit ${outcome.ref} finalized on-chain as a FAILURE — nothing was credited`,
        },
        ts: deps.now(),
      };
      return { address: outcome.address, event };
    }
    case "already-credited":
    case "orphaned":
    case "ignored-unfinalized":
      return null;
  }
}

/**
 * Resolve the `deposit_credit` {@link LedgerEntry} the store just wrote for this credit so the
 * `ledger:update` carries its REAL monotonic `id` (the web ledger reducer's sequence cursor —
 * a synthetic id would read as stale and be dropped). Scans newest-first for the entry matching
 * this credit's `ref`. Returns `null` in the "impossible" case the store returns no matching row
 * (M2): the caller then logs loudly and emits nothing, rather than push a synthetic `id: 0n`
 * frame the client silently drops (which would hide the invariant break).
 */
async function resolveDepositCreditEntry(
  ledger: Pick<LedgerStore, "getEntries">,
  outcome: { readonly address: string; readonly ref: string; readonly amount: bigint },
): Promise<LedgerEntry | null> {
  const entries = await ledger.getEntries(outcome.address);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "deposit_credit" && entry.ref === outcome.ref) {
      return {
        id: entry.id,
        accountAddress: entry.accountAddress as MidnightAddress,
        kind: entry.kind,
        amount: entry.amount,
        ref: entry.ref,
      };
    }
  }
  return null;
}
