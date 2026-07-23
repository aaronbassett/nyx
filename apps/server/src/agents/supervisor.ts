/**
 * Nyx supervisor + turn state machine — the US1 orchestration core (T138).
 *
 * This is the DETERMINISTIC turn state machine that fuses the already-built US1
 * primitives into one prompt→DApp lifecycle: the ledger (reserve-then-settle,
 * D34), the intent classifier (D25), the sub-agent swarm (scaffolding / planning
 * / implementation / review), the compile pipeline (compile-before-surface,
 * FR-002/D35), the behavioural verify budget (≤3 cycles, D21), and chat
 * persistence (D23). Every side effect is an INJECTED SEAM — the real LLM calls,
 * the real Compile Service, and the real WebContainer are OWNER-GATED — so the
 * whole machine is exercised with NO model, NO network, and NO container
 * (constitution III/IV). Nothing here reads a wall clock or randomness: the clock
 * is `ctx.now`, the backoff is `retryDelay`, and the money is `bigint` in code but
 * a decimal STRING on the wire (the protocol encoders own that boundary).
 *
 * The turn lifecycle (spec P1; D21/D24/D25/D34/D35; FR-002/004/005/009/010):
 *  1. Single active turn (D24/FR-009) — a per-project lock, acquired SYNCHRONOUSLY
 *     at method entry so a racing second prompt can never open a second turn. A
 *     locked project rejects the new prompt (input-locked message) without opening
 *     a turn.
 *  2. Open the turn (`classifying`) + append the user's prompt to chat.
 *  3. Classify (D25). Off-domain ⇒ `decline` (NO reserve), a decline message, and
 *     return — nothing consumed, so NO settle (FR-010).
 *  4. Reserve (accept). A below-gate reserve ⇒ a top-up CTA (EC-01) and return —
 *     nothing ran, so NO settle.
 *  5. Verify loop (≤3 cycles, D21). Per cycle: run the cycle's sub-agents →
 *     emit their activity/narration + `file:write`s → compile-CHECK the result
 *     (compile-before-surface: a failed check is a failing cycle, never done work,
 *     FR-002/SC-002) → on a clean check, await the CLIENT's behavioural tests and
 *     record the verdict. Green ⇒ the ONE full compile (D35/FR-029) + a
 *     done-presentation. Exhausted ⇒ an honest failure summary (WIP kept + a
 *     suggested next prompt, D21). A thrown infra fault retries with backoff, then
 *     fails LOUDLY naming the service (scenario 5).
 *  6. Settle ALWAYS on any non-declined/non-insufficient outcome (success, honest
 *     failure, infra failure) at ACTUAL consumption (the SUM of sub-agent tokens),
 *     emitting the encoded `turn:settled` + `ledger:update` frames (D34).
 *
 * Per-cycle sub-agent composition (documented, deterministic):
 *  - Cold-start (the project's FIRST turn, FR-003) cycle 1: scaffolding → planning
 *    → implementation → review. Scaffolding bootstraps the skeleton exactly once.
 *  - Every other cycle (cold-start cycles 2-3, and every cycle of a warm project):
 *    planning → implementation → review.
 * Later agents override earlier ones per file path within a cycle; the merged set
 * is the cycle's file changes.
 *
 * ⚠️ Seam note (owner-gated wiring): the compile is SPLIT into two seams so D35 holds
 * exactly — there is exactly ONE full compile per green turn, gated on green TESTS. The
 * per-cycle {@link SupervisorDeps.checkCompile} is the fast CHECK only (no proving keys,
 * no R2 upload, no announce), so a check-pass NEVER surfaces artifacts before the
 * behavioural tests run (FR-002/FR-029). The FULL compile ({@link SupervisorDeps.runFullCompile},
 * which wraps the real {@link ArtifactOrchestrator.runTurn}) is what does the keygen,
 * zkir, manifest→R2 upload, and the single `artifacts:ready` — it fires at-most-once via
 * the {@link GreenCompileTrigger}'s latch, ONLY on a green {@link VerifyDecision} (D35).
 * Production wraps `CompileClient.check` + `ArtifactOrchestrator.runTurn` behind these
 * seams; that wiring is the owner-gated step (T139/T140).
 */
import { encodeLedgerUpdateEvent, encodeTurnSettledEvent } from "@nyx/protocol";
import type {
  FileWriteEvent,
  LedgerEntry,
  LedgerUpdateEvent,
  LedgerUpdateEventWire,
  MidnightAddress,
  TestFailure,
  TestResultsPayload,
  TurnActivityEvent,
  TurnId,
  TurnMessageEvent,
  TurnMessageRole,
  TurnSettledEvent,
  TurnSettledEventWire,
} from "@nyx/protocol";
import type { CompileOutcome, CompileTurnInput, Diagnostic, SourceFile } from "../compile/index.js";
import type { ChatStore } from "../projects/chat.js";
import type { CommitResult, FileWrite } from "../projects/store.js";
import type { Balance, LedgerStore } from "../ledger/ledger.js";
import { InsufficientAvailableError } from "../ledger/ledger.js";
import { capTestResults } from "./coverage.js";
import { createGreenCompileTrigger, createVerifyBudget } from "./verify.js";
import type {
  GreenCompileTrigger,
  GreenCompileTriggerDeps,
  VerifyBudget,
  VerifyBudgetOptions,
  VerifyDiagnostic,
} from "./verify.js";

// ── Public seam types ─────────────────────────────────────────────────────────

/** The session context a turn runs under — carries the account address (D43). */
export interface SupervisorSession {
  /** The wallet's unshielded address — the ledger account key (D43). */
  readonly address: string;
}

