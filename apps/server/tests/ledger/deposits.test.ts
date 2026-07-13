/**
 * Deposit-flow store contract tests (T120 deposit portion, US6) — deterministic,
 * in-memory, NO Postgres. Drives an {@link InMemoryDepositStore} (defined here) through
 * the shared {@link DepositStore} interface to pin the finality-gated credit semantics
 * US6 depends on (D45/D46, FR-041/042/044, EC-28..32, SC-021/022):
 *
 *  - preregister mints a RANDOM ref bound to account + expected_amount with a TTL
 *    (FR-042); a below-minimum amount is rejected with a named error (D45/D47);
 *  - a finalized SUCCESS of a KNOWN ref credits EXACTLY ONCE via the ledger, and a
 *    DUPLICATE/REORG observation of the same ref returns `already-credited` with the
 *    ledger showing ONE credit (SC-021 exactly-once);
 *  - EC-28: an on-chain amount ≠ expected credits the ON-CHAIN amount and logs the
 *    mismatch LOUDLY (asserted via the injected logger seam);
 *  - a finalized FAILURE credits nothing and surfaces a `failed` outcome (scenario 6);
 *  - an UNREGISTERED finalized success is ORPHANED, never auto-credited (D46/FR-044/
 *    EC-31); a duplicate orphan observation is idempotent;
 *  - a NON-finalized observation is ignored (credit ONLY on finalized success);
 *  - expireStale sweeps ONLY past-TTL `preregistered` refs → `expired` (EC-29);
 *  - EC-30 indexer catch-up: replaying the SAME observation twice yields a SINGLE
 *    credit (belt-and-suspenders: the deposit-ref CAS + creditDeposit's ref-idempotency).
 *
 * The observation is a Nyx-internal seam ({@link DepositObservation}), NOT an SDK/indexer
 * type (constitution I). The in-memory double models `deposit_refs` + `orphan_deposits`
 * with an injected clock, RNG, and logger; a {@link FakeLedgerStore} models the ledger's
 * `creditDeposit` (idempotent by ref) so credit counts are assertable without Postgres.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEPOSIT_REF_TTL_MS,
  DEFAULT_MINIMUM_DEPOSIT,
  DepositAboveMaximumError,
  DepositBelowMinimumError,
  MAXIMUM_DEPOSIT,
  randomDepositRef,
} from "../../src/ledger/deposits.js";
import type {
  CreditOutcome,
  DepositLogger,
  DepositObservation,
  DepositRegistration,
  DepositStatus,
  DepositStore,
  DepositView,
} from "../../src/ledger/deposits.js";
import { NonPositiveAmountError } from "../../src/ledger/ledger.js";
import type { Balance, LedgerEntryRecord, LedgerStore, Turn } from "../../src/ledger/ledger.js";

const ACCOUNT = "midnight-account-address";
const OTHER = "midnight-other-address";
const TTL_MS = 1_800_000; // 30-minute test TTL.
const MIN_DEPOSIT = 1_000n;

// --- Test doubles -----------------------------------------------------------

/** Mutable clock the store reads, so tests advance time deterministically. */
interface Clock {
  now: number;
}

/** A recording {@link DepositLogger} so EC-28 / late-deposit warnings are assertable. */
class RecordingLogger implements DepositLogger {
  readonly warnings: { context: Record<string, unknown>; message: string }[] = [];
  warn(context: Record<string, unknown>, message: string): void {
    this.warnings.push({ context, message });
  }
  messages(): string[] {
    return this.warnings.map((entry) => entry.message);
  }
}

/**
 * Minimal {@link LedgerStore} double exercising ONLY `creditDeposit` (the sole ledger
 * method the deposit flow calls), idempotent by ref like the real store. `creditCalls`
 * records every invocation (so SC-021 exactly-once = one distinct ref credited even under
 * duplicate calls); the unused turn/settle methods reject (never reached by deposits).
 */
class FakeLedgerStore implements LedgerStore {
  readonly credits = new Map<string, { address: string; amount: bigint }>();
  readonly creditCalls: { address: string; ref: string; amount: bigint }[] = [];

