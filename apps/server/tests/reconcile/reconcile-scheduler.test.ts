/**
 * Deterministic reconcile-scheduler tests (T175, US10) — the daily-cadence driver over an
 * injected timer seam. Proves: a tick resolves a canonical watermark and runs one reconcile;
 * ticks are rescheduled; a faulting watermark source / reconcile is reported and SURVIVED (the
 * schedule is never killed, EC-48); `stop()` cancels + halts rescheduling; `start()` is
 * idempotent; a `stop()`→`start()` cannot double-arm (M3); and the first post-boot tick is
 * scheduled from the elapsed-since-last-run (liveness catch-up under scale-to-zero, P).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createReconcileScheduler,
  type CancelScheduled,
} from "../../src/ledger/reconcile-scheduler.js";
import type { ReconcileJob, ReconcileResult } from "../../src/ledger/reconcile.js";

/** A hand-driven timer seam (closures — no `this`): captures the pending tick + its delay. */
interface FakeTimer {
  readonly schedule: (fn: () => void, ms: number) => CancelScheduled;
  readonly armed: () => boolean;
  readonly cancelled: () => number;
  readonly lastDelay: () => number | null;
  /** Fire the pending tick and let its async body (source → reconcile → re-arm) settle. */
  readonly fire: () => Promise<void>;
}

/** A macrotask flush — drains the async `start()` (which reads lastRunAt before arming). */
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

const RECONCILED: ReconcileResult = {
  kind: "reconciled",
  watermark: "wm",
  snapshot: {
    ledgerCredits: 0n,
    ledgerSettlements: 0n,
    onchainDepositTotal: 0n,
    vaultBalance: 0n,
  },
  burnAmount: 0n,
  burnTx: null,
  drift: 0n,
};

function fakeJob(impl?: ReconcileJob["runReconcile"]): ReconcileJob {
  return { runReconcile: vi.fn(impl ?? (() => Promise.resolve(RECONCILED))) };
}