/**
 * The JSON-safe frames the supervisor may hand to {@link SupervisorContext.send}.
 *
 * Money-bearing events are the ENCODED wire forms ({@link TurnSettledEventWire} /
 * {@link LedgerUpdateEventWire}) whose amounts are decimal strings — so a
 * `bigint`-carrying (unencoded) frame is a COMPILE error here, not a runtime
 * `JSON.stringify` throw. The rest carry no `bigint` and cross as-is.
 */
export type OutboundEvent =
  | TurnMessageEvent
  | TurnActivityEvent
  | FileWriteEvent
  | TurnSettledEventWire
  | LedgerUpdateEventWire;

/** The per-turn context the WS session layer supplies to {@link Supervisor.handlePrompt}. */
export interface SupervisorContext {
  /** The authenticated session (its account address is the ledger key). */
  readonly session: SupervisorSession;
  /** The project this connection is bound to (mirrors the prompt's project id). */
  readonly projectId: string;
  /** Emit one server→client frame (JSON-safe; money already encoded). */
  send(event: OutboundEvent): void | Promise<void>;
  /** Deterministic clock for event `ts`; defaults to `Date.now` when absent. */
  now?(): number;
}

/** The prompt that opens a turn — `prompt:submit`'s payload (D62). */
export interface TurnPrompt {
  readonly projectId: string;
  readonly text: string;
}

/** The intent classifier verdict (D25). `off-domain` declines with no charge. */
export interface IntentResult {
  readonly kind: "dapp" | "off-domain";
  /** Optional human reason folded into the decline message. */
  readonly reason?: string;
}

/**
 * The intent-classifier seam (D25, cheap tier). Production wraps the routed
 * supervisor model + `Output.choice`; tests inject a pure verdict function.
 */
export type IntentClassifier = (text: string) => Promise<IntentResult>;

/** One entry in a sub-agent's activity feed (`turn:activity` minus the turn id, D20). */
export interface SubAgentActivity {
  /** The sub-agent that produced this activity (scaffolding/planning/…). */
  readonly agent: string;
  /** The phase label (e.g. `cycle 1`). */
  readonly phase: string;
  /** Human-readable detail rendered in the activity stream. */
  readonly detail: string;
}

/** The output of one sub-agent invocation for a cycle. */
export interface SubAgentWork {
  /** The file changes this sub-agent produced (later agents override earlier). */
  readonly files: readonly SourceFile[];
  /** NYXT base units this sub-agent consumed — summed into the turn's settle (D34). */
  readonly tokensConsumed: bigint;
  /** Optional supervisor narration streamed as a `turn:message` (D20). */
  readonly narration?: string;
  /** Optional explicit activity feed; a single default is emitted when omitted. */
  readonly activity?: readonly SubAgentActivity[];
}

/** The context handed to each sub-agent for a cycle. */
export interface SubAgentCycleContext {
  readonly projectId: string;
  readonly turnId: string;
  /** The user's original prompt text for this turn. */
  readonly prompt: string;
  /** 1-based verify cycle (D21). */
  readonly cycle: number;
  /** True on the project's FIRST turn — the FR-003 scaffolding gate. */
  readonly coldStart: boolean;
  /** Diagnostics fed forward from a prior cycle's failed compile CHECK. */
  readonly compileDiagnostics: readonly Diagnostic[];
  /** Failing tests fed forward from a prior cycle's failed behavioural suite. */
  readonly testFailures: readonly TestFailure[];
}

/**
 * The sub-agent swarm seam. Each role is a pure `(cycleCtx) => Promise<SubAgentWork>`
 * function so the whole loop is mock-tested; the REAL agents (T139/T140) wrap the
 * routed models. The supervisor decides the per-cycle composition (see the module
 * header), not the swarm.
 */
export interface SubAgents {
  scaffolding(ctx: SubAgentCycleContext): Promise<SubAgentWork>;
  planning(ctx: SubAgentCycleContext): Promise<SubAgentWork>;
  implementation(ctx: SubAgentCycleContext): Promise<SubAgentWork>;
  review(ctx: SubAgentCycleContext): Promise<SubAgentWork>;
}

/**
 * The result of one cycle's compile CHECK — the fast, no-keys, no-upload, no-announce
 * path (D35). `ok` proceeds to the behavioural tests; `!ok` is a failing cycle whose
 * `diagnostics` feed the next cycle (compile-before-surface, FR-002). A structural
 * subset of the Compile Service's check response, so production returns that verbatim.
 */
