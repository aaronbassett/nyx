/**
 * Scaffolding sub-agent for the US1 supervisor (T139, D3/FR-003).
 *
 * This is the production `SubAgents["scaffolding"]` seam the supervisor drives on
 * a project's FIRST turn (cold start) to bootstrap the initial DApp skeleton. Per
 * D3/FR-003 there is NO template system: the agent assembles the skeleton by
 * RETRIEVING Midnight skills at runtime (Tome — `search_skills` then `get_skill`
 * for `midnight-dapp-dev` / `compact-core`, and optionally the Midnight Manual)
 * and grounding every framework/SDK/Compact choice in what it retrieves, never in
 * model memory (constitution I). The generated skeleton is a Vite + React 19 +
 * shadcn + Tailwind v4 web app wired to consume a Midnight contract address.
 *
 * The agent is a Vercel AI SDK v7 {@link ToolLoopAgent} whose tools wrap the
 * injected {@link RetrievalClient} (`McpClient.call`), and whose file set is a
 * typed `Output.object` schema — the scaffold is VALIDATED structured data, never
 * free-text parsed. Both the model and the retrieval clients are injected seams
 * (a {@link MockLanguageModelV4} + a fake Tome in tests), so the whole tool-wiring
 * → retrieval-sequence → output-parsing → token-accounting path is exercised with
 * no network, no API key, and no MCP server (constitution III/IV).
 *
 * ⚠️ Owner-gated: the REAL routed `scaffolding` model + the REAL Tome/mnm MCP
 * servers are validated during the US1 Independent Test. The MCP tool contracts
 * assumed here — `search_skills({ query })`, `get_skill({ name })`, and (mnm)
 * `search_docs({ query })` — are NOT yet verified against the live MCP servers;
 * confirm the exact tool names + input shapes before wiring production (the
 * output shapes are passed straight through to the model, so only names/inputs
 * are load-bearing on this side).
 *
 * AI SDK v7 constructs used (verified against installed `ai@7.0.26` types, not
 * memory): {@link ToolLoopAgent} with `instructions` (not `system`), `tools` built
 * with {@link tool} (`inputSchema`, not `parameters`), `stopWhen: isStepCount(n)`,
 * `maxOutputTokens`, and a typed `output: Output.object({schema})`. `.generate({
 * prompt })` yields `.output` (the parsed file set) and `.usage` (the aggregated,
 * flat `{ inputTokens, outputTokens, totalTokens }` summed across steps).
 */
import { Output, ToolLoopAgent, isStepCount, tool } from "ai";
import type { LanguageModel, LanguageModelUsage, ToolSet } from "ai";
import { z } from "zod";
import type { SourceFile } from "../compile/index.js";
import type { McpClient } from "../mcp/client.js";
import type { SubAgentCycleContext, SubAgentWork, SubAgents } from "./supervisor.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** The sub-agent's stable name (matches the supervisor's composition step label). */
const AGENT_NAME = "scaffolding";

/**
 * The tool-loop step cap (D21 is the VERIFY budget; this is the retrieval-loop
 * guard). Generous enough for a search plus several skill reads plus the final
 * structured emit, bounded so a misbehaving loop cannot run unbounded.
 */
const MAX_SCAFFOLD_STEPS = 12;

/** A safety cap on generated output size per model step. */
const MAX_OUTPUT_TOKENS = 16_000;

/** The scaffolding agent's system instructions (D3/FR-003 — retrieve, don't template). */
const SCAFFOLD_INSTRUCTIONS = [
  "You are the Scaffolding sub-agent for Nyx, a prompt-to-DApp platform for the Midnight Network.",
  "You bootstrap the INITIAL project skeleton for a new DApp — once, on the project's first turn (FR-003).",
  "There is NO template: assemble the skeleton from Midnight skills you retrieve at runtime (D3).",
  "Always retrieve before you generate — search_skills, then get_skill — and ground every framework,",
  "SDK, and Compact decision in the retrieved material, never in memory (constitution I).",
  "Target stack: Vite + React 19 + shadcn + Tailwind v4, wired to consume a Midnight contract address.",
  "Emit a complete, coherent set of project files as structured { path, content } output.",
].join("\n");

