/**
 * Daily reconcile scheduler (T175, US10) — the config-cadence driver (D56/FR-066) for the
 * background {@link ReconcileJob}. STRICTLY off every user-facing path (SC-039): the scheduler
 * is armed once at boot from {@link index.ts} and never reachable from a request handler.
 *
 * Each tick resolves a CANONICAL watermark ({@link FinalizedWatermarkSource}) and runs one
 * reconcile. `runReconcile` returns typed results for every EXPECTED condition
 * (skip/drift/blocked/burn-failure), so a tick only ever throws on an unexpected store/source
 * fault — which is caught, reported to `onError`, and NEVER allowed to escape (a failed tick
 * must not kill the scheduler; the next cadence still fires, EC-48's "run skipped and
 * rescheduled"). The timer is injected ({@link ReconcileSchedulerDeps.schedule}) so the cadence
 * is deterministic in tests; production defaults to `setTimeout`.
 *
 * LIVENESS under scale-to-zero (constitution VI — `min_machines_running = 0`). The first tick
 * after boot is scheduled from the ELAPSED time since the last recorded run
 * ({@link ReconcileSchedulerDeps.lastRunAt}), not a fresh full cadence — otherwise a machine
 * that restarts (deploy, scale-to-zero wake) before a full uninterrupted `cadenceMs` window
 * would reset its countdown every time and the "daily" job might silently NEVER fire. This is
 * best-effort: a truly-asleep machine cannot fire an in-process timer, so a hard daily
 * guarantee ultimately needs an EXTERNAL trigger (a Fly scheduled machine / cron hitting a
 * one-shot) — owner-gated deployment wiring. The elapsed-catch-up makes any warm instance run
 * as soon as it is overdue.
 *
 * The scheduler IS started at boot ({@link index.ts}); today the owner-gated `watermarkSource`
 * rejects each tick, so it simply logs a `tick-error` per cadence (the honest "armed but gated"
 * state) — the job's on-chain seams are never even reached until the chain adapter lands.
 */
import type { ReconcileJob, ReconcileResult } from "./reconcile.js";

/**
 * Resolves the CANONICAL watermark to reconcile as of (EC-50). A NARROW owner-gated seam
 * (constitution I — NOT an `@midnight-ntwrk/*` type). Load-bearing CONTRACT for exactly-once
 * (SC-037): the returned watermark MUST be a canonical per-reconcile-PERIOD key — IDENTICAL
 * across concurrent instances for the same period, and STABLE across ticks until that period is
 * cleanly reconciled — derived from a FINALIZED chain position, never wall-clock now. It MUST
 * NOT be a live per-instance chain cursor (two instances a block apart would burn the same
 * delta under different watermarks, defeating the on-chain dedup — the C1 double-burn). Rejects
 * when the chain cursor is unavailable, which the tick treats as a skip-worthy fault.
 */
export type FinalizedWatermarkSource = () => Promise<string>;

/** Cancels a pending scheduled tick. Returned by {@link ReconcileSchedulerDeps.schedule}. */
export type CancelScheduled = () => void;

/** Construction deps for {@link createReconcileScheduler}. */
export interface ReconcileSchedulerDeps {
  readonly job: ReconcileJob;
  /** Cadence in ms between ticks (D56 — `config.tunables.reconcileCadenceMs`). */
  readonly cadenceMs: number;
  /** The canonical-watermark source (owner-gated). */
  readonly watermarkSource: FinalizedWatermarkSource;
  /**
   * Timer seam: schedule `fn` after `ms`, returning a canceller. Injected for determinism;
   * defaults to `setTimeout`/`clearTimeout`.
   */
  readonly schedule?: (fn: () => void, ms: number) => CancelScheduled;
  /**
   * Epoch-ms of the last recorded run (liveness catch-up under scale-to-zero), or `null` if
   * none. When present, the FIRST post-boot tick is scheduled at
   * `max(firstTickMinDelayMs, cadenceMs − (now − lastRunAt))`. Omit to always wait a full
   * cadence (the naive countdown). Owner-gated: wire it to `store.lastReconciled().ranAt`.
   */
  readonly lastRunAt?: () => Promise<number | null>;
  /** Clock for the elapsed-catch-up calc; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Floor for the first-tick delay (never fire instantly on boot); defaults to 60s. */
  readonly firstTickMinDelayMs?: number;
  /** Called with each tick's typed result (telemetry). */
  readonly onResult?: (result: ReconcileResult) => void;
  /** Called when a tick faults unexpectedly (source/store error) — never rethrown. */
  readonly onError?: (error: unknown) => void;
}

/** A started/stoppable daily reconcile scheduler. */
export interface ReconcileScheduler {
  /** Arm the first tick (idempotent — a second `start` while running is a no-op). */
  start(): void;
  /** Cancel any pending tick and stop rescheduling (idempotent). */
  stop(): void;
}

/** Default first-tick floor (60s) — a never-run reconcile fires soon after boot, not instantly. */
export const DEFAULT_FIRST_TICK_MIN_DELAY_MS = 60_000;

/** Default timer seam over Node's `setTimeout`. */
function defaultSchedule(fn: () => void, ms: number): CancelScheduled {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * Build the daily reconcile scheduler. Ticks are serial (the next is armed only after the
 * current completes). A `generation` counter, bumped on every `stop()`, invalidates any
 * in-flight tick's re-arm and any pending first-tick computation, so a `stop()`→`start()`
 * cannot leave two timers armed (the M3 double-arm).
 */
export function createReconcileScheduler(deps: ReconcileSchedulerDeps): ReconcileScheduler {
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? Date.now;
  const firstTickMinDelayMs = deps.firstTickMinDelayMs ?? DEFAULT_FIRST_TICK_MIN_DELAY_MS;
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
      const watermark = await deps.watermarkSource();
      const result = await deps.job.runReconcile(watermark);
      deps.onResult?.(result);
    } catch (error) {
      // A source/store fault must NOT kill the schedule — report and carry on (EC-48).
      deps.onError?.(error);
    } finally {
      // Reschedule at a full cadence — but only if this tick still belongs to the live
      // generation (a `stop()` mid-tick bumps the generation and suppresses the re-arm).
      armAfter(gen, deps.cadenceMs);
    }
  }

  /** Elapsed-catch-up first-tick delay (liveness under scale-to-zero). */
  async function firstDelay(): Promise<number> {
    if (deps.lastRunAt === undefined) {
      return deps.cadenceMs;
    }
    const last = await deps.lastRunAt();
    if (last === null) {
      return firstTickMinDelayMs;
    }
    const remaining = deps.cadenceMs - (now() - last);
    return Math.max(firstTickMinDelayMs, remaining);
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      const gen = generation;
      // Compute the first-tick delay asynchronously (it may read the store), then arm — but
      // only if this generation is still live (a stop() before it resolves invalidates it).
      firstDelay()
        .then((delayMs) => {
          armAfter(gen, delayMs);
        })
        .catch(() => {
          // A lastRunAt read failure falls back to a full cadence — never blocks startup.
          armAfter(gen, deps.cadenceMs);
        });
    },
    stop(): void {
      running = false;
      generation += 1;
      clearPending();
    },
  };
}
