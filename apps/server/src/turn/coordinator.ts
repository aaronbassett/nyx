/**
 * Turn coordinator — the deterministic WS wiring for the US1 supervisor turn loop
 * (T135/T146).
 *
 * The supervisor ({@link createSupervisor}) is a PURE state machine over injected
 * seams — it never touches the socket, the clock, or a network. This module is the
 * glue that binds those seams to a live WebSocket connection and drives one turn per
 * `prompt:submit`. It owns three things the supervisor deliberately does not:
 *
 *  1. **Per-PROJECT, ctx-bound seams.** Each PROJECT (not connection) gets ONE
 *     {@link Supervisor} + one dynamic {@link SupervisorContext} whose `send` forwards to
 *     the project's CURRENT live connection (`state.liveCtx`), so the supervisor's own
 *     single-active-turn lock (D24) is enforced across ALL of a project's connections and
 *     a mid-turn D40 takeover reroutes in-flight frames to the new socket. Three seams are
 *     bound to that dynamic context:
 *       - `checkCompile` adapts a {@link CompileTurnInput} → the Compile Service's
 *         {@link CheckRequest} and calls {@link CompileClient.check}; the service's
 *         `{ ok, diagnostics, … }` IS the supervisor's `CheckOutcome` (a structural
 *         superset), so a check-fail stays DATA and never throws (FR-002/SC-002).
 *       - `runFullCompile` drives a fresh {@link ArtifactOrchestrator} (keys, zkir,
 *         manifest→R2, and the single `artifacts:ready`) — fired at-most-once, ONLY
 *         on a green suite by the supervisor's own green trigger (D35/FR-029).
 *       - `awaitTestResults` emits `verify:run` to the client (the client's
 *         WebContainer owns the OZ/Vitest run, US4) then awaits the matching
 *         `test:results` via the {@link TestResultsInbox}. The wait is BOUNDED so a
 *         crashed/silent container can never hang the turn (no-hang, D42).
 *
 *  2. **The `verify:run`/`test:results` rendezvous.** The {@link TestResultsInbox}
 *     registers a pending wait per `turnId` and resolves it when the client's
 *     `test:results` arrives (capped, FR-033), or — on timeout — resolves as a
 *     FAILING verdict so the verify budget records a failing cycle (uniform with a
 *     D42 timeout kill) instead of hanging. Each wait is OWNED by the project that
 *     started the turn, and delivery is gated on that ownership (Defense 4): the
 *     `test:results` handler refuses a verdict from any connection not authorized for
 *     the turn's project, so no tenant can inject a false PASS/FAIL into another's turn.
 *
 *  3. **The terminal signal for non-settling outcomes.** The supervisor settles + emits
 *     its own `turn:settled` for green / exhausted / and the verify-loop `infra-failed`
 *     (`settled:true`). Three outcomes settle NOTHING yet must still end the turn — the
 *     chat UI unlocks input ONLY on `turn:settled`/`declined` — so the coordinator
 *     synthesizes a "turn ended, nothing charged" `turn:settled { consumed: "0" }` (no
 *     ledger entry, balance unchanged): a `declined` (D25), a below-gate
 *     `insufficient-balance` (EC-01), and a RESERVE-time `infra-failed` (`settled:false` —
 *     nothing was ever reserved). A `rejected` (turn-active, D24) outcome gets NO extra
 *     frame — the supervisor already sent the input-locked `turn:message`, and the active
 *     turn's own `turn:settled` will unlock input. As a last-resort BACKSTOP, if
 *     `handlePrompt` THROWS unexpectedly (a settle/appendChat DB fault propagating past the
 *     retries), the coordinator catches it, logs LOUDLY (never silently), and STILL emits a
 *     zero-consumed unlock so the client always recovers.
 *
 * Everything is DETERMINISTIC and seam-injected: `now`/`delay` are injectable, the
 * models + MCP + Compile Service + WebContainer are OWNER-GATED, and every test drives
 * the whole path with fakes (constitution III/IV). `bigint` money stays `bigint` in
 * code and crosses the wire as a decimal STRING — the protocol encoders own that
 * boundary, so every emitted frame is `JSON.stringify`-safe.
 */
import { encodeTurnSettledEvent } from "@nyx/protocol";
import type { ServerToClientEvent, TestResultsPayload, TurnId } from "@nyx/protocol";
import { buildImplementationInstructions, buildScaffoldingInstructions } from "@nyx/scaffold";
import {
  capTestResults,
  computeCircuitCoverage,
  testNamesFromResults,
} from "../agents/coverage.js";
import type { CircuitCoverageReport } from "../agents/coverage.js";
import { createIntentClassifier } from "../agents/classifier.js";
import { createImplementationAgent } from "../agents/implementation.js";
import { createPlanningAgent } from "../agents/planning.js";
import { createReviewAgent } from "../agents/review.js";
import type { ModelRouter } from "../agents/routing.js";
import { createScaffoldingAgent } from "../agents/scaffolding.js";
import { createSupervisor } from "../agents/supervisor.js";
import type {
  IntentClassifier,
  OutboundEvent,
  SubAgents,
  Supervisor,
  SupervisorContext,
  SupervisorDeps,
  TurnResult,
} from "../agents/supervisor.js";
import { ArtifactOrchestrator } from "../compile/index.js";
import type { CheckRequest, CompileClient, CompileTurnInput } from "../compile/index.js";
import type { LedgerStore } from "../ledger/ledger.js";
import type { ChatStore } from "../projects/chat.js";
import type { ProjectStore } from "../projects/store.js";
import type { ConnectionContext, EventRouter } from "../protocol/router.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * Default bounded wait for the client's `test:results` (no-hang backstop). Longer
 * than the D42 120s in-container run kill so the client's own failing verdict lands
 * first; this fires only when the client never reports at all (a crashed container).
 */
