/**
 * US6 (T124, D34/D37/D62) — NYXT top-up flow.
 *
 * Drives the pure `useTopUp` state machine and the `TopUpView` presenter with
 * injected fakes: a `DepositClient` (REST), a `DepositCeremony` (OWNER-GATED SDK
 * tx-build + Lace sign + prover-proxy proving — faked here), a `DepositSubscription`
 * (the `ledger:update` seam, driven synchronously), and a controllable clock. No
 * real network, wallet, timers, or browser — the whole one-deposit lifecycle
 * (amount → preregister → ceremony → pending → credited | failed | expired) is
 * exercised from data, mirroring the US5 `connect.test.ts` / container-test style.
 *
 * Balances are asserted to come verbatim from the server payload, never computed
 * in-component (FR-070).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  CreateDepositResponse,
  DepositRef,
  DepositStatusResponse,
  LedgerUpdatePayload,
  MidnightAddress,
} from "@nyx/protocol";

import {
  formatElapsed,
  parseAmountInput,
  TopUp,
  topUpReducer,
  TopUpView,
  useTopUp,
} from "@/wallet/topup";
import type {
  CeremonyResult,
  DepositCeremony,
  DepositClient,
  DepositSubscription,
  DepositUpdate,
  DepositUpdateListener,
  TopUpClock,
  TopUpState,
  UseTopUpOptions,
} from "@/wallet/topup";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// --- fixtures ----------------------------------------------------------------

const REF = "deposit-ref-1" as DepositRef;
const ADDR = "mn_addr_1" as MidnightAddress;
const FAR_FUTURE = 10_000_000;

const noop = (): void => {
  /* no-op */
};

/** A server `ledger:update` crediting the tracked deposit (FR-070 balances). */
function creditUpdate(amount: bigint, available: bigint, reserved: bigint): LedgerUpdatePayload {
  return {
    entry: { id: 1n, accountAddress: ADDR, kind: "deposit_credit", amount, ref: "deposit-ref-1" },
    available,
    reserved,
  };
}

interface HarnessConfig {
  readonly expiresAt?: number;
  readonly status?: DepositStatusResponse;
  readonly ceremony?: DepositCeremony["runCeremony"];
  readonly minimumAmount?: bigint;
  readonly pollIntervalMs?: number;
  readonly tickIntervalMs?: number;
  readonly startNow?: number;
}

interface Harness {
  readonly options: UseTopUpOptions;
  readonly createDeposit: ReturnType<typeof vi.fn>;
  readonly getDepositStatus: ReturnType<typeof vi.fn>;
  readonly runCeremony: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  emit(update: DepositUpdate): void;
  setNow(now: number): void;
}

/** Build the injected seams for one top-up flow, with sane, overridable defaults. */
function makeHarness(config: HarnessConfig = {}): Harness {
  let now = config.startNow ?? 1000;
  const clock: TopUpClock = { now: () => now };

  const created: CreateDepositResponse = {
    depositRef: REF,
    expiresAt: config.expiresAt ?? FAR_FUTURE,
  };
  const createDeposit = vi.fn(() => Promise.resolve(created));
  const status: DepositStatusResponse = config.status ?? { status: "seen" };
  const getDepositStatus = vi.fn(() => Promise.resolve(status));
  const client: DepositClient = { createDeposit, getDepositStatus };

  const runCeremony = vi.fn(config.ceremony ?? (() => Promise.resolve({ txRef: "tx-1" })));
  const ceremony: DepositCeremony = { runCeremony };

  let listener: DepositUpdateListener = () => {
    /* replaced on subscribe */
  };
  const unsubscribe = vi.fn((): void => {
    listener = () => {
      /* detached */
    };
  });
  const subscribe = vi.fn((ref: DepositRef, onUpdate: DepositUpdateListener): (() => void) => {
    listener = onUpdate;
    return unsubscribe;
  });
  const subscription: DepositSubscription = { subscribe };

  const options: UseTopUpOptions = {
    client,
    ceremony,
    subscription,
    minimumAmount: config.minimumAmount ?? 100n,
    clock,
    pollIntervalMs: config.pollIntervalMs ?? 5000,
    tickIntervalMs: config.tickIntervalMs ?? 1000,
  };

  return {
    options,
    createDeposit,
    getDepositStatus,
    runCeremony,
    subscribe,
    unsubscribe,
    emit: (update: DepositUpdate) => {
      listener(update);
    },
    setNow: (next: number) => {
      now = next;
    },
  };
}

