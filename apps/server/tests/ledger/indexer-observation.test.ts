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
  creditOutcomeToPush,
  DepositIndexerNotWiredError,
  IndexerUnavailableError,
  type DepositIndexerQuery,
  type DepositStateEntry,
} from "../../src/ledger/indexer-observation.js";
import { createDepositStore } from "../../src/ledger/deposits.js";
import type {
  CreditOutcome,
  DepositObservation,
  DepositStore,
  OpenDepositRef,
} from "../../src/ledger/deposits.js";
import type { LedgerEntryRecord, LedgerStore } from "../../src/ledger/ledger.js";

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

/** A no-op `expireStale` (I2): every tick runs the sweep; most tests only need it to succeed. */
function expireStaleMock(): DepositStore["expireStale"] {
  return vi.fn<DepositStore["expireStale"]>(() => Promise.resolve(0));
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
      store: { listOpenRefs, observeFinalized: ignoreAllMock(), expireStale: expireStaleMock() },
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
      store: {
        listOpenRefs: listOpenRefsMock("aa", "bb"),
        observeFinalized: ignoreAllMock(),
        expireStale: expireStaleMock(),
      },
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
      store: {
        listOpenRefs: listOpenRefsMock(FINALIZED_SUCCESS.ref),
        observeFinalized,
        expireStale: expireStaleMock(),
      },
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
      store: {
        listOpenRefs: listOpenRefsMock(unfinalized.ref),
        observeFinalized,
        expireStale: expireStaleMock(),
      },
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
      store: {
        listOpenRefs: listOpenRefsMock("aa"),
        observeFinalized: ignoreAllMock(),
        expireStale: expireStaleMock(),
      },
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
        expireStale: expireStaleMock(),
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
      store: {
        listOpenRefs: listOpenRefsMock(),
        observeFinalized: ignoreAllMock(),
        expireStale: expireStaleMock(),
      },
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
      store: {
        listOpenRefs: listOpenRefsMock(),
        observeFinalized: ignoreAllMock(),
        expireStale: expireStaleMock(),
      },
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
        expireStale: expireStaleMock(),
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

  it("runs expireStale each tick BEFORE listing, so a swept ref drops out (I2 — EC-29 wired)", async () => {
    const timer = makeFakeTimer();
    // A stateful fake store: `old` is open until expireStale sweeps it, then it drops out.
    let expired = false;
    const expireStale = vi.fn<DepositStore["expireStale"]>(() => {
      expired = true;
      return Promise.resolve(1);
    });
    const listOpenRefs = vi.fn<DepositStore["listOpenRefs"]>(() =>
      Promise.resolve(expired ? [] : ([{ ref: "old" }] as readonly OpenDepositRef[])),
    );
    const findDeposits = vi.fn<DepositIndexerQuery["findDeposits"]>(() => Promise.resolve([]));
    const poller = createObservationPoller({
      store: { listOpenRefs, observeFinalized: ignoreAllMock(), expireStale },
      query: { findDeposits },
      intervalMs: 1_000,
      graceMs: 0,
      schedule: timer.schedule,
    });

    poller.start();
    await timer.fire();

    // The sweep ran BEFORE listing, so the abandoned ref never reached the indexer query.
    expect(expireStale).toHaveBeenCalledTimes(1);
    expect(findDeposits).not.toHaveBeenCalled();
    // And it is no longer returned by listOpenRefs (unbounded growth / dead EC-29 fixed).
    await expect(listOpenRefs(0)).resolves.toEqual([]);
  });

  it("isolates a per-observation store rejection: later observations still credit (I3)", async () => {
    const timer = makeFakeTimer();
    const obsA: DepositObservation = { ...FINALIZED_SUCCESS, ref: "aa".repeat(32) };
    const obsB: DepositObservation = { ...FINALIZED_SUCCESS, ref: "bb".repeat(32) };
    const boom = new Error("store hiccup on A");
    const creditedB: CreditOutcome = {
      kind: "credited",
      ref: obsB.ref,
      address: "mn_addr_bob",
      amount: 5_000n,
      balance: { available: 5_000n, reserved: 0n },
    };
    // The FIRST observation's store call rejects; the SECOND must still be processed.
    const observeFinalized = vi.fn<DepositStore["observeFinalized"]>((obs) =>
      obs.ref === obsA.ref ? Promise.reject(boom) : Promise.resolve(creditedB),
    );
    const outcomes: CreditOutcome[] = [];
    const errors: unknown[] = [];
    const poller = createObservationPoller({
      store: {
        listOpenRefs: listOpenRefsMock(obsA.ref, obsB.ref),
        observeFinalized,
        expireStale: expireStaleMock(),
      },
      query: { findDeposits: vi.fn(() => Promise.resolve([obsA, obsB])) },
      intervalMs: 1_000,
      graceMs: 0,
      onOutcome: (o) => outcomes.push(o),
      onError: (e) => errors.push(e),
      schedule: timer.schedule,
    });

    poller.start();
    await timer.fire();

    // A's rejection is reported but does NOT skip B (no cross-user credit starvation).
    expect(errors).toEqual([boom]);
    expect(observeFinalized).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([creditedB]);
    expect(timer.armed()).toBe(true); // the loop still survives to the next tick
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

  it("POSTs the contractAction query with the vault address as a BOUND GraphQL variable (M1)", async () => {
    const fetchMock = jsonFetchMock(contractActionResponse("0xhash", 218));
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: fetchMock,
      readDepositsState: () => Promise.resolve(new Map<string, DepositStateEntry>()),
    });

    await query.findDeposits([REF_A]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8088/api/v4/graphql");
    expect(init?.method).toBe("POST");
    const body = init?.body;
    if (typeof body !== "string") {
      throw new Error("expected a string request body");
    }
    const sentBody = JSON.parse(body) as { query: string; variables: { addr: string } };
    // M1 — the address is a bound `$addr: HexEncoded!` variable, NEVER interpolated into the
    // query string (GraphQL-injection hygiene, matching the module's bound-parameter rule).
    expect(sentBody.query).toContain("contractAction(address: $addr)");
    expect(sentBody.query).not.toContain(VAULT);
    expect(sentBody.variables).toEqual({ addr: VAULT });
  });

  it("maps a ref present in the decoded deposits map to a finalized success observation", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088/api/v4/graphql",
      vaultAddress: VAULT,
      fetch: jsonFetchMock(contractActionResponse("0xdeadbeef", 218)),
      // The on-chain amount arrives as a native bigint from `mod.ledger().deposits.lookup`;
      // the reader also reports finality (I1) — here a finalized entry.
      readDepositsState: () =>
        Promise.resolve(
          new Map<string, DepositStateEntry>([[REF_A, { amount: 7_777n, finalized: true }]]),
        ),
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

  it("propagates the reader's finalized flag — an UNFINALIZED read yields no credit (I1)", async () => {
    // I1 — finality is a VALUE the reader returns, not hardcoded. A reader that reports the
    // deposit as NOT yet finalized must produce a `finalized: false` observation so the store's
    // finality gate (the off-chain-mint backbone, SC-021) actually fires for this pipeline.
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: jsonFetchMock(contractActionResponse("0xhash", 218)),
      readDepositsState: () =>
        Promise.resolve(
          new Map<string, DepositStateEntry>([[REF_A, { amount: 5_000n, finalized: false }]]),
        ),
    });

    const observations = await query.findDeposits([REF_A]);
    const observation = observations[0];
    expect(observation?.finalized).toBe(false);
    if (observation === undefined) {
      throw new Error("expected an observation");
    }

    // Feed it through a REAL deposit store whose db + ledger THROW if touched: the finality gate
    // must short-circuit to `ignored-unfinalized` BEFORE any credit work (NO off-chain mint).
    const creditDeposit = vi.fn(() =>
      Promise.reject(new Error("must not credit an unfinalized deposit")),
    );
    const dbQuery = vi.fn(() =>
      Promise.reject(new Error("must not query for an unfinalized deposit")),
    );
    const store = createDepositStore({ query: dbQuery }, {
      creditDeposit,
    } as unknown as LedgerStore);

    const outcome = await store.observeFinalized(observation);
    expect(outcome).toEqual({ kind: "ignored-unfinalized", ref: REF_A });
    expect(creditDeposit).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns an empty array (well-formed no-results) when the contract has no action yet", async () => {
    const readDepositsState = vi.fn(() => Promise.resolve(new Map<string, DepositStateEntry>()));
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
      readDepositsState: () => Promise.resolve(new Map<string, DepositStateEntry>()),
    });
    await expect(query.findDeposits([REF_A])).rejects.toBeInstanceOf(IndexerUnavailableError);
  });

  it("rejects with IndexerUnavailableError when the GraphQL response carries errors", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: jsonFetchMock({ errors: [{ message: "unknown field" }] }),
      readDepositsState: () => Promise.resolve(new Map<string, DepositStateEntry>()),
    });
    await expect(query.findDeposits([REF_A])).rejects.toBeInstanceOf(IndexerUnavailableError);
  });

  it("rejects with IndexerUnavailableError when fetch itself throws (transport down)", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: vi.fn<typeof fetch>(() => Promise.reject(new Error("ECONNREFUSED"))),
      readDepositsState: () => Promise.resolve(new Map<string, DepositStateEntry>()),
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

// --- creditOutcomeToPush (the Task 8 sink → ledger:update push) --------------

/** A `getEntries`-only ledger double returning a canned entry list for one address. */
function getEntriesMock(entries: LedgerEntryRecord[]): Pick<LedgerStore, "getEntries"> {
  return { getEntries: vi.fn(() => Promise.resolve(entries)) };
}

/** A `deposit_credit` ledger row (the entry the credited push resolves for its real id). */
function creditEntry(overrides: Partial<LedgerEntryRecord> = {}): LedgerEntryRecord {
  return {
    id: 77n,
    accountAddress: "mn_addr_alice",
    kind: "deposit_credit",
    amount: 5_000n,
    ref: "dep-ref-1",
    createdAt: 1_000,
    ...overrides,
  };
}

const CREDITED: Extract<CreditOutcome, { kind: "credited" }> = {
  kind: "credited",
  ref: "dep-ref-1",
  address: "mn_addr_alice",
  amount: 5_000n,
  balance: { available: 5_000n, reserved: 0n },
};

const NOW = 1_720_000_000_000;

describe("creditOutcomeToPush", () => {
  it("maps a credited outcome to exactly ONE encoded ledger:update for the depositor's address", async () => {
    const ledger = getEntriesMock([creditEntry()]);
    const push = await creditOutcomeToPush(CREDITED, { ledger, now: () => NOW });

    expect(push).not.toBeNull();
    expect(push?.address).toBe("mn_addr_alice");
    expect(push?.event.type).toBe("ledger:update");
    // Money is DECIMAL STRINGS on the wire (encode* helper used) — never JSON numbers/bigint.
    const payload = (push?.event as { payload: Record<string, unknown> }).payload;
    expect(payload.available).toBe("5000");
    expect(payload.reserved).toBe("0");
    const entry = payload.entry as Record<string, unknown>;
    expect(entry.id).toBe("77"); // the REAL resolved entry id (monotonic sequence, not synthetic)
    expect(entry.amount).toBe("5000");
    expect(entry.kind).toBe("deposit_credit");
    expect(entry.ref).toBe("dep-ref-1");
  });

  it("emits NO frame and logs loudly when no matching deposit_credit row can be re-read (M2)", async () => {
    // M2 — the store JUST wrote this credit yet no row is re-readable: an "impossible" state. A
    // synthetic `id: 0n` frame would be silently dropped by the P13 client id-cursor guard,
    // HIDING the invariant break. Instead we log loudly and emit nothing.
    const ledger = getEntriesMock([]); // store returned nothing for this address
    const breaks: { context: Record<string, unknown>; message: string }[] = [];
    const push = await creditOutcomeToPush(CREDITED, {
      ledger,
      now: () => NOW,
      onInvariantBreak: (context, message) => breaks.push({ context, message }),
    });

    expect(push).toBeNull(); // nothing emitted (no invisible synthetic frame)
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.context).toMatchObject({ ref: "dep-ref-1", address: "mn_addr_alice" });
  });

  it("maps a finalized FAILURE with a known address to a deposit:failed frame (no ledger read)", async () => {
    const ledger = getEntriesMock([]);
    const failed: CreditOutcome = {
      kind: "failed",
      ref: "dep-ref-9",
      txRef: "0xdead",
      amount: 5_000n,
      address: "mn_addr_bob",
    };
    const push = await creditOutcomeToPush(failed, { ledger, now: () => NOW });

    expect(push?.address).toBe("mn_addr_bob");
    expect(push?.event.type).toBe("deposit:failed");
    const payload = (push?.event as { payload: Record<string, unknown> }).payload;
    expect(payload.ref).toBe("dep-ref-9");
    expect(payload.txRef).toBe("0xdead");
    expect(typeof payload.detail).toBe("string");
    // A failure never reads or asserts a balance (nothing was credited) — FR-070 untouched.
    expect(ledger.getEntries).not.toHaveBeenCalled();
  });

  it("maps a FAILURE for an UNREGISTERED ref (no address) to no frame (logged only)", async () => {
    const failed: CreditOutcome = {
      kind: "failed",
      ref: "dep-ref-x",
      txRef: "0xbeef",
      amount: 5_000n,
    };
    const push = await creditOutcomeToPush(failed, { ledger: getEntriesMock([]), now: () => NOW });
    expect(push).toBeNull();
  });

  it.each([
    { kind: "already-credited", ref: "r" },
    { kind: "orphaned", ref: "r", txRef: "0x", amount: 1n },
    { kind: "ignored-unfinalized", ref: "r" },
  ] as CreditOutcome[])("maps $kind to NO frame (logged only)", async (outcome) => {
    const push = await creditOutcomeToPush(outcome, { ledger: getEntriesMock([]), now: () => NOW });
    expect(push).toBeNull();
  });
});
