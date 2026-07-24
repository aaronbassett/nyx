/**
 * Deterministic indexer-observation tests (P3 Task 7) — the on-chain→off-chain crediting
 * bridge, split into two seams:
 *
 *  - {@link createObservationPoller}: the fully-production poller. Each tick lists the open
 *    deposit refs, queries the indexer for exactly those, and feeds every returned
 *    observation VERBATIM into `DepositStore.observeFinalized` (the exactly-once CAS
 *    chokepoint from Phase 8 — the poller NEVER classifies or credits, it only observes).
 *    Mirrors `reconcile-scheduler.ts`: injected timer, serial ticks, a generation guard so a
 *    `stop()` mid-tick cannot re-arm, and a tick fault reported to `onError` never kills the
 *    loop.
 *  - {@link createDevnetDepositIndexerQuery}: the owner-gated real indexer adapter. Its raw
 *    GraphQL transport (the SPIKE-2-verified `contractAction` query) is exercised here with a
 *    fake `fetch` + canned responses; the per-ref amount DECODE is an owner-gated SDK seam.
 *
 * Money-critical: these tests prove the poller never bypasses the store CAS (it passes
 * observations through untouched), and that on-chain amounts stay `bigint` (never `Number()`).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createDevnetDepositIndexerQuery,
  createObservationPoller,
  DepositIndexerNotWiredError,
  IndexerUnavailableError,
  type DepositIndexerQuery,
} from "../../src/ledger/indexer-observation.js";
import type {
  CreditOutcome,
  DepositObservation,
  DepositStore,
  OpenDepositRef,
} from "../../src/ledger/deposits.js";

// --- Test doubles -----------------------------------------------------------

/** A hand-driven timer seam (closures — no `this`): captures the pending tick + its delay. */
interface FakeTimer {
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly armed: () => boolean;
  readonly cancelled: () => number;
  readonly lastDelay: () => number | null;
  /** Fire the pending tick and let its async body (list → query → observe → re-arm) settle. */
  readonly fire: () => Promise<void>;
}

/** A macrotask flush — drains the async tick body. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeTimer(): FakeTimer {
  let pending: (() => void) | null = null;
  let cancelled = 0;
  let lastDelay: number | null = null;
  return {
    schedule: (fn, ms) => {
      pending = fn;
      lastDelay = ms;
      return () => {
        pending = null;
        cancelled += 1;
      };
    },
    armed: () => pending !== null,
    cancelled: () => cancelled,
    lastDelay: () => lastDelay,
    fire: async () => {
      const fn = pending;
      pending = null;
      fn?.();
      await settle();
    },
  };
}

/** A deferred promise so a test can hold a store call in-flight and settle it on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Mocks captured as locals (asserting on interface methods directly trips `unbound-method`). */
function listOpenRefsMock(...refs: string[]): DepositStore["listOpenRefs"] {
  return vi.fn(() => Promise.resolve(refs.map((ref) => ({ ref })) as readonly OpenDepositRef[]));
}

function ignoreAllMock(): DepositStore["observeFinalized"] {
  return vi.fn<DepositStore["observeFinalized"]>((obs) =>
    Promise.resolve<CreditOutcome>({ kind: "ignored-unfinalized", ref: obs.ref }),
  );
}

const FINALIZED_SUCCESS: DepositObservation = {
  ref: "aa".repeat(32),
  amount: 5_000n,
  txRef: "0xtx",
  outcome: "success",
  finalized: true,
};

// --- Poller -----------------------------------------------------------------

