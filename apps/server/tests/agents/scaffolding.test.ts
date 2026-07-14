/**
 * Scaffolding sub-agent tests (US1 — T139, D3/FR-003) — deterministic, no
 * network, no real API key, no template.
 *
 * These pin {@link createScaffoldingAgent} against an injected
 * {@link MockLanguageModelV4} + a fake Tome retrieval client. The agent is a
 * {@link ToolLoopAgent} whose tools forward to `tome.call(...)`; the mock model
 * drives the FR-003 cold-start retrieval sequence (`search_skills` → `get_skill`)
 * and then emits a structured file set through the typed `Output.object` schema.
 * The tests prove: (1) the retrieval sequence reaches Tome in order; (2) the
 * returned {@link SubAgentWork} files are the MODEL's output verbatim (no
 * hardcoded template, D3); (3) `tokensConsumed` accumulates from the aggregated
 * usage; (4) `coldStart:false` short-circuits (a project is scaffolded exactly
 * once, FR-003) with no model or Tome call; (5) a retrieval fault
 * ({@link McpConnectionError}) PROPAGATES rather than letting the model fabricate
 * a scaffold (constitution I); (6) identical inputs yield an identical result.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { McpConnectionError } from "../../src/mcp/errors.js";
import { createScaffoldingAgent } from "../../src/agents/scaffolding.js";
import type { RetrievalClient } from "../../src/agents/scaffolding.js";
import type { SubAgentCycleContext } from "../../src/agents/supervisor.js";

// ── Mock plumbing ───────────────────────────────────────────────────────────

/** Deterministic per-step token usage for a mock generate result. */
interface Usage {
  readonly input: number;
  readonly output: number;
}

const STEP_USAGE: Usage = { input: 10, output: 5 };

