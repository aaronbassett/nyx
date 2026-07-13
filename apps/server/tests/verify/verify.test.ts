/**
 * Verify-cycle accounting tests (US4 — the behavioural verify loop).
 *
 * These drive the pure {@link createVerifyBudget} state machine and the injectable
 * {@link createGreenCompileTrigger} directly (no swarm, no real Compile Service, no
 * R2) to pin the decisions this module owns:
 *  - D21 — at most 3 compile-plus-test cycles per turn; on exhaustion the turn ends
 *    honestly (charged, WIP kept, a suggested next prompt) and unverified code is
 *    never presented as done;
 *  - D42 — any failing verdict (including a 120s-timeout kill) consumes exactly one
 *    cycle; accounting is uniform over pass/fail;
 *  - D35/FR-029 — a green suite is the SOLE trigger for the full compile, which fires
 *    AT MOST ONCE per successful turn;
 *  - D41 — green acts purely on the pass boolean; no coverage/suite-size gate;
 *  - SC-014 — the same sequence of verdicts is byte-identical across fresh budgets.
 */
import { describe, expect, it } from "vitest";
import {
  createGreenCompileTrigger,
  createVerifyBudget,
  DEFAULT_MAX_CYCLES,
  defaultSuggestedNextPrompt,
  VerifyTurnClosedError,
} from "../../src/agents/verify.js";
import type { VerifyDecision, VerifyDiagnostic } from "../../src/agents/verify.js";
import type { CompileOutcome, CompileTurnInput } from "../../src/compile/index.js";

/** A stub green terminal outcome (kind:"ready") — no real orchestrator or R2. */
const READY_OUTCOME: CompileOutcome = {
  kind: "ready",
  urlPrefix: "https://r2.nyx.test/proj-1/abc123",
  reused: false,
  compilerVersion: "0.24.0",
  circuits: [{ name: "increment", proof: true }],
  announced: true,
  telemetry: {
    compilerVersion: "0.24.0",
    checkLatencyMs: 5,
    checkDurationMs: 4,
    progress: [],
  },
};

/** A turn's full-compile input — the seam is fully injected, so `files` can be empty. */
const COMPILE_INPUT: CompileTurnInput = {
  projectId: "proj-1",
  files: [],
  changedPaths: ["src/counter.compact"],
};

/** A deterministic failing-suite diagnostic carried into the exhaustion summary. */
const DIAGNOSTICS: readonly VerifyDiagnostic[] = [
  { testName: "increments the counter", message: "expected 1, received 0" },
];

/** A recording full-compile seam — deterministic, asserts invocation count. */
function makeFakeCompile(outcome: CompileOutcome = READY_OUTCOME): {
  readonly runFullCompile: (input: CompileTurnInput) => Promise<CompileOutcome>;
  readonly calls: CompileTurnInput[];
} {
  const calls: CompileTurnInput[] = [];
  return {
    runFullCompile: (input) => {
      calls.push(input);
      return Promise.resolve(outcome);
    },
    calls,
  };
}

describe("VerifyBudget — D21: three failing cycles exhaust the budget honestly", () => {
  it("charges the turn, keeps WIP, and offers a next prompt on the third failing result", () => {
    const budget = createVerifyBudget();
    expect(budget.maxCycles).toBe(DEFAULT_MAX_CYCLES);

    const first = budget.recordTestResult(false);
    expect(first).toEqual({ kind: "retry-allowed", cyclesUsed: 1, cyclesRemaining: 2 });

    const second = budget.recordTestResult(false);
    expect(second).toEqual({ kind: "retry-allowed", cyclesUsed: 2, cyclesRemaining: 1 });

    const third = budget.recordTestResult(false, DIAGNOSTICS);
    if (third.kind !== "exhausted") {
      throw new Error(`expected exhausted, got ${third.kind}`);
    }
    expect(third.cyclesUsed).toBe(3);
    expect(third.summary.charged).toBe(true);
    expect(third.summary.keepWorkInProgress).toBe(true);
    expect(third.summary.suggestedNextPrompt.length).toBeGreaterThan(0);
    expect(third.summary.diagnostics).toEqual(DIAGNOSTICS);

    // Unverified-never-done: the closed turn is exhausted, never green.
    expect(budget.closedBy).toBe("exhausted");
    expect(budget.isClosed).toBe(true);
    expect(budget.cyclesRemaining).toBe(0);
  });
});