  creditDeposit(address: string, ref: string, amount: bigint): Promise<Balance> {
    this.creditCalls.push({ address, ref, amount });
    if (amount <= 0n) {
      return Promise.reject(new NonPositiveAmountError("amount", amount));
    }
    if (!this.credits.has(ref)) {
      this.credits.set(ref, { address, amount });
    }
    let available = 0n;
    for (const credit of this.credits.values()) {
      if (credit.address === address) {
        available += credit.amount;
      }
    }
    return Promise.resolve({ available, reserved: 0n });
  }

  /** Distinct refs credited to `address` — the exactly-once witness (SC-021). */
  creditedRefs(address: string): string[] {
    return [...this.credits.entries()]
      .filter(([, credit]) => credit.address === address)
      .map(([ref]) => ref);
  }

  openTurn(): Promise<Turn> {
    return Promise.reject(new Error("openTurn is not used by the deposit flow"));
  }
  getTurn(): Promise<Turn | null> {
    return Promise.reject(new Error("getTurn is not used by the deposit flow"));
  }
  placeReserve(): Promise<Balance> {
    return Promise.reject(new Error("placeReserve is not used by the deposit flow"));
  }
  settle(): Promise<Balance> {
    return Promise.reject(new Error("settle is not used by the deposit flow"));
  }
  decline(): Promise<Turn> {
    return Promise.reject(new Error("decline is not used by the deposit flow"));
  }
  getBalance(address: string): Promise<Balance> {
    let available = 0n;
    for (const credit of this.credits.values()) {
      if (credit.address === address) {
        available += credit.amount;
      }
    }
    return Promise.resolve({ available, reserved: 0n });
  }
  getEntries(): Promise<LedgerEntryRecord[]> {
    return Promise.reject(new Error("getEntries is not used by the deposit flow"));
  }
}

/** Mutable `deposit_refs` row modelling the table. */
interface DepositRefRecord {
  ref: string;
  address: string;
  expectedAmount: bigint;
  createdAt: number;
  expiresAt: number;
  status: DepositStatus;
}

interface InMemoryDepositOptions {
  readonly minimumDeposit: bigint;
  readonly depositRefTtlMs: number;
  readonly generateRef: () => string;
  readonly logger: DepositLogger;
}

/**
 * In-memory {@link DepositStore} modelling the Postgres semantics (`deposit_refs` +
 * `orphan_deposits`) with an injected clock, RNG, and logger. The credit path mirrors
 * {@link PgDepositStore}: read the ref, orphan-if-unknown, no-op-if-credited, else CREDIT
 * FIRST (via the injected ledger, idempotent by ref) THEN flip the ref → `credited`.
 */
class InMemoryDepositStore implements DepositStore {
  private readonly refs = new Map<string, DepositRefRecord>();
  private readonly orphans = new Map<string, { ref: string; amount: bigint; txRef: string }>();

  constructor(
    private readonly clock: () => number,
    private readonly ledger: LedgerStore,
    private readonly options: InMemoryDepositOptions,
  ) {}

  /** Test accessor: distinct orphan refs recorded (the UNIQUE-ref idempotency witness). */
  orphanRefs(): string[] {
    return [...this.orphans.keys()];
  }

  preregister(address: string, amount: bigint): Promise<DepositRegistration> {
    if (amount < this.options.minimumDeposit) {
      return Promise.reject(
        new DepositBelowMinimumError(address, amount, this.options.minimumDeposit),
      );
    }
    // Parity with PgDepositStore (H1): an above-cap amount can never be minted on-chain.
    if (amount > MAXIMUM_DEPOSIT) {
      return Promise.reject(new DepositAboveMaximumError(address, amount, MAXIMUM_DEPOSIT));
    }
    const ref = this.options.generateRef();
    const createdAt = this.clock();
    const expiresAt = createdAt + this.options.depositRefTtlMs;
    this.refs.set(ref, {
      ref,
      address,
      expectedAmount: amount,
      createdAt,
      expiresAt,
      status: "preregistered",
    });
    return Promise.resolve({ ref, expiresAt });
  }