// --- pure helpers ------------------------------------------------------------

describe("parseAmountInput", () => {
  it("parses a positive integer string to a bigint", () => {
    expect(parseAmountInput("500")).toBe(500n);
    expect(parseAmountInput("  1000 ")).toBe(1000n);
  });

  it("rejects empty, non-numeric, and non-positive input", () => {
    expect(parseAmountInput("")).toBeUndefined();
    expect(parseAmountInput("abc")).toBeUndefined();
    expect(parseAmountInput("1.5")).toBeUndefined();
    expect(parseAmountInput("-5")).toBeUndefined();
    expect(parseAmountInput("0")).toBeUndefined();
  });
});

describe("formatElapsed", () => {
  it("renders seconds under a minute and m/s beyond", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(3000)).toBe("3s");
    expect(formatElapsed(65000)).toBe("1m 5s");
  });
});

// --- state machine (useTopUp) ------------------------------------------------

describe("useTopUp — one-deposit state machine", () => {
  it("happy path: amount → preregister → ceremony → pending → ledger:update credited", async () => {
    const h = makeHarness();
    const { result } = renderHook(() => useTopUp(h.options));

    expect(result.current.state.phase).toBe("idle");

    await act(async () => {
      await result.current.submit(500n);
    });

    // preregistered with the entered amount, ceremony ran, now pending.
    expect(h.createDeposit).toHaveBeenCalledWith(500n);
    expect(h.runCeremony).toHaveBeenCalledWith({ depositRef: REF, amount: 500n });
    expect(result.current.state.phase).toBe("pending");
    if (result.current.state.phase === "pending") {
      expect(result.current.state.txRef).toBe("tx-1");
      expect(result.current.state.elapsedMs).toBe(0);
    }

    // Credit observed via the ledger:update seam.
    act(() => {
      h.emit({ kind: "credited", ledger: creditUpdate(500n, 777n, 88n) });
    });

    const state = result.current.state;
    expect(state.phase).toBe("credited");
    if (state.phase === "credited") {
      expect(state.ledger?.creditedAmount).toBe(500n);
    }
  });

  it("below-minimum amount → validation error, no createDeposit call", async () => {
    const h = makeHarness({ minimumAmount: 100n });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(50n);
    });

    expect(h.createDeposit).not.toHaveBeenCalled();
    const state = result.current.state;
    expect(state.phase).toBe("idle");
    if (state.phase === "idle") {
      expect(state.validationError).toMatch(/minimum/i);
    }
  });

  it("ceremony rejects (user cancels / proving fails) → actionable error, never pending", async () => {
    const h = makeHarness({ ceremony: () => Promise.reject(new Error("user declined")) });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });

    // Preregister still happened, but there is no false "pending".
    expect(h.createDeposit).toHaveBeenCalledOnce();
    const state = result.current.state;
    expect(state.phase).toBe("error");
    if (state.phase === "error") {
      expect(state.reason).toBe("ceremony-rejected");
    }
  });

  it("on-chain FAILURE via the ledger seam → failed state with diagnostics", async () => {
    const h = makeHarness();
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    act(() => {
      h.emit({ kind: "failed", detail: "reverted: insufficient funds" });
    });

    const state = result.current.state;
    expect(state.phase).toBe("failed");
    if (state.phase === "failed") {
      expect(state.detail).toMatch(/reverted/);
    }
  });

  it("credited via POLLING fallback (getDepositStatus → 'credited') when no WS event arrives", async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      status: { status: "credited", txRef: "tx-poll" },
      pollIntervalMs: 100,
    });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const state = result.current.state;
    expect(state.phase).toBe("credited");
    if (state.phase === "credited") {
      expect(state.txRef).toBe("tx-poll");
      // The poll carries no balance — the hook must NOT fabricate one (FR-070).
      expect(state.ledger).toBeUndefined();
    }
  });

  it("TTL expiry: clock advances past expiresAt while pending → expired with retry", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ expiresAt: 5000, startNow: 1000, tickIntervalMs: 100 });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    h.setNow(6000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.state.phase).toBe("expired");
  });

  it("TTL expiry: status poll returns 'expired' → expired", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ status: { status: "expired" }, pollIntervalMs: 100 });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.state.phase).toBe("expired");
  });

  it("pending reflects elapsed time from the injected clock (EC-53)", async () => {
    vi.useFakeTimers();
    const h = makeHarness({ startNow: 1000, tickIntervalMs: 1000, pollIntervalMs: 100000 });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    h.setNow(4000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const state = result.current.state;
    expect(state.phase).toBe("pending");
    if (state.phase === "pending") {
      expect(state.elapsedMs).toBe(3000);
    }
  });

  it("balances are display-only: credited ledger fields equal the server payload verbatim", async () => {
    const h = makeHarness();
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    act(() => {
      h.emit({ kind: "credited", ledger: creditUpdate(500n, 777n, 88n) });
    });

    const state = result.current.state;
    expect(state.phase).toBe("credited");
    if (state.phase === "credited") {
      expect(state.ledger).toEqual({ creditedAmount: 500n, available: 777n, reserved: 88n });
    }
  });

  it("reset() returns a terminal state to idle for a retry", async () => {
    const h = makeHarness({ ceremony: () => Promise.reject(new Error("nope")) });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("error");

    act(() => {
      result.current.reset();
    });
    expect(result.current.state.phase).toBe("idle");
  });

  it("M1: poll credit shows the requested amount, then a late ledger:update upgrades to server balances", async () => {
    vi.useFakeTimers();
    // The 5s status poll credits FIRST (carries no balance); the authoritative
    // ledger:update lands LATE with a DIFFERENT amount (EC-28: on-chain ≠ requested).
    const h = makeHarness({
      status: { status: "credited", txRef: "tx-poll" },
      pollIntervalMs: 100,
    });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    // Poll credits with no server ledger → credited-without-ledger (shows "Requested").
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const afterPoll = result.current.state;
    expect(afterPoll.phase).toBe("credited");
    if (afterPoll.phase === "credited") {
      expect(afterPoll.ledger).toBeUndefined();
      expect(afterPoll.amount).toBe(500n); // the client-entered figure, never server truth
    }

    // The late authoritative ledger:update (server credited 480, not the requested
    // 500) must UPGRADE the state to the server-derived balances (FR-070).
    act(() => {
      h.emit({ kind: "credited", ledger: creditUpdate(480n, 980n, 20n) });
    });
    const afterLedger = result.current.state;
    expect(afterLedger.phase).toBe("credited");
    if (afterLedger.phase === "credited") {
      expect(afterLedger.ledger).toEqual({ creditedAmount: 480n, available: 980n, reserved: 20n });
    }
  });

  it("L3: two synchronous submit() calls in one tick start only ONE ceremony", async () => {
    const h = makeHarness();
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      // Both fire in the SAME tick, before React commits the first phase change —
      // the render-time phase guard alone would let both through.
      const first = result.current.submit(500n);
      const second = result.current.submit(500n);
      await Promise.all([first, second]);
    });

    expect(h.createDeposit).toHaveBeenCalledTimes(1);
    expect(h.runCeremony).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("pending");
  });
});

