/**
 * Implementation sub-agent tests (US1 — T140, D3) — deterministic, no real model, no
 * real MCP.
 *
 * These pin {@link createImplementationAgent} against a {@link MockLanguageModelV4}
 * plus fake mnm/tome retrieval, proving:
 *  - the agent GROUNDS in mnm + MNE/tome retrieval before it writes Compact/React
 *    (D3/constitution I) — the retrieve tools wrap `mnm.call`/`tome.call`;
 *  - the typed {@link Output} file set (contract + witness + React + tests) is mapped
 *    onto {@link SubAgentWork.files} with tokens summed from the model usage;
 *  - fed-forward compile diagnostics / test failures on a retry cycle are folded into
 *    the model prompt so the retry consults retrieval + the diagnostics (scenario 3) —
 *    the diagnostics now come from the SUPERVISOR's per-cycle browser CHECK (P2), not an
 *    in-agent compile step;
 *  - a retrieval-MCP throw (McpTimeoutError) PROPAGATES (the supervisor's infra-retry
 *    owns it) rather than being swallowed;
 *  - the same mock inputs yield identical work (determinism, constitution IV).
 *
 * P2: the compiler MCP is retired — user contracts compile in the browser toolchain —
 * so there is NO compile-before-surface tool here anymore.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createImplementationAgent,
  EXAMPLES_RETRIEVAL_TOOL,
  MANUAL_RETRIEVAL_TOOL,
  MNM_RETRIEVAL_TOOL,
  TOME_RETRIEVAL_TOOL,
} from "../../src/agents/implementation.js";
import type { McpCallable } from "../../src/agents/implementation.js";
import type { SubAgentCycleContext, SubAgents, SubAgentWork } from "../../src/agents/supervisor.js";
import type { Diagnostic } from "../../src/compile/index.js";
import type { TestFailure } from "@nyx/protocol";
import { McpTimeoutError } from "../../src/mcp/errors.js";

// ── Mock-model plumbing (LanguageModelV4 doGenerate result shapes) ─────────────

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

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

function finalStep(outputObject: unknown, input = 10, output = 8) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outputObject) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(input, output),
    warnings: [],
  };
}

function mockModel(
  steps: ReturnType<typeof finalStep | typeof toolCallStep>[],
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: steps });
}

function promptText(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doGenerateCalls[0]?.prompt ?? []);
}

/**
 * Extract the system-instruction string the {@link ToolLoopAgent} sent to the model —
 * the AI SDK renders `instructions` as the leading `{ role: "system" }` message of the
 * recorded prompt, so this reads back exactly what the agent was steered with.
 */
function systemPrompt(model: MockLanguageModelV4): string {
  const messages = model.doGenerateCalls[0]?.prompt ?? [];
  for (const message of messages) {
    if (message.role === "system") {
      return message.content;
    }
  }
  return "";
}

/** A stable fragment of the implementation agent's baked base instructions. */
const BASE_MARKER = "You are the Implementation agent for Nyx";

// ── Fakes + fixtures ───────────────────────────────────────────────────────────

function fakeMcp(impl?: (tool: string, args?: Record<string, unknown>) => Promise<unknown>): {
  call: Mock<McpCallable["call"]>;
} {
  return {
    call: vi.fn<McpCallable["call"]>(
      impl ?? (() => Promise.resolve({ docs: ["counter example"] })),
    ),
  };
}

/** The contract + witness + React + test file set the model returns. */
const IMPL_OUTPUT = {
  narration: "Implemented the Counter contract, witness, React UI, and a behavioural test.",
  files: [
    {
      path: "contracts/counter.compact",
      content: "pragma language_version >= 0.16;\nledger count: Counter;\n",
    },
    { path: "src/witnesses.ts", content: "export const witnesses = {};\n" },
    { path: "src/App.tsx", content: "export function App() {\n  return null;\n}\n" },
    { path: "tests/counter.test.ts", content: "it('increments', () => {});\n" },
  ],
  activity: ["wrote the increment circuit", "wired the React counter UI"],
};

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