export interface CheckOutcome {
  /** True when the check is clean (or nothing to compile) — proceed to the tests. */
  readonly ok: boolean;
  /** The check's structured diagnostics (empty when `ok`), fed forward on a failure. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The per-cycle compile-CHECK seam (D35) — the compile-before-surface fast path: no
 * proving keys, no R2 upload, no announce. A transport/service fault THROWS (→ the
 * infra path); a clean or failed check is DATA in {@link CheckOutcome}. Production
 * wraps the Compile Service's `check` fast path; tests inject a verdict function.
 */
export type CheckCompiler = (input: CompileTurnInput) => Promise<CheckOutcome>;

/**
 * The green-only FULL compile seam (D35/FR-029) — proving keys, zkir, manifest→R2, and
 * the single `artifacts:ready`. Fired at-most-once by the {@link GreenCompileTrigger},
 * ONLY on a green {@link VerifyDecision} (never on a mere check-pass). A transport/service
 * fault THROWS (→ the infra path); every other result is DATA in the {@link CompileOutcome}
 * union. Production wraps {@link ArtifactOrchestrator.runTurn}.
 */
export type FullCompiler = (input: CompileTurnInput) => Promise<CompileOutcome>;

/**
 * The behavioural-test continuation seam: resolves when the CLIENT's WebContainer
 * emits `test:results` for this turn (FR-007). Production wires it to the WS
 * `test:results` handler as a per-turn promise; tests return canned verdicts.
 */
export type AwaitTestResults = (turnId: string) => Promise<TestResultsPayload>;

/** The ledger surface the supervisor depends on (a subset of {@link LedgerStore}). */
export type SupervisorLedger = Pick<
  LedgerStore,
  "openTurn" | "decline" | "placeReserve" | "settle" | "getEntries"
>;

/** Injected dependencies for {@link createSupervisor} — every seam is fakeable. */
export interface SupervisorDeps {
  /** Reserve-then-settle metering (D34). */
  readonly ledger: SupervisorLedger;
  /** The per-cycle compile CHECK (compile-before-surface, fast — no keys/upload/announce, D35). */
  readonly checkCompile: CheckCompiler;
  /** The green-only FULL compile (D35/FR-029) — keys, zkir, R2 upload, the one `artifacts:ready`. */
  readonly runFullCompile: FullCompiler;
  /** Chat persistence + rehydration (D23); also the cold-start signal (FR-003). */
  readonly chat: ChatStore;
  /**
   * Persist a turn's accumulated files as ONE agent-authored commit (SC-026) at every
   * turn ending that reached the verify loop. REQUIRED — the US13 exports and the US14
   * editor read the resulting `project_file_versions` rows; a settled turn must never be
   * hollow. Production wires it to {@link ProjectStore.commit} with `author: "agent"`.
   */
  readonly commitFiles: (projectId: string, files: readonly FileWrite[]) => Promise<CommitResult>;
  /** The flat pre-turn reserve in NYXT base units (D34/D47). */
  readonly flatReserve: bigint;
  /** Intent classification (D25). */
  readonly classifyIntent: IntentClassifier;
  /** The sub-agent swarm. */
  readonly subAgents: SubAgents;
  /** The behavioural-test continuation (FR-007). */
  readonly awaitTestResults: AwaitTestResults;
  /** Verify-budget factory (D21); defaults to {@link createVerifyBudget}. */
  readonly verifyBudget?: (options?: VerifyBudgetOptions) => VerifyBudget;
  /** Green→full-compile trigger factory (D35); defaults to {@link createGreenCompileTrigger}. */
  readonly greenTrigger?: (deps: GreenCompileTriggerDeps) => GreenCompileTrigger;
  /** Max infra RETRIES before failing loudly (scenario 5); default {@link DEFAULT_MAX_INFRA_RETRIES}. */
  readonly maxInfraRetries?: number;
  /** Backoff seam between infra retries; defaults to an immediate (deterministic) resolve. */
  readonly retryDelay?: (attempt: number) => Promise<void>;
  /**
   * The bounded-timeout delay seam for turn-end file persistence (mirrors the coordinator's
   * D42 `delay`+`timeoutMs` no-hang pattern). Defaults to an unref'd `setTimeout` so a live
   * bound never pins the process; tests inject an immediate/fake-time resolve to drive the
   * timeout deterministically.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Bounded wait for {@link commitFiles} before the turn proceeds to its money terminal
   * (I2 no-hang); default {@link DEFAULT_PERSIST_TIMEOUT_MS}. A HUNG store must never
   * postpone `turn:settled` (input locked, reserve held) — a timeout is treated exactly
   * like a commit failure: logged loudly onto the activity feed, then settle continues.
   */
  readonly persistTimeoutMs?: number;
}

/**
 * The terminal result of a turn — a discriminated union callers + tests assert on.
 * Every variant carries the turn id, the cycle count, and the consumed tokens so
 * exactly what happened is observable without re-deriving it.
 */
export type TurnResult =
  /** D24/FR-009 — a turn was already active; the new prompt was rejected. */
  | {
      readonly kind: "rejected";
      readonly reason: "turn-active";
      readonly turnId: string;
      readonly cycles: 0;
      readonly consumed: bigint;
    }
  /** D25/FR-010 — an off-domain prompt; declined with no charge. */
  | {
      readonly kind: "declined";
      readonly turnId: string;
      readonly cycles: 0;
      readonly consumed: bigint;
    }
  /** EC-01 — a below-gate reserve; a top-up CTA, no charge. */
  | {
      readonly kind: "insufficient-balance";
      readonly turnId: string;
      readonly cycles: 0;
      readonly consumed: bigint;
    }
  /** D35/FR-029 — a green suite; the full compile ran + a done-presentation. */
  | {
      readonly kind: "green";
      readonly turnId: string;
      readonly cycles: number;
      readonly consumed: bigint;
    }
  /** D21 — the verify budget was exhausted; an honest failure, still charged. */
  | {
      readonly kind: "exhausted";
      readonly turnId: string;
      readonly cycles: number;
      readonly consumed: bigint;
    }
  /**
   * A thrown infra fault (scenario 5) — failed loudly. The {@link settled} flag
   * distinguishes the TWO sub-shapes so the coordinator emits the terminal unlock exactly
   * when the supervisor did not: a reserve-time fault never reserved (nothing settled), a
   * verify-loop fault settled at actual after a reserve.
   */
  | {
      readonly kind: "infra-failed";
      readonly turnId: string;
      readonly cycles: number;
      readonly consumed: bigint;
      /** The service named in the loud failure. */
      readonly service: string;
      /**
       * True when the supervisor already settled + emitted its own `turn:settled` (the
       * verify-loop infra path settles at actual). False when the fault happened at RESERVE
       * time — nothing was reserved or settled, so NO terminal frame was sent and the
       * coordinator must synthesize the zero-consumed unlock (else the client's input, which
       * only unlocks on `turn:settled`/`declined`, stays locked forever).
       */
      readonly settled: boolean;
    };

/** The supervisor's public surface — one method drives a whole turn. */
export interface Supervisor {
  /** Drive one prompt to a terminal {@link TurnResult}; never throws for a designed outcome. */
  handlePrompt(ctx: SupervisorContext, prompt: TurnPrompt): Promise<TurnResult>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default infra RETRIES before a loud named failure (scenario 5). */
export const DEFAULT_MAX_INFRA_RETRIES = 3;

/**
 * Default bounded wait for turn-end file persistence (I2 no-hang). A commit that has not
 * completed within this window is treated exactly like a failed commit — logged loudly,
 * then the turn proceeds to settle — so a hung {@link SupervisorDeps.commitFiles} store can
 * never postpone the money terminal (input locked, reserve held) indefinitely.
 */
export const DEFAULT_PERSIST_TIMEOUT_MS = 10_000;

/** The service name attributed to a thrown compile fault. */
const COMPILE_SERVICE_NAME = "Compile Service";

/** The service name attributed to an unexpected ledger fault at reserve time. */
const LEDGER_SERVICE_NAME = "ledger";

/** The strictly-positive floor for a settle amount (the ledger rejects `<= 0`). */
const MIN_SETTLE_AMOUNT = 1n;

/** The input-locked message surfaced when a turn is already active (D24). */
const INPUT_LOCKED_MESSAGE =
  "Input is locked while the current turn finishes. I'll unlock it as soon as this turn settles.";

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * The default persist-timeout delay — an UNREF'd timer so a live bounded wait never pins
 * the process. Mirrors the coordinator's `defaultDelay` (the D42 no-hang pattern).
 */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Sentinel signalling the persist bound timed out before {@link SupervisorDeps.commitFiles} resolved. */
const PERSIST_TIMEOUT = Symbol("persist-timeout");

/**
 * A thrown infra fault that survived every retry (scenario 5). Carries the named
 * service so the loud failure can attribute the outage; caught at the loop
 * boundary and converted to the settle-and-fail-loud ending.
 */
class InfraFailureError extends Error {
  constructor(
    readonly service: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(`infra failure calling ${service} after ${String(attempts)} attempt(s)`);
    this.name = "InfraFailureError";
  }
}

/**
 * A settle that survived every bounded retry (BUG-2). Deliberately NOT a subclass of
 * {@link InfraFailureError} so the verify-loop catch does not re-route it back through a
 * SECOND settle — it propagates straight out of `handlePrompt` to the coordinator's
 * catch-all backstop, which logs it loudly and still unlocks the client's input.
 *
 * ⚠️ Residual: a settle that ultimately fails leaves the turn's reserve stranded
 * `reserved` (there are NO credit-backs, D34) — a later reconcile has to release it.
 */
class SettleFailureError extends Error {
  constructor(
    readonly turnId: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(`settle failed for turn ${turnId} after ${String(attempts)} attempt(s)`);
    this.name = "SettleFailureError";
  }
}

/** The classification of one cycle's compile CHECK (compile-before-surface). */
type CompileCheck =
  /** The check is clean (or nothing to compile) — proceed to the behavioural tests. */
  | { readonly ok: true }
  /** The check surfaced compile problems — a failing cycle; feed the diagnostics forward. */
  | {
      readonly ok: false;
      readonly diagnostics: readonly VerifyDiagnostic[];
      readonly raw: readonly Diagnostic[];
    };

/** Project a compiler {@link Diagnostic} onto a {@link VerifyDiagnostic} for the budget. */
function toVerifyDiagnostic(diagnostic: Diagnostic): VerifyDiagnostic {
  return {
    testName: diagnostic.file ?? diagnostic.code ?? diagnostic.source,
    message: diagnostic.message,
  };
}

/** Project failing {@link TestFailure}s onto {@link VerifyDiagnostic}s for the budget. */
function toVerifyDiagnostics(failures: readonly TestFailure[]): readonly VerifyDiagnostic[] {
  return failures.map((failure) => ({ testName: failure.name, message: failure.message }));
}

/**
 * Classify one cycle's {@link CheckOutcome} for the verify loop. `ok` (a clean check,
 * or nothing to compile) proceeds to the behavioural tests; `!ok` is a failing cycle
 * whose diagnostics feed the next cycle (compile-before-surface, FR-002/SC-002). A
 * THROW is never seen here — it is handled by the infra path — so the only failures
 * reaching the budget are DATA, never faults.
 */
function classifyCheck(outcome: CheckOutcome): CompileCheck {
  if (outcome.ok) {
    return { ok: true };
  }
  const raw = outcome.diagnostics;
  const diagnostics =
    raw.length > 0
      ? raw.map(toVerifyDiagnostic)
      : [{ testName: "compile", message: "compile check failed" }];
  return { ok: false, diagnostics, raw: [...raw] };
}

/** Build the off-domain decline message (D25) — explains what Nyx is for. */
function declineMessage(reason: string | undefined): string {
  const because = reason === undefined || reason.length === 0 ? "" : ` (${reason})`;
  return (
    `This request is outside what Nyx does${because}. Nyx builds privacy-preserving ` +
    `DApps for Midnight from a prompt — describe the app you want and I'll scaffold, ` +
    `implement, and verify it. Nothing was charged for this.`
  );
}

/** Build the below-gate top-up call-to-action (EC-01). */
function topUpMessage(error: InsufficientAvailableError): string {
  return (
    `Your NYXT balance is too low to start this turn (need ${String(error.required)} ` +
    `base units, have ${String(error.available)}). Top up your balance and try again — ` +
    `nothing was charged.`
  );
}

/** Build the loud named infra-failure message (scenario 5). */
function infraMessage(service: string): string {
  return (
    `The ${service} is currently unavailable, so this turn could not finish. Your ` +
    `work in progress is kept — please try again shortly.`
  );
}

/** Build the honest exhaustion summary message (D21) — WIP kept + next prompt. */
function exhaustionMessage(
  suggestedNextPrompt: string,
  diagnostics: readonly VerifyDiagnostic[],
): string {
  const lines = [
    "I couldn't reach a verified, passing state within the retry budget.",
    "Your work in progress is kept so you can continue from here.",
    suggestedNextPrompt,
  ];
  if (diagnostics.length > 0) {
    lines.push("Outstanding issues:");
    for (const diagnostic of diagnostics) {
      lines.push(`- ${diagnostic.testName}: ${diagnostic.message}`);
    }
  }
  return lines.join("\n");
}

/** The green done-presentation message. */
const DONE_MESSAGE =
  "Done — the contract compiled cleanly and the behavioural test suite passed. Your preview is live.";

/** The parameters threaded through the accepted (post-reserve) turn body. */
interface TurnParams {
  readonly projectId: string;
  readonly text: string;
  readonly address: string;
  readonly turnId: string;
  readonly coldStart: boolean;
}

/** One step of a cycle's sub-agent composition. */
interface AgentStep {
  readonly name: string;
  readonly run: (ctx: SubAgentCycleContext) => Promise<SubAgentWork>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

/** The single-instance {@link Supervisor} (one per server; per-project locking inside). */
class TurnSupervisor implements Supervisor {
  /**
   * Per-project turn lock (D24/FR-009). `has(projectId)` = a turn is live;
   * `get(projectId)` is the active turn id once known (`null` in the tiny window
   * between synchronous lock acquisition and `openTurn` resolving).
   */
  private readonly active = new Map<string, string | null>();
  private readonly maxInfraRetries: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly persistTimeoutMs: number;
  private readonly makeBudget: (options?: VerifyBudgetOptions) => VerifyBudget;
  private readonly makeTrigger: (deps: GreenCompileTriggerDeps) => GreenCompileTrigger;

