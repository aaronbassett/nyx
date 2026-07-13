/**
 * NYXT ledger store contract tests (T120, US6) — deterministic, in-memory, NO Postgres.
 *
 * These drive an {@link InMemoryLedgerStore} (defined here) through the shared
 * {@link LedgerStore} interface to pin the reserve-then-settle metering semantics US6
 * depends on (D34):
 *  - reserve moves `available → reserved` by exactly the flat reserve;
 *  - settle writes the `reserve_release` + `settlement` PAIR atomically at ACTUAL
 *    consumption, netting `available -= actual` and `reserved → 0` (scenario 4);
 *  - SC-023: the balance invariant `available + reserved = Σdeposit_credit − Σsettlement`
 *    holds after every operation of a mixed sequence (property-style);
 *  - D34 overage: `actual > available` drives `available` NEGATIVE (never clamped), and
 *    the next `placeReserve` is REJECTED until a `creditDeposit` restores headroom;
 *  - D25: a declined turn writes NO ledger entries (declined-never-charged);
 *  - exactly-once: `creditDeposit` is idempotent by `ref`;
 *  - SC-003: the settlement entry's `created_at` sits within 60s of the turn-end
 *    timestamp, asserted deterministically via the INJECTED clock;
 *  - the `reserve_release` + `settlement` pair is atomic — a fault mid-settle rolls back
 *    BOTH (in-memory fault hook; the Pg impl proves the same via one transaction).
 *
 * The in-memory double models `ledger_entries` + `turns` with an injected clock and a
 * snapshot/restore transaction (mirroring Postgres ROLLBACK), and reuses the REAL
 * {@link foldBalance} so a balance derived here is byte-for-byte comparable with the SQL
 * fold the Postgres store computes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LedgerEntryKind } from "@nyx/protocol";
import {
  DEFAULT_FLAT_RESERVE,
  foldBalance,
  InsufficientAvailableError,
  InvalidTurnStateError,
  NonPositiveAmountError,
  TurnNotFoundError,
} from "../../src/ledger/ledger.js";
import type {
  Balance,
  LedgerEntryRecord,
  LedgerStore,
  Turn,
  TurnStatus,
} from "../../src/ledger/ledger.js";

const ACCOUNT = "midnight-account-address";
const PROJECT = "project-1";
const MINUTE_MS = 60_000;

// --- In-memory double -------------------------------------------------------

/** Mutable clock the store reads, so tests can advance time deterministically. */
interface Clock {
  now: number;
}

/** Mutable turn row modelling the `turns` table. */
interface TurnRecord {
  id: string;
  projectId: string;
  status: TurnStatus;
  cyclesUsed: number;
  reserveEntry: bigint | null;
  settleEntry: bigint | null;
  startedAt: number;
  endedAt: number | null;
}