// --- finalizing: a SUBMITTED deposit that outlived its TTL keeps watching ------

describe("useTopUp — finalizing (submitted deposit past TTL keeps its credit watch)", () => {
  it("finalizing then ledger:update: the subscription stays alive and the late credit lands with server balances", async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      expiresAt: 5000,
      startNow: 1000,
      tickIntervalMs: 100,
      pollIntervalMs: 100000,
    });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    // Clock crosses the TTL while pending (tx already submitted) → finalizing, NOT
    // a terminal retry: the state stays `expired` but carries the submitted txRef.
    h.setNow(6000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const finalizing = result.current.state;
    expect(finalizing.phase).toBe("expired");
    if (finalizing.phase === "expired") {
      expect(finalizing.txRef).toBe("tx-1");
    }

    // The submitted tx credits late (server credits even an expired ref). Because
    // the subscription was NOT torn down at expiry, the credit is observed and
    // upgrades finalizing → credited with the authoritative server balances.
    act(() => {
      h.emit({ kind: "credited", ledger: creditUpdate(500n, 777n, 88n) });
    });
    const credited = result.current.state;
    expect(credited.phase).toBe("credited");
    if (credited.phase === "credited") {
      expect(credited.ledger).toEqual({ creditedAmount: 500n, available: 777n, reserved: 88n });
      expect(credited.txRef).toBe("tx-1");
    }
  });

  it("finalizing then poll 'credited': the status poll stays alive and also upgrades to credited", async () => {
    vi.useFakeTimers();
    // The fast tick trips the TTL FIRST (finalizing); the slower poll then returns
    // 'credited' while finalizing — the poll must still be running to observe it.
    const h = makeHarness({
      status: { status: "credited", txRef: "tx-poll" },
      expiresAt: 2000,
      startNow: 1000,
      tickIntervalMs: 100,
      pollIntervalMs: 5000,
    });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");

    // Past TTL via the fast tick → finalizing (the 5s poll has not fired yet).
    h.setNow(3000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.state.phase).toBe("expired");

    // The still-running poll fires in the finalizing state and observes the credit.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const credited = result.current.state;
    expect(credited.phase).toBe("credited");
    if (credited.phase === "credited") {
      // The poll carries no balance → "Requested" fallback (M1); never fabricated.
      expect(credited.ledger).toBeUndefined();
      expect(credited.txRef).toBe("tx-poll");
    }
  });

  it("keeps a SINGLE ledger subscription across pending → finalizing → credited (no leak, balanced teardown)", async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      expiresAt: 5000,
      startNow: 1000,
      tickIntervalMs: 100,
      pollIntervalMs: 100000,
    });
    const { result } = renderHook(() => useTopUp(h.options));

    await act(async () => {
      await result.current.submit(500n);
    });
    expect(result.current.state.phase).toBe("pending");
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).not.toHaveBeenCalled();

    // pending → finalizing tracks the SAME deposit ref: no re-subscribe, no teardown.
    h.setNow(6000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.state.phase).toBe("expired");
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).not.toHaveBeenCalled();

    // finalizing → credited (with ledger): the single watcher is torn down once.
    act(() => {
      h.emit({ kind: "credited", ledger: creditUpdate(500n, 777n, 88n) });
    });
    expect(result.current.state.phase).toBe("credited");
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("pre-submission: no ledger subscription or status poll is armed until a tx is submitted (watchers are pending-gated)", async () => {
    let resolveCeremony: (ceremonyResult: CeremonyResult) => void = () => {
      /* set when the ceremony runs */
    };
    const h = makeHarness({
      ceremony: () =>
        new Promise<CeremonyResult>((resolve) => {
          resolveCeremony = resolve;
        }),
    });
    const { result } = renderHook(() => useTopUp(h.options));

    const pending: Promise<void>[] = [];
    await act(async () => {
      pending.push(result.current.submit(500n));
      await Promise.resolve();
    });

    // Parked in awaiting-signature (ceremony pending): nothing submitted yet, so no
    // watcher is armed — the subscription and status poll are pending-gated. A
    // pre-submission expiry is therefore terminal, with nothing to tear down.
    await waitFor(() => {
      expect(result.current.state.phase).toBe("awaiting-signature");
    });
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.getDepositStatus).not.toHaveBeenCalled();

    // Completing the ceremony reaches pending — only NOW is a watcher armed.
    await act(async () => {
      resolveCeremony({ txRef: "tx-1" });
      await Promise.all(pending);
    });
    expect(result.current.state.phase).toBe("pending");
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });
});