  constructor(private readonly deps: SupervisorDeps) {
    this.maxInfraRetries = deps.maxInfraRetries ?? DEFAULT_MAX_INFRA_RETRIES;
    this.retryDelay = deps.retryDelay ?? (() => Promise.resolve());
    this.delay = deps.delay ?? defaultDelay;
    this.persistTimeoutMs = deps.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;
    this.makeBudget = deps.verifyBudget ?? createVerifyBudget;
    this.makeTrigger = deps.greenTrigger ?? createGreenCompileTrigger;
  }

  async handlePrompt(ctx: SupervisorContext, prompt: TurnPrompt): Promise<TurnResult> {
    const { projectId, text } = prompt;

    // (1) Single active turn — the lock is checked + acquired SYNCHRONOUSLY (before
    // any await) so a racing second prompt can never slip past into a second turn.
    if (this.active.has(projectId)) {
      const activeTurnId = this.active.get(projectId) ?? null;
      if (activeTurnId !== null) {
        await this.emitMessage(ctx, activeTurnId, "supervisor", INPUT_LOCKED_MESSAGE);
      }
      return {
        kind: "rejected",
        reason: "turn-active",
        turnId: activeTurnId ?? "",
        cycles: 0,
        consumed: 0n,
      };
    }
    this.active.set(projectId, null);

    try {
      // Cold-start (FR-003) is decided from chat emptiness BEFORE the user prompt is
      // appended: an empty history means no prior turn ran for this project.
      const priorChat = await this.deps.chat.getChat(projectId);
      const coldStart = priorChat.length === 0;

      // (2) Open the turn (`classifying`) and record the active turn id.
      const turn = await this.deps.ledger.openTurn(projectId);
      const turnId = turn.id;
      this.active.set(projectId, turnId);

      return await this.executeTurn(ctx, {
        projectId,
        text,
        address: ctx.session.address,
        turnId,
        coldStart,
      });
    } finally {
      this.active.delete(projectId);
    }
  }