function toTurn(record: TurnRecord): Turn {
  return {
    id: record.id,
    projectId: record.projectId,
    status: record.status,
    cyclesUsed: record.cyclesUsed,
    reserveEntry: record.reserveEntry,
    settleEntry: record.settleEntry,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

/**
 * In-memory {@link LedgerStore} modelling the Postgres semantics with an injected
 * clock. Every mutation that must be all-or-nothing runs inside {@link transaction},
 * which snapshots and restores on throw — so the injected mid-settle fault leaves the
 * previous consistent balance intact (atomic reserve_release + settlement).
 */
class InMemoryLedgerStore implements LedgerStore {
  private entries: LedgerEntryRecord[] = [];
  private turns = new Map<string, TurnRecord>();
  private nextEntryId = 1n;
  private turnSeq = 0;
  private faultSettleAfterRelease = false;

  constructor(
    private readonly clock: () => number,
    private readonly flatReserve: bigint = DEFAULT_FLAT_RESERVE,
  ) {}

  /** Arm a one-shot fault that throws AFTER the reserve_release but BEFORE the settlement. */
  failNextSettleAfterRelease(): void {
    this.faultSettleAfterRelease = true;
  }

  private now(): number {
    return this.clock();
  }

  private entriesFor(address: string): LedgerEntryRecord[] {
    return this.entries.filter((entry) => entry.accountAddress === address);
  }

  private append(
    address: string,
    kind: LedgerEntryKind,
    amount: bigint,
    ref: string | null,
  ): LedgerEntryRecord {
    const entry: LedgerEntryRecord = {
      id: this.nextEntryId,
      accountAddress: address,
      kind,
      amount,
      ref,
      createdAt: this.now(),
    };
    this.nextEntryId += 1n;
    this.entries.push(entry);
    return entry;
  }

  // Snapshot/restore transaction: mirrors Postgres ROLLBACK so a mid-settle fault
  // rewinds the entries AND the turn mutation together (append-only pair atomicity).
  private transaction<T>(fn: () => T): T {
    const snapshot = {
      entries: [...this.entries],
      turns: new Map([...this.turns].map(([id, record]) => [id, { ...record }] as const)),
      nextEntryId: this.nextEntryId,
    };
    try {
      return fn();
    } catch (error) {
      this.entries = snapshot.entries;
      this.turns = snapshot.turns;
      this.nextEntryId = snapshot.nextEntryId;
      throw error;
    }
  }

  openTurn(projectId: string): Promise<Turn> {
    this.turnSeq += 1;
    const record: TurnRecord = {
      id: `turn-${String(this.turnSeq)}`,
      projectId,
      status: "classifying",
      cyclesUsed: 0,
      reserveEntry: null,
      settleEntry: null,
      startedAt: this.now(),
      endedAt: null,
    };
    this.turns.set(record.id, record);
    return Promise.resolve(toTurn(record));
  }

  getTurn(turnId: string): Promise<Turn | null> {
    const record = this.turns.get(turnId);
    return Promise.resolve(record === undefined ? null : toTurn(record));
  }

  creditDeposit(address: string, ref: string, amount: bigint): Promise<Balance> {
    if (amount <= 0n) {
      return Promise.reject(new NonPositiveAmountError("amount", amount));
    }
    // Idempotent by ref: a second finalized observation of the same deposit is a no-op.
    const already = this.entries.some(
      (entry) => entry.kind === "deposit_credit" && entry.ref === ref,
    );
    if (!already) {
      this.append(address, "deposit_credit", amount, ref);
    }
    return this.getBalance(address);
  }

  placeReserve(
    address: string,
    turnId: string,
    flatReserve: bigint = this.flatReserve,
  ): Promise<Balance> {
    if (flatReserve <= 0n) {
      return Promise.reject(new NonPositiveAmountError("flatReserve", flatReserve));
    }
    try {
      const balance = this.transaction<Balance>(() => {
        const turn = this.turns.get(turnId);
        if (turn === undefined) {
          throw new TurnNotFoundError(turnId);
        }
        if (turn.status !== "classifying") {
          throw new InvalidTurnStateError(turnId, turn.status, ["classifying"]);
        }
        // Pre-turn GATE (D34/EC-01): a new reserve requires available ≥ flatReserve.
        const available = foldBalance(this.entriesFor(address)).available;
        if (available < flatReserve) {
          throw new InsufficientAvailableError(address, available, flatReserve);
        }
        const entry = this.append(address, "reserve", flatReserve, turnId);
        turn.status = "reserved";
        turn.reserveEntry = entry.id;
        return foldBalance(this.entriesFor(address));
      });
      return Promise.resolve(balance);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  settle(address: string, turnId: string, actualConsumption: bigint): Promise<Balance> {
    if (actualConsumption <= 0n) {
      return Promise.reject(new NonPositiveAmountError("actualConsumption", actualConsumption));
    }
    try {
      const balance = this.transaction<Balance>(() => {
        const turn = this.turns.get(turnId);
        if (turn === undefined) {
          throw new TurnNotFoundError(turnId);
        }
        if (turn.status !== "reserved" && turn.status !== "running") {
          throw new InvalidTurnStateError(turnId, turn.status, ["reserved", "running"]);
        }
        if (turn.reserveEntry === null) {
          throw new InvalidTurnStateError(turnId, turn.status, ["reserved", "running"]);
        }
        // Release the FULL reserve that was placed for THIS turn (looked up, not re-derived).
        const reserveEntryId = turn.reserveEntry;
        const reserved = this.entries.find((entry) => entry.id === reserveEntryId);
        if (reserved === undefined) {
          throw new Error(`reserve entry missing for turn ${turnId}`);
        }
        // One clock read drives BOTH the settlement entry AND the turn-end stamp so the
        // settlement always lands within 0ms (≤ 60s) of turn-end (SC-003).
        const settledAt = this.now();
        this.appendAt(address, "reserve_release", reserved.amount, turnId, settledAt);
        if (this.faultSettleAfterRelease) {
          this.faultSettleAfterRelease = false;
          throw new Error("injected mid-settle fault");
        }
        const settlement = this.appendAt(
          address,
          "settlement",
          actualConsumption,
          turnId,
          settledAt,
        );
        turn.status = "settled";
        turn.settleEntry = settlement.id;
        turn.endedAt = settledAt;
        return foldBalance(this.entriesFor(address));
      });
      return Promise.resolve(balance);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Append at an explicit timestamp (settle drives release + settlement at one instant).
  private appendAt(
    address: string,
    kind: LedgerEntryKind,
    amount: bigint,
    ref: string | null,
    createdAt: number,
  ): LedgerEntryRecord {
    const entry: LedgerEntryRecord = {
      id: this.nextEntryId,
      accountAddress: address,
      kind,
      amount,
      ref,
      createdAt,
    };
    this.nextEntryId += 1n;
    this.entries.push(entry);
    return entry;
  }

  decline(turnId: string): Promise<Turn> {
    const turn = this.turns.get(turnId);
    if (turn === undefined) {
      return Promise.reject(new TurnNotFoundError(turnId));
    }
    if (turn.status !== "classifying") {
      return Promise.reject(new InvalidTurnStateError(turnId, turn.status, ["classifying"]));
    }
    // D25: a declined turn is charged NOTHING — no ledger entries, no reserve/settle links.
    turn.status = "declined";
    turn.endedAt = this.now();
    return Promise.resolve(toTurn(turn));
  }

  getBalance(address: string): Promise<Balance> {
    return Promise.resolve(foldBalance(this.entriesFor(address)));
  }

  getEntries(address: string): Promise<LedgerEntryRecord[]> {
    return Promise.resolve([...this.entriesFor(address)].sort((a, b) => Number(a.id - b.id)));
  }
}

// --- Helpers ----------------------------------------------------------------

let clock: Clock;
let store: InMemoryLedgerStore;

beforeEach(() => {
  clock = { now: 1_000_000 };
  store = new InMemoryLedgerStore(() => clock.now);
});

/** Σdeposit_credit − Σsettlement — the RHS of the SC-023 invariant, from the log. */
function creditsMinusSettlements(entries: readonly LedgerEntryRecord[]): bigint {
  let credits = 0n;
  let settlements = 0n;
  for (const entry of entries) {
    if (entry.kind === "deposit_credit") {
      credits += entry.amount;
    } else if (entry.kind === "settlement") {
      settlements += entry.amount;
    }
  }
  return credits - settlements;
}

/** Assert SC-023: available + reserved = credits − settlements, holds by construction. */
async function assertInvariant(address: string): Promise<void> {
  const balance = await store.getBalance(address);
  const entries = await store.getEntries(address);
  expect(balance.available + balance.reserved).toBe(creditsMinusSettlements(entries));
}

// --- foldBalance (the pure fold, FR-070) ------------------------------------

describe("foldBalance — the pure balance fold (FR-070/SC-023)", () => {
  it("derives available and reserved from the signed-by-kind entry log", () => {
    const balance = foldBalance([
      { kind: "deposit_credit", amount: 1_000n },
      { kind: "reserve", amount: 100n },
      { kind: "reserve_release", amount: 100n },
      { kind: "settlement", amount: 250n },
      { kind: "reserve", amount: 100n },
    ]);
    // reserved = Σreserve − Σreserve_release = 200 − 100 = 100.
    expect(balance.reserved).toBe(100n);
    // available = Σdc − Σreserve + Σreserve_release − Σsettlement = 1000 − 200 + 100 − 250 = 650.
    expect(balance.available).toBe(650n);
    // Invariant: available + reserved = credits − settlements = 1000 − 250 = 750.
    expect(balance.available + balance.reserved).toBe(750n);
  });

  it("returns a zero balance for an empty log", () => {
    expect(foldBalance([])).toEqual({ available: 0n, reserved: 0n });
  });
});

// --- reserve → settle happy path (scenario 4) -------------------------------

describe("reserve then settle at actual (D34 scenario 4)", () => {
  it("moves available→reserved by exactly the flat reserve, then nets available -= actual", async () => {
    await store.creditDeposit(ACCOUNT, "deposit-1", 1_000n);
    const turn = await store.openTurn(PROJECT);

    const afterReserve = await store.placeReserve(ACCOUNT, turn.id, 100n);
    // Reserve moves 100 out of available and into reserved — exactly the flat reserve.
    expect(afterReserve).toEqual({ available: 900n, reserved: 100n });
    const reserved = await store.getTurn(turn.id);
    expect(reserved?.status).toBe("reserved");
    expect(reserved?.reserveEntry).not.toBeNull();

    const afterSettle = await store.settle(ACCOUNT, turn.id, 250n);
    // Settle at ACTUAL: available -= actual (1000 − 250), reserved → 0.
    expect(afterSettle).toEqual({ available: 750n, reserved: 0n });

    const settled = await store.getTurn(turn.id);
    expect(settled?.status).toBe("settled");
    expect(settled?.settleEntry).not.toBeNull();

    // The settle wrote the reserve_release + settlement PAIR (scenario 4's "one atomic entry").
    const entries = await store.getEntries(ACCOUNT);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "deposit_credit",
      "reserve",
      "reserve_release",
      "settlement",
    ]);
    await assertInvariant(ACCOUNT);
  });

  it("uses the configured flat reserve when no per-call amount is given", async () => {
    const configured = new InMemoryLedgerStore(() => clock.now, 300n);
    await configured.creditDeposit(ACCOUNT, "deposit-1", 1_000n);
    const turn = await configured.openTurn(PROJECT);
    const afterReserve = await configured.placeReserve(ACCOUNT, turn.id);
    expect(afterReserve).toEqual({ available: 700n, reserved: 300n });
  });
});

// --- SC-023 invariant over a mixed sequence ---------------------------------

describe("SC-023 invariant holds after every operation (property-style)", () => {
  it("keeps available + reserved = credits − settlements across a mixed sequence", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    await assertInvariant(ACCOUNT);

    const t1 = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, t1.id, 100n);
    await assertInvariant(ACCOUNT);

    await store.settle(ACCOUNT, t1.id, 250n);
    await assertInvariant(ACCOUNT);

    await store.creditDeposit(ACCOUNT, "d2", 50n);
    await assertInvariant(ACCOUNT);

    const t2 = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, t2.id, 100n);
    await assertInvariant(ACCOUNT);

    await store.settle(ACCOUNT, t2.id, 400n);
    await assertInvariant(ACCOUNT);

    const finalBalance = await store.getBalance(ACCOUNT);
    // credits 1050 − settlements 650 = 400; reserved back to 0.
    expect(finalBalance).toEqual({ available: 400n, reserved: 0n });
  });
});

// --- Overage / negative balance (D34, no clamp, no credit-back) -------------

describe("overage drives available negative and blocks the next reserve (D34)", () => {
  it("does NOT clamp on overage and rejects the next reserve until topped up", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 100n);
    const t1 = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, t1.id, 100n);

    // Actual exceeds available: available goes negative, NOT clamped to zero (no credit-back).
    const afterSettle = await store.settle(ACCOUNT, t1.id, 300n);
    expect(afterSettle).toEqual({ available: -200n, reserved: 0n });
    await assertInvariant(ACCOUNT);

    // The negative balance blocks a new reserve (available −200 < flatReserve 100).
    const t2 = await store.openTurn(PROJECT);
    await expect(store.placeReserve(ACCOUNT, t2.id, 100n)).rejects.toBeInstanceOf(
      InsufficientAvailableError,
    );
    // The rejected reserve left the turn untouched (still classifying, no entry).
    expect((await store.getTurn(t2.id))?.status).toBe("classifying");

    // Topping up restores headroom; the SAME turn can now reserve.
    await store.creditDeposit(ACCOUNT, "d2", 400n);
    const afterReserve = await store.placeReserve(ACCOUNT, t2.id, 100n);
    expect(afterReserve).toEqual({ available: 100n, reserved: 100n });
    await assertInvariant(ACCOUNT);
  });
});

