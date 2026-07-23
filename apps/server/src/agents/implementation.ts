/**
 * Implementation sub-agent (US1 — T140, D3/FR-002).
 *
 * The build step of a verify cycle: it writes the privacy-preserving Compact contract
 * + witnesses, the React frontend, and the behavioural tests for the plan — GROUNDED
 * in retrieval (the Midnight Manual `mnm` + the example corpus `tome`), never
 * hand-written from memory (D3, constitution I).
 *
 * ⚠️ P2 — the compiler MCP is retired: user contracts compile in the USER'S BROWSER
 * (`@nyx/compact-wasm`), so there is no compile-check tool here anymore. The authoritative
 * compile feedback is the SUPERVISOR's per-cycle CHECK through the `CompileClient` seam
 * (which now delegates to the browser toolchain); its diagnostics are fed forward into the
 * next cycle's prompt (scenario 3) so the agent iterates against real compiler output.
 *
 * This module is the DETERMINISTIC core. The real LLM + the real retrieval MCP servers
 * (mnm, tome) are OWNER-GATED, so everything here is exercised with a
 * {@link MockLanguageModelV4} and fake clients (constitution III/IV):
 *  - the Vercel AI SDK v7 {@link ToolLoopAgent} tool-wiring — `retrieve_manual` (mnm) and
 *    `retrieve_examples` (tome), each wrapping {@link McpClient.call} (preserving its D31
 *    bounded-concurrency + deadlines);
 *  - the typed {@link Output.object} file set → {@link SubAgentWork.files};
 *  - token accounting from the model usage → a `bigint` base-unit count (D34);
 *  - the fed-forward-diagnostics handling (a retry folds the prior cycle's compile
 *    diagnostics + failing tests into the prompt so the agent consults retrieval + the
 *    diagnostics rather than regenerating from memory — scenario 3);
 *  - loud propagation: a retrieval MCP fault NEVER gets swallowed — it re-throws so the
 *    supervisor's infra-retry owns it.
 *
 * ⚠️ Assumed MCP tool contracts (flag — verify vs the live MCP servers before
 * un-gating, constitution I): the retrieval tool name is assumed
 * {@link MNM_RETRIEVAL_TOOL}/{@link TOME_RETRIEVAL_TOOL} (`"search"`, `{ query }`),
 * overridable via {@link ImplementationAgentDeps} so the owner can reconcile them.
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

/** AI SDK tool name the model calls to search the Midnight Manual (mnm-backed). */
export const MANUAL_RETRIEVAL_TOOL = "retrieve_manual";

/** AI SDK tool name the model calls to search the example corpus (tome-backed). */
export const EXAMPLES_RETRIEVAL_TOOL = "retrieve_examples";

/**
 * The MCP tool name invoked on the `mnm` client. ASSUMED `"search"` with a `{ query }`
 * argument — VERIFY against the live Midnight Manual MCP; overridable via
 * {@link ImplementationAgentDeps.mnmRetrievalTool}.
 */
export const MNM_RETRIEVAL_TOOL = "search";

/**
 * The MCP tool name invoked on the `tome` client. ASSUMED `"search"` with a `{ query }`
 * argument — VERIFY against the live Tome MCP; overridable via
 * {@link ImplementationAgentDeps.tomeRetrievalTool}.
 */
export const TOME_RETRIEVAL_TOOL = "search";

/** Default ToolLoopAgent step budget (retrieval iterations + the final files). */
export const DEFAULT_IMPLEMENTATION_STEPS = 12;

// ── Seam types ─────────────────────────────────────────────────────────────────

/**
 * The narrow MCP surface this agent depends on — just {@link McpClient.call}. A real
 * `McpClient` satisfies it structurally; tests inject a fake with a single `call` spy.
 */