  async observeFinalized(observation: DepositObservation): Promise<CreditOutcome> {
    if (!observation.finalized) {
      return { kind: "ignored-unfinalized", ref: observation.ref };
    }
    if (observation.outcome === "failure") {
      return this.recordFailure(observation);
    }
    return this.creditSuccess(observation);
  }

  private recordFailure(observation: DepositObservation): CreditOutcome {
    const known = this.refs.get(observation.ref);
    this.options.logger.warn(
      { ref: observation.ref, txRef: observation.txRef, amount: observation.amount.toString() },
      "deposit finalized as FAILURE — not credited (scenario 6)",
    );
    // Do NOT orphan a known ref on failure (D46): surface a failed outcome only.
    return known === undefined
      ? {
          kind: "failed",
          ref: observation.ref,
          txRef: observation.txRef,
          amount: observation.amount,
        }
      : {
          kind: "failed",
          ref: observation.ref,
          txRef: observation.txRef,
          amount: observation.amount,
          address: known.address,
        };
  }

  private async creditSuccess(observation: DepositObservation): Promise<CreditOutcome> {
    const record = this.refs.get(observation.ref);
    if (record === undefined) {
      // Unregistered → orphan (idempotent by UNIQUE ref); NEVER auto-credit (D46/EC-31).
      if (!this.orphans.has(observation.ref)) {
        this.orphans.set(observation.ref, {
          ref: observation.ref,
          amount: observation.amount,
          txRef: observation.txRef,
        });
      }
      return {
        kind: "orphaned",
        ref: observation.ref,
        txRef: observation.txRef,
        amount: observation.amount,
      };
    }
    if (record.status === "credited") {
      return { kind: "already-credited", ref: observation.ref };
    }
    if (record.status === "expired") {
      this.options.logger.warn(
        { ref: observation.ref, txRef: observation.txRef },
        "deposit finalized SUCCESS after TTL expiry — crediting confirmed on-chain funds (fund safety)",
      );
    }
    if (record.expectedAmount !== observation.amount) {
      this.options.logger.warn(
        {
          ref: observation.ref,
          expected: record.expectedAmount.toString(),
          observed: observation.amount.toString(),
          txRef: observation.txRef,
        },
        "deposit amount mismatch (EC-28) — crediting the ON-CHAIN observed amount",
      );
    }
    // Credit FIRST (idempotent by ref) so a crash before the flip never loses the credit;
    // creditDeposit's ref-dedup prevents a double credit on replay (EC-30).
    const balance = await this.ledger.creditDeposit(
      record.address,
      observation.ref,
      observation.amount,
    );
    record.status = "credited";
    return {
      kind: "credited",
      ref: observation.ref,
      address: record.address,
      amount: observation.amount,
      balance,
    };
  }

  expireStale(): Promise<number> {
    const now = this.clock();
    let expired = 0;
    for (const record of this.refs.values()) {
      if (record.status === "preregistered" && record.expiresAt <= now) {
        record.status = "expired";
        expired += 1;
      }
    }
    return Promise.resolve(expired);
  }

  getDeposit(ref: string): Promise<DepositView | null> {
    const record = this.refs.get(ref);
    return Promise.resolve(record === undefined ? null : { status: record.status });
  }
}

// --- Fixtures ---------------------------------------------------------------

let clock: Clock;
let ledger: FakeLedgerStore;
let logger: RecordingLogger;
let refSeq: number;
let store: InMemoryDepositStore;

beforeEach(() => {
  clock = { now: 1_000_000 };
  ledger = new FakeLedgerStore();
  logger = new RecordingLogger();
  refSeq = 0;
  store = new InMemoryDepositStore(() => clock.now, ledger, {
    minimumDeposit: MIN_DEPOSIT,
    depositRefTtlMs: TTL_MS,
    // Deterministic, injected RNG: distinct, reproducible refs per test.
    generateRef: () => {
      refSeq += 1;
      return `ref-${String(refSeq)}`;
    },
    logger,
  });
});

/** Build a finalized on-chain observation seam value (the indexer→Nyx adapter's output). */
function observe(overrides: Partial<DepositObservation> & { ref: string }): DepositObservation {
  return {
    amount: 1_000n,
    txRef: `tx-${overrides.ref}`,
    outcome: "success",
    finalized: true,
    ...overrides,
  };
}