// --- Declined turns are never charged (D25) ---------------------------------

describe("declined turns place nothing (D25)", () => {
  it("marks the turn declined with no ledger entries and no reserve/settle links", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    const turn = await store.openTurn(PROJECT);

    const declined = await store.decline(turn.id);
    expect(declined.status).toBe("declined");
    // declined-never-charged invariant: neither link is ever set.
    expect(declined.reserveEntry).toBeNull();
    expect(declined.settleEntry).toBeNull();

    // The deposit is the ONLY entry — the decline wrote nothing.
    const entries = await store.getEntries(ACCOUNT);
    expect(entries.map((entry) => entry.kind)).toEqual(["deposit_credit"]);
    expect(await store.getBalance(ACCOUNT)).toEqual({ available: 1_000n, reserved: 0n });
  });

  it("refuses to decline a turn that has already reserved", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    const turn = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, turn.id, 100n);
    await expect(store.decline(turn.id)).rejects.toBeInstanceOf(InvalidTurnStateError);
  });
});

// --- creditDeposit idempotency (exactly-once) -------------------------------

describe("creditDeposit is idempotent by ref (exactly-once)", () => {
  it("credits once even when the same ref is observed twice", async () => {
    const first = await store.creditDeposit(ACCOUNT, "deposit-42", 500n);
    expect(first).toEqual({ available: 500n, reserved: 0n });

    // A second finalized observation of the SAME deposit ref must not double-credit.
    const second = await store.creditDeposit(ACCOUNT, "deposit-42", 500n);
    expect(second).toEqual({ available: 500n, reserved: 0n });

    const entries = await store.getEntries(ACCOUNT);
    expect(entries.filter((entry) => entry.kind === "deposit_credit")).toHaveLength(1);
  });

  it("rejects a non-positive deposit amount with a named error", async () => {
    await expect(store.creditDeposit(ACCOUNT, "d0", 0n)).rejects.toBeInstanceOf(
      NonPositiveAmountError,
    );
  });
});