  /** Classify → reserve → verify loop. Returns a terminal {@link TurnResult}. */
  private async executeTurn(ctx: SupervisorContext, params: TurnParams): Promise<TurnResult> {
    const { projectId, text, address, turnId } = params;

    await this.deps.chat.appendChat(projectId, { role: "user", content: text });

    // (3) Classify (D25). Off-domain declines with no reserve and no settle (FR-010).
    const intent = await this.deps.classifyIntent(text);
    if (intent.kind === "off-domain") {
      await this.deps.ledger.decline(turnId);
      const message = declineMessage(intent.reason);
      await this.emitMessage(ctx, turnId, "supervisor", message);
      await this.deps.chat.appendChat(projectId, { role: "supervisor", content: message, turnId });
      return { kind: "declined", turnId, cycles: 0, consumed: 0n };
    }

    // (4) Reserve (accept). A below-gate reserve is the ONLY expected reject (EC-01);
    // an unexpected ledger fault fails loud WITHOUT a settle (no reserve was placed).
    try {
      await this.deps.ledger.placeReserve(address, turnId, this.deps.flatReserve);
    } catch (error) {
      if (error instanceof InsufficientAvailableError) {
        const message = topUpMessage(error);
        await this.emitMessage(ctx, turnId, "supervisor", message);
        await this.deps.chat.appendChat(projectId, {
          role: "supervisor",
          content: message,
          turnId,
        });
        return { kind: "insufficient-balance", turnId, cycles: 0, consumed: 0n };
      }
      // A reserve that failed for any other reason left the turn `classifying`, so a
      // settle would be invalid — fail loud, charge nothing (D34 settles the accepted
      // path only; nothing was reserved here). `settled:false` tells the coordinator this
      // outcome emitted NO `turn:settled`, so it must synthesize the unlock frame itself.
      const message = infraMessage(LEDGER_SERVICE_NAME);
      await this.emitMessage(ctx, turnId, "supervisor", message);
      await this.deps.chat.appendChat(projectId, { role: "supervisor", content: message, turnId });
      return {
        kind: "infra-failed",
        turnId,
        cycles: 0,
        consumed: 0n,
        service: LEDGER_SERVICE_NAME,
        settled: false,
      };
    }

    // (5) Verify loop.
    return await this.runVerifyLoop(ctx, params);
  }