export interface McpCallable {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Injected dependencies for {@link createImplementationAgent}. */
export interface ImplementationAgentDeps {
  /** The routed implementation model (D19) — production wires `ModelRouter.model("implementation")`. */
  readonly model: LanguageModel;
  /** The Midnight Manual retrieval client (required grounding source, D3). */
  readonly mnm: McpCallable;
  /** The example-corpus retrieval client (required grounding source, D3). */
  readonly tome: McpCallable;
  /** Max ToolLoopAgent steps; default {@link DEFAULT_IMPLEMENTATION_STEPS}. */
  readonly maxSteps?: number;
  /**
   * Optional platform STEERING appended to the agent's baked base
   * {@link IMPLEMENTATION_INSTRUCTIONS} (it AUGMENTS, never replaces, them). Production
   * injects the `@nyx/scaffold` house rules via `buildImplementationInstructions()` (all
   * four rules incl. compact-testing — D10/D37/FR-027/FR-037/FR-080); absent = the base
   * instructions only (unchanged behaviour).
   */
  readonly steering?: string;
  /** Override the assumed mnm MCP tool name; default {@link MNM_RETRIEVAL_TOOL}. */
  readonly mnmRetrievalTool?: string;
  /** Override the assumed tome MCP tool name; default {@link TOME_RETRIEVAL_TOOL}. */
  readonly tomeRetrievalTool?: string;
}

// ── Structured output schema ─────────────────────────────────────────────────────

/** One produced source file (structurally a {@link SourceFile}). */
const OutputFileSchema = z.object({ path: z.string().min(1), content: z.string() });

/**
 * The typed file set the model returns: narration, the contract + witness + React +
 * test files, and an optional activity feed.
 */
const ImplementationOutputSchema = z.object({
  narration: z.string(),
  files: z.array(OutputFileSchema).default([]),
  activity: z.array(z.string()).optional(),
});
type ImplementationOutput = z.infer<typeof ImplementationOutputSchema>;

// ── Shared internal helpers (kept inline per the no-extra-files constraint) ──────

/** A guard wrapping an MCP call: records the first fault so it can re-throw later. */
type McpGuard = <T>(op: () => Promise<T>) => Promise<T>;

/** The implementation system prompt — mandates retrieval grounding for every Compact/SDK shape. */
const IMPLEMENTATION_INSTRUCTIONS = [
  "You are the Implementation agent for Nyx, a prompt-to-DApp builder for Midnight.",
  "Write the privacy-preserving Compact contract and witnesses, the React frontend, and the",
  "behavioural tests for the plan. GROUND every Compact and SDK shape in retrieval: call",
  "retrieve_manual (the Midnight Manual) and retrieve_examples (the example corpus) before you",
  "write any contract, ledger ADT, stdlib call, witness, or SDK API. Never write Compact or SDK",
  "code from memory. Your Compact is compiled in the user's browser toolchain each cycle; if",
  "prior compile diagnostics or failing tests are provided, fix them — re-consult retrieval for",
  "the exact shapes. Return the full file set with a narration and an activity list.",
].join(" ");

/** The separator between the agent's base instructions and any appended platform steering. */
const STEERING_SEPARATOR = "\n\n";

/**
 * Compose the agent's effective system instructions: the baked base, optionally
 * AUGMENTED (never replaced) by the platform steering — base first, then a blank-line
 * separator, then the steering — so the Nyx house rules layer ON TOP of the agent's own
 * instructions ({@link ImplementationAgentDeps.steering}). Absent (or empty) steering
 * yields the base verbatim, so the default behaviour is unchanged.
 */
function composeInstructions(base: string, steering: string | undefined): string {
  return steering === undefined || steering.length === 0
    ? base
    : `${base}${STEERING_SEPARATOR}${steering}`;
}

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
    "Compile diagnostics from the previous cycle to fix (ground the fix in retrieval):",
    ...lines,
  ].join("\n");
}

/** Render fed-forward failing tests into a promptable block (scenario 3). */
function renderFailures(failures: readonly TestFailure[]): string {
  const lines = failures.map((failure) => `- ${failure.name}: ${failure.message}`);
  return ["Behavioural test failures from the previous cycle to fix:", ...lines].join("\n");
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
  output: ImplementationOutput,
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
 * Construct the implementation sub-agent — the supervisor's
 * {@link SubAgents.implementation} seam (T140). Each invocation grounds in retrieval and
 * produces the file set; the browser toolchain compiles the produced Compact each cycle
 * (P2), so there is no in-agent compile step. Any retrieval MCP fault re-throws so the
 * supervisor's infra-retry owns it.
 */
export function createImplementationAgent(
  deps: ImplementationAgentDeps,
): SubAgents["implementation"] {
  const maxSteps = deps.maxSteps ?? DEFAULT_IMPLEMENTATION_STEPS;
  const mnmTool = deps.mnmRetrievalTool ?? MNM_RETRIEVAL_TOOL;
  const tomeTool = deps.tomeRetrievalTool ?? TOME_RETRIEVAL_TOOL;
  // Stable across every invocation (ctx-independent): the base instructions augmented by
  // any injected platform steering (`@nyx/scaffold` house rules).
  const instructions = composeInstructions(IMPLEMENTATION_INSTRUCTIONS, deps.steering);

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
        "Search the Midnight Manual for verified Compact/SDK shapes before writing code.",
        guard,
      ),
      [EXAMPLES_RETRIEVAL_TOOL]: retrievalTool(
        deps.tome,
        tomeTool,
        "Search the Midnight example corpus for working contract/frontend patterns.",
        guard,
      ),
    };

    const agent = new ToolLoopAgent({
      model: deps.model,
      instructions,
      tools,
      stopWhen: isStepCount(maxSteps),
      output: Output.object({ schema: ImplementationOutputSchema }),
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

    return buildWork(result.output, "implementation", ctx.cycle, usageToTokens(result.usage));
  };
}