describe("createObservationPoller", () => {
  it("lists open refs each tick and queries only those; zero open refs → no query", async () => {
    const timer = makeFakeTimer();
    const listOpenRefs = listOpenRefsMock(); // → [] (nothing open)
    const findDeposits = vi.fn<DepositIndexerQuery["findDeposits"]>(() => Promise.resolve([]));
    const poller = createObservationPoller({
      store: { listOpenRefs, observeFinalized: ignoreAllMock() },
      query: { findDeposits },
      intervalMs: 1_000,
      graceMs: 60_000,
      schedule: timer.schedule,
    });

    poller.start();
    expect(timer.armed()).toBe(true);
    expect(timer.lastDelay()).toBe(1_000);

    await timer.fire();
    expect(listOpenRefs).toHaveBeenCalledWith(60_000);
    expect(findDeposits).not.toHaveBeenCalled(); // nothing open → no indexer call
    expect(timer.armed()).toBe(true); // rescheduled
  });

  it("queries exactly the open refs the store reports", async () => {
    const timer = makeFakeTimer();
    const findDeposits = vi.fn<DepositIndexerQuery["findDeposits"]>(() => Promise.resolve([]));
    const poller = createObservationPoller({
      store: { listOpenRefs: listOpenRefsMock("aa", "bb"), observeFinalized: ignoreAllMock() },
      query: { findDeposits },
      intervalMs: 1_000,
      graceMs: 0,
      schedule: timer.schedule,
    });

    poller.start();
    await timer.fire();
    expect(findDeposits).toHaveBeenCalledWith(["aa", "bb"]);
  });

  it("passes a finalized success to observeFinalized VERBATIM and surfaces `credited`", async () => {
    const timer = makeFakeTimer();
    const credited: CreditOutcome = {
      kind: "credited",
      ref: FINALIZED_SUCCESS.ref,
      address: "mn_addr_undeployed1abc",
      amount: 5_000n,
      balance: { available: 5_000n, reserved: 0n },
    };
    const observeFinalized = vi.fn<DepositStore["observeFinalized"]>(() =>
      Promise.resolve(credited),
    );
    const findDeposits = vi.fn<DepositIndexerQuery["findDeposits"]>(() =>
      Promise.resolve([FINALIZED_SUCCESS]),
    );
    const outcomes: CreditOutcome[] = [];
    const poller = createObservationPoller({
      store: { listOpenRefs: listOpenRefsMock(FINALIZED_SUCCESS.ref), observeFinalized },
      query: { findDeposits },
      intervalMs: 1_000,
      graceMs: 0,
      onOutcome: (o) => outcomes.push(o),
      schedule: timer.schedule,
    });

    poller.start();
    await timer.fire();

    // VERBATIM: the exact observation object reaches the store — the poller mutates nothing.
    expect(observeFinalized).toHaveBeenCalledWith(FINALIZED_SUCCESS);
    expect(observeFinalized.mock.calls[0]?.[0]).toBe(FINALIZED_SUCCESS);
    expect(outcomes).toEqual([credited]);
  });

  it("still feeds an unfinalized observation to the store (classification is the store's job)", async () => {
    const timer = makeFakeTimer();
    const unfinalized: DepositObservation = { ...FINALIZED_SUCCESS, finalized: false };
    const observeFinalized = ignoreAllMock();
    const findDeposits = vi.fn<DepositIndexerQuery["findDeposits"]>(() =>
      Promise.resolve([unfinalized]),
    );
    const outcomes: CreditOutcome[] = [];
    const poller = createObservationPoller({
      store: { listOpenRefs: listOpenRefsMock(unfinalized.ref), observeFinalized },
      query: { findDeposits },
      intervalMs: 1_000,
      graceMs: 0,
      onOutcome: (o) => outcomes.push(o),
      schedule: timer.schedule,
    });

    poller.start();
    await timer.fire();

    // The poller does NOT pre-filter on `finalized` — it hands the observation over and the
    // store returns `ignored-unfinalized`. No duplicated classification in the poller.
    expect(observeFinalized).toHaveBeenCalledWith(unfinalized);
    expect(outcomes).toEqual([{ kind: "ignored-unfinalized", ref: unfinalized.ref }]);
  });

  it("reports a query rejection to onError and keeps ticking", async () => {
    const timer = makeFakeTimer();
    const boom = new Error("indexer down");
    const findDeposits = vi.fn<DepositIndexerQuery["findDeposits"]>(() => Promise.reject(boom));
    const errors: unknown[] = [];
    const poller = createObservationPoller({
      store: { listOpenRefs: listOpenRefsMock("aa"), observeFinalized: ignoreAllMock() },
      query: { findDeposits },
      intervalMs: 1_000,
      graceMs: 0,
      onError: (e) => errors.push(e),
      schedule: timer.schedule,
    });

    poller.start();
    await timer.fire();
    expect(errors).toEqual([boom]);
    expect(timer.armed()).toBe(true); // the loop survives — next tick is armed

    // The next scheduled tick still fires.
    await timer.fire();
    expect(findDeposits).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the pending tick; an in-flight tick cannot re-arm after stop()", async () => {
    const timer = makeFakeTimer();
    const gate = deferred<CreditOutcome>();
    const poller = createObservationPoller({
      store: {
        listOpenRefs: listOpenRefsMock(FINALIZED_SUCCESS.ref),
        observeFinalized: vi.fn(() => gate.promise),
      },
      query: { findDeposits: vi.fn(() => Promise.resolve([FINALIZED_SUCCESS])) },
      intervalMs: 1_000,
      graceMs: 0,
      schedule: timer.schedule,
    });

    poller.start();
    // Fire the tick but keep the store call in-flight (observeFinalized pending on `gate`).
    const firePromise = timer.fire();
    // stop() arrives while the tick is mid-flight.
    poller.stop();
    // Now release the in-flight store call and let the tick's finally run.
    gate.resolve({ kind: "already-credited", ref: FINALIZED_SUCCESS.ref });
    await firePromise;

    // The generation guard suppressed the finally re-arm: no timer is armed after stop().
    expect(timer.armed()).toBe(false);
  });

  it("stop() then start() does not double-arm (generation guard)", () => {
    const timer = makeFakeTimer();
    const poller = createObservationPoller({
      store: { listOpenRefs: listOpenRefsMock(), observeFinalized: ignoreAllMock() },
      query: { findDeposits: vi.fn(() => Promise.resolve([])) },
      intervalMs: 1_000,
      graceMs: 0,
      schedule: timer.schedule,
    });
    poller.start();
    poller.stop();
    poller.start();
    expect(timer.armed()).toBe(true);
    poller.stop();
    expect(timer.armed()).toBe(false);
  });

  it("start() is idempotent (a second start while running is a no-op)", () => {
    const timer = makeFakeTimer();
    const poller = createObservationPoller({
      store: { listOpenRefs: listOpenRefsMock(), observeFinalized: ignoreAllMock() },
      query: { findDeposits: vi.fn(() => Promise.resolve([])) },
      intervalMs: 1_000,
      graceMs: 0,
      schedule: timer.schedule,
    });
    poller.start();
    poller.start(); // no-op
    poller.stop();
    expect(timer.cancelled()).toBe(1); // only one armed handle ever existed
  });

  it("ticks are serial: the next tick is armed only after the store calls settle", async () => {
    const timer = makeFakeTimer();
    const gate = deferred<CreditOutcome>();
    const poller = createObservationPoller({
      store: {
        listOpenRefs: listOpenRefsMock(FINALIZED_SUCCESS.ref),
        observeFinalized: vi.fn(() => gate.promise),
      },
      query: { findDeposits: vi.fn(() => Promise.resolve([FINALIZED_SUCCESS])) },
      intervalMs: 1_000,
      graceMs: 0,
      schedule: timer.schedule,
    });

    poller.start();
    const firePromise = timer.fire();
    await settle();
    // The store call is still in flight → the next tick is NOT yet armed.
    expect(timer.armed()).toBe(false);

    gate.resolve({
      kind: "credited",
      ref: FINALIZED_SUCCESS.ref,
      address: "x",
      amount: 5_000n,
      balance: { available: 5_000n, reserved: 0n },
    });
    await firePromise;
    // Only now, after the store settled, is the next tick armed.
    expect(timer.armed()).toBe(true);
  });
});

