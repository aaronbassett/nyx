/**
 * Planning sub-agent (US1 — T140, D3/FR-002).
 *
 * The first creative step of a verify cycle: it reads the user's prompt, GROUNDS its
 * design in retrieval (the Midnight Manual `mnm` + the example corpus `tome`), and
 * produces a plan for the contract + frontend as {@link SubAgentWork} — planning
 * narration, an activity feed, and MAY write plan/spec files into the VFS. Per D3 and
 * constitution I the design is grounded in retrieval, NEVER hand-written from memory;
 * the retrieval tools are the only source of Compact/SDK shapes this agent trusts.
 *
 * This module is the DETERMINISTIC core of that agent. The real LLM + the real MCP
 * servers are OWNER-GATED, so everything here is exercised with a
 * {@link MockLanguageModelV4} and fake `mnm`/`tome` clients (constitution III/IV):
 *  - the Vercel AI SDK v7 {@link ToolLoopAgent} tool-wiring — a `retrieve_manual`
 *    (mnm) and optional `retrieve_examples` (tome) tool, each wrapping the existing
 *    {@link McpClient.call} (preserving its D31 bounded-concurrency + deadlines);
 *  - the typed {@link Output.object} plan schema → {@link SubAgentWork};
 *  - token accounting from the model usage (v7 nested provider usage → flat
 *    result usage → a `bigint` base-unit count summed into the turn settle, D34);
 *  - the fed-forward-diagnostics handling (a retry cycle folds the prior cycle's
 *    compile diagnostics + failing tests into the prompt so the agent consults
 *    retrieval + the diagnostics rather than regenerating from memory — scenario 3);
 *  - loud propagation: an MCP fault surfaced by a tool is NEVER swallowed by the tool
 *    loop — it re-throws out of the agent so the supervisor's infra-retry owns it.
 *
 * ⚠️ Assumed MCP tool contracts (flag — verify against the live MCP servers before
 * un-gating): the mnm/tome retrieval tool name is assumed to be
 * {@link MNM_RETRIEVAL_TOOL}/{@link TOME_RETRIEVAL_TOOL} (`"search"`) taking a
 * `{ query }` argument. The names are overridable via {@link PlanningAgentDeps} so the
 * owner can reconcile them with the real servers without a code change.
 */
import { isStepCount, Output, tool, ToolLoopAgent } from "ai";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { z } from "zod";
import type { TestFailure } from "@nyx/protocol";
import type { Diagnostic, SourceFile } from "../compile/index.js";
import type {
  SubAgentActivity,
  SubAgentCycleContext,
  SubAgents,
  SubAgentWork,
} from "./supervisor.js";

// ── Assumed tool contracts (flagged — verify vs the live MCP servers) ──────────

/**
 * The AI SDK tool name the model calls to search the Midnight Manual (mnm). This is
 * the ToolLoopAgent-facing name (distinct from the MCP tool name below) so the mnm and
 * tome tools never collide even when they share an MCP tool name.
 */
export const MANUAL_RETRIEVAL_TOOL = "retrieve_manual";

/** The AI SDK tool name the model calls to search the example corpus (tome). */
export const EXAMPLES_RETRIEVAL_TOOL = "retrieve_examples";

/**
 * The MCP tool name invoked on the `mnm` client. ASSUMED `"search"` with a `{ query }`
 * argument — VERIFY against the live Midnight Manual MCP before un-gating (constitution
 * I); overridable via {@link PlanningAgentDeps.mnmRetrievalTool}.
 */
export const MNM_RETRIEVAL_TOOL = "search";

/**
 * The MCP tool name invoked on the `tome` client. ASSUMED `"search"` with a `{ query }`
 * argument — VERIFY against the live Tome MCP; overridable via
 * {@link PlanningAgentDeps.tomeRetrievalTool}.
 */
export const TOME_RETRIEVAL_TOOL = "search";

/** Default ToolLoopAgent step budget (retrieval iterations + the final plan). */
export const DEFAULT_PLANNING_STEPS = 6;

// ── Seam types ─────────────────────────────────────────────────────────────────

/**
 * The narrow MCP surface this agent depends on — just {@link McpClient.call}. A real
 * `McpClient` satisfies it structurally; tests inject a fake with a single `call` spy
 * (so no real MCP server is needed, constitution IV).
 */