  /** The ≤3-cycle verify loop (D21). Settles on every terminal branch (D34). */
  private async runVerifyLoop(ctx: SupervisorContext, params: TurnParams): Promise<TurnResult> {
    const { projectId, text, turnId, coldStart } = params;

    const budget = this.makeBudget();
    const trigger = this.makeTrigger({
      // The single green FULL compile (D35/FR-029) — keys, zkir, R2 upload, the one
      // `artifacts:ready` — is a SEPARATE seam from the per-cycle check, fired
      // at-most-once by the trigger ONLY on a green VerifyDecision.
      runFullCompile: (input) =>
        this.withInfraRetry(() => this.deps.runFullCompile(input), COMPILE_SERVICE_NAME),
    });

    let totalTokens = 0n;
    let cycles = 0;
    let compileDiagnostics: readonly Diagnostic[] = [];
    let testFailures: readonly TestFailure[] = [];
    // The turn's accumulated files across ALL cycles (a later cycle overrides an earlier
    // one per path), persisted as ONE agent commit at every ending that reaches the loop.
    const turnFiles = new Map<string, FileWrite>();

    try {
      for (;;) {
        cycles += 1;
        const cycleCtx: SubAgentCycleContext = {
          projectId,
          turnId,
          prompt: text,
          cycle: cycles,
          coldStart,
          compileDiagnostics,
          testFailures,
        };

        // (5a) Run this cycle's sub-agents → merged files + summed tokens.
        const work = await this.runCycleAgents(ctx, cycleCtx, coldStart);
        totalTokens += work.tokens;
        for (const file of work.files) {
          turnFiles.set(file.path, { path: file.path, content: file.content });
          await this.emitFileWrite(ctx, file);
        }

        // (5b) Compile-before-surface CHECK — the fast path ONLY (no keys, no upload,
        // no announce, D35); a throw → infra path. The FULL compile is never run here:
        // artifacts must not surface before the behavioural tests pass (FR-002/FR-029).
        const changedPaths = work.files.map((file) => file.path);
        const compileInput: CompileTurnInput = { projectId, files: work.files, changedPaths };
        const checkOutcome = await this.withInfraRetry(
          () => this.deps.checkCompile(compileInput),
          COMPILE_SERVICE_NAME,
        );
        const check = classifyCheck(checkOutcome);

        if (!check.ok) {
          // A failed check is a failing cycle — never done work (FR-002/SC-002).
          compileDiagnostics = check.raw;
          testFailures = [];
          await this.emitActivity(ctx, turnId, {
            agent: "supervisor",
            phase: `cycle ${String(cycles)}`,
            detail: "compile check failed; iterating on the reported diagnostics",
          });
          const decision = budget.recordTestResult(false, check.diagnostics);
          if (decision.kind === "exhausted") {
            await this.persistTurnFiles(ctx, turnId, projectId, turnFiles);
            return await this.exhaustedEnding(ctx, {
              params,
              consumed: totalTokens,
              cycles,
              summary: decision.summary,
            });
          }
          continue;
        }

        // (5c) Clean check → await the CLIENT's behavioural suite (FR-007), cap it
        // (FR-033), and record the verdict.
        const rawResults = await this.deps.awaitTestResults(turnId);
        const capped = capTestResults(rawResults);
        const decision = budget.recordTestResult(capped.pass, toVerifyDiagnostics(capped.failures));

        if (decision.kind === "green") {
          // Green TESTS are the SOLE trigger for the ONE full compile + `artifacts:ready`
          // (D35/FR-029) — never a mere check-pass, never before the tests run. Then the
          // done-presentation.
          await trigger.triggerOnGreen(decision, compileInput);
          await this.persistTurnFiles(ctx, turnId, projectId, turnFiles);
          return await this.greenEnding(ctx, { params, consumed: totalTokens, cycles });
        }
        if (decision.kind === "exhausted") {
          await this.persistTurnFiles(ctx, turnId, projectId, turnFiles);
          return await this.exhaustedEnding(ctx, {
            params,
            consumed: totalTokens,
            cycles,
            summary: decision.summary,
          });
        }

        // retry-allowed — feed the failing suite forward and iterate.
        compileDiagnostics = [];
        testFailures = capped.failures;
        await this.emitActivity(ctx, turnId, {
          agent: "supervisor",
          phase: `cycle ${String(cycles)}`,
          detail: "behavioural tests failed; iterating",
        });
      }
    } catch (error) {
      if (error instanceof InfraFailureError) {
        await this.persistTurnFiles(ctx, turnId, projectId, turnFiles);
        return await this.infraEnding(ctx, {
          params,
          consumed: totalTokens,
          cycles,
          service: error.service,
        });
      }
      throw error;
    }
  }

  /**
   * Persist the turn's accumulated files as one agent commit (SC-026). Persistence must
   * NEVER break — nor even DELAY — the money path (I2): a commit that fails OR hangs is
   * logged onto the activity feed and swallowed, and the turn still settles (the files
   * still live in the client VFS). The commit is BOUNDED ({@link commitWithinBound}) so a
   * hung store can never postpone `turn:settled` (input locked, reserve held). An empty
   * turn (no files produced) writes nothing (no phantom empty version).
   */
  private async persistTurnFiles(
    ctx: SupervisorContext,
    turnId: string,
    projectId: string,
    turnFiles: ReadonlyMap<string, FileWrite>,
  ): Promise<void> {
    if (turnFiles.size === 0) {
      return;
    }
    const failure = await this.commitWithinBound(projectId, [...turnFiles.values()]);
    if (failure === undefined) {
      return;
    }
    // M3: the persist-failure notice is best-effort — a throwing/rejecting `ctx.send`
    // (dead socket) must NOT block the settle that follows, so its own throw is swallowed.
    // Settle stays UNCONDITIONAL; the files still live in the client VFS regardless.
    try {
      await this.emitActivity(ctx, turnId, {
        agent: "supervisor",
        phase: "persist",
        detail: `file persistence failed (${failure}); files remain in the container only`,
      });
    } catch {
      // The notice could not be delivered — swallow so the money terminal is never blocked.
    }
  }

