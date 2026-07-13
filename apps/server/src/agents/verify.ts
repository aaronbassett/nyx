/**
 * Verify-cycle accounting + green→full-compile trigger (US4 — the behavioural verify
 * loop).
 *
 * This module is a pure, side-effect-free state machine over injected seams: the
 * accounting PRIMITIVES the US1 agent swarm will later drive per turn. It does NOT
 * own the per-turn orchestration and never compiles or writes R2 — the full compile
 * is a narrow injected seam so the whole module is deterministic with no real
 * orchestrator (constitution III/IV).
 *
 * The decisions it pins:
 *  - D21 — {@link createVerifyBudget} caps a turn at {@link DEFAULT_MAX_CYCLES}
 *    compile-plus-test cycles. On exhaustion the turn ends honestly: the failing
 *    state is summarised with diagnostics, the WIP files stay in the VFS, and a
 *    suggested next prompt is offered. An exhausted budget is real work and IS charged
 *    (no credit-back, D34); unverified code is never presented as done.
 *  - D42 — a run killed at 120s is seen here as just another failing `test:results`.
 *    Accounting is UNIFORM over pass/fail: any failing verdict consumes exactly one
 *    cycle, whether it failed assertions or timed out.
 *  - D35/FR-029 — a green suite (the current cycle's tests pass) is the SOLE trigger
 *    for the full artifacts compile + done-presentation, and {@link createGreenCompileTrigger}
 *    guarantees the full compile fires AT MOST ONCE per successful turn.
 *  - D41 — green requires only that the pass boolean is true; this module never gates
 *    on coverage, suite size, or any mechanical adequacy signal.
 *
 * Everything is deterministic: no wall-clock, no randomness. A fresh turn is a fresh
 * budget (and a fresh trigger); both are single-turn by construction.
 */
import type { CompileOutcome, CompileTurnInput } from "../compile/orchestrator.js";

/** Default per-turn verify-loop budget (D21): at most 3 compile-plus-test cycles. */
export const DEFAULT_MAX_CYCLES = 3;

/**
 * A single behavioural-test failure summarised into the honest exhaustion report
 * (D21). Sourced from the failing `test:results`; kept structural so the caller can
 * render it without re-parsing.
 */
export interface VerifyDiagnostic {
  /** The failing test's name, as reported by the suite. */
  readonly testName: string;
  /** The failure detail (assertion message, or a timeout note for a D42 kill). */
  readonly message: string;
}

/** The context handed to the suggested-next-prompt builder on exhaustion (D21). */
export interface ExhaustionContext {
  /** Cycles spent this turn — equal to `maxCycles` at exhaustion. */
  readonly cyclesUsed: number;
  /** The turn's cycle budget (D21). */
  readonly maxCycles: number;
  /** The final cycle's failing diagnostics. */
  readonly diagnostics: readonly VerifyDiagnostic[];
}

/**
 * The honest failure summary produced when the verify budget is exhausted (D21). The
 * turn ends without ever presenting unverified code as done: the exhausted cycle is
 * real work and is charged, the work-in-progress files stay in the VFS, and a concrete
 * next prompt is offered so the user is never left at a dead end.
 */
export interface ExhaustionSummary {
  /** D21/D34 — an exhausted budget is real work and is charged (no credit-back). */
  readonly charged: true;
  /** D21 — WIP files are kept in the VFS, never discarded on exhaustion. */
  readonly keepWorkInProgress: true;
  /** A deterministic, actionable prompt the user can run next (D21). */
  readonly suggestedNextPrompt: string;
  /** The failing-suite diagnostics summarised for the user (D21). */
  readonly diagnostics: readonly VerifyDiagnostic[];
}

/**
 * The verdict of recording one cycle's `test:results`. A discriminated union the
 * caller switches on: `green` ⇒ run the full compile (D35); `retry-allowed` ⇒ iterate
 * within budget; `exhausted` ⇒ end the turn honestly (D21). A `green` OR an
 * `exhausted` verdict terminally closes the turn.
 */
export type VerifyDecision =
  | {
      /** D35/FR-029 — the suite passed; the SOLE trigger for the full compile. */
      readonly kind: "green";
      readonly cyclesUsed: number;
      readonly cyclesRemaining: number;
    }
  | {
      /** D42 — the suite failed (assertion or timeout) but budget remains; iterate. */
      readonly kind: "retry-allowed";
      readonly cyclesUsed: number;
      readonly cyclesRemaining: number;
    }
  | {
      /** D21 — the suite failed and the budget is spent; the turn ends honestly. */
      readonly kind: "exhausted";
      readonly cyclesUsed: number;
      readonly summary: ExhaustionSummary;
    };