// --- reducer edge cases (M1 upgrade / no-downgrade, M2 expiry discrimination) --

describe("topUpReducer — credit upgrade & expiry provenance", () => {
  it("M1: a late credited-ledger upgrades a poll-credited state (no ledger) to server balances", () => {
    const pollCredited: TopUpState = {
      phase: "credited",
      amount: 500n,
      depositRef: REF,
      txRef: "tx-poll",
    };
    const next = topUpReducer(pollCredited, {
      type: "credited-ledger",
      ledger: creditUpdate(480n, 980n, 20n),
    });
    expect(next.phase).toBe("credited");
    if (next.phase === "credited") {
      expect(next.ledger).toEqual({ creditedAmount: 480n, available: 980n, reserved: 20n });
      expect(next.txRef).toBe("tx-poll");
    }
  });

  it("M1: a credited-ledger never DOWNGRADES a credited-with-ledger state", () => {
    const credited: TopUpState = {
      phase: "credited",
      amount: 500n,
      depositRef: REF,
      txRef: "tx-1",
      ledger: { creditedAmount: 500n, available: 777n, reserved: 88n },
    };
    const next = topUpReducer(credited, {
      type: "credited-ledger",
      ledger: creditUpdate(999n, 111n, 22n),
    });
    expect(next).toBe(credited); // unchanged — the authoritative ledger already landed
  });

  it("M2: expiry from pending carries the submitted txRef (in-flight tx may still credit)", () => {
    const pending: TopUpState = {
      phase: "pending",
      amount: 500n,
      depositRef: REF,
      expiresAt: FAR_FUTURE,
      txRef: "tx-1",
      startedAt: 1000,
      elapsedMs: 0,
    };
    const next = topUpReducer(pending, { type: "expired" });
    expect(next.phase).toBe("expired");
    if (next.phase === "expired") {
      expect(next.txRef).toBe("tx-1");
    }
  });

  it("M2: expiry from awaiting-signature carries NO txRef (nothing submitted → safe retry)", () => {
    const awaiting: TopUpState = {
      phase: "awaiting-signature",
      amount: 500n,
      depositRef: REF,
      expiresAt: FAR_FUTURE,
    };
    const next = topUpReducer(awaiting, { type: "expired" });
    expect(next.phase).toBe("expired");
    if (next.phase === "expired") {
      expect(next.txRef).toBeUndefined();
    }
  });
});