// --- SC-003 settlement latency (structural, via injected clock) -------------

describe("SC-003 settlement latency is within 60s of turn-end", () => {
  it("stamps the settlement entry within 60s of the turn-end timestamp", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    const turn = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, turn.id, 100n);

    // Advance the clock to simulate the turn running, THEN settle — both the turn-end
    // stamp and the settlement entry are driven by the same injected clock read.
    clock.now += 5_000;
    await store.settle(ACCOUNT, turn.id, 250n);

    const settled = await store.getTurn(turn.id);
    const entries = await store.getEntries(ACCOUNT);
    const settlement = entries.find((entry) => entry.kind === "settlement");
    if (settlement === undefined || settled?.endedAt === undefined || settled.endedAt === null) {
      throw new Error("expected a settled turn with a settlement entry");
    }
    // Structural latency assertion: |settlement.createdAt − turn.endedAt| ≤ 60s.
    expect(Math.abs(settlement.createdAt - settled.endedAt)).toBeLessThanOrEqual(MINUTE_MS);
  });
});

// --- Atomic reserve_release + settlement (rollback both) --------------------

describe("the reserve_release + settlement pair is atomic", () => {
  it("rolls back BOTH when a fault strikes mid-settle, leaving the reserve intact", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    const turn = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, turn.id, 100n);
    const beforeSettle = await store.getBalance(ACCOUNT);
    expect(beforeSettle).toEqual({ available: 900n, reserved: 100n });

    store.failNextSettleAfterRelease();
    await expect(store.settle(ACCOUNT, turn.id, 250n)).rejects.toThrow(/mid-settle fault/);

    // Neither the reserve_release nor the settlement survived — the reserve still stands.
    const entries = await store.getEntries(ACCOUNT);
    expect(entries.map((entry) => entry.kind)).toEqual(["deposit_credit", "reserve"]);
    expect(await store.getBalance(ACCOUNT)).toEqual({ available: 900n, reserved: 100n });
    expect((await store.getTurn(turn.id))?.status).toBe("reserved");

    // A subsequent settle succeeds cleanly — the failed attempt left no residue.
    const afterSettle = await store.settle(ACCOUNT, turn.id, 250n);
    expect(afterSettle).toEqual({ available: 750n, reserved: 0n });
    await assertInvariant(ACCOUNT);
  });
});

// --- Turn-state + amount guards ---------------------------------------------

describe("turn-state and amount guards reject with named errors", () => {
  it("rejects a reserve on a missing turn", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    await expect(store.placeReserve(ACCOUNT, "nope", 100n)).rejects.toBeInstanceOf(
      TurnNotFoundError,
    );
  });

  it("rejects a second reserve on the same turn", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    const turn = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, turn.id, 100n);
    await expect(store.placeReserve(ACCOUNT, turn.id, 100n)).rejects.toBeInstanceOf(
      InvalidTurnStateError,
    );
  });

  it("rejects settling a turn that never reserved", async () => {
    const turn = await store.openTurn(PROJECT);
    await expect(store.settle(ACCOUNT, turn.id, 250n)).rejects.toBeInstanceOf(
      InvalidTurnStateError,
    );
  });

  it("rejects a non-positive settlement amount", async () => {
    await store.creditDeposit(ACCOUNT, "d1", 1_000n);
    const turn = await store.openTurn(PROJECT);
    await store.placeReserve(ACCOUNT, turn.id, 100n);
    await expect(store.settle(ACCOUNT, turn.id, 0n)).rejects.toBeInstanceOf(NonPositiveAmountError);
  });
});
