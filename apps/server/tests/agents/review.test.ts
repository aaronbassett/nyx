/**
 * Review sub-agent tests (US1 — T140, D41) — deterministic, no real model, no real
 * MCP.
 *
 * These pin {@link createReviewAgent} against a {@link MockLanguageModelV4} and an
 * OPTIONAL fake mnm retrieval client, proving:
 *  - the agent reviews the turn (quality/correctness, the layer that owns test
 *    adequacy, D41) and surfaces its verdict as {@link SubAgentWork} narration +
 *    optional revised files;
 *  - it runs with NO retrieval client (mnm optional) and, when one is supplied,
 *    grounds its review in retrieval;
 *  - fed-forward compile diagnostics / test failures are folded into the model prompt
 *    so the review reasons about the current failing state (scenario 3);
 *  - a retrieval throw PROPAGATES (never swallowed); tokens sum from the model usage;
 *  - the same mock inputs yield identical work (determinism, constitution IV).
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createReviewAgent,
  MANUAL_RETRIEVAL_TOOL,
  MNM_RETRIEVAL_TOOL,
} from "../../src/agents/review.js";
import type { McpCallable } from "../../src/agents/review.js";
import type { SubAgentCycleContext, SubAgents, SubAgentWork } from "../../src/agents/supervisor.js";
import type { Diagnostic } from "../../src/compile/index.js";
import type { TestFailure } from "@nyx/protocol";
import { McpTimeoutError } from "../../src/mcp/errors.js";

// ── Mock-model plumbing ────────────────────────────────────────────────────────

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

// ── Fakes + fixtures ───────────────────────────────────────────────────────────

function fakeMcp(impl?: (tool: string, args?: Record<string, unknown>) => Promise<unknown>): {
  call: Mock<McpCallable["call"]>;
} {
  return {
    call: vi.fn<McpCallable["call"]>(
      impl ?? (() => Promise.resolve({ docs: ["review checklist"] })),
    ),
  };
}

/** A representative review verdict the model returns, adding one behavioural test. */
const REVIEW_OUTPUT = {
  narration: "Review: the increment circuit looks correct; added a boundary test for overflow.",
  files: [
    { path: "tests/counter.overflow.test.ts", content: "it('does not overflow', () => {});\n" },
  ],
  activity: ["checked disclosure boundaries", "added an overflow test"],
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createReviewAgent", () => {
  it("satisfies the supervisor SubAgents.review seam", () => {
    const review: SubAgents["review"] = createReviewAgent({ model: mockModel([]) });
    expect(review).toBeTypeOf("function");
  });

  it("reviews the turn and surfaces the verdict as SubAgentWork (no mnm)", async () => {
    const model = mockModel([finalStep(REVIEW_OUTPUT)]);
    const review = createReviewAgent({ model });

    const work = await review(makeCtx());

    expect(work.narration).toBe(REVIEW_OUTPUT.narration);
    expect(work.files).toEqual(REVIEW_OUTPUT.files);
    expect(work.activity).toEqual([
      { agent: "review", phase: "cycle 1", detail: "checked disclosure boundaries" },
      { agent: "review", phase: "cycle 1", detail: "added an overflow test" },
    ]);
    expect(work.tokensConsumed).toBe(18n);
  });

  it("grounds the review in mnm retrieval when a client is supplied", async () => {
    const mnm = fakeMcp();
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "compact review checklist" }),
      finalStep(REVIEW_OUTPUT),
    ]);
    const review = createReviewAgent({ model, mnm });

    await review(makeCtx());

    expect(mnm.call).toHaveBeenCalledWith(MNM_RETRIEVAL_TOOL, {
      query: "compact review checklist",
    });
  });

  it("returns review-only work when the model revises no files", async () => {
    const model = mockModel([finalStep({ narration: "Looks good; no changes needed." })]);
    const review = createReviewAgent({ model });

    const work = await review(makeCtx());

    expect(work.narration).toBe("Looks good; no changes needed.");
    expect(work.files).toEqual([]);
    expect(work.activity).toBeUndefined();
  });

  it("folds fed-forward diagnostics + test failures into the review prompt (scenario 3)", async () => {
    const diagnostic: Diagnostic = {
      severity: "error",
      source: "compactc",
      message: "DISCLOSURE_REQUIRED on witness value",
      raw: false,
    };
    const failure: TestFailure = { name: "counter increments", message: "expected 1 received 0" };
    const model = mockModel([finalStep(REVIEW_OUTPUT)]);
    const review = createReviewAgent({ model });

    await review(
      makeCtx({
        cycle: 3,
        coldStart: false,
        compileDiagnostics: [diagnostic],
        testFailures: [failure],
      }),
    );

    const text = promptText(model);
    expect(text).toContain("DISCLOSURE_REQUIRED on witness value");
    expect(text).toContain("counter increments");
  });

  it("propagates an mnm retrieval timeout instead of swallowing it", async () => {
    const mnm = fakeMcp(() => Promise.reject(new McpTimeoutError("http://mnm.test", "call", 5000)));
    const model = mockModel([
      toolCallStep(MANUAL_RETRIEVAL_TOOL, { query: "review" }),
      finalStep(REVIEW_OUTPUT),
    ]);
    const review = createReviewAgent({ model, mnm });

    await expect(review(makeCtx())).rejects.toBeInstanceOf(McpTimeoutError);
  });

  it("is deterministic — identical mock inputs produce identical work", async () => {
    const build = (): ReturnType<SubAgents["review"]> =>
      createReviewAgent({ model: mockModel([finalStep(REVIEW_OUTPUT)]) })(makeCtx());

    const first: SubAgentWork = await build();
    const second: SubAgentWork = await build();
    expect(first).toEqual(second);
  });
});