  /**
   * Commit within a BOUNDED wait (I2 no-hang). Races {@link SupervisorDeps.commitFiles}
   * against the injected {@link persistTimeoutMs} timeout: a rejection OR a timeout resolves
   * to a human failure message (this NEVER throws), so the caller always proceeds to settle.
   * Returns `undefined` on a clean commit. The commit promise carries its own rejection
   * handler, so a rejection that lands AFTER the timeout wins is never an unhandled rejection.
   */
  private async commitWithinBound(
    projectId: string,
    files: readonly FileWrite[],
  ): Promise<string | undefined> {
    const committed: Promise<string | undefined> = this.deps.commitFiles(projectId, files).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const timedOut: Promise<typeof PERSIST_TIMEOUT> = this.delay(this.persistTimeoutMs).then(
      () => PERSIST_TIMEOUT,
    );
    const outcome = await Promise.race([committed, timedOut]);
    if (outcome === PERSIST_TIMEOUT) {
      return `did not complete within ${String(this.persistTimeoutMs)}ms`;
    }
    return outcome;
  }

  /**
   * Run one cycle's sub-agents in composition order, emitting each one's activity
   * feed + narration and merging their file changes (later agents override earlier
   * per path). A sub-agent throw is an infra fault handled by the loop boundary.
   */
  private async runCycleAgents(
    ctx: SupervisorContext,
    cycleCtx: SubAgentCycleContext,
    coldStart: boolean,
  ): Promise<{ files: SourceFile[]; tokens: bigint }> {
    const steps = this.cycleComposition(cycleCtx.cycle, coldStart);
    const merged = new Map<string, SourceFile>();
    let tokens = 0n;

    for (const step of steps) {
      const work = await this.withInfraRetry(() => step.run(cycleCtx), step.name);
      tokens += work.tokensConsumed;

      const activities: readonly SubAgentActivity[] = work.activity ?? [
        {
          agent: step.name,
          phase: `cycle ${String(cycleCtx.cycle)}`,
          detail: `${step.name} produced ${String(work.files.length)} file(s)`,
        },
      ];
      for (const activity of activities) {
        await this.emitActivity(ctx, cycleCtx.turnId, activity);
      }
      if (work.narration !== undefined) {
        await this.emitMessage(ctx, cycleCtx.turnId, "supervisor", work.narration);
      }
      for (const file of work.files) {
        merged.set(file.path, file);
      }
    }

    return { files: [...merged.values()], tokens };
  }

  /**
   * The per-cycle composition (documented in the module header). Scaffolding runs
   * exactly once — the first cycle of a cold-start turn (FR-003) — then every cycle
   * runs planning → implementation → review.
   */
  private cycleComposition(cycle: number, coldStart: boolean): AgentStep[] {
    const steps: AgentStep[] = [];
    if (coldStart && cycle === 1) {
      steps.push({ name: "scaffolding", run: (ctx) => this.deps.subAgents.scaffolding(ctx) });
    }
    steps.push({ name: "planning", run: (ctx) => this.deps.subAgents.planning(ctx) });
    steps.push({ name: "implementation", run: (ctx) => this.deps.subAgents.implementation(ctx) });
    steps.push({ name: "review", run: (ctx) => this.deps.subAgents.review(ctx) });
    return steps;
  }

  /** The green ending: done-presentation + settle (D35). */
  private async greenEnding(
    ctx: SupervisorContext,
    args: { params: TurnParams; consumed: bigint; cycles: number },
  ): Promise<TurnResult> {
    const { params, consumed, cycles } = args;
    await this.emitMessage(ctx, params.turnId, "assistant", DONE_MESSAGE);
    await this.deps.chat.appendChat(params.projectId, {
      role: "assistant",
      content: DONE_MESSAGE,
      turnId: params.turnId,
    });
    await this.settleAndEmit(ctx, params, consumed);
    return { kind: "green", turnId: params.turnId, cycles, consumed };
  }

  /** The exhausted ending: honest summary (D21) + settle at actual (D34). */
  private async exhaustedEnding(
    ctx: SupervisorContext,
    args: {
      params: TurnParams;
      consumed: bigint;
      cycles: number;
      summary: { suggestedNextPrompt: string; diagnostics: readonly VerifyDiagnostic[] };
    },
  ): Promise<TurnResult> {
    const { params, consumed, cycles, summary } = args;
    const message = exhaustionMessage(summary.suggestedNextPrompt, summary.diagnostics);
    await this.emitMessage(ctx, params.turnId, "supervisor", message);
    await this.deps.chat.appendChat(params.projectId, {
      role: "supervisor",
      content: message,
      turnId: params.turnId,
    });
    await this.settleAndEmit(ctx, params, consumed);
    return { kind: "exhausted", turnId: params.turnId, cycles, consumed };
  }

  /** The infra ending: loud named failure (scenario 5) + settle at actual (D34). */
  private async infraEnding(
    ctx: SupervisorContext,
    args: { params: TurnParams; consumed: bigint; cycles: number; service: string },
  ): Promise<TurnResult> {
    const { params, consumed, cycles, service } = args;
    const message = infraMessage(service);
    await this.emitMessage(ctx, params.turnId, "supervisor", message);
    await this.deps.chat.appendChat(params.projectId, {
      role: "supervisor",
      content: message,
      turnId: params.turnId,
    });
    await this.settleAndEmit(ctx, params, consumed);
    // `settled:true` — this path settled at actual + emitted its own `turn:settled`.
    return {
      kind: "infra-failed",
      turnId: params.turnId,
      cycles,
      consumed,
      service,
      settled: true,
    };
  }

