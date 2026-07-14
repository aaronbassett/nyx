/**
 * Intent-classifier tests (US1 — T139, D25/FR-003) — deterministic, no network,
 * no real API key.
 *
 * These pin {@link createIntentClassifier} against an injected
 * {@link MockLanguageModelV4}: the model's structured verdict is mapped onto the
 * supervisor's {@link IntentResult} seam. `dapp` accepts (no decline reason);
 * `off-domain` declines with a reason folded into the supervisor's decline
 * message (D25/FR-010). A model that classifies off-domain without a reason falls
 * back to a deterministic default so the decline is never reasonless. Identical
 * input yields an identical verdict (no clock, no randomness).
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createIntentClassifier } from "../../src/agents/classifier.js";

// ── Mock plumbing ───────────────────────────────────────────────────────────

/** Deterministic per-step token usage for a mock generate result. */
interface Usage {
  readonly input: number;
  readonly output: number;
}

/** A single-shot mock generate result carrying the classifier's JSON verdict. */
function jsonResult(value: unknown, usage: Usage = { input: 4, output: 3 }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A mock model that always returns `value` as its structured verdict. */
function modelReturning(value: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-classifier",
    provider: "mock",
    doGenerate: () => Promise.resolve(jsonResult(value)),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createIntentClassifier", () => {
  it("maps an off-domain verdict to a decline result with the model's reason", async () => {
    const model = modelReturning({
      classification: "off-domain",
      reason: "this is a general cooking question, not a Midnight DApp",
    });
    const classify = createIntentClassifier({ model });

    const result = await classify("how do I bake sourdough bread?");

    expect(result.kind).toBe("off-domain");
    expect(result.reason).toBe("this is a general cooking question, not a Midnight DApp");
  });

  it("maps a dapp verdict to an accept result with no decline reason", async () => {
    const model = modelReturning({ classification: "dapp", reason: "a privacy voting app" });
    const classify = createIntentClassifier({ model });

    const result = await classify("build a private voting DApp on Midnight");

    // A dapp verdict carries no decline reason (exactOptionalPropertyTypes: the key
    // is absent, never `undefined`).
    expect(result).toEqual({ kind: "dapp" });
    expect("reason" in result).toBe(false);
  });

  it("supplies a deterministic default reason when off-domain has none", async () => {
    const model = modelReturning({ classification: "off-domain" });
    const classify = createIntentClassifier({ model });

    const result = await classify("what's the weather in Paris?");

    expect(result.kind).toBe("off-domain");
    expect(typeof result.reason).toBe("string");
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });

  it("invokes the model exactly once (cheap single-shot tier, D25)", async () => {
    const model = modelReturning({ classification: "dapp" });
    const classify = createIntentClassifier({ model });

    await classify("a shielded token faucet");

    expect(model.doGenerateCalls.length).toBe(1);
  });

  it("is deterministic — identical input yields an identical verdict", async () => {
    const verdict = { classification: "off-domain", reason: "off-topic" };
    const first = await createIntentClassifier({ model: modelReturning(verdict) })(
      "summarize this PDF",
    );
    const second = await createIntentClassifier({ model: modelReturning(verdict) })(
      "summarize this PDF",
    );

    expect(first).toEqual(second);
  });
});