export const DEFAULT_TEST_RESULTS_TIMEOUT_MS = 180_000;

/** The synthetic failing-test name for a `test:results` wait that timed out (no-hang, D42). */
export const TEST_RESULTS_TIMEOUT_FAILURE_NAME = "verify:timeout";

/** Ring-buffer cap for the lightweight in-process console capture (bounded — never leaks). */
export const MAX_CONSOLE_CAPTURE = 500;

/**
 * Sentinel turn id for the catch-all terminal unlock (BUG-2 backstop). An unexpected
 * `handlePrompt` throw carries no `TurnResult`, so the real turn id is unknown; the client
 * unlocks input on ANY `turn:settled`, so a non-empty placeholder (`TurnIdSchema` requires
 * `min(1)`) is all the unlock frame needs.
 */
export const UNKNOWN_TURN_ID = "unknown";

/**
 * The `turn:message` surfaced when a `prompt:submit` targets a project OTHER than the
 * connection's authorized one (Defense 2). A well-behaved client only ever submits its own
 * `ctx.projectId`, so this fires solely on a misrouted or hostile frame; nothing is opened
 * or charged, so no `turn:settled` unlock is owed.
 */
export const PROJECT_MISMATCH_MESSAGE =
  "This prompt targets a different project than the one this connection is authorized " +
  "for. Reconnect to that project and try again — nothing was started or charged.";

// ── Public seam types ────────────────────────────────────────────────────────────

/**
 * The narrow MCP surface each sub-agent needs — just {@link McpClient.call}. The real
 * `McpClient` satisfies it structurally; tests inject a fake `{ call }`. Matches the
 * per-agent `McpCallable` in `agents/*.ts` so `mcp.tome`/`mnm`/`toolchain` wire straight
 * into every sub-agent factory.
 */