/** Drive the model to ground (mnm + tome), then emit the implementation files. */
function groundedRun(): MockLanguageModelV4 {
  return mockModel([
    toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "counter ledger" }),
    toolCallStep(EXAMPLES_RETRIEVAL_TOOL, { query: "increment circuit" }),
    finalStep(IMPL_OUTPUT),
  ]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createImplementationAgent", () => {
  it("satisfies the supervisor SubAgents.implementation seam", () => {
    const implementation: SubAgents["implementation"] = createImplementationAgent({
      model: mockModel([]),
      mnm: fakeMcp(),
      tome: fakeMcp(),
    });
    expect(implementation).toBeTypeOf("function");
  });

  it("grounds in mnm + tome retrieval, then surfaces the produced file set (D3)", async () => {
    const mnm = fakeMcp();
    const tome = fakeMcp();
    const implementation = createImplementationAgent({
      model: groundedRun(),
      mnm,
      tome,
    });

    const work = await implementation(makeCtx());

    // Grounding: both retrieval sources were consulted with the model's queries (D3).
    expect(mnm.call).toHaveBeenCalledWith(MNM_RETRIEVAL_TOOL, { query: "counter ledger" });
    expect(tome.call).toHaveBeenCalledWith(TOME_RETRIEVAL_TOOL, { query: "increment circuit" });
    // The typed file set is surfaced verbatim (the browser toolchain compiles it — no
    // in-agent compile step).
    expect(work.files).toEqual(IMPL_OUTPUT.files);
    expect(work.narration).toBe(IMPL_OUTPUT.narration);
  });

  it("sums the model usage across all steps into tokensConsumed (bigint)", async () => {
    const implementation = createImplementationAgent({
      model: groundedRun(),
      mnm: fakeMcp(),
      tome: fakeMcp(),
    });

    const work = await implementation(makeCtx());

    // (5+2) + (5+2) + (10+8) = 32 base units.
    expect(work.tokensConsumed).toBe(32n);
    expect(typeof work.tokensConsumed).toBe("bigint");
  });

  it("folds fed-forward compile diagnostics + test failures into the model prompt and re-grounds (scenario 3)", async () => {
    const diagnostic: Diagnostic = {
      severity: "error",
      source: "compactc",
      message: "TYPE_MISMATCH expected Uint<64>",
      raw: false,
    };
    const failure: TestFailure = { name: "counter increments", message: "expected 1 received 0" };
    const mnm = fakeMcp();
    const model = groundedRun();
    const implementation = createImplementationAgent({
      model,
      mnm,
      tome: fakeMcp(),
    });

    await implementation(
      makeCtx({
        cycle: 2,
        coldStart: false,
        compileDiagnostics: [diagnostic],
        testFailures: [failure],
      }),
    );

    // The retry consults retrieval AND the diagnostics + failures reach the model.
    expect(mnm.call).toHaveBeenCalled();
    const text = promptText(model);
    expect(text).toContain("TYPE_MISMATCH expected Uint<64>");
    expect(text).toContain("counter increments");
  });

  it("propagates an mnm retrieval timeout instead of swallowing it", async () => {
    const mnm = fakeMcp(() => Promise.reject(new McpTimeoutError("http://mnm.test", "call", 5000)));
    const implementation = createImplementationAgent({
      model: groundedRun(),
      mnm,
      tome: fakeMcp(),
    });

    await expect(implementation(makeCtx())).rejects.toBeInstanceOf(McpTimeoutError);
  });

  it("is deterministic — identical mock inputs produce identical work", async () => {
    const build = (): ReturnType<SubAgents["implementation"]> =>
      createImplementationAgent({
        model: groundedRun(),
        mnm: fakeMcp(),
        tome: fakeMcp(),
      })(makeCtx());

    const first: SubAgentWork = await build();
    const second: SubAgentWork = await build();
    expect(first).toEqual(second);
  });
});

describe("createImplementationAgent — steering seam (US1, D3/FR-080)", () => {
  const STEERING = "PLATFORM STEERING MARKER — ship OZ-simulator + Vitest tests for the contract.";

  /** A one-step model that emits an empty file set. */
  function outputOnlyModel(): MockLanguageModelV4 {
    return mockModel([finalStep({ narration: "done", files: [] })]);
  }

  it("APPENDS provided steering to the base instructions (base first, then steering)", async () => {
    const model = outputOnlyModel();
    const implementation = createImplementationAgent({
      model,
      mnm: fakeMcp(),
      tome: fakeMcp(),
      steering: STEERING,
    });

    await implementation(makeCtx());

    const system = systemPrompt(model);
    // The house rules AUGMENT the base — both survive, base first (never replaced).
    expect(system).toContain(BASE_MARKER);
    expect(system).toContain(STEERING);
    expect(system.indexOf(BASE_MARKER)).toBeLessThan(system.indexOf(STEERING));
  });

  it("leaves the base instructions unchanged when no steering is provided (default behaviour)", async () => {
    const model = outputOnlyModel();
    const implementation = createImplementationAgent({
      model,
      mnm: fakeMcp(),
      tome: fakeMcp(),
    });

    await implementation(makeCtx());

    const system = systemPrompt(model);
    expect(system).toContain(BASE_MARKER);
    expect(system).not.toContain(STEERING);
  });
});
