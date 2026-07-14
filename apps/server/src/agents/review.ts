/**
 * Review sub-agent (US1 — T140, D41).
 *
 * The quality step of a verify cycle: it reviews the generated Compact contract +
 * frontend for correctness, privacy, and — the layer that owns test adequacy (D41) —
 * behavioural-test quality, producing a review narration and OPTIONALLY revised files
 * (e.g. an added boundary test or a corrected witness). It reasons about the current
 * failing state when the supervisor feeds forward the prior cycle's compile diagnostics
 * or failing tests (scenario 3). When a retrieval client is supplied it grounds its
 * review in the Midnight Manual (mnm), never in memory (constitution I).
 *
 * This module is the DETERMINISTIC core. The real LLM + the real MCP server are
 * OWNER-GATED, so everything here is exercised with a {@link MockLanguageModelV4} and an
 * optional fake `mnm` client (constitution III/IV):
 *  - the Vercel AI SDK v7 {@link ToolLoopAgent} tool-wiring — an optional
 *    `retrieve_manual` (mnm) tool wrapping {@link McpClient.call} (preserving its D31
 *    bounded-concurrency + deadlines);
 *  - the typed {@link Output.object} review schema → {@link SubAgentWork};
 *  - token accounting from the model usage → a `bigint` base-unit count (D34);
 *  - the fed-forward-diagnostics handling (a retry folds the prior cycle's compile
 *    diagnostics + failing tests into the prompt — scenario 3);
 *  - loud propagation: an MCP fault is NEVER swallowed — it re-throws so the
 *    supervisor's infra-retry owns it.
 *
 * ⚠️ Assumed MCP tool contract (flag — verify vs the live MCP server before un-gating,
 * constitution I): the mnm retrieval tool name is assumed {@link MNM_RETRIEVAL_TOOL}
 * (`"search"`) with a `{ query }` argument; overridable via {@link ReviewAgentDeps}.
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

// ── Assumed tool contracts (flagged — verify vs the live MCP server) ───────────

/** AI SDK tool name the model calls to search the Midnight Manual (mnm-backed). */
export const MANUAL_RETRIEVAL_TOOL = "retrieve_manual";

/**
 * The MCP tool name invoked on the `mnm` client. ASSUMED `"search"` with a `{ query }`
 * argument — VERIFY against the live Midnight Manual MCP; overridable via
 * {@link ReviewAgentDeps.mnmRetrievalTool}.
 */
export const MNM_RETRIEVAL_TOOL = "search";

/** Default ToolLoopAgent step budget (optional retrieval + the final review). */
export const DEFAULT_REVIEW_STEPS = 6;

// ── Seam types ─────────────────────────────────────────────────────────────────

/**
 * The narrow MCP surface this agent depends on — just {@link McpClient.call}. A real
 * `McpClient` satisfies it structurally; tests inject a fake with a single `call` spy.
 */
export interface McpCallable {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Injected dependencies for {@link createReviewAgent}. */
export interface ReviewAgentDeps {
  /** The routed review model (D19) — production wires `ModelRouter.model("review")`. */
  readonly model: LanguageModel;
  /** The Midnight Manual retrieval client (optional grounding source, D3). */
  readonly mnm?: McpCallable;
  /** Max ToolLoopAgent steps; default {@link DEFAULT_REVIEW_STEPS}. */
  readonly maxSteps?: number;
  /** Override the assumed mnm MCP tool name; default {@link MNM_RETRIEVAL_TOOL}. */
  readonly mnmRetrievalTool?: string;
}

// ── Structured output schema ─────────────────────────────────────────────────────

/** One revised source file (structurally a {@link SourceFile}). */
const OutputFileSchema = z.object({ path: z.string().min(1), content: z.string() });

/**
 * The typed review the model returns: a narration verdict, any revised files (an added
 * test or a correction), and an optional activity feed.
 */
const ReviewOutputSchema = z.object({
  narration: z.string(),
  files: z.array(OutputFileSchema).default([]),
  activity: z.array(z.string()).optional(),
});
type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// ── Shared internal helpers (kept inline per the no-extra-files constraint) ──────

/** A guard wrapping an MCP call: records the first fault so it can re-throw later. */
type McpGuard = <T>(op: () => Promise<T>) => Promise<T>;

/** The review system prompt — quality/correctness + test adequacy (D41). */
const REVIEW_INSTRUCTIONS = [
  "You are the Review agent for Nyx, a prompt-to-DApp builder for Midnight.",
  "Review the generated Compact contract, witnesses, and React frontend for correctness,",
  "privacy (disclosure boundaries), and behavioural-test adequacy — you own test adequacy.",
  "When retrieve_manual is available, ground any correctness claim in the Midnight Manual",
  "rather than memory. If prior compile diagnostics or failing tests are provided, focus the",
  "review on them. Return a concise verdict as a narration, an activity list of what you",
  "checked, and any revised files (a corrected witness or an added behavioural test).",
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
  return ["Compile diagnostics from the previous cycle to weigh in the review:", ...lines].join(
    "\n",
  );
}

/** Render fed-forward failing tests into a promptable block (scenario 3). */
function renderFailures(failures: readonly TestFailure[]): string {
  const lines = failures.map((failure) => `- ${failure.name}: ${failure.message}`);
  return [
    "Behavioural test failures from the previous cycle to weigh in the review:",
    ...lines,
  ].join("\n");
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
function buildWork(
  output: ReviewOutput,
  role: string,
  cycle: number,
  tokens: bigint,
): SubAgentWork {
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
 * Construct the review sub-agent — the supervisor's {@link SubAgents.review} seam
 * (T140). Runs with or without a retrieval client; when one is supplied it grounds the
 * review in the Midnight Manual. Any MCP fault re-throws so the supervisor's infra-retry
 * owns it.
 */
export function createReviewAgent(deps: ReviewAgentDeps): SubAgents["review"] {
  const maxSteps = deps.maxSteps ?? DEFAULT_REVIEW_STEPS;
  const mnmTool = deps.mnmRetrievalTool ?? MNM_RETRIEVAL_TOOL;

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

    const tools =
      deps.mnm !== undefined
        ? {
            [MANUAL_RETRIEVAL_TOOL]: retrievalTool(
              deps.mnm,
              mnmTool,
              "Search the Midnight Manual to ground correctness/privacy findings.",
              guard,
            ),
          }
        : {};

    const agent = new ToolLoopAgent({
      model: deps.model,
      instructions: REVIEW_INSTRUCTIONS,
      tools,
      stopWhen: isStepCount(maxSteps),
      output: Output.object({ schema: ReviewOutputSchema }),
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

    return buildWork(result.output, "review", ctx.cycle, usageToTokens(result.usage));
  };
}