export interface McpCallable {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Injected dependencies for {@link createPlanningAgent}. */
export interface PlanningAgentDeps {
  /** The routed planning model (D19) — production wires `ModelRouter.model("planning")`. */
  readonly model: LanguageModel;
  /** The Midnight Manual retrieval client (required grounding source, D3). */
  readonly mnm: McpCallable;
  /** The example-corpus retrieval client (optional additional grounding). */
  readonly tome?: McpCallable;
  /** Max ToolLoopAgent steps; default {@link DEFAULT_PLANNING_STEPS}. */
  readonly maxSteps?: number;
  /** Override the assumed mnm MCP tool name; default {@link MNM_RETRIEVAL_TOOL}. */
  readonly mnmRetrievalTool?: string;
  /** Override the assumed tome MCP tool name; default {@link TOME_RETRIEVAL_TOOL}. */
  readonly tomeRetrievalTool?: string;
}

// ── Structured output schema ─────────────────────────────────────────────────────

/** One planned/written source file (structurally a {@link SourceFile}). */
const OutputFileSchema = z.object({ path: z.string().min(1), content: z.string() });

/**
 * The typed plan the model returns: a narration, any plan/spec files to write, and an
 * optional activity feed (the supervisor renders a default activity row when omitted).
 */
const PlanOutputSchema = z.object({
  narration: z.string(),
  files: z.array(OutputFileSchema).default([]),
  activity: z.array(z.string()).optional(),
});
type PlanOutput = z.infer<typeof PlanOutputSchema>;

// ── Shared internal helpers (kept inline per the no-extra-files constraint) ──────

/** A guard wrapping an MCP call: records the first fault so it can re-throw later. */
type McpGuard = <T>(op: () => Promise<T>) => Promise<T>;

/**
 * The planning system prompt. Mandates retrieval grounding (constitution I) — the
 * design must come from `retrieve_manual`/`retrieve_examples`, never memory — and a
 * structured plan as the final output.
 */
const PLANNING_INSTRUCTIONS = [
  "You are the Planning agent for Nyx, a prompt-to-DApp builder for Midnight.",
  "Plan the privacy-preserving Compact contract and its React frontend for the user's request.",
  "GROUND every design decision in retrieval: call retrieve_manual (the Midnight Manual) and,",
  "when available, retrieve_examples (the example corpus) before you commit to any Compact or",
  "SDK shape. Never invent Compact syntax, ledger ADTs, stdlib names, or SDK APIs from memory.",
  "If prior compile diagnostics or failing tests are provided, plan the fix around them and",
  "re-consult retrieval for the exact shapes involved.",
  "Return a concise plan: a narration, an activity list of the decisions you made, and any",
  "plan/spec markdown files worth persisting.",
].join(" ");

/** Build a retrieval tool over an MCP client, routing faults through the guard. */
function retrievalTool(client: McpCallable, mcpTool: string, description: string, guard: McpGuard) {
  return tool({
    description,
    inputSchema: z.object({ query: z.string() }),
    execute: (input) => guard(() => client.call(mcpTool, { query: input.query })),
  });
}

/**
 * Fold an AI SDK aggregated {@link LanguageModelUsage} into NYXT base units for the
 * turn's settle (D34). Prefers the flat `totalTokens`, falling back to the input+output
 * sum; a missing or non-positive figure floors to zero (never negative). NOTE the v7
 * result usage is FLAT (`{ inputTokens, outputTokens, totalTokens }`) — distinct from
 * the model's nested provider usage (`usage.inputTokens.total`), which the SDK sums for
 * us across every tool-loop step. Mirrors `scaffolding.ts` for a future shared kit.
 */
function usageToTokens(usage: LanguageModelUsage): bigint {
  const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const safe = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  return BigInt(safe);
}

/**
 * Re-throw a captured MCP fault — identity-preserving for real Errors (the MCP layer
 * only ever throws named Errors, so a live fault is never wrapped). This propagates the
 * original error to the supervisor's infra-retry while keeping the throw well-typed.
 */
function throwCaptured(fault: unknown): never {
  throw fault instanceof Error ? fault : new Error(String(fault));
}

/** Render fed-forward compile diagnostics into a promptable block (scenario 3). */
function renderDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const lines = diagnostics.map((diagnostic) => {
    const where = diagnostic.file === undefined ? "" : ` (${diagnostic.file})`;
    return `- [${diagnostic.source} ${diagnostic.severity}] ${diagnostic.message}${where}`;
  });
  return [
    "Compile diagnostics from the previous cycle to resolve (ground the fix in retrieval):",
    ...lines,
  ].join("\n");
}

