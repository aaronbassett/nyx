/**
 * Planning sub-agent tests (US1 — T140, D3/FR-002) — deterministic, no real model,
 * no real MCP.
 *
 * These pin {@link createPlanningAgent} against a {@link MockLanguageModelV4} and a
 * fake mnm/tome retrieval client, proving:
 *  - the agent GROUNDS in retrieval (mnm/MNE) before it plans (D3/constitution I) —
 *    the `retrieve` tool wraps `mnm.call` and is invoked during the run;
 *  - the typed {@link Output} plan is mapped onto the {@link SubAgentWork} seam
 *    (`files` + `narration` + `activity`), with tokens summed from the model usage;
 *  - a fed-forward compile diagnostic (a retry cycle) is folded into the model
 *    prompt so the retry consults retrieval + the diagnostics (scenario 3);
 *  - an MCP throw (McpTimeoutError) PROPAGATES (the supervisor's infra-retry owns it)
 *    rather than being swallowed by the tool loop;
 *  - the same mock inputs yield byte-identical work (determinism, constitution IV).
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createPlanningAgent,
  MANUAL_RETRIEVAL_TOOL,
  MNM_RETRIEVAL_TOOL,
} from "../../src/agents/planning.js";
import type { McpCallable } from "../../src/agents/planning.js";
import type { SubAgentCycleContext, SubAgents, SubAgentWork } from "../../src/agents/supervisor.js";
import type { Diagnostic } from "../../src/compile/index.js";
import { McpTimeoutError } from "../../src/mcp/errors.js";

// ── Mock-model plumbing (LanguageModelV4 doGenerate result shapes) ─────────────

/** A nested provider-level usage record (LanguageModelV4Usage) for a mock step. */
function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** A model step that emits a single tool call (drives the tool loop's execute). */
function toolCallStep(name: string, args: unknown, input = 5, output = 2) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `call-${name}`,
        toolName: name,
        input: JSON.stringify(args),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
    usage: usage(input, output),
    warnings: [],
  };
}

/** A terminal model step whose text is the JSON structured output. */
function finalStep(outputObject: unknown, input = 10, output = 8) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outputObject) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(input, output),
    warnings: [],
  };
}

/** Build a mock model that returns the given ordered steps, one per model call. */
function mockModel(
  steps: ReturnType<typeof finalStep | typeof toolCallStep>[],
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: steps });
}

/** Flatten a recorded prompt to a searchable string (for prompt-content assertions). */
function promptText(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doGenerateCalls[0]?.prompt ?? []);
}

// ── Fakes + fixtures ───────────────────────────────────────────────────────────

/** A fake retrieval MCP client whose `call` is a recording spy. */
function fakeMcp(impl?: (tool: string, args?: Record<string, unknown>) => Promise<unknown>): {
  call: Mock<McpCallable["call"]>;
} {
  return {
    call: vi.fn<McpCallable["call"]>(
      impl ?? (() => Promise.resolve({ docs: ["counter ledger pattern"] })),
    ),
  };
}

/** A representative plan the model returns as its structured output. */
const PLAN_OUTPUT = {
  narration: "Plan: a private Counter contract with an increment circuit + a React counter UI.",
  files: [{ path: "docs/plan.md", content: "# Plan\n- Counter ledger\n- increment circuit\n" }],
  activity: ["chose the Counter ledger ADT", "sketched the increment circuit"],
};

/** Build a cycle context, overriding only what a test cares about. */
function makeCtx(overrides: Partial<SubAgentCycleContext> = {}): SubAgentCycleContext {
  return {
    projectId: "proj-1",
    turnId: "turn-1",
    prompt: "build me a private counter dapp",
    cycle: 1,
    coldStart: true,
    compileDiagnostics: [],
    testFailures: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createPlanningAgent", () => {
  it("satisfies the supervisor SubAgents.planning seam", () => {
    const planning: SubAgents["planning"] = createPlanningAgent({
      model: mockModel([]),
      mnm: fakeMcp(),
    });
    expect(planning).toBeTypeOf("function");
  });

  it("grounds in mnm retrieval and maps the plan onto SubAgentWork", async () => {
    const mnm = fakeMcp();
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "counter ledger" }),
      finalStep(PLAN_OUTPUT),
    ]);
    const planning = createPlanningAgent({ model, mnm });

    const work = await planning(makeCtx());

    // Grounding: the retrieve tool wrapped mnm.call with the model's query (D3/constitution I).
    expect(mnm.call).toHaveBeenCalledWith(MNM_RETRIEVAL_TOOL, { query: "counter ledger" });
    // The typed plan is surfaced as narration + files + activity.
    expect(work.narration).toBe(PLAN_OUTPUT.narration);
    expect(work.files).toEqual(PLAN_OUTPUT.files);
    expect(work.activity).toEqual([
      { agent: "planning", phase: "cycle 1", detail: "chose the Counter ledger ADT" },
      { agent: "planning", phase: "cycle 1", detail: "sketched the increment circuit" },
    ]);
  });

  it("sums the model usage across steps into tokensConsumed (bigint)", async () => {
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "q" }, 5, 2),
      finalStep(PLAN_OUTPUT, 10, 8),
    ]);
    const planning = createPlanningAgent({ model, mnm: fakeMcp() });

    const work = await planning(makeCtx());

    // 5+2 (step 1) + 10+8 (step 2) = 25 base units.
    expect(work.tokensConsumed).toBe(25n);
    expect(typeof work.tokensConsumed).toBe("bigint");
  });

  it("omits activity when the model plan carries none", async () => {
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "q" }),
      finalStep({ narration: "Plan-only, no explicit activity.", files: [] }),
    ]);
    const planning = createPlanningAgent({ model, mnm: fakeMcp() });

    const work = await planning(makeCtx());

    expect(work.narration).toBe("Plan-only, no explicit activity.");
    expect(work.activity).toBeUndefined();
    expect(work.files).toEqual([]);
  });

  it("folds a fed-forward compile diagnostic into the retry prompt (scenario 3)", async () => {
    const diagnostic: Diagnostic = {
      severity: "error",
      source: "compactc",
      message: "UNBOUND_LEDGER_FIELD counter",
      raw: false,
    };
    const mnm = fakeMcp();
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "counter" }),
      finalStep(PLAN_OUTPUT),
    ]);
    const planning = createPlanningAgent({ model, mnm });

    await planning(makeCtx({ cycle: 2, coldStart: false, compileDiagnostics: [diagnostic] }));

    // The retry consults retrieval (mnm.call) AND the diagnostics reach the model.
    expect(mnm.call).toHaveBeenCalled();
    expect(promptText(model)).toContain("UNBOUND_LEDGER_FIELD counter");
  });

  it("propagates an MCP retrieval timeout instead of swallowing it", async () => {
    const mnm = fakeMcp(() => Promise.reject(new McpTimeoutError("http://mnm.test", "call", 5000)));
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "counter" }),
      finalStep(PLAN_OUTPUT),
    ]);
    const planning = createPlanningAgent({ model, mnm });

    await expect(planning(makeCtx())).rejects.toBeInstanceOf(McpTimeoutError);
  });

  it("is deterministic — identical mock inputs produce identical work", async () => {
    const build = (): ReturnType<SubAgents["planning"]> => {
      const model = mockModel([
        toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "counter" }),
        finalStep(PLAN_OUTPUT),
      ]);
      return createPlanningAgent({ model, mnm: fakeMcp() })(makeCtx());
    };

    const first: SubAgentWork = await build();
    const second: SubAgentWork = await build();
    expect(first).toEqual(second);
  });
});