describe("VerifyBudget — D35/FR-029: a green result is the sole full-compile trigger", () => {
  it("returns green even on cycle 1 (D41 — acts purely on the pass boolean)", () => {
    const budget = createVerifyBudget();
    const decision = budget.recordTestResult(true);
    expect(decision).toEqual({ kind: "green", cyclesUsed: 1, cyclesRemaining: 2 });
    expect(budget.closedBy).toBe("green");
  });

  it("triggers runFullCompile on green and NEVER on a failing verdict", async () => {
    const fake = makeFakeCompile();
    const trigger = createGreenCompileTrigger({ runFullCompile: fake.runFullCompile });

    const failing: VerifyDecision = { kind: "retry-allowed", cyclesUsed: 1, cyclesRemaining: 2 };
    const failResult = await trigger.triggerOnGreen(failing, COMPILE_INPUT);
    expect(failResult.kind).toBe("not-green");
    expect(fake.calls).toHaveLength(0);

    const green: VerifyDecision = { kind: "green", cyclesUsed: 1, cyclesRemaining: 2 };
    const greenResult = await trigger.triggerOnGreen(green, COMPILE_INPUT);
    if (greenResult.kind !== "compiled") {
      throw new Error(`expected compiled, got ${greenResult.kind}`);
    }
    expect(greenResult.outcome.kind).toBe("ready");
    expect(fake.calls).toEqual([COMPILE_INPUT]);
  });

  it("never triggers runFullCompile for an exhausted decision", async () => {
    const fake = makeFakeCompile();
    const trigger = createGreenCompileTrigger({ runFullCompile: fake.runFullCompile });
    const exhausted: VerifyDecision = {
      kind: "exhausted",
      cyclesUsed: 3,
      summary: {
        charged: true,
        keepWorkInProgress: true,
        suggestedNextPrompt: "try again",
        diagnostics: [],
      },
    };

    const result = await trigger.triggerOnGreen(exhausted, COMPILE_INPUT);
    expect(result.kind).toBe("not-green");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("GreenCompileTrigger — D35: the full compile fires at most once per turn", () => {
  it("invokes runFullCompile once even when green is signalled twice", async () => {
    const fake = makeFakeCompile();
    const trigger = createGreenCompileTrigger({ runFullCompile: fake.runFullCompile });
    const green: VerifyDecision = { kind: "green", cyclesUsed: 1, cyclesRemaining: 2 };

    const firstCall = await trigger.triggerOnGreen(green, COMPILE_INPUT);
    const secondCall = await trigger.triggerOnGreen(green, COMPILE_INPUT);

    expect(firstCall.kind).toBe("compiled");
    expect(secondCall.kind).toBe("already-compiled");
    expect(fake.calls).toHaveLength(1);
    expect(trigger.hasCompiled).toBe(true);
  });
});

describe("VerifyBudget — the turn is terminally guarded once decided", () => {
  it("throws when recording after an exhausted turn (never reports done)", () => {
    const budget = createVerifyBudget({ maxCycles: 1 });
    const decision = budget.recordTestResult(false);
    expect(decision.kind).toBe("exhausted");
    expect(() => budget.recordTestResult(false)).toThrow(VerifyTurnClosedError);
    expect(budget.closedBy).toBe("exhausted");
  });

  it("throws when recording after a green turn (the turn is over)", () => {
    const budget = createVerifyBudget();
    budget.recordTestResult(true);
    expect(() => budget.recordTestResult(true)).toThrow(VerifyTurnClosedError);
  });
});

describe("VerifyBudget — SC-014: identical verdict sequences are byte-identical", () => {
  it("produces byte-identical decisions across 100 fresh budgets (fail→fail→fail)", () => {
    const run = (): readonly VerifyDecision[] => {
      const budget = createVerifyBudget();
      return [
        budget.recordTestResult(false),
        budget.recordTestResult(false),
        budget.recordTestResult(false, DIAGNOSTICS),
      ];
    };
    const baseline = JSON.stringify(run());
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(run())).toBe(baseline);
    }
  });

  it("is byte-identical for a green-terminating sequence too (fail→pass)", () => {
    const run = (): VerifyDecision => {
      const budget = createVerifyBudget();
      budget.recordTestResult(false);
      return budget.recordTestResult(true);
    };
    const baseline = JSON.stringify(run());
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(run())).toBe(baseline);
    }
  });
});

describe("VerifyBudget — configuration is injectable", () => {
  it("honors an injected maxCycles (D21 default is overridable)", () => {
    const budget = createVerifyBudget({ maxCycles: 2 });
    expect(budget.recordTestResult(false).kind).toBe("retry-allowed");
    expect(budget.recordTestResult(false).kind).toBe("exhausted");
  });

  it("uses an overridable suggested-next-prompt builder", () => {
    const budget = createVerifyBudget({
      maxCycles: 1,
      buildSuggestedNextPrompt: (context) => `retry:${String(context.cyclesUsed)}`,
    });
    const decision = budget.recordTestResult(false);
    if (decision.kind !== "exhausted") {
      throw new Error(`expected exhausted, got ${decision.kind}`);
    }
    expect(decision.summary.suggestedNextPrompt).toBe("retry:1");
  });

  it("rejects a non-positive maxCycles at construction", () => {
    expect(() => createVerifyBudget({ maxCycles: 0 })).toThrow(RangeError);
  });

  it("has a deterministic default prompt that names the cycle budget", () => {
    const context = { cyclesUsed: 3, maxCycles: 3, diagnostics: DIAGNOSTICS };
    const prompt = defaultSuggestedNextPrompt(context);
    expect(prompt).toContain("3 verify cycles");
    expect(prompt).toBe(defaultSuggestedNextPrompt(context));
  });
});