/**
 * The typed scaffold output (D3) — a validated `{ path, content }[]`, never
 * free-text-parsed. `path` mirrors {@link SourceFile} (non-empty); `content` is
 * the file body.
 */
const ScaffoldOutputSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })),
});

// ── Seam types ───────────────────────────────────────────────────────────────

/**
 * The retrieval-client surface the agent depends on — the narrow subset of
 * {@link McpClient} it uses. Tests inject a fake `{ call }`; production passes the
 * real Tome (and optional Midnight Manual) {@link McpClient}.
 */
export type RetrievalClient = Pick<McpClient, "call">;

/** Injected dependencies for {@link createScaffoldingAgent}. */
export interface ScaffoldingAgentDeps {
  /** The routed `scaffolding` model (D19); injected, never constructed here. */
  readonly model: LanguageModel;
  /** The Tome retrieval client — the skill catalogue for the cold-start scaffold (D3). */
  readonly tome: RetrievalClient;
  /** Optional Midnight Manual (mnm) retrieval client for SDK/Compact reference passages. */
  readonly mnm?: RetrievalClient;
  /**
   * Optional platform STEERING appended to the agent's baked base {@link SCAFFOLD_INSTRUCTIONS}
   * (it AUGMENTS, never replaces, them). Production injects the `@nyx/scaffold` house rules
   * via `buildScaffoldingInstructions()` (config-chokepoint, prover default, wrong-network
   * guard — D10/D37/FR-037/FR-080); absent = the base instructions only (unchanged behaviour).
   */
  readonly steering?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The separator between the agent's base instructions and any appended platform steering. */
const STEERING_SEPARATOR = "\n\n";

/**
 * Compose the agent's effective system instructions: the baked base, optionally
 * AUGMENTED (never replaced) by the platform steering — base first, then a blank-line
 * separator, then the steering — so the Nyx house rules layer ON TOP of the agent's own
 * instructions ({@link ScaffoldingAgentDeps.steering}). Absent (or empty) steering yields
 * the base verbatim, so the default cold-start behaviour is unchanged.
 */
function composeInstructions(base: string, steering: string | undefined): string {
  return steering === undefined || steering.length === 0
    ? base
    : `${base}${STEERING_SEPARATOR}${steering}`;
}

/**
 * Fold an AI SDK aggregated {@link LanguageModelUsage} into NYXT base units for the
 * turn's settle (D34). Prefers `totalTokens`, falling back to the input+output sum;
 * a missing or non-positive figure floors to zero (never negative).
 */
function usageToTokens(usage: LanguageModelUsage): bigint {
  const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const safe = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  return BigInt(safe);
}

/**
 * Build the retrieval tool set the tool-loop calls. Each tool forwards to its
 * {@link RetrievalClient}, recording (and re-raising) the FIRST fault via
 * `recordError` — the AI SDK swallows a tool `execute` throw into the loop, so the
 * caller re-raises after generation to keep a retrieval outage LOUD (constitution I).
 *
 * ⚠️ Assumed MCP tool contracts (unverified against the live servers): Tome
 * `search_skills({ query })` + `get_skill({ name })`, and mnm `search_docs({ query })`.
 */
function buildScaffoldTools(deps: {
  readonly tome: RetrievalClient;
  readonly mnm: RetrievalClient | undefined;
  readonly recordError: (error: unknown) => void;
}): ToolSet {
  const { tome, mnm, recordError } = deps;

  const forward = async (
    client: RetrievalClient,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      return await client.call(toolName, args);
    } catch (error) {
      recordError(error);
      throw error;
    }
  };

  const tools: ToolSet = {
    search_skills: tool({
      description: "Search the Tome skill catalogue for Midnight skills relevant to a query.",
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => forward(tome, "search_skills", { query }),
    }),
    get_skill: tool({
      description:
        "Fetch one Midnight skill's full content from Tome by name (e.g. midnight-dapp-dev, compact-core).",
      inputSchema: z.object({ name: z.string() }),
      execute: ({ name }) => forward(tome, "get_skill", { name }),
    }),
  };