/** How a turn's budget was terminally closed, or `null` while it is still open. */
export type VerifyClosure = "green" | "exhausted" | null;

/**
 * Thrown when a terminally-closed turn's budget is recorded against again. The turn is
 * over (green or exhausted); a new turn requires a fresh {@link VerifyBudget}. Recorded
 * as a loud, clear error rather than a silent no-op so the caller cannot accidentally
 * extend a decided turn.
 */
export class VerifyTurnClosedError extends Error {
  constructor(readonly closedBy: "green" | "exhausted") {
    super(`verify turn already closed (${closedBy}); a new turn requires a fresh budget`);
    this.name = "VerifyTurnClosedError";
  }
}

/** Options for {@link createVerifyBudget}. Deterministic — no clock, no randomness. */
export interface VerifyBudgetOptions {
  /** Max compile-plus-test cycles per turn (D21); default {@link DEFAULT_MAX_CYCLES}. */
  readonly maxCycles?: number;
  /**
   * Overridable, deterministic suggested-next-prompt builder (D21). Defaults to
   * {@link defaultSuggestedNextPrompt}; injectable so the swarm can tailor the honest
   * dead-end guidance without breaking SC-014.
   */
  readonly buildSuggestedNextPrompt?: (context: ExhaustionContext) => string;
}

/**
 * A stateful, single-turn verify budget (D21). Pure accounting over the pass/fail
 * booleans of each cycle's `test:results` — no I/O, no clock, no randomness — so the
 * same sequence of verdicts is byte-identical across fresh budgets (SC-014). A `green`
 * or `exhausted` decision terminally closes the turn; recording again throws.
 */
export interface VerifyBudget {
  /** The turn's cycle budget (D21). */
  readonly maxCycles: number;
  /** Cycles consumed so far this turn. */
  readonly cyclesUsed: number;
  /** Cycles left before exhaustion (never negative). */
  readonly cyclesRemaining: number;
  /** How the turn closed, or `null` while it is still open. */
  readonly closedBy: VerifyClosure;
  /** True once the turn is terminally decided (green or exhausted). */
  readonly isClosed: boolean;
  /**
   * Record one cycle's verdict (D42 — pass/fail is uniform; a timeout is a failing
   * verdict). Increments the cycle count and returns the {@link VerifyDecision}.
   * `diagnostics` (defaulting to none) are folded into the exhaustion summary only.
   * Throws {@link VerifyTurnClosedError} if the turn is already closed.
   */
  recordTestResult(pass: boolean, diagnostics?: readonly VerifyDiagnostic[]): VerifyDecision;
}

/**
 * The default deterministic suggested-next-prompt (D21). Pure over its context so
 * SC-014 holds — no clock, no randomness. Override via
 * {@link VerifyBudgetOptions.buildSuggestedNextPrompt}.
 */
export function defaultSuggestedNextPrompt(context: ExhaustionContext): string {
  const cycles = `${String(context.maxCycles)} verify cycle${context.maxCycles === 1 ? "" : "s"}`;
  const first = context.diagnostics[0];
  const focus =
    first === undefined ? "the failing behaviour" : `the failing test "${first.testName}"`;
  return (
    `The behavioural test suite is still failing after ${cycles}. ` +
    `Ask me to focus the next turn on fixing ${focus}.`
  );
}

/** The single-turn {@link VerifyBudget} implementation (see {@link createVerifyBudget}). */
class TurnVerifyBudget implements VerifyBudget {
  readonly maxCycles: number;
  private used = 0;
  private closure: VerifyClosure = null;
  private readonly buildSuggestedNextPrompt: (context: ExhaustionContext) => string;

  constructor(options: VerifyBudgetOptions) {
    const maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES;
    if (!Number.isInteger(maxCycles) || maxCycles < 1) {
      throw new RangeError(`maxCycles must be a positive integer, got ${String(maxCycles)}`);
    }
    this.maxCycles = maxCycles;
    this.buildSuggestedNextPrompt = options.buildSuggestedNextPrompt ?? defaultSuggestedNextPrompt;
  }

  get cyclesUsed(): number {
    return this.used;
  }

  get cyclesRemaining(): number {
    return this.maxCycles - this.used;
  }

  get closedBy(): VerifyClosure {
    return this.closure;
  }

  get isClosed(): boolean {
    return this.closure !== null;
  }