// --- presenter (TopUpView) ---------------------------------------------------

describe("TopUpView — per-state rendering", () => {
  it("idle: renders the amount form and submits the parsed bigint amount", () => {
    const onSubmit = vi.fn();
    render(
      <TopUpView
        state={{ phase: "idle" }}
        minimumAmount={100n}
        onSubmit={onSubmit}
        onReset={noop}
      />,
    );
    fireEvent.change(screen.getByTestId("topup-amount"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /top up/i }));
    expect(onSubmit).toHaveBeenCalledWith(500n);
  });

  it("idle: surfaces a validation error from the state", () => {
    render(
      <TopUpView
        state={{ phase: "idle", validationError: "Minimum top-up is 100 NYXT." }}
        minimumAmount={100n}
        onSubmit={noop}
        onReset={noop}
      />,
    );
    expect(screen.getByTestId("topup-validation-error").textContent).toMatch(/minimum/i);
  });

  it("pending: shows a pending panel with elapsed time", () => {
    const state: TopUpState = {
      phase: "pending",
      amount: 500n,
      depositRef: REF,
      expiresAt: FAR_FUTURE,
      txRef: "tx-1",
      startedAt: 1000,
      elapsedMs: 3000,
    };
    render(<TopUpView state={state} minimumAmount={100n} onSubmit={noop} onReset={noop} />);
    const panel = screen.getByTestId("topup-pending");
    expect(panel.textContent).toMatch(/pending/i);
    expect(panel.textContent).toMatch(/3s/);
  });

  it("credited: shows the credited amount and the server balance", () => {
    const state: TopUpState = {
      phase: "credited",
      amount: 500n,
      depositRef: REF,
      txRef: "tx-1",
      ledger: { creditedAmount: 500n, available: 777n, reserved: 88n },
    };
    render(<TopUpView state={state} minimumAmount={100n} onSubmit={noop} onReset={noop} />);
    const panel = screen.getByTestId("topup-credited");
    expect(panel.textContent).toMatch(/500/);
    expect(panel.textContent).toMatch(/777/);
  });

  it("M1: credited via poll (no ledger) labels the client amount 'Requested', never 'Deposited'", () => {
    const state: TopUpState = {
      phase: "credited",
      amount: 500n,
      depositRef: REF,
      txRef: "tx-poll",
    };
    render(<TopUpView state={state} minimumAmount={100n} onSubmit={noop} onReset={noop} />);
    const panel = screen.getByTestId("topup-credited");
    expect(panel.textContent).toMatch(/Requested/);
    expect(panel.textContent).not.toMatch(/Deposited/);
    expect(panel.textContent).toMatch(/500/);
  });

  it("failed: shows diagnostics and a retry that fires onReset", () => {
    const onReset = vi.fn();
    const state: TopUpState = {
      phase: "failed",
      amount: 500n,
      depositRef: REF,
      detail: "reverted: gas",
    };
    render(<TopUpView state={state} minimumAmount={100n} onSubmit={noop} onReset={onReset} />);
    expect(screen.getByTestId("topup-failed").textContent).toMatch(/reverted: gas/);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("expired: shows a retry affordance that fires onReset (EC-29)", () => {
    const onReset = vi.fn();
    const state: TopUpState = { phase: "expired", amount: 500n, depositRef: REF };
    render(<TopUpView state={state} minimumAmount={100n} onSubmit={noop} onReset={onReset} />);
    expect(screen.getByTestId("topup-expired")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("M2: expired AFTER submission (txRef present) shows the finalizing state with NO retry CTA", () => {
    const onReset = vi.fn();
    const state: TopUpState = { phase: "expired", amount: 500n, depositRef: REF, txRef: "tx-1" };
    render(<TopUpView state={state} minimumAmount={100n} onSubmit={noop} onReset={onReset} />);
    expect(screen.getByTestId("topup-expired-finalizing")).not.toBeNull();
    // The safe-retry panel and its CTA must be absent — re-submitting risks a double deposit.
    expect(screen.queryByTestId("topup-expired")).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.getByTestId("topup-expired-finalizing").textContent).toMatch(/tx-1/);
    expect(onReset).not.toHaveBeenCalled();
  });
});

// --- container (TopUp) -------------------------------------------------------

describe("TopUp — container wiring", () => {
  it("drives the full flow through the DOM: form → pending → credited", async () => {
    const h = makeHarness();
    render(<TopUp {...h.options} />);

    fireEvent.change(screen.getByTestId("topup-amount"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /top up/i }));

    await waitFor(() => {
      expect(screen.getByTestId("topup-pending")).not.toBeNull();
    });

    act(() => {
      h.emit({ kind: "credited", ledger: creditUpdate(500n, 777n, 88n) });
    });

    expect(screen.getByTestId("topup-credited")).not.toBeNull();
  });
});