  /**
   * Settle at ACTUAL consumption (D34) and emit the encoded `turn:settled` +
   * `ledger:update` frames. The amount is floored at {@link MIN_SETTLE_AMOUNT}
   * because the ledger stores only strictly-positive magnitudes; a real turn always
   * consumes more, so the floor only guards a degenerate zero-token turn.
   */
  private async settleAndEmit(
    ctx: SupervisorContext,
    params: TurnParams,
    consumed: bigint,
  ): Promise<void> {
    const amount = consumed > 0n ? consumed : MIN_SETTLE_AMOUNT;
    const balance = await this.settleWithRetry(params.address, params.turnId, amount);

    const settled: TurnSettledEvent = {
      type: "turn:settled",
      payload: {
        turnId: params.turnId as TurnId,
        consumed: amount,
        balance: balance.available,
      },
      ts: this.now(ctx),
    };
    await ctx.send(encodeTurnSettledEvent(settled));

    const entry = await this.resolveSettlementEntry(params.address, params.turnId, amount);
    const update: LedgerUpdateEvent = {
      type: "ledger:update",
      payload: { entry, available: balance.available, reserved: balance.reserved },
      ts: this.now(ctx),
    };
    await ctx.send(encodeLedgerUpdateEvent(update));
  }

  /**
   * Resolve the settlement {@link LedgerEntry} the turn just wrote so `ledger:update`
   * carries a real entry. Reads the account's entries (newest first) for THIS turn's
   * settlement; a synthetic fallback keeps the emit total even in the impossible case
   * the store returns none.
   */
  private async resolveSettlementEntry(
    address: string,
    turnId: string,
    amount: bigint,
  ): Promise<LedgerEntry> {
    const entries = await this.deps.ledger.getEntries(address);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === "settlement" && entry.ref === turnId) {
        // `entry.ref === turnId` narrowed `ref` to a defined string.
        return {
          id: entry.id,
          accountAddress: entry.accountAddress as MidnightAddress,
          kind: entry.kind,
          amount: entry.amount,
          ref: entry.ref,
        };
      }
    }
    return {
      id: 0n,
      accountAddress: address as MidnightAddress,
      kind: "settlement",
      amount,
      ref: turnId,
    };
  }

  /**
   * Run `op` with bounded infra retries (scenario 5): the initial attempt plus up to
   * {@link maxInfraRetries} retries, each preceded by the injected backoff. On final
   * failure a {@link InfraFailureError} naming `service` is thrown for the loop
   * boundary to convert into the loud settle-and-fail ending.
   */
  private async withInfraRetry<T>(op: () => Promise<T>, service: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await op();
      } catch (error) {
        if (error instanceof InfraFailureError) {
          // Already an infra failure (a nested seam) — do not re-wrap or re-retry.
          throw error;
        }
        if (attempt >= this.maxInfraRetries) {
          throw new InfraFailureError(service, attempt + 1, error);
        }
        await this.retryDelay(attempt);
        attempt += 1;
      }
    }
  }

  /**
   * Settle with bounded infra retries (BUG-2): a TRANSIENT settle fault retries the whole
   * `reserve_release`+`settlement` write rather than instantly stranding the reserve. On
   * final failure a {@link SettleFailureError} is thrown — distinct from
   * {@link InfraFailureError} so it is NOT caught + re-settled by the verify loop, but
   * propagates to the coordinator backstop (loud log + client unlock). ⚠️ Residual: a
   * settle that fails after every retry leaves the reserve `reserved` for a later reconcile.
   */
  private async settleWithRetry(address: string, turnId: string, amount: bigint): Promise<Balance> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.deps.ledger.settle(address, turnId, amount);
      } catch (error) {
        if (attempt >= this.maxInfraRetries) {
          throw new SettleFailureError(turnId, attempt + 1, error);
        }
        await this.retryDelay(attempt);
        attempt += 1;
      }
    }
  }

  /** Resolve the deterministic event clock (`ctx.now`, else `Date.now`). */
  private now(ctx: SupervisorContext): number {
    return ctx.now?.() ?? Date.now();
  }

  /** Emit a `turn:message` chat-stream delta (D20/D62). */
  private async emitMessage(
    ctx: SupervisorContext,
    turnId: string,
    role: TurnMessageRole,
    delta: string,
  ): Promise<void> {
    const event: TurnMessageEvent = {
      type: "turn:message",
      payload: { turnId: turnId as TurnId, role, delta },
      ts: this.now(ctx),
    };
    await ctx.send(event);
  }

  /** Emit a `turn:activity` sub-agent-feed row (D20). */
  private async emitActivity(
    ctx: SupervisorContext,
    turnId: string,
    activity: SubAgentActivity,
  ): Promise<void> {
    const event: TurnActivityEvent = {
      type: "turn:activity",
      payload: {
        turnId: turnId as TurnId,
        agent: activity.agent,
        phase: activity.phase,
        detail: activity.detail,
      },
      ts: this.now(ctx),
    };
    await ctx.send(event);
  }

  /** Emit a `file:write` VFS write (FR-019). */
  private async emitFileWrite(ctx: SupervisorContext, file: SourceFile): Promise<void> {
    const event: FileWriteEvent = {
      type: "file:write",
      payload: { path: file.path, content: file.content },
      ts: this.now(ctx),
    };
    await ctx.send(event);
  }
}

/** Construct the US1 supervisor from its injected seams (T138). */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  return new TurnSupervisor(deps);
}