export interface McpCallable {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The three named MCP clients the swarm consumes (a subset of {@link McpClients}). */
export interface TurnCoordinatorMcp {
  /** The compiler toolchain client — the Implementation agent's compile-before-surface. */
  readonly toolchain: McpCallable;
  /** The Tome skill/example retrieval client (scaffolding + planning + implementation). */
  readonly tome: McpCallable;
  /** The Midnight Manual retrieval client (planning + implementation + review). */
  readonly mnm: McpCallable;
}

/**
 * The `verify:run`/`test:results` rendezvous. The supervisor's `awaitTestResults` seam
 * {@link TestResultsInbox.register}s a pending wait per `turnId` — OWNED by the project that
 * started the turn; the WS `test:results` handler {@link TestResultsInbox.deliver}s the
 * client's verdict, resolving the wait ONLY when the delivering connection is authorized for
 * that project (Defense 4 — cross-tenant verdict-injection guard). A wait that is never
 * delivered resolves as a FAILING verdict after the bounded timeout (no-hang, D42) — it never
 * rejects, so a crashed container is just a failing cycle.
 */
export interface TestResultsInbox {
  /**
   * Await the client's `test:results` for `turnId`, OWNED by `projectId` (the project on
   * whose connection the turn was started). Bounded — resolves failing on timeout (no-hang,
   * D42). The recorded owner gates {@link TestResultsInbox.deliver}.
   */
  register(turnId: string, projectId: string): Promise<TestResultsPayload>;
  /**
   * Resolve the pending wait matching `payload.turnId`. `deliveringProjectId` is the project
   * the delivering connection is authorized for (`ctx.projectId`): when provided — as the WS
   * handler always does — a delivery whose project does NOT own the turn is IGNORED (Defense
   * 4), so no foreign socket can force a false PASS or grief the owner's verify budget.
   * Omitted only by trusted in-process callers. A no-op when no wait is pending for `turnId`.
   */
  deliver(payload: TestResultsPayload, deliveringProjectId?: string): void;
}

/**
 * Injected dependencies for {@link createTurnCoordinator}.
 *
 * The shared services (`modelRouter`/`compileClient`/`ledger`/`chat`/`mcp`) are the
 * production wiring the buildServer task constructs from config; the optional seam
 * OVERRIDES (`classifyIntent`/`subAgents`/`buildSupervisor`) let tests drive the whole
 * loop with NO real models, NO Compile Service, and NO WebContainer.
 */
export interface TurnCoordinatorDeps {
  /** Per-agent model routing (D19) — used to build the default sub-agent swarm. */
  readonly modelRouter: ModelRouter;
  /** The Compile Service client (US2) — the per-cycle CHECK + the green FULL compile. */
  readonly compileClient: CompileClient;
  /** Reserve-then-settle metering (D34). */
  readonly ledger: LedgerStore;
  /** Chat persistence + rehydration (D23); the cold-start signal (FR-003). */
  readonly chat: ChatStore;
  /**
   * Turn-end file persistence (US7 store; the US13 exports + US14 editor read path depend on it)
   * plus latest-green-build recording (FR-054): a `ready` full compile is persisted so the US8
   * deploy handler's greenness gate can read it at deploy time.
   */
  readonly projectStore: Pick<ProjectStore, "commit" | "recordGreenBuild">;
  /** The three named MCP clients the swarm retrieves + compiles through. */
  readonly mcp: TurnCoordinatorMcp;
  /** The flat pre-turn reserve in NYXT base units (D34/D47). */
  readonly flatReserve: bigint;
  /** Deterministic event clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable delay for the orchestrator poll + the `test:results` timeout backstop. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Bounded wait for the client's `test:results`; default {@link DEFAULT_TEST_RESULTS_TIMEOUT_MS}. */
  readonly testResultsTimeoutMs?: number;
  /** Per-event byte cap for a delivered `test:results` (FR-033); defaults to the coverage default. */
  readonly maxTestResultsBytes?: number;
  /** Compile poll cadence (FR-016) — forwarded to the {@link ArtifactOrchestrator}. */
  readonly pollIntervalMs?: number;
  /** Bounded max wait for the full compile job (FR-016) — forwarded to the orchestrator. */
  readonly maxWaitMs?: number;
  /** `fetch` for reading R2 artifacts (verify-before-announce); forwarded to the orchestrator. */
  readonly fetchArtifact?: typeof fetch;
  /** Override the intent classifier (tests inject a pure verdict; default = routed model). */
  readonly classifyIntent?: IntentClassifier;
  /** Override the sub-agent swarm (tests inject canned agents; default = routed models). */
  readonly subAgents?: SubAgents;
  /** Override supervisor construction (tests inject a spy; default {@link createSupervisor}). */
  readonly buildSupervisor?: (deps: SupervisorDeps) => Supervisor;
  /**
   * Structured error sink for the BUG-2 catch-all backstop — an unexpected `handlePrompt`
   * throw (e.g. a settle/appendChat DB fault) is logged LOUDLY here (never silently
   * swallowed) before the client is unlocked. Defaults to a structured `process.stderr`
   * line; tests inject a spy to assert the loud log fired.
   */
  readonly logError?: (message: string, detail: Record<string, unknown>) => void;
  /**
   * Telemetry sink for the FR-032 per-circuit coverage report, emitted ONCE per green full
   * compile (D41: telemetry ONLY — no branch of turn control flow reads it, so a hollow or
   * zeroed report NEVER blocks, fails, or alters the turn). Defaults to a single structured
   * `info` line via the coordinator's {@link defaultLogCoverage} pattern; tests inject a sink
   * to capture the report.
   */
  readonly logCoverage?: (report: CircuitCoverageReport) => void;
}

/**
 * The turn-observation seam the US8 deploy handler consumes to queue deploys behind an active
 * turn (EC-40 / FR-058): a deploy must not race an in-flight turn's compile/artifacts, so it
 * waits for the project's CURRENT turn to settle. The coordinator OWNS this — it is a pure
 * OBSERVER over the turn loop that never starts, rejects, or otherwise alters a turn. The deploy
 * handler declares a structurally IDENTICAL `turnGate` shape, so `coordinator.turnGate` wires
 * straight into `createDeployHandler({ turnGate, … })` with no shared import (both sides couple
 * on the structure, not a nominal type).
 */
export interface TurnGate {
  /**
   * Is a real (non-`rejected`) turn currently in flight for `projectId` (D24)? `false` before any
   * prompt, `true` from the moment a turn begins executing until it settles, `false` again after.
   * A `rejected` (turn-active) prompt or a project-mismatch never flips it on its own — only a
   * turn that will actually settle does.
   */
  isTurnActive(projectId: string): boolean;
  /**
   * Run `fn` once the project is idle: IMMEDIATELY when no turn is in flight, otherwise QUEUED and
   * fired (FIFO) after the project's current turn settles. Every `fn` is guarded — a throwing
   * callback is logged loudly and can never break the turn loop or the sibling queued callbacks.
   */
  runWhenIdle(projectId: string, fn: () => void): void;
}

/**
 * The coordinator's public surface. `handlers` is the {@link WsHandlerOptions.handlers}
 * hook the buildServer task passes to `createWsHandler`; `inbox` is exposed so the same
 * task (and tests) can observe/deliver the `test:results` rendezvous directly; `turnGate`
 * lets the US8 deploy handler queue deploys behind an active turn (EC-40 / FR-058).
 */
export interface TurnCoordinator {
  /** Register the coordinator's client→server handlers on a connection's router. */
  readonly handlers: (router: EventRouter) => void;
  /** The `verify:run`/`test:results` rendezvous inbox. */
  readonly inbox: TestResultsInbox;
  /** The turn-observation seam the US8 deploy handler queues deploys behind (EC-40 / FR-058). */
  readonly turnGate: TurnGate;
}

// ── Internal helpers ─────────────────────────────────────────────────────────────

/** The default inter-poll / timeout delay — an UNREF'd timer so a live wait never pins the process. */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * The default structured error sink (BUG-2 backstop): a single JSON line to `process.stderr`
 * (mirrors `index.ts`'s fatal-error convention). `Error` values are rendered to
 * `{ name, message, stack }` and any stray `bigint` to a decimal string, so the log line
 * itself can NEVER throw and block the client's terminal unlock.
 */
function defaultLogError(message: string, detail: Record<string, unknown>): void {
  const rendered: Record<string, unknown> = { level: "error", source: "turn-coordinator", message };
  for (const [key, value] of Object.entries(detail)) {
    rendered[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  const line = JSON.stringify(rendered, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  process.stderr.write(`${line}\n`);
}

/**
 * The default coverage telemetry sink (FR-032): a single structured `info` JSON line to
 * `process.stderr` (mirrors {@link defaultLogError}'s convention at info level). Telemetry
 * only — the {@link CircuitCoverageReport} holds only numbers/strings/booleans, so the line
 * can never throw and the emit never gates or alters the turn (D41).
 */
function defaultLogCoverage(report: CircuitCoverageReport): void {
  const line = JSON.stringify({
    level: "info",
    source: "turn-coordinator",
    message: "circuit coverage",
    coveredCount: report.coveredCount,
    totalCount: report.totalCount,
    ratio: report.ratio,
    perCircuit: report.perCircuit,
  });
  process.stderr.write(`${line}\n`);
}

/** Adapt a supervisor {@link CompileTurnInput} onto the Compile Service {@link CheckRequest} (§4.1). */
function toCheckRequest(input: CompileTurnInput): CheckRequest {
  return {
    files: [...input.files],
    ...(input.entry === undefined ? {} : { entry: input.entry }),
  };
}

/** Build the synthetic FAILING verdict for a `test:results` wait that timed out (no-hang, D42). */
function timeoutTestResults(turnId: string, timeoutMs: number): TestResultsPayload {
  return {
    turnId: turnId as TurnId,
    pass: false,
    failures: [
      {
        name: TEST_RESULTS_TIMEOUT_FAILURE_NAME,
        message:
          `no test:results within ${String(timeoutMs)}ms — treating this verify cycle as ` +
          `failing so a crashed or silent container cannot hang the turn (no-hang, D42/US4).`,
      },
    ],
  };
}

/**
 * Forward an already-wire-encoded {@link OutboundEvent} through the connection's
 * validated `send`. {@link ConnectionContext.send} is typed with the POST-parse
 * (`bigint`) money shape, but `sendEvent` re-validates against the schema whose INPUT
 * is the wire (decimal-string) form — so an encoded frame is exactly what the validator
 * consumes and re-serializes. This is the single wire/domain boundary the two views
 * meet at; the runtime path (parse string→bigint→serialize) is correct for the wire form.
 */
function sendOutbound(ctx: ConnectionContext, event: OutboundEvent): void {
  ctx.send(event as unknown as ServerToClientEvent);
}

/**
 * One pending `test:results` wait: the project that OWNS it (Defense 4) + the resolver that
 * settles {@link PendingTestResultsInbox.register}'s promise when the owner's verdict lands.
 */
interface PendingTestResultsWait {
  /** The project that started the turn — the only one authorized to deliver its verdict. */
  readonly projectId: string;
  /** Resolve the awaiting `register` promise with the delivered (owner) verdict. */
  readonly resolve: (payload: TestResultsPayload) => void;
}

/** The bounded, seam-injected {@link TestResultsInbox} (see {@link createTurnCoordinator}). */
class PendingTestResultsInbox implements TestResultsInbox {
  private readonly pending = new Map<string, PendingTestResultsWait>();
  private readonly delay: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: { delay: (ms: number) => Promise<void>; timeoutMs: number }) {
    this.delay = options.delay;
    this.timeoutMs = options.timeoutMs;
  }

  register(turnId: string, projectId: string): Promise<TestResultsPayload> {
    // The delivered wait is set SYNCHRONOUSLY (the executor runs now), so a `deliver` that
    // arrives immediately after `awaitTestResults` sends `verify:run` finds it. The owning
    // `projectId` is stored ALONGSIDE the resolver so `deliver` can reject a cross-tenant
    // verdict (Defense 4) and the ownership is freed with the wait itself (no separate map).
    const delivered = new Promise<TestResultsPayload>((resolve) => {
      this.pending.set(turnId, { projectId, resolve });
    });
    // The bounded backstop resolves as FAILING (never rejects) so a silent container is
    // recorded as a failing cycle (uniform with a D42 timeout kill), never a hang.
    const timedOut = this.delay(this.timeoutMs).then(() =>
      timeoutTestResults(turnId, this.timeoutMs),
    );
    // The `finally` frees the whole wait record (resolver + ownership together), so the
    // pending map is bounded by CONCURRENTLY-pending waits, never by completed turns.
    return Promise.race([delivered, timedOut]).finally(() => {
      this.pending.delete(turnId);
    });
  }

  deliver(payload: TestResultsPayload, deliveringProjectId?: string): void {
    const wait = this.pending.get(payload.turnId);
    if (wait === undefined) {
      // No waiter for this turn (a late, duplicate, or unknown verdict) — drop it, never throw.
      return;
    }
    if (deliveringProjectId !== undefined && wait.projectId !== deliveringProjectId) {
      // Defense 4: the delivering connection is NOT authorized for this turn's project — a
      // foreign green cannot force a false PASS, nor a foreign red grief the owner's verify
      // budget. Leave the wait pending so the OWNER's own later verdict still resolves it.
      return;
    }
    this.pending.delete(payload.turnId);
    wait.resolve(payload);
  }
}

/**
 * Build the default production swarm from the routed models + MCP clients.
 *
 * The Scaffolding and Implementation agents are steered with the `@nyx/scaffold` house
 * rules (D3/FR-003/FR-080, constitution VII/VIII): `buildScaffoldingInstructions()` and
 * `buildImplementationInstructions()` are passed as each factory's `steering`, which the
 * factories APPEND to their own baked base `instructions` (never replacing them). This is
 * the platform delta the generic retrieved Midnight skills do not carry — the config.ts
 * contract-address chokepoint, the prover-provider default, the wrong-network guard, and
 * (implementation only) the compact-testing rule. Planning/review take no steering:
 * `@nyx/scaffold` exposes builders only for the two generation agents, and those factories
 * are the only ones (in this task's scope) with a steering seam.
 */
function buildDefaultAgents(deps: TurnCoordinatorDeps): {
  classifyIntent: IntentClassifier;
  subAgents: SubAgents;
} {
  const { modelRouter, mcp } = deps;
  const classifyIntent = createIntentClassifier({ model: modelRouter.model("supervisor") });
  const subAgents: SubAgents = {
    scaffolding: createScaffoldingAgent({
      model: modelRouter.model("scaffolding"),
      tome: mcp.tome,
      mnm: mcp.mnm,
      steering: buildScaffoldingInstructions(),
    }),
    planning: createPlanningAgent({
      model: modelRouter.model("planning"),
      mnm: mcp.mnm,
      tome: mcp.tome,
    }),
    implementation: createImplementationAgent({
      model: modelRouter.model("implementation"),
      mnm: mcp.mnm,
      tome: mcp.tome,
      toolchain: mcp.toolchain,
      steering: buildImplementationInstructions(),
    }),
    review: createReviewAgent({
      model: modelRouter.model("review"),
      mnm: mcp.mnm,
    }),
  };
  return { classifyIntent, subAgents };
}

/**
 * The per-PROJECT turn state (BUG-1): ONE {@link Supervisor} + one dynamic
 * {@link SupervisorContext}, shared across ALL of the project's connections so the
 * supervisor's single-active-turn lock (D24) spans reconnects + second tabs. `liveCtx` is
 * the CURRENT live connection (the emit target) — MUTABLE because a D40 takeover swaps it
 * mid-turn so remaining frames follow the new socket. `supervisorCtx.send` and the
 * supervisor's ctx-bound seams all read `liveCtx` at emit time.
 */
interface ProjectTurnState {
  /** The project's single supervisor; its active-turn map enforces D24 across all sockets. */
  readonly supervisor: Supervisor;
  /** The dynamic ctx passed to `handlePrompt`; its `send` forwards to the current `liveCtx`. */
  readonly supervisorCtx: SupervisorContext;
  /** The project's CURRENT live connection — swapped on a D40 takeover. */
  liveCtx: ConnectionContext;
  /**
   * `true` while a real (non-`rejected`) turn is in flight for this project (EC-40 / FR-058) —
   * SET when a prompt begins a turn (the project was idle), CLEARED in the run's `finally` when
   * the turn settles. A `rejected` prompt (the D24 lock already held) never sets it, so the flag
   * tracks the ONE active turn, never every prompt. Read by {@link TurnGate.isTurnActive}.
   */
  turnInFlight: boolean;
  /**
   * FIFO queue of idle callbacks (US8 deploys queued behind this turn, EC-40) fired AFTER the
   * turn's terminal signal. Drained + invoked (each guarded) in the run's `finally`; empty
   * whenever no turn is in flight. The reference is fixed; only its CONTENTS mutate (push/drain).
   */
  readonly idleQueue: (() => void)[];
}

// ── Factory ──────────────────────────────────────────────────────────────────────

/**
 * Construct the turn coordinator (T135). Builds the shared sub-agent swarm + intent
 * classifier ONCE (from the injected overrides, else the routed models), and returns
 * the `handlers` hook + the `test:results` inbox for the buildServer task to register.
 */
export function createTurnCoordinator(deps: TurnCoordinatorDeps): TurnCoordinator {
  const now: () => number = deps.now ?? Date.now;
  const delay: (ms: number) => Promise<void> = deps.delay ?? defaultDelay;
  const buildSupervisor = deps.buildSupervisor ?? createSupervisor;
  const logError = deps.logError ?? defaultLogError;
  const logCoverage = deps.logCoverage ?? defaultLogCoverage;

  /**
   * Run one outbound emit, swallowing a dead-socket throw (Defense 3). `ws.send` on a
   * CLOSED socket throws synchronously, and a mid-turn disconnect (browser closed, no
   * reconnect) must NOT let that throw propagate: if it reached the turn machine it would
   * abort the turn BEFORE its settle (stranding the reserve with zero settle attempts), and
   * if it reached the catch-all backstop the backstop's own unlock on the same dead ctx
   * would throw again — uncaught, then swallowed by `router.dispatch`. So a gone client is a
   * NO-OP: every emit that fails is logged LOUDLY (never silently) and the turn CONTINUES to
   * its normal end and SETTLES, releasing the reserve, even though nothing reaches the wire.
   */
  const safeEmit = (emit: () => void): void => {
    try {
      emit();
    } catch (error) {
      logError("outbound emit failed (dead socket?); continuing the turn", { error });
    }
  };

  /**
   * Invoke one idle callback (a US8 deploy released at turn-idle, EC-40), swallowing a throw so a
   * faulty deploy callback can NEVER break the turn loop or its sibling queued callbacks. Any
   * throw is logged LOUDLY (never silently), mirroring {@link safeEmit}'s dead-socket policy.
   */
  const runIdleCallback = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      logError("queued idle callback (deploy) threw; continuing the turn loop", { error });
    }
  };

  const inbox = new PendingTestResultsInbox({
    delay,
    timeoutMs: deps.testResultsTimeoutMs ?? DEFAULT_TEST_RESULTS_TIMEOUT_MS,
  });

  // The swarm + classifier are built ONCE and shared across every connection/turn. The
  // default (routed-model) build is lazy + memoised so an all-overridden test never
  // touches `modelRouter`/`mcp`.
  let cachedDefaults: { classifyIntent: IntentClassifier; subAgents: SubAgents } | undefined;
  const defaults = (): { classifyIntent: IntentClassifier; subAgents: SubAgents } =>
    (cachedDefaults ??= buildDefaultAgents(deps));
  const classifyIntent: IntentClassifier = deps.classifyIntent ?? defaults().classifyIntent;
  const subAgents: SubAgents = deps.subAgents ?? defaults().subAgents;

  // A bounded, PER-PROJECT ring buffer for the client's console relay — captured, never
  // crash-on. Keyed by `ctx.projectId` so one tenant's console frames can never pool into
  // another's (cross-tenant scoping, Defense 4); a shared cross-project buffer is deliberately
  // avoided. The sink is currently dead (nothing reads it yet), but per-project keying is the
  // correct shape for when a later story surfaces it; each project's buffer stays bounded by
  // {@link MAX_CONSOLE_CAPTURE}, and the map's lifecycle mirrors the per-project `projects` map.
  const consoleByProject = new Map<string, string[]>();
  const recordConsole = (projectId: string, level: "log" | "error", message: string): void => {
    let buffer = consoleByProject.get(projectId);
    if (buffer === undefined) {
      buffer = [];
      consoleByProject.set(projectId, buffer);
    }
    buffer.push(`[${level}] ${message}`);
    if (buffer.length > MAX_CONSOLE_CAPTURE) {
      buffer.splice(0, buffer.length - MAX_CONSOLE_CAPTURE);
    }
  };

  const capResults = (payload: TestResultsPayload): TestResultsPayload =>
    deps.maxTestResultsBytes === undefined
      ? capTestResults(payload)
      : capTestResults(payload, { maxBytes: deps.maxTestResultsBytes });

  // The last CAPPED `test:results` per PROJECT — the sole input, alongside the green full
  // compile's circuits, to the FR-032 coverage telemetry. Keyed by `ctx.projectId` (the
  // delivering connection's authorized project) so a foreign tenant's verdict can only ever
  // stash under its OWN key, never pollute the owner's (cross-tenant scoping, Defense 4). Its
  // lifecycle MIRRORS the per-project `projects`/`consoleByProject` maps (one entry per
  // project, coordinator-lifetime): the entry is REPLACED every turn before the green compile
  // reads it, so a stale cross-turn value can never reach coverage. It is telemetry-only (D41),
  // so a miss just yields an empty-testNames report — never a gate.
  const lastResultsByProject = new Map<string, TestResultsPayload>();

  // One {@link Supervisor} per PROJECT (BUG-1 fix), keyed by `projectId` — NOT one per
  // connection. The supervisor's per-project single-active-turn lock (D24/FR-009) only
  // enforces "one turn at a time on this project/ledger account" if a single supervisor
  // instance sees every prompt for the project; a fresh supervisor per socket (reconnect /
  // second tab) had an EMPTY active-turn map, so a second turn ran concurrently on the same
  // ledger account → double `placeReserve` + double `settle` (double billing). `liveCtx` is
  // the project's CURRENT live connection (D40 keeps ≤1 live socket per (account, project));
  // a takeover swaps it so an in-flight turn's remaining frames follow the new socket.
  const projects = new Map<string, ProjectTurnState>();

  const orchestratorFor = (getLiveCtx: () => ConnectionContext): ArtifactOrchestrator =>
    new ArtifactOrchestrator({
      client: deps.compileClient,
      emitArtifactsReady: (payload) => {
        safeEmit(() => {
          getLiveCtx().send({ type: "artifacts:ready", payload, ts: now() });
        });
      },
      now,
      delay,
      ...(deps.fetchArtifact === undefined ? {} : { fetchArtifact: deps.fetchArtifact }),
      ...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
      ...(deps.maxWaitMs === undefined ? {} : { maxWaitMs: deps.maxWaitMs }),
    });

  /**
   * Build the project's {@link ProjectTurnState}: ONE supervisor + one dynamic
   * {@link SupervisorContext} whose `send` and ctx-bound seams all read `state.liveCtx` at
   * EMIT time (deferred closures), so a mid-turn D40 takeover reroutes frames to the new
   * connection. The self-referential literal is safe: the arrows capture `state` but are
   * only invoked when a seam/send fires (long after `state` is assigned) — `buildSupervisor`
   * stores its seams, it never calls them during construction.
   */
  const createProjectState = (ctx: ConnectionContext, projectId: string): ProjectTurnState => {
    // The account address is stable across a project's connections (D40 is per (account,
    // project)), so it is captured once from the first connection to open the project. This
    // is SOUND — never a cross-account hijack — because a connection can only OPEN for a
    // project its account OWNS (Defense 1, `createProjectAuthorizer`) and a prompt can only
    // run for `ctx.projectId` (Defense 2, `runPromptTurn`): every connection that reaches a
    // given project therefore shares the SAME owning account, so the captured address can
    // never bind a foreign socket's turns to the owner's ledger account.
    const address = ctx.session.accountAddress;
    const state: ProjectTurnState = {
      liveCtx: ctx,
      turnInFlight: false,
      idleQueue: [],
      supervisorCtx: {
        session: { address },
        projectId,
        send: (event) => {
          safeEmit(() => {
            sendOutbound(state.liveCtx, event);
          });
        },
        now,
      },
      supervisor: buildSupervisor({
        ledger: deps.ledger,
        chat: deps.chat,
        flatReserve: deps.flatReserve,
        classifyIntent,
        subAgents,
        // Turn-end file persistence: commit the turn's accumulated files as ONE
        // agent-authored batch at the last committed version (US7 SC-026) so a settled
        // turn is never hollow (the US13 exports + US14 editor read these rows).
        commitFiles: (projectId, files) =>
          deps.projectStore.commit(projectId, { author: "agent", files }),
        // The per-cycle CHECK is the fast path: adapt the input and hand back the service's
        // `{ ok, diagnostics, … }` verbatim (a structural superset of `CheckOutcome`).
        checkCompile: (input) => deps.compileClient.check(toCheckRequest(input)),
        // The green-only FULL compile: a fresh orchestrator per turn, so `artifacts:ready`
        // is at-most-once by construction; it announces to the CURRENT live connection. On a
        // `ready` outcome, persist it as the project's latest green build (FR-054) so the US8
        // deploy handler's greenness gate reads it at deploy time. A record failure must NEVER
        // fail the turn — the artifacts are already announced; a deploy simply won't see the
        // build. Loud-log and continue (mirrors the commitFiles backstop).
        runFullCompile: async (input) => {
          const outcome = await orchestratorFor(() => state.liveCtx).runTurn(input);
          if (outcome.kind === "ready") {
            try {
              await deps.projectStore.recordGreenBuild(input.projectId, {
                urlPrefix: outcome.urlPrefix,
                compilerVersion: outcome.compilerVersion,
              });
            } catch (error) {
              logError("green-build record failed; turn continues (deploy won't see this build)", {
                projectId: input.projectId,
                error,
              });
            }
            // FR-032 coverage TELEMETRY (D41): emit once per green full compile, derived from
            // the green build's circuits + the project's last capped `test:results`. Read-only
            // evidence — NO branch of turn control flow consults the report, so this can never
            // gate, fail, or alter the turn (an absent stash just yields an empty-testNames,
            // all-uncovered report). `testNamesFromResults` folds the payload's FAILING names;
            // a richer runner would supply the full passed+failed set (see coverage.ts).
            const lastResults = lastResultsByProject.get(input.projectId);
            logCoverage(
              computeCircuitCoverage({
                circuits: outcome.circuits.map((circuit) => circuit.name),
                testNames: lastResults === undefined ? [] : testNamesFromResults(lastResults),
              }),
            );
          }
          return outcome;
        },
        // Signal the client to run the verify suite, then await its `test:results` (bounded).
        // The wait is registered as OWNED by this project (Defense 4): only a connection
        // authorized for `projectId` can later deliver its verdict via the `test:results`
        // handler. The ownership is freed with the wait when it resolves (see the inbox).
        awaitTestResults: (turnId) => {
          safeEmit(() => {
            state.liveCtx.send({
              type: "verify:run",
              payload: { turnId: turnId as TurnId },
              ts: now(),
            });
          });
          return inbox.register(turnId, projectId);
        },
      }),
    };
    return state;
  };

  /**
   * Resolve the project's shared {@link ProjectTurnState}, creating it on first use. On a
   * reconnect / second tab (a new {@link ConnectionContext} for a project that already has
   * state), the newest connection becomes the live emit target (D40 takeover) so the
   * in-flight turn's remaining frames follow the socket — the SHARED supervisor's active-turn
   * check then rejects the racing prompt (D24) instead of opening a second billed turn.
   */
  const projectStateFor = (ctx: ConnectionContext, projectId: string): ProjectTurnState => {
    const existing = projects.get(projectId);
    if (existing !== undefined) {
      existing.liveCtx = ctx;
      return existing;
    }
    const state = createProjectState(ctx, projectId);
    projects.set(projectId, state);
    return state;
  };

  /**
   * Synthesize the "turn ended, nothing charged" `turn:settled { consumed: "0" }` unlock —
   * the chat UI ends a turn (and unlocks input) on ANY `turn:settled`. The balance is read
   * best-effort: a balance read that ITSELF faults (e.g. the same outage that broke settle)
   * must never block the unlock, so it falls back to `0`. The frame is JSON-safe (encoded
   * string money) by construction.
   */
  const emitTerminalUnlock = async (state: ProjectTurnState, turnId: string): Promise<void> => {
    const available = await deps.ledger
      .getBalance(state.liveCtx.session.accountAddress)
      .then((balance) => balance.available)
      .catch(() => 0n);
    const settled = encodeTurnSettledEvent({
      type: "turn:settled",
      payload: { turnId: turnId as TurnId, consumed: 0n, balance: available },
      ts: now(),
    });
    safeEmit(() => {
      sendOutbound(state.liveCtx, settled);
    });
  };

  /**
   * Emit the terminal signal the supervisor did NOT. Three outcomes settle NOTHING yet must
   * still unlock the client: `declined` (D25), below-gate `insufficient-balance` (EC-01),
   * and a RESERVE-time `infra-failed` (`settled:false` — no reserve ever landed). Every
   * SETTLING outcome (green / exhausted / verify-loop `infra-failed` with `settled:true`)
   * already emitted its own `turn:settled`; a `rejected` (turn-active) outcome relies on the
   * active turn's settled to unlock (the supervisor already sent the input-locked message).
   */
  const emitTerminalSignal = async (state: ProjectTurnState, result: TurnResult): Promise<void> => {
    const needsUnlock =
      result.kind === "declined" ||
      result.kind === "insufficient-balance" ||
      (result.kind === "infra-failed" && !result.settled);
    if (!needsUnlock) {
      return;
    }
    await emitTerminalUnlock(state, result.turnId);
  };

  /**
   * Reject a `prompt:submit` whose payload targets a project OTHER than the connection's
   * authorized one (Defense 2). No turn is opened and no {@link ProjectTurnState} is created
   * for the foreign id — the client just gets a `turn:message` explaining the mismatch.
   */
  const rejectProjectMismatch = (ctx: ConnectionContext): void => {
    safeEmit(() => {
      ctx.send({
        type: "turn:message",
        payload: {
          turnId: UNKNOWN_TURN_ID as TurnId,
          role: "supervisor",
          delta: PROJECT_MISMATCH_MESSAGE,
        },
        ts: now(),
      });
    });
  };

  /**
   * Drive one prompt on the project's SHARED supervisor + dynamic ctx. The catch-all
   * BACKSTOP (BUG-2) is load-bearing: `handlePrompt` should never throw for a designed
   * outcome, but a settle / appendChat DB fault can propagate — and `router.dispatch`
   * swallows a rejected handler promise (`.catch(() => undefined)`), which would leave the
   * client's input locked forever. So we catch it, log LOUDLY (never silently), and STILL
   * emit a zero-consumed unlock so the client recovers. ⚠️ Residual: if a settle ultimately
   * failed, the reserve is stranded `reserved` (no credit-backs, D34) for a later reconcile.
   */
  const runPromptTurn = async (
    ctx: ConnectionContext,
    payload: { projectId: string; text: string },
  ): Promise<void> => {
    // Defense 2 (cross-account hijack): the connection is authorized for exactly ONE
    // project at connect time — `ctx.projectId`, the id the ownership seam checked (see
    // `createProjectAuthorizer`). The prompt's `payload.projectId` is CLIENT-supplied, so it
    // is validated-must-equal input: a prompt naming any OTHER project is rejected outright.
    // We never open/find a `ProjectTurnState` for the foreign id, so an attacker can never
    // reach — let alone reroute frames to, or bill — another account's turn state, EVEN IF
    // the connect-time check regressed (defence in depth). All per-project state below is
    // keyed off `ctx.projectId`, never `payload.projectId`.
    const projectId = ctx.projectId;
    if (payload.projectId !== projectId) {
      rejectProjectMismatch(ctx);
      return;
    }
    const state = projectStateFor(ctx, projectId);
    // In-flight tracking for the deploy turn-gate (EC-40 / FR-058): this prompt STARTS a turn iff
    // the project is idle right now. The check-and-claim is synchronous (no await between the read
    // and the set), so two racing prompts can never both claim; if a turn is already in flight the
    // supervisor's single-active-turn lock (D24) REJECTS this prompt, so it starts no turn and
    // must neither set nor clear the flag (a `rejected` outcome owns no in-flight lifecycle). A
    // project mismatch returned above, so it never reaches — nor flips — the flag either.
    const startsTurn = !state.turnInFlight;
    if (startsTurn) {
      state.turnInFlight = true;
    }
    try {
      const result = await state.supervisor.handlePrompt(state.supervisorCtx, {
        projectId,
        text: payload.text,
      });
      await emitTerminalSignal(state, result);
    } catch (error) {
      logError("prompt:submit turn failed unexpectedly; emitting terminal unlock", {
        projectId,
        error,
      });
      await emitTerminalUnlock(state, UNKNOWN_TURN_ID);
    } finally {
      if (startsTurn) {
        // The turn settled — every terminal path (green / exhausted / infra / declined /
        // insufficient) and the unexpected-throw backstop pass through here. Clear the flag, then
        // release the deploys queued behind it (EC-40): FIFO, AFTER the terminal signal above, each
        // guarded so a throwing deploy callback cannot break the turn loop or its siblings. The
        // queue is DRAINED first so a callback that itself enqueues a deploy defers to a later turn.
        state.turnInFlight = false;
        for (const queued of state.idleQueue.splice(0)) {
          runIdleCallback(queued);
        }
      }
    }
  };

  /**
   * The turn-observation seam for the US8 deploy handler (EC-40 / FR-058). `isTurnActive` reads
   * the project's live in-flight flag ({@link ProjectTurnState.turnInFlight}); `runWhenIdle` fires
   * `fn` IMMEDIATELY when the project is idle (no {@link ProjectTurnState}, or none in flight),
   * else QUEUES it on the project's `idleQueue` to fire (FIFO, guarded) when the current turn
   * settles. A pure observer — it never opens, rejects, or otherwise touches a turn.
   */
  const turnGate: TurnGate = {
    isTurnActive: (projectId) => projects.get(projectId)?.turnInFlight === true,
    runWhenIdle: (projectId, fn) => {
      const state = projects.get(projectId);
      // Idle when the project has no state OR no turn in flight → run `fn` now; else queue it.
      if (state?.turnInFlight !== true) {
        runIdleCallback(fn);
        return;
      }
      state.idleQueue.push(fn);
    },
  };

  const handlers = (router: EventRouter): void => {
    router
      .on("prompt:submit", (event, ctx) => runPromptTurn(ctx, event.payload))
      .on("test:results", (event, ctx) => {
        // Cap the wire payload ONCE (server-side FR-033 enforcement) and reuse it for both the
        // rendezvous delivery and the coverage stash so the two never diverge.
        const capped = capResults(event.payload);
        // Stash the capped verdict as this project's latest results — the FR-032 coverage
        // input the green full compile reads. Keyed by the delivering connection's OWN
        // `ctx.projectId`, so a foreign verdict stashes under the foreign key, never the
        // owner's (Defense 4 scoping); the inbox delivery below still gates ownership.
        lastResultsByProject.set(ctx.projectId, capped);
        // Defense 4 (cross-tenant verdict injection): hand the inbox the delivering
        // connection's project so it resolves ONLY a wait OWNED by that project. A foreign
        // socket's verdict for another tenant's in-flight turnId is IGNORED (no false PASS, no
        // budget griefing); an unknown turnId is a no-op. Mirrors Defense 2's project check.
        inbox.deliver(capped, ctx.projectId);
      })
      .on("console:log", (event, ctx) => {
        recordConsole(ctx.projectId, "log", event.payload.message);
      })
      .on("console:error", (event, ctx) => {
        recordConsole(ctx.projectId, "error", event.payload.message);
      });
  };

  return { handlers, inbox, turnGate };
}