// --- Devnet indexer query adapter -------------------------------------------

/**
 * A canned `contractAction` GraphQL response. Shape verified by execution in SPIKE-2
 * (`sdkwork/deposit-common.mjs`, run 2026-07-23 against indexer `4.2.1`): the query
 * `{ contractAction(address: "…") { __typename address unshieldedBalances { tokenType amount }
 * transaction { hash block { height } } } }` returns `data.contractAction` with the vault's
 * latest contract-call tx hash + block height. The per-ref amount is NOT in this envelope — it
 * lives in the contract's serialized ledger state, decoded by the owner-gated `readDepositsState`
 * seam (SPIKE-2 `queryContractState` + `mod.ledger(state).deposits.lookup(ref)`).
 */
function contractActionResponse(hash: string, height: number): unknown {
  return {
    data: {
      contractAction: {
        __typename: "ContractCall",
        address: "0200vaultaddr",
        unshieldedBalances: [{ tokenType: "0100dead", amount: "5000" }],
        transaction: { hash, block: { height } },
      },
    },
  };
}

/** A fake `fetch` returning a canned JSON body (200 by default). Captured as a local mock. */
function jsonFetchMock(
  body: unknown,
  init: { status?: number } = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  const status = init.status ?? 200;
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("createDevnetDepositIndexerQuery", () => {
  const VAULT = "0200vaultaddr";
  const REF_A = "aa".repeat(32);
  const REF_B = "bb".repeat(32);

  it("POSTs the verified contractAction query to the GraphQL endpoint with the vault address", async () => {
    const fetchMock = jsonFetchMock(contractActionResponse("0xhash", 218));
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: fetchMock,
      readDepositsState: () => Promise.resolve(new Map<string, bigint>()),
    });

    await query.findDeposits([REF_A]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8088/api/v4/graphql");
    expect(init?.method).toBe("POST");
    const body = init?.body;
    if (typeof body !== "string") {
      throw new Error("expected a string request body");
    }
    const sentBody = JSON.parse(body) as { query: string };
    expect(sentBody.query).toContain("contractAction(address:");
    expect(sentBody.query).toContain(VAULT);
  });

  it("maps a ref present in the decoded deposits map to a finalized success observation", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088/api/v4/graphql",
      vaultAddress: VAULT,
      fetch: jsonFetchMock(contractActionResponse("0xdeadbeef", 218)),
      // The on-chain amount arrives as a native bigint from `mod.ledger().deposits.lookup`.
      readDepositsState: () => Promise.resolve(new Map<string, bigint>([[REF_A, 7_777n]])),
    });

    const observations = await query.findDeposits([REF_A, REF_B]);

    expect(observations).toEqual([
      {
        ref: REF_A,
        amount: 7_777n,
        txRef: "0xdeadbeef",
        outcome: "success",
        finalized: true,
      },
    ]);
    // Money discipline: the amount is a bigint, never coerced through Number().
    expect(typeof observations[0]?.amount).toBe("bigint");
    // REF_B is not in the on-chain map → no observation (the store keeps watching it).
    expect(observations.map((o) => o.ref)).toEqual([REF_A]);
  });

  it("returns an empty array (well-formed no-results) when the contract has no action yet", async () => {
    const readDepositsState = vi.fn(() => Promise.resolve(new Map<string, bigint>()));
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: jsonFetchMock({ data: { contractAction: null } }),
      readDepositsState,
    });

    const observations = await query.findDeposits([REF_A]);
    expect(observations).toEqual([]);
    // No contract state to decode → the owner-gated decode seam is never reached.
    expect(readDepositsState).not.toHaveBeenCalled();
  });

  it("rejects with IndexerUnavailableError on a non-2xx HTTP status", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: jsonFetchMock({}, { status: 503 }),
      readDepositsState: () => Promise.resolve(new Map<string, bigint>()),
    });
    await expect(query.findDeposits([REF_A])).rejects.toBeInstanceOf(IndexerUnavailableError);
  });

  it("rejects with IndexerUnavailableError when the GraphQL response carries errors", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: jsonFetchMock({ errors: [{ message: "unknown field" }] }),
      readDepositsState: () => Promise.resolve(new Map<string, bigint>()),
    });
    await expect(query.findDeposits([REF_A])).rejects.toBeInstanceOf(IndexerUnavailableError);
  });

  it("rejects with IndexerUnavailableError when fetch itself throws (transport down)", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: vi.fn<typeof fetch>(() => Promise.reject(new Error("ECONNREFUSED"))),
      readDepositsState: () => Promise.resolve(new Map<string, bigint>()),
    });
    await expect(query.findDeposits([REF_A])).rejects.toBeInstanceOf(IndexerUnavailableError);
  });

  it("rejects owner-gated (DepositIndexerNotWiredError) when the decode seam is not injected", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: jsonFetchMock(contractActionResponse("0xhash", 218)),
      // readDepositsState omitted → the real SDK decode is owner-gated.
    });
    await expect(query.findDeposits([REF_A])).rejects.toBeInstanceOf(DepositIndexerNotWiredError);
  });
});
