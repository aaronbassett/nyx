/**
 * `CompileResultsInbox` — the server-side rendezvous for browser-delegated compiles
 * (P2 — Task 7).
 *
 * P2 makes the BROWSER the compiler: the server emits `compile:run { turnId, kind }`
 * and the client replies `compile:results` with the same `turnId` + `kind`. This inbox
 * is where the awaiting {@link BrowserCompileClient} and the WS `compile:results` handler
 * meet — a direct mirror of the verify loop's `PendingTestResultsInbox`
 * (`turn/coordinator.ts`), adapted so the key is `(turnId, kind)` (one turn awaits BOTH a
 * per-cycle `check` and a green-only `full`).
 *
 * The load-bearing discipline, all carried from the verify loop:
 *  - **Ownership binding (Defense 4).** Each wait records the `projectId` that OWNS the
 *    turn; a `deliver` whose `deliveringProjectId` does not match is IGNORED and the wait
 *    stays pending, so no foreign socket can force a false verdict or grief the owner —
 *    the owner's own later delivery still resolves it.
 *  - **Bounded, never-hangs (D42).** `register` races the delivery against an injected
 *    `delay`; on timeout it resolves `null` (never rejects). A dead or silent tab is a
 *    failed compile, mapped by the client — never an infinite wait.
 *  - **Leak-free, crash-free.** The wait is removed in a `finally` on BOTH the delivered
 *    and timed-out paths, so the pending map is bounded by concurrently-pending waits.
 *    A late / duplicate / unknown / cross-tenant delivery finds no (owned) wait and is
 *    dropped LOUDLY-as-a-no-op — it never throws and never resolves a stale promise.
 */
import type { CompileKind, CompileResultsPayload } from "@nyx/protocol";

/** One pending `compile:results` wait: the owning project + the resolver for its promise. */
interface PendingCompileWait {
  /** The project that started the turn — the only one authorized to deliver its verdict. */
  readonly projectId: string;
  /** Resolve the awaiting `register` promise (payload on delivery, `null` on timeout). */
  readonly resolve: (payload: CompileResultsPayload | null) => void;
}

/**
 * The server-side wait registry for browser-delegated compiles. `register` awaits one
 * `(turnId, kind)` verdict bounded by a timeout; `deliver` settles it iff the delivering
 * connection owns the turn's project.
 */
export interface CompileResultsInbox {
  /**
   * Await the client's `compile:results` for `(turnId, kind)`, OWNED by `projectId`.
   * Bounded — resolves `null` on timeout (never rejects, no-hang D42). The recorded owner
   * gates {@link CompileResultsInbox.deliver}.
   */
  register(
    turnId: string,
    kind: CompileKind,
    projectId: string,
    timeoutMs: number,
  ): Promise<CompileResultsPayload | null>;
  /**
   * Resolve the pending wait matching `(payload.turnId, payload.kind)`. `deliveringProjectId`
   * is the project the delivering connection is authorized for (`ctx.projectId`): when
   * provided — as the WS handler always does — a delivery whose project does NOT own the
   * wait is IGNORED (Defense 4). Omitted only by trusted in-process callers. A no-op when
   * no wait is pending (late / duplicate / unknown verdict).
   */
  deliver(payload: CompileResultsPayload, deliveringProjectId?: string): void;
}

/** The composite pending-map key. `kind` is a fixed enum prefix, so `${kind}:${turnId}`
 * separates a turn's `check` and `full` waits with no collision. */
function waitKey(turnId: string, kind: CompileKind): string {
  return `${kind}:${turnId}`;
}

/**
 * Build a {@link CompileResultsInbox} over an injected `delay` (real `setTimeout` in
 * production; an advancing/never-resolving stub in tests) so the bounded wait is
 * deterministic with no real timers.
 */
export function createCompileResultsInbox(deps: {
  delay: (ms: number) => Promise<void>;
}): CompileResultsInbox {
  const pending = new Map<string, PendingCompileWait>();

  return {
    register(turnId, kind, projectId, timeoutMs) {
      const key = waitKey(turnId, kind);
      // The wait is recorded SYNCHRONOUSLY (the Promise executor runs now), so a `deliver`
      // that lands immediately after the client's `emitCompileRun` finds it. The owning
      // `projectId` lives ALONGSIDE the resolver so `deliver` can reject a cross-tenant
      // verdict and the ownership is freed with the wait itself (no separate map).
      const delivered = new Promise<CompileResultsPayload | null>((resolve) => {
        pending.set(key, { projectId, resolve });
      });
      // The bounded backstop resolves `null` (never rejects) so a silent tab is a failed
      // compile the client synthesizes, never a hang.
      const timedOut = deps.delay(timeoutMs).then(() => null);
      // The `finally` frees the wait on BOTH paths, so the map is bounded by CONCURRENTLY
      // pending waits, never by completed turns.
      return Promise.race([delivered, timedOut]).finally(() => {
        pending.delete(key);
      });
    },

    deliver(payload, deliveringProjectId) {
      const key = waitKey(payload.turnId, payload.kind);
      const wait = pending.get(key);
      if (wait === undefined) {
        // No waiter (a late, duplicate, or unknown verdict) — drop it, never throw.
        return;
      }
      if (deliveringProjectId !== undefined && wait.projectId !== deliveringProjectId) {
        // Defense 4: the delivering connection is NOT authorized for this turn's project.
        // Leave the wait pending so the OWNER's own later verdict still resolves it.
        return;
      }
      pending.delete(key);
      wait.resolve(payload);
    },
  };
}