/** Narrow a {@link CreditOutcome} to its `credited` variant, or fail loudly. */
function asCredited(outcome: CreditOutcome): Extract<CreditOutcome, { kind: "credited" }> {
  if (outcome.kind !== "credited") {
    throw new Error(`expected a 'credited' outcome, got '${outcome.kind}'`);
  }
  return outcome;
}

// --- preregister (FR-042/D45/D47) -------------------------------------------

describe("preregister mints a TTL-bound ref (FR-042)", () => {
  it("binds a random ref to the account + expected amount with an expiry", async () => {
    const registration = await store.preregister(ACCOUNT, 5_000n);
    expect(registration.ref).toBe("ref-1");
    // expiresAt = now + TTL, driven by the injected clock (DB clock in production).
    expect(registration.expiresAt).toBe(1_000_000 + TTL_MS);

    const view = await store.getDeposit(registration.ref);
    expect(view).toEqual({ status: "preregistered" });
  });

  it("mints DISTINCT refs across preregistrations", async () => {
    const first = await store.preregister(ACCOUNT, 5_000n);
    const second = await store.preregister(ACCOUNT, 5_000n);
    expect(first.ref).not.toBe(second.ref);
  });

  it("rejects a below-minimum deposit with a named error (D45/D47)", async () => {
    await expect(store.preregister(ACCOUNT, MIN_DEPOSIT - 1n)).rejects.toBeInstanceOf(
      DepositBelowMinimumError,
    );
    // A zero/negative amount is likewise below the (positive) minimum.
    await expect(store.preregister(ACCOUNT, 0n)).rejects.toBeInstanceOf(DepositBelowMinimumError);
  });

  it("accepts a deposit exactly at the minimum", async () => {
    const registration = await store.preregister(ACCOUNT, MIN_DEPOSIT);
    expect((await store.getDeposit(registration.ref))?.status).toBe("preregistered");
  });

  it("rejects an above-cap deposit with a named error (H1 mint-cap, D45 parity)", async () => {
    // 2^64 is one above the contract's per-deposit mint cap — never mintable on-chain.
    await expect(store.preregister(ACCOUNT, MAXIMUM_DEPOSIT + 1n)).rejects.toBeInstanceOf(
      DepositAboveMaximumError,
    );
  });

  it("accepts a deposit exactly at the per-deposit mint cap (2^64-1)", async () => {
    const registration = await store.preregister(ACCOUNT, MAXIMUM_DEPOSIT);
    expect((await store.getDeposit(registration.ref))?.status).toBe("preregistered");
  });

  it("exposes a default 32-byte-hex random ref generator (RNG seam default)", () => {
    const a = randomDepositRef();
    const b = randomDepositRef();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b); // 32 random bytes → collision-free in practice.
  });
});

// --- finalized SUCCESS credits exactly once (SC-021) ------------------------

describe("finalized success credits a known ref exactly once (SC-021)", () => {
  it("credits the on-chain amount via the ledger and flips the ref to credited", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n);

    const outcome = asCredited(await store.observeFinalized(observe({ ref, amount: 5_000n })));
    expect(outcome.address).toBe(ACCOUNT);
    expect(outcome.amount).toBe(5_000n);
    expect(outcome.balance).toEqual({ available: 5_000n, reserved: 0n });

    expect(ledger.creditCalls).toEqual([{ address: ACCOUNT, ref, amount: 5_000n }]);
    expect((await store.getDeposit(ref))?.status).toBe("credited");
  });

  it("returns already-credited on a DUPLICATE/REORG observation with ONE ledger credit", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n);
    await store.observeFinalized(observe({ ref, amount: 5_000n }));

    const replay = await store.observeFinalized(observe({ ref, amount: 5_000n }));
    expect(replay).toEqual({ kind: "already-credited", ref });

    // Exactly-once: the ledger was touched once and shows a single distinct credited ref.
    expect(ledger.creditCalls).toHaveLength(1);
    expect(ledger.creditedRefs(ACCOUNT)).toEqual([ref]);
  });

  it("EC-30 indexer catch-up: replaying the same observation twice → a single credit", async () => {
    const { ref } = await store.preregister(ACCOUNT, 2_000n);
    const observation = observe({ ref, amount: 2_000n });

    await store.observeFinalized(observation);
    const replay = await store.observeFinalized(observation);

    expect(replay.kind).toBe("already-credited");
    expect(ledger.creditedRefs(ACCOUNT)).toEqual([ref]);
    expect(ledger.creditCalls).toHaveLength(1);
  });
});