  recordTestResult(pass: boolean, diagnostics: readonly VerifyDiagnostic[] = []): VerifyDecision {
    if (this.closure !== null) {
      // Guarded: the turn is terminally decided; a fresh budget starts a new turn.
      throw new VerifyTurnClosedError(this.closure);
    }

    this.used += 1;
    const cyclesUsed = this.used;
    const cyclesRemaining = this.maxCycles - cyclesUsed;

    // D35/FR-029/D41 — green (pass boolean only) closes the turn and is the SOLE
    // full-compile trigger; no coverage or suite-size gate is consulted.
    if (pass) {
      this.closure = "green";
      return { kind: "green", cyclesUsed, cyclesRemaining };
    }

    // D42 — a failing verdict (assertion failure OR a 120s-timeout kill) consumes one
    // cycle; while budget remains the caller may iterate.
    if (cyclesRemaining > 0) {
      return { kind: "retry-allowed", cyclesUsed, cyclesRemaining };
    }

    // D21 — budget spent: end the turn honestly — charged, WIP kept, next prompt
    // offered. Copy the diagnostics so the summary never aliases the caller's array.
    this.closure = "exhausted";
    const frozenDiagnostics: readonly VerifyDiagnostic[] = [...diagnostics];
    const summary: ExhaustionSummary = {
      charged: true,
      keepWorkInProgress: true,
      suggestedNextPrompt: this.buildSuggestedNextPrompt({
        cyclesUsed,
        maxCycles: this.maxCycles,
        diagnostics: frozenDiagnostics,
      }),
      diagnostics: frozenDiagnostics,
    };
    return { kind: "exhausted", cyclesUsed, summary };
  }
}

/**
 * Create a fresh per-turn verify budget (D21). Default cap is {@link DEFAULT_MAX_CYCLES};
 * `maxCycles` and the suggested-next-prompt builder are injectable.
 */
export function createVerifyBudget(options: VerifyBudgetOptions = {}): VerifyBudget {
  return new TurnVerifyBudget(options);
}

/** The outcome of asking the trigger to run the full compile for a decision (D35). */
export type FullCompileTriggerResult =
  /** Green + first request: the full compile ran; its outcome is returned. */
  | { readonly kind: "compiled"; readonly outcome: CompileOutcome }
  /** Green but the full compile already ran this turn — the at-most-once guard fired. */
  | { readonly kind: "already-compiled" }
  /** Not a green decision — a failing verdict is never presented as done, so no compile. */
  | { readonly kind: "not-green" };

/** Injected dependencies for {@link createGreenCompileTrigger}. */
export interface GreenCompileTriggerDeps {
  /**
   * The full-compile seam (D35): proving keys, zkir, manifest→R2, and the single
   * `artifacts:ready`. Bound later to US2's `ArtifactOrchestrator.runTurn`; fully
   * injected here so the trigger stays deterministic and side-effect-free in tests.
   */
  readonly runFullCompile: (input: CompileTurnInput) => Promise<CompileOutcome>;
}

/**
 * A single-turn latch guaranteeing the full compile runs AT MOST ONCE (D35): the full
 * artifacts build + `artifacts:ready` fire only on a green decision and never twice,
 * even if green is signalled more than once. A fresh turn requires a fresh trigger.
 */
export interface GreenCompileTrigger {
  /** True once the full compile has been invoked this turn. */
  readonly hasCompiled: boolean;
  /**
   * Run the full compile iff `decision` is green AND it has not already run this turn.
   * A non-green decision never fires it (a failing verdict is never done work). Returns
   * a marker distinguishing a fresh compile, the at-most-once guard, and a non-green
   * decision — never a silent no-op.
   */
  triggerOnGreen(
    decision: VerifyDecision,
    input: CompileTurnInput,
  ): Promise<FullCompileTriggerResult>;
}

/** The single-turn {@link GreenCompileTrigger} implementation. */
class OnceGreenCompileTrigger implements GreenCompileTrigger {
  private compiled = false;
  private readonly runFullCompile: (input: CompileTurnInput) => Promise<CompileOutcome>;

  constructor(deps: GreenCompileTriggerDeps) {
    this.runFullCompile = deps.runFullCompile;
  }

  get hasCompiled(): boolean {
    return this.compiled;
  }

  async triggerOnGreen(
    decision: VerifyDecision,
    input: CompileTurnInput,
  ): Promise<FullCompileTriggerResult> {
    // D35 — only green triggers the full compile; a failing verdict never does.
    if (decision.kind !== "green") {
      return { kind: "not-green" };
    }
    // At-most-once — latch synchronously BEFORE awaiting so a double green signal can
    // never race the seam into a second invocation.
    if (this.compiled) {
      return { kind: "already-compiled" };
    }
    this.compiled = true;
    const outcome = await this.runFullCompile(input);
    return { kind: "compiled", outcome };
  }
}

/** Create a fresh per-turn green→full-compile trigger (D35, at-most-once). */
export function createGreenCompileTrigger(deps: GreenCompileTriggerDeps): GreenCompileTrigger {
  return new OnceGreenCompileTrigger(deps);
}
