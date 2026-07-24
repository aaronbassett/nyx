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
import type {
  CreditOutcome,
  DepositObservation,
  DepositStore,
  OpenDepositRef,
} from "./deposits.js";

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
  /** The exactly-once credit chokepoint + the open-ref source (never bypassed). */
  readonly store: Pick<DepositStore, "observeFinalized" | "listOpenRefs">;
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
      const open: readonly OpenDepositRef[] = await deps.store.listOpenRefs(deps.graceMs);
      if (open.length > 0) {
        const observations = await deps.query.findDeposits(open.map((row) => row.ref));
        for (const observation of observations) {
          // OBSERVE — the store is the exactly-once CAS. The observation is passed through
          // untouched; the store decides credit/ignore/orphan/failure (EC-28/EC-30/D46).
          const outcome = await deps.store.observeFinalized(observation);
          deps.onOutcome?.(outcome);
        }
      }
    } catch (error) {
      // A list/query/store fault must NOT kill the poll loop — report and carry on.
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
 * Decode the NyxtVault's on-chain `deposits` map for a contract address into `refHex → amount`
 * (base units, `bigint`). This is the OWNER-GATED SDK seam (constitution I): the verified recipe
 * (SPIKE-2 §C/§D, `sdkwork/deposit-common.mjs`, executed 2026-07-23 against indexer 4.2.1) is
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
 * module, and return the decoded map. The seam MUST surface amounts as native `bigint` (never
 * `Number()`) and MUST reflect only FINALIZED contract state (see the finality note below).
 */
export type DepositsStateReader = (vaultAddress: string) => Promise<ReadonlyMap<string, bigint>>;

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
 * FINALITY (retrieval-sourced): SPIKE-1 §5 observed the on-chain state change via the indexer
 * only AFTER finalization on node 0.22.5, so a ref present in the indexer-served `deposits` map is
 * treated as `finalized: true`. The precise finalized-vs-included semantics of the indexer's
 * contract-state read is an owner-gated live-schema confirmation (Task 7 Step 5); the safe
 * contract is that {@link DepositsStateReader} surfaces only FINALIZED state. The store gates on
 * `finalized` regardless, so a not-yet-final read never credits.
 *
 * `findDeposits`:
 *   1. GraphQL `contractAction(vaultAddress)` → tx hash (the diagnostic `txRef`) + existence.
 *      `null` / absent → `[]` (well-formed no-results; the decode seam is never reached).
 *   2. decode the on-chain `deposits` map (owner-gated) → `refHex → amount` (bigint).
 *   3. for each requested ref present in the map → a finalized `success` observation carrying the
 *      ON-CHAIN amount. Refs absent from the map yield no observation (the store keeps watching).
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
    const query =
      `{ contractAction(address: "${options.vaultAddress}") ` +
      `{ __typename address unshieldedBalances { tokenType amount } ` +
      `transaction { hash block { height } } } }`;

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
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
        const amount = deposits.get(ref);
        if (amount === undefined) {
          continue; // not landed on-chain yet — the store keeps watching this ref
        }
        observations.push({
          ref,
          amount, // ON-CHAIN, native bigint (EC-28 authoritative) — never Number()
          txRef: action.txRef,
          outcome: "success",
          finalized: true,
        });
      }
      return observations;
    },
  };
}