// --- EC-28 amount mismatch --------------------------------------------------

describe("EC-28: an on-chain amount ≠ expected credits the on-chain amount, logged loudly", () => {
  it("credits the observed on-chain amount (not the expected) and emits a mismatch warning", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n); // expected 5000

    // Finalized on-chain amount differs from what the UI selected.
    const outcome = asCredited(await store.observeFinalized(observe({ ref, amount: 4_200n })));
    expect(outcome.amount).toBe(4_200n);
    expect(ledger.creditCalls).toEqual([{ address: ACCOUNT, ref, amount: 4_200n }]);
    expect(outcome.balance).toEqual({ available: 4_200n, reserved: 0n });

    // The mismatch is surfaced LOUDLY (EC-28), carrying both amounts for diagnostics.
    const mismatch = logger.warnings.find((entry) => entry.message.includes("EC-28"));
    expect(mismatch).toBeDefined();
    expect(mismatch?.context).toMatchObject({ expected: "5000", observed: "4200", ref });
  });

  it("does NOT warn when the on-chain amount equals the expected amount", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n);
    await store.observeFinalized(observe({ ref, amount: 5_000n }));
    expect(logger.messages().some((message) => message.includes("EC-28"))).toBe(false);
  });
});

// --- finalized FAILURE (scenario 6) -----------------------------------------

describe("finalized failure credits nothing and surfaces a failed outcome (scenario 6)", () => {
  it("returns failed with diagnostics, credits nothing, and does not orphan a known ref", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n);

    const outcome = await store.observeFinalized(
      observe({ ref, amount: 5_000n, outcome: "failure" }),
    );
    expect(outcome).toEqual({
      kind: "failed",
      ref,
      txRef: `tx-${ref}`,
      amount: 5_000n,
      address: ACCOUNT,
    });

    // Nothing credited; the ref stays creditable (a later success can still land).
    expect(ledger.creditCalls).toHaveLength(0);
    expect((await store.getDeposit(ref))?.status).toBe("preregistered");
    // A known ref is NEVER orphaned on failure (D46).
    expect(store.orphanRefs()).toHaveLength(0);
    expect(logger.messages().some((message) => message.includes("FAILURE"))).toBe(true);
  });

  it("surfaces a failed outcome for an UNKNOWN ref without orphaning it (no funds landed)", async () => {
    const outcome = await store.observeFinalized(
      observe({ ref: "unknown-ref", amount: 3_000n, outcome: "failure" }),
    );
    expect(outcome.kind).toBe("failed");
    expect(store.orphanRefs()).toHaveLength(0);
    expect(ledger.creditCalls).toHaveLength(0);
  });
});

// --- unregistered ref → orphan (D46/FR-044/EC-31) ---------------------------

describe("an unregistered finalized success is orphaned, never auto-credited (D46)", () => {
  it("records an orphan and NEVER credits", async () => {
    const outcome = await store.observeFinalized(observe({ ref: "surprise-ref", amount: 7_000n }));
    expect(outcome).toEqual({
      kind: "orphaned",
      ref: "surprise-ref",
      txRef: "tx-surprise-ref",
      amount: 7_000n,
    });

    expect(ledger.creditCalls).toHaveLength(0);
    expect(store.orphanRefs()).toEqual(["surprise-ref"]);
    // getDeposit reads deposit_refs only — an orphan ref is unknown there.
    expect(await store.getDeposit("surprise-ref")).toBeNull();
  });

  it("is idempotent for a duplicate orphan observation (UNIQUE ref)", async () => {
    await store.observeFinalized(observe({ ref: "surprise-ref", amount: 7_000n }));
    const replay = await store.observeFinalized(observe({ ref: "surprise-ref", amount: 7_000n }));
    expect(replay.kind).toBe("orphaned");
    // The orphan is recorded exactly once, never credited.
    expect(store.orphanRefs()).toEqual(["surprise-ref"]);
    expect(ledger.creditCalls).toHaveLength(0);
  });
});