/** A mock step that calls a tool with JSON-encoded arguments. */
function toolCallStep(id: string, toolName: string, input: unknown) {
  return {
    content: [
      { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
    usage: {
      inputTokens: {
        total: STEP_USAGE.input,
        noCache: STEP_USAGE.input,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: STEP_USAGE.output, text: STEP_USAGE.output, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A terminal mock step emitting the structured file-set JSON. */
function outputStep(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: {
        total: STEP_USAGE.input,
        noCache: STEP_USAGE.input,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: STEP_USAGE.output, text: STEP_USAGE.output, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A recording fake Tome client that returns canned retrieval bodies. */
interface TomeCall {
  readonly tool: string;
  readonly args: Record<string, unknown> | undefined;
}

interface FakeTome {
  readonly client: RetrievalClient;
  readonly calls: TomeCall[];
}

function fakeTome(): FakeTome {
  const calls: TomeCall[] = [];
  const client: RetrievalClient = {
    call: (tool, args) => {
      calls.push({ tool, args });
      if (tool === "search_skills") {
        return Promise.resolve({ skills: ["midnight-dapp-dev", "compact-core"] });
      }
      return Promise.resolve({ body: "retrieved skill body" });
    },
  };
  return { client, calls };
}

/**
 * Extract the system-instruction string the {@link ToolLoopAgent} sent to the model.
 * The AI SDK renders `instructions` as the leading `{ role: "system" }` message of the
 * recorded `doGenerateCalls[0].prompt`, so this is a direct read of what the agent was
 * actually steered with — no reliance on any private field.
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

/** A stable fragment of the scaffolding agent's baked base instructions. */
const BASE_MARKER = "You are the Scaffolding sub-agent for Nyx";

/**
 * A mock model driving: search_skills → get_skill(midnight-dapp-dev) →
 * get_skill(compact-core) → structured file set. `files` is the model's output.
 */
function scaffoldModel(files: readonly { path: string; content: string }[]): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    modelId: "mock-scaffolding",
    provider: "mock",
    doGenerate: () => {
      step += 1;
      if (step === 1) {
        return Promise.resolve(toolCallStep("c1", "search_skills", { query: "midnight dapp" }));
      }
      if (step === 2) {
        return Promise.resolve(toolCallStep("c2", "get_skill", { name: "midnight-dapp-dev" }));
      }
      if (step === 3) {
        return Promise.resolve(toolCallStep("c3", "get_skill", { name: "compact-core" }));
      }
      return Promise.resolve(outputStep({ files }));
    },
  });
}

const COLD_CTX: SubAgentCycleContext = {
  projectId: "proj-1",
  turnId: "turn-1",
  prompt: "build a private voting DApp",
  cycle: 1,
  coldStart: true,
  compileDiagnostics: [],
  testFailures: [],
};

const SCAFFOLD_FILES = [
  { path: "package.json", content: '{"name":"nyx-app"}' },
  { path: "vite.config.ts", content: "export default {};" },
  { path: "src/App.tsx", content: "export const App = () => null;" },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createScaffoldingAgent", () => {
  it("retrieves via Tome in order (search_skills → get_skill) on cold start", async () => {
    const tome = fakeTome();
    const scaffold = createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: tome.client,
    });

    await scaffold(COLD_CTX);

    expect(tome.calls.map((c) => c.tool)).toEqual(["search_skills", "get_skill", "get_skill"]);
    expect(tome.calls[0]?.args).toEqual({ query: "midnight dapp" });
    expect(tome.calls[1]?.args).toEqual({ name: "midnight-dapp-dev" });
    expect(tome.calls[2]?.args).toEqual({ name: "compact-core" });
  });

  it("returns the model's structured files verbatim (no hardcoded template, D3)", async () => {
    const tome = fakeTome();
    const scaffold = createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: tome.client,
    });

    const work = await scaffold(COLD_CTX);

    expect(work.files).toEqual(SCAFFOLD_FILES);
  });

  it("reflects a DIFFERENT model output — the scaffold is model-driven, not templated", async () => {
    const distinct = [{ path: "tailwind.config.ts", content: "export default { theme: {} };" }];
    const tome = fakeTome();
    const scaffold = createScaffoldingAgent({ model: scaffoldModel(distinct), tome: tome.client });

    const work = await scaffold(COLD_CTX);

    expect(work.files).toEqual(distinct);
  });

  it("accumulates tokensConsumed from the aggregated usage", async () => {
    const tome = fakeTome();
    const scaffold = createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: tome.client,
    });

    const work = await scaffold(COLD_CTX);

    // 4 model steps × (10 input + 5 output) = 60 base units consumed.
    expect(work.tokensConsumed).toBe(60n);
  });

  it("emits narration and an activity feed for the scaffold", async () => {
    const tome = fakeTome();
    const scaffold = createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: tome.client,
    });

    const work = await scaffold(COLD_CTX);

    expect(typeof work.narration).toBe("string");
    expect((work.narration ?? "").length).toBeGreaterThan(0);
    expect(work.activity?.length ?? 0).toBeGreaterThan(0);
    expect(work.activity?.[0]?.agent).toBe("scaffolding");
  });

  it("honours coldStart:false — no re-scaffold, no model or Tome call (FR-003)", async () => {
    const tome = fakeTome();
    const model = scaffoldModel(SCAFFOLD_FILES);
    const scaffold = createScaffoldingAgent({ model, tome: tome.client });

    const work = await scaffold({ ...COLD_CTX, coldStart: false });

    expect(work.files).toEqual([]);
    expect(work.tokensConsumed).toBe(0n);
    expect(model.doGenerateCalls.length).toBe(0);
    expect(tome.calls.length).toBe(0);
  });

  it("propagates an McpConnectionError from retrieval (never fabricates a scaffold)", async () => {
    const failing: RetrievalClient = {
      call: () => Promise.reject(new McpConnectionError("http://tome", new Error("down"))),
    };
    const scaffold = createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: failing,
    });

    await expect(scaffold(COLD_CTX)).rejects.toBeInstanceOf(McpConnectionError);
  });

  it("is deterministic — identical inputs yield identical SubAgentWork", async () => {
    const first = await createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: fakeTome().client,
    })(COLD_CTX);
    const second = await createScaffoldingAgent({
      model: scaffoldModel(SCAFFOLD_FILES),
      tome: fakeTome().client,
    })(COLD_CTX);

    expect(first).toEqual(second);
  });
});

describe("createScaffoldingAgent — steering seam (US1, D3/FR-003/FR-080)", () => {
  const STEERING = "PLATFORM STEERING MARKER — read the contract address via config.ts only.";

  it("APPENDS provided steering to the base instructions (base first, then steering)", async () => {
    const model = scaffoldModel(SCAFFOLD_FILES);
    const scaffold = createScaffoldingAgent({
      model,
      tome: fakeTome().client,
      steering: STEERING,
    });

    await scaffold(COLD_CTX);

    const system = systemPrompt(model);
    // The house rules AUGMENT the base — both survive, base first (never replaced).
    expect(system).toContain(BASE_MARKER);
    expect(system).toContain(STEERING);
    expect(system.indexOf(BASE_MARKER)).toBeLessThan(system.indexOf(STEERING));
  });

  it("leaves the base instructions unchanged when no steering is provided (default behaviour)", async () => {
    const model = scaffoldModel(SCAFFOLD_FILES);
    const scaffold = createScaffoldingAgent({ model, tome: fakeTome().client });

    await scaffold(COLD_CTX);

    const system = systemPrompt(model);
    expect(system).toContain(BASE_MARKER);
    expect(system).not.toContain(STEERING);
  });
});