describe("createReconcileScheduler", () => {
  it("runs one reconcile per tick with the canonical watermark, then reschedules", async () => {
    const timer = makeFakeTimer();
    const job = fakeJob();
    const results: ReconcileResult[] = [];
    const scheduler = createReconcileScheduler({
      job,
      cadenceMs: 86_400_000,
      watermarkSource: () => Promise.resolve("canonical-period"),
      schedule: timer.schedule,
      onResult: (r) => results.push(r),
    });

    scheduler.start();
    await settle(); // the async start() reads lastRunAt (absent → cadence) then arms
    expect(timer.armed()).toBe(true);

    await timer.fire();
    expect(job.runReconcile).toHaveBeenCalledWith("canonical-period");
    expect(results).toHaveLength(1);
    expect(timer.armed()).toBe(true); // rescheduled

    await timer.fire();
    expect(job.runReconcile).toHaveBeenCalledTimes(2);
  });

  it("survives a faulting watermark source and keeps rescheduling (EC-48)", async () => {
    const timer = makeFakeTimer();
    const job = fakeJob();
    const errors: unknown[] = [];
    const scheduler = createReconcileScheduler({
      job,
      cadenceMs: 1_000,
      watermarkSource: () => Promise.reject(new Error("chain cursor unavailable")),
      schedule: timer.schedule,
      onError: (e) => errors.push(e),
    });

    scheduler.start();
    await settle();
    await timer.fire();
    expect(errors).toHaveLength(1);
    expect(job.runReconcile).not.toHaveBeenCalled(); // never reached the reconcile
    expect(timer.armed()).toBe(true); // schedule NOT killed
  });

  it("survives an unexpectedly-throwing reconcile", async () => {
    const timer = makeFakeTimer();
    const job = fakeJob(() => Promise.reject(new Error("store down")));
    const errors: unknown[] = [];
    const scheduler = createReconcileScheduler({
      job,
      cadenceMs: 1_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
      onError: (e) => errors.push(e),
    });

    scheduler.start();
    await settle();
    await timer.fire();
    expect(errors).toHaveLength(1);
    expect(timer.armed()).toBe(true);
  });

  it("stops: cancels the pending tick and halts rescheduling", async () => {
    const timer = makeFakeTimer();
    const scheduler = createReconcileScheduler({
      job: fakeJob(),
      cadenceMs: 1_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
    });

    scheduler.start();
    await settle();
    expect(timer.armed()).toBe(true);
    scheduler.stop();
    expect(timer.armed()).toBe(false);
    expect(timer.cancelled()).toBe(1);
  });

  it("does not reschedule when stopped mid-tick", async () => {
    const timer = makeFakeTimer();
    // A holder lets the in-flight tick call stop() without a forward `let` (prefer-const).
    const holder: { scheduler?: ReturnType<typeof createReconcileScheduler> } = {};
    const job = fakeJob(() => {
      holder.scheduler?.stop(); // stop arrives while the reconcile is in flight
      return Promise.resolve(RECONCILED);
    });
    const scheduler = createReconcileScheduler({
      job,
      cadenceMs: 1_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
    });
    holder.scheduler = scheduler;

    scheduler.start();
    await settle();
    await timer.fire();
    expect(job.runReconcile).toHaveBeenCalledTimes(1);
    expect(timer.armed()).toBe(false); // the finally-block re-arm is suppressed by stop()
  });

  it("does not double-arm on stop() then start() (M3)", async () => {
    const timer = makeFakeTimer();
    const scheduler = createReconcileScheduler({
      job: fakeJob(),
      cadenceMs: 1_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
    });

    scheduler.start();
    await settle();
    scheduler.stop();
    scheduler.start();
    await settle();
    // Exactly one live timer — a stale generation cannot leave a second armed.
    expect(timer.armed()).toBe(true);
    scheduler.stop();
    expect(timer.armed()).toBe(false);
  });

  it("start() is idempotent (no double-arm)", async () => {
    const timer = makeFakeTimer();
    const scheduler = createReconcileScheduler({
      job: fakeJob(),
      cadenceMs: 1_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
    });
    scheduler.start();
    scheduler.start(); // second start is a no-op
    await settle();
    scheduler.stop();
    expect(timer.cancelled()).toBe(1); // only one armed handle existed
  });

  it("liveness (P): schedules the first tick from elapsed since the last run", async () => {
    const timer = makeFakeTimer();
    const scheduler = createReconcileScheduler({
      job: fakeJob(),
      cadenceMs: 100_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
      now: () => 1_000_000,
      lastRunAt: () => Promise.resolve(1_000_000 - 80_000), // ran 80s ago
      firstTickMinDelayMs: 1_000,
    });

    scheduler.start();
    await settle();
    // cadence 100s − elapsed 80s = 20s remaining (not a fresh full 100s).
    expect(timer.lastDelay()).toBe(20_000);
  });

  it("liveness (P): an overdue run is scheduled at the min delay, not a negative/zero", async () => {
    const timer = makeFakeTimer();
    const scheduler = createReconcileScheduler({
      job: fakeJob(),
      cadenceMs: 100_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
      now: () => 1_000_000,
      lastRunAt: () => Promise.resolve(1_000_000 - 250_000), // 2.5 cadences ago → overdue
      firstTickMinDelayMs: 1_000,
    });

    scheduler.start();
    await settle();
    expect(timer.lastDelay()).toBe(1_000); // floored, runs soon
  });

  it("liveness (P): a never-run job schedules the first tick at the min delay", async () => {
    const timer = makeFakeTimer();
    const scheduler = createReconcileScheduler({
      job: fakeJob(),
      cadenceMs: 100_000,
      watermarkSource: () => Promise.resolve("wm"),
      schedule: timer.schedule,
      lastRunAt: () => Promise.resolve(null),
      firstTickMinDelayMs: 5_000,
    });

    scheduler.start();
    await settle();
    expect(timer.lastDelay()).toBe(5_000);
    // Subsequent ticks are a full cadence apart.
    await timer.fire();
    expect(timer.lastDelay()).toBe(100_000);
  });
});