// --- non-finalized observation is ignored -----------------------------------

describe("a non-finalized observation is ignored (credit ONLY on finalized success)", () => {
  it("credits nothing, orphans nothing, and leaves the ref untouched", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n);

    const outcome = await store.observeFinalized(
      observe({ ref, amount: 5_000n, finalized: false }),
    );
    expect(outcome).toEqual({ kind: "ignored-unfinalized", ref });

    expect(ledger.creditCalls).toHaveLength(0);
    expect(store.orphanRefs()).toHaveLength(0);
    expect((await store.getDeposit(ref))?.status).toBe("preregistered");
  });
});

// --- expireStale sweep (EC-29) ----------------------------------------------

describe("expireStale sweeps only past-TTL preregistered refs (EC-29)", () => {
  it("expires the abandoned ref, leaves the fresh + credited refs untouched", async () => {
    const stale = await store.preregister(ACCOUNT, 5_000n); // expires at now + TTL
    const credited = await store.preregister(ACCOUNT, 5_000n);
    await store.observeFinalized(observe({ ref: credited.ref, amount: 5_000n })); // → credited

    // Advance PAST the stale ref's TTL, then register a fresh (still-live) ref.
    clock.now += TTL_MS + 1;
    const fresh = await store.preregister(OTHER, 5_000n);

    const swept = await store.expireStale();
    expect(swept).toBe(1); // only the abandoned preregistered ref.

    expect((await store.getDeposit(stale.ref))?.status).toBe("expired");
    expect((await store.getDeposit(credited.ref))?.status).toBe("credited"); // untouched
    expect((await store.getDeposit(fresh.ref))?.status).toBe("preregistered"); // still live
  });

  it("returns zero when nothing is past its TTL", async () => {
    await store.preregister(ACCOUNT, 5_000n);
    expect(await store.expireStale()).toBe(0);
  });
});

// --- late deposit past TTL still credits (fund safety) ----------------------

describe("a finalized success after TTL expiry still credits (never drop confirmed funds)", () => {
  it("credits a previously-expired ref and logs the late deposit loudly", async () => {
    const { ref } = await store.preregister(ACCOUNT, 5_000n);
    clock.now += TTL_MS + 1;
    expect(await store.expireStale()).toBe(1);
    expect((await store.getDeposit(ref))?.status).toBe("expired");

    // The on-chain deposit finalizes late — confirmed funds are authoritative over the TTL.
    const outcome = asCredited(await store.observeFinalized(observe({ ref, amount: 5_000n })));
    expect(outcome.amount).toBe(5_000n);
    expect(ledger.creditedRefs(ACCOUNT)).toEqual([ref]);
    expect((await store.getDeposit(ref))?.status).toBe("credited");
    expect(logger.messages().some((message) => message.includes("TTL expiry"))).toBe(true);
  });
});

// --- getDeposit lookups -----------------------------------------------------

describe("getDeposit reads the deposit-ref lifecycle status", () => {
  it("returns null for an unknown ref", async () => {
    expect(await store.getDeposit("never-registered")).toBeNull();
  });
});

// --- shipped config defaults are mirrored -----------------------------------

describe("store defaults mirror the shipped config tunables (D45/D47)", () => {
  it("mirrors MINIMUM_DEPOSIT and DEPOSIT_REF_TTL_MS", () => {
    expect(DEFAULT_MINIMUM_DEPOSIT).toBe(1_000n);
    expect(DEFAULT_DEPOSIT_REF_TTL_MS).toBe(3_600_000);
  });

  it("pins the per-deposit mint cap to the contract's Uint<64> limit (2^64-1)", () => {
    expect(MAXIMUM_DEPOSIT).toBe(18_446_744_073_709_551_615n);
    expect(MAXIMUM_DEPOSIT).toBe(2n ** 64n - 1n);
  });
});