/** Render fed-forward failing tests into a promptable block (scenario 3). */
function renderFailures(failures: readonly TestFailure[]): string {
  const lines = failures.map((failure) => `- ${failure.name}: ${failure.message}`);
  return ["Behavioural test failures from the previous cycle to resolve:", ...lines].join("\n");
}

/** Build the user prompt for one cycle, folding in any fed-forward diagnostics. */
function buildPrompt(ctx: SubAgentCycleContext): string {
  const sections = [
    `User request:\n${ctx.prompt}`,
    `Verify cycle ${String(ctx.cycle)}${ctx.coldStart ? " (cold start — the project's first turn)" : ""}.`,
  ];
  if (ctx.compileDiagnostics.length > 0) {
    sections.push(renderDiagnostics(ctx.compileDiagnostics));
  }
  if (ctx.testFailures.length > 0) {
    sections.push(renderFailures(ctx.testFailures));
  }
  return sections.join("\n\n");
}

/**
 * Map a typed agent output + the summed tokens onto the {@link SubAgentWork} seam,
 * honouring `exactOptionalPropertyTypes` (narration/activity only set when present).
 */
function buildWork(output: PlanOutput, role: string, cycle: number, tokens: bigint): SubAgentWork {
  const files: SourceFile[] = output.files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
  const phase = `cycle ${String(cycle)}`;
  const activity: SubAgentActivity[] | undefined =
    output.activity !== undefined && output.activity.length > 0
      ? output.activity.map((detail) => ({ agent: role, phase, detail }))
      : undefined;
  const narration = output.narration.length > 0 ? output.narration : undefined;
  return {
    files,
    tokensConsumed: tokens,
    ...(narration !== undefined ? { narration } : {}),
    ...(activity !== undefined ? { activity } : {}),
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Construct the planning sub-agent — the supervisor's {@link SubAgents.planning} seam
 * (T140). Each invocation builds a fresh {@link ToolLoopAgent} (so the fault-capture
 * state is per-cycle), grounds the plan in retrieval, and maps the typed output onto
 * {@link SubAgentWork}. An MCP fault re-throws so the supervisor's infra-retry owns it.
 */
export function createPlanningAgent(deps: PlanningAgentDeps): SubAgents["planning"] {
  const maxSteps = deps.maxSteps ?? DEFAULT_PLANNING_STEPS;
  const mnmTool = deps.mnmRetrievalTool ?? MNM_RETRIEVAL_TOOL;
  const tomeTool = deps.tomeRetrievalTool ?? TOME_RETRIEVAL_TOOL;

  return async (ctx: SubAgentCycleContext): Promise<SubAgentWork> => {
    // Per-invocation fault capture: the AI SDK tool loop turns a thrown tool execute
    // into a `tool-error` (it does NOT propagate), so we record the first MCP fault and
    // re-throw it after `generate` — a swallowed infra failure would be invisible.
    let capturedMcpError: unknown;
    const guard: McpGuard = async (op) => {
      try {
        return await op();
      } catch (error) {
        if (capturedMcpError === undefined) {
          capturedMcpError = error;
        }
        throw error;
      }
    };

    const tools = {
      [MANUAL_RETRIEVAL_TOOL]: retrievalTool(
        deps.mnm,
        mnmTool,
        "Search the Midnight Manual for verified Compact/SDK guidance. Ground plans here.",
        guard,
      ),
      ...(deps.tome !== undefined
        ? {
            [EXAMPLES_RETRIEVAL_TOOL]: retrievalTool(
              deps.tome,
              tomeTool,
              "Search the Midnight example corpus for working patterns to model the plan on.",
              guard,
            ),
          }
        : {}),
    };

    const agent = new ToolLoopAgent({
      model: deps.model,
      instructions: PLANNING_INSTRUCTIONS,
      tools,
      stopWhen: isStepCount(maxSteps),
      output: Output.object({ schema: PlanOutputSchema }),
    });

    let result;
    try {
      result = await agent.generate({ prompt: buildPrompt(ctx) });
    } catch (error) {
      // A captured MCP fault is the truer cause than a downstream generate error.
      if (capturedMcpError !== undefined) {
        throwCaptured(capturedMcpError);
      }
      throwCaptured(error);
    }
    if (capturedMcpError !== undefined) {
      throwCaptured(capturedMcpError);
    }

    return buildWork(result.output, "planning", ctx.cycle, usageToTokens(result.usage));
  };
}