  if (mnm !== undefined) {
    tools.search_docs = tool({
      description: "Search the Midnight Manual (mnm) for SDK / Compact reference passages.",
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => forward(mnm, "search_docs", { query }),
    });
  }

  return tools;
}

/** Build the per-turn scaffold prompt from the cycle context. */
function buildScaffoldPrompt(ctx: SubAgentCycleContext): string {
  return [
    "Scaffold a new Midnight DApp project for the following request.",
    "",
    `User request: ${ctx.prompt}`,
    "",
    "First retrieve the relevant Midnight skills with `search_skills`, then read each one you",
    "need with `get_skill` (at minimum `midnight-dapp-dev` and `compact-core`). Ground every",
    "choice in what you retrieve — do NOT rely on memory. Then produce the initial project",
    "skeleton: a Vite + React 19 + shadcn + Tailwind v4 web app wired for a Midnight contract.",
    "Return the files as structured { path, content } entries.",
  ].join("\n");
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the US1 scaffolding sub-agent (D3/FR-003). Returns the supervisor's
 * `SubAgents["scaffolding"]` seam: a `(ctx) => Promise<SubAgentWork>` that, on a
 * cold start, retrieves Midnight skills via Tome and generates the initial project
 * skeleton as validated structured files.
 *
 * A warm project (`ctx.coldStart === false`) short-circuits with NO work and NO
 * model/retrieval call — the skeleton is bootstrapped exactly once (FR-003). A
 * retrieval fault PROPAGATES (it is never swallowed into a fabricated scaffold),
 * so the supervisor's infra path can retry or fail loudly (constitution I).
 */
export function createScaffoldingAgent(deps: ScaffoldingAgentDeps): SubAgents["scaffolding"] {
  const { model, tome, mnm } = deps;
  // Stable across every cold-start invocation (ctx-independent): the base instructions
  // augmented by any injected platform steering (`@nyx/scaffold` house rules).
  const instructions = composeInstructions(SCAFFOLD_INSTRUCTIONS, deps.steering);

  return async (ctx: SubAgentCycleContext): Promise<SubAgentWork> => {
    const phase = `cycle ${String(ctx.cycle)}`;

    // FR-003 — a project is scaffolded exactly once, on its first turn. A warm
    // project never re-scaffolds: no model call, no retrieval, no token spend.
    if (!ctx.coldStart) {
      return {
        files: [],
        tokensConsumed: 0n,
        activity: [
          {
            agent: AGENT_NAME,
            phase,
            detail: "skipped — project already scaffolded (cold-start only, FR-003)",
          },
        ],
      };
    }

    let retrievalError: unknown = undefined;
    const recordError = (error: unknown): void => {
      if (retrievalError === undefined) {
        retrievalError = error;
      }
    };

    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools: buildScaffoldTools({ tome, mnm, recordError }),
      stopWhen: isStepCount(MAX_SCAFFOLD_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      output: Output.object({ schema: ScaffoldOutputSchema }),
    });

    const result = await agent.generate({ prompt: buildScaffoldPrompt(ctx) });

    // The AI SDK converts a tool `execute` throw into a tool-error result and keeps
    // looping, so a retrieval outage would otherwise let the model fabricate a
    // scaffold from memory. Re-raise the first captured fault to keep it LOUD — the
    // supervisor's infra path (retry → fail-loud) owns the recovery (constitution I).
    if (retrievalError !== undefined) {
      throw retrievalError instanceof Error
        ? retrievalError
        : new Error("scaffolding retrieval failed with a non-Error value");
    }

    const files: SourceFile[] = result.output.files.map((file) => ({
      path: file.path,
      content: file.content,
    }));
    const tokensConsumed = usageToTokens(result.usage);

    return {
      files,
      tokensConsumed,
      narration:
        "Bootstrapping the project skeleton from Midnight skills retrieved via Tome " +
        `(no template — D3/FR-003): ${String(files.length)} file(s).`,
      activity: [
        {
          agent: AGENT_NAME,
          phase,
          detail:
            "retrieved Midnight skills and generated the Vite + React 19 + shadcn + Tailwind v4 " +
            `scaffold (${String(files.length)} file(s))`,
        },
      ],
    };
  };
}
