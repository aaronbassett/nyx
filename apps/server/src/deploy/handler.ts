/**
 * Deploy request handler — the US8 `deploy:request` → deploy-pipeline glue (T160, FR-054/058,
 * EC-40, scenarios 1/3/7).
 *
 * `createDeployHandler` returns a `handlers(router)` hook (the same shape the turn coordinator
 * exposes) that registers ONE client→server handler: `deploy:request`. The event is EMPTY by
 * protocol construction — a deploy always targets the connection's OWN project — so the handler
 * NEVER reads a client-supplied project: the deploy runs against `ctx.projectId`, the id US1's
 * `authorizeProject` ownership-checked at WS connect (Defense in depth mirrors the turn
 * coordinator's `ctx.projectId`-only rule). It owns four gates the pipeline deliberately does
 * not, then hands a valid, funded, single-in-flight deploy to {@link DeployPipeline.runDeploy}:
 *
 *  1. **One-in-flight per project (FR-058 / scenario 7).** A per-project in-flight set is
 *     CLAIMED atomically (a `has`+`add` with no `await` between) at request time, so two racing
 *     requests can never both start; the loser gets an in-progress
 *     `deploy:status { phase: "failed" }` — a duplicate is REJECTED, never queued (one deploy per
 *     project at a time). The flag is released when the deploy settles (any {@link DeployResult}),
 *     when a gate rejects it (no green build / funds), or when a queued wait times out — so a
 *     project is never wedged.
 *  2. **Queue-during-turn, bounded (EC-40 / FR-058 / M2).** If a turn is active (D24
 *     single-active-turn), the deploy must not race the turn's own compile/artifacts: the handler
 *     emits a queued `deploy:status { phase: "validating" }` and defers the run via
 *     {@link TurnGate.runWhenIdle}, holding the in-flight flag across the wait; the deploy starts
 *     when the turn ends. The wait is BOUNDED by {@link DeployHandlerDeps.queueTimeoutMs} — if the
 *     turn never goes idle (a genuine hang, where the idle queue would never drain), the timeout
 *     releases the flag and emits a terminal `deploy:status { phase: "failed" }`, so a hung turn
 *     can never wedge every future deploy. The idle callback and the timeout race: whichever fires
 *     FIRST wins, the other is a no-op. With no active turn the deploy runs immediately.
 *  3. **Greenness at DEPLOY time (FR-054 / scenario 3).** {@link DeployHandlerDeps.getLatestGreenBuild}
 *     yields the project's latest persisted green build, read INSIDE `run` (i.e. AFTER the queued
 *     wait for the queued path) so greenness reflects the project AS DEPLOYED — never a pre-turn,
 *     now-stale build, which is EC-40's whole point (the turn the deploy waited behind is exactly
 *     what mutates the green state). A `null` (no compile+tests-passing build, or the turn left the
 *     project non-green) is a named `deploy:status { phase: "failed" }` and the pipeline (and the
 *     funds gate) is NEVER touched — a deploy without a green build cannot start.
 *  4. **Pre-deploy funds gate (EC-38).** {@link DeployWalletMonitor.assertCanDeploy} runs before
 *     `runDeploy`; an {@link InsufficientDeployFundsError} (the platform's fee wallet is empty)
 *     is surfaced as a PLATFORM fault — a `deploy:status { phase: "failed" }` carrying the
 *     platform-framed message ({@link PLATFORM_REFUELLING_MESSAGE}), NEVER a user-blaming one —
 *     and nothing is deployed (so no `contract:deployed`).
 *
 * CONSTITUTION III — the handler NEVER touches, reads, or emits the deploy key. It drives the
 * pipeline over a narrow {@link DeployHandlerDeps.makePipeline} seam; the key flows ONLY into the
 * pipeline's (owner-gated) executor adapter, server-side (D50). Every `deploy:status` this
 * handler emits is sourced from a fixed, wire-safe {@link DEPLOY_HANDLER_DETAIL} classification.
 *
 * EMIT-SEAM RECONCILIATION (§2). The pipeline's `emit`/`emitContractDeployed` are CONSTRUCTION
 * deps, but they must reach the connection that sent `deploy:request` (per-request `ctx.send`). So
 * the handler takes a per-request pipeline FACTORY ({@link DeployHandlerDeps.makePipeline}): at
 * run time it builds the pipeline with `emit`/`emitContractDeployed` sinks BOUND to the requesting
 * `ctx`, via {@link safeSend} (a dead-socket `ws.send` throw is swallowed — a no-op, mirroring the
 * turn coordinator's `safeEmit`). The pipeline then streams its OWN phase stream
 * (`validating`→…→`awaiting_finality`) + its exactly-once `contract:deployed` straight to that
 * connection; this handler emits only its four GATING statuses (rejections + queued +
 * platform-fault) — it does not re-emit the pipeline's phases.
 *
 * NEVER-REJECT BACKSTOP (mirrors the pipeline's `unexpectedFailure`). {@link run} wraps its WHOLE
 * body in a catch-all: an UNEXPECTED throw from {@link DeployHandlerDeps.getLatestGreenBuild} (a
 * transient DB-read fault), a sync throw from {@link DeployHandlerDeps.makePipeline}, or any other
 * stray fault becomes a LOUD structured log ({@link DeployHandlerDeps.logError} — never the raw
 * error on the wire, constitution III) + a terminal wire-safe `deploy:status { phase: "failed" }`
 * ({@link DEPLOY_HANDLER_DETAIL.unexpected}) + a released in-flight flag. `run` RESOLVES on EVERY
 * path — it never rejects. This is load-bearing on the QUEUED path, where `run` is invoked as
 * `void run(...)` from the turn-idle callback: an escaping rejection there is an UNHANDLED
 * rejection that, under Node's default `--unhandled-rejections=throw`, would KILL THE PROCESS and
 * take down every other connection + deploy. On the immediate path (`await run(...)`) a reject
 * would instead be swallowed by the router boundary → a silent hung spinner. Both are precluded.
 *
 * ⚠️ UX GAP (accepted, D40). The sinks are bound to the REQUEST ctx captured at `deploy:request`
 * time — NOT a dynamic live-ctx like the turn coordinator's `state.liveCtx`. If a D40 takeover
 * swaps the project's live socket MID-DEPLOY, the pipeline's later frames go to the now-dead
 * request ctx and DROP. That is acceptable: `GET /projects/:id/deploys` is authoritative and the
 * deploy still completes + records server-side. Dynamic live-ctx routing for deploys is left
 * unbuilt (it is not trivially free here — the pipeline is per-request, not per-project).
 *
 * Everything is DETERMINISTIC and seam-injected: `makePipeline`/`getLatestGreenBuild`/`wallet`/
 * `turnGate`/`newRequestId`/`now` are all injected, so the whole gate machine is testable with
 * no chain, no prover, no key, and no real turn coordinator (constitution IV).
 */
import type {
  ContractDeployedPayload,
  DeployStatusPayload,
  DeployStatusPhase,
  ServerToClientEvent,
} from "@nyx/protocol";
import type { ConnectionContext, EventRouter } from "../protocol/router.js";
import { errorNameOf } from "./devnet-executor.js";
import type { DeployArtifacts, DeployPipeline } from "./pipeline.js";
import { InsufficientDeployFundsError, PLATFORM_REFUELLING_MESSAGE } from "./wallet.js";
import type { DeployWalletMonitor } from "./wallet.js";

// --- Seams ------------------------------------------------------------------

/**
 * The queue-during-turn seam (EC-40 / FR-058). The REAL implementation couples to the turn
 * coordinator's per-project single-active-turn state (D24) — a deploy must wait for an in-flight
 * turn to finish so it never races the turn's compile/artifacts — and is an OWNER-GATED/US1
 * wiring concern. Tests inject a fake `{ isTurnActive, runWhenIdle }`.
 */
export interface TurnGate {
  /** Is a turn currently active for `projectId` (D24)? A queued deploy waits for it to end. */
  isTurnActive(projectId: string): boolean;
  /** Run `fn` when the project's active turn goes idle (immediately if none is active). */
  runWhenIdle(projectId: string, fn: () => void): void;
}

/**
 * The per-request pipeline emit sinks (§2). Bound by the handler to the requesting connection so
 * the pipeline's own phase stream + exactly-once `contract:deployed` reach the client that asked
 * to deploy. Structurally the pipeline's `emit`/`emitContractDeployed` construction deps, lifted
 * to a per-request factory arg so a single pipeline construction can target any connection.
 */
export interface DeployPipelineSinks {
  /** The pipeline's `deploy:status` stream sink (payload only; the handler wraps + sends it). */
  readonly emit: (status: DeployStatusPayload) => void;
  /** The pipeline's exactly-once `contract:deployed` sink (payload only; handler wraps + sends). */
  readonly emitContractDeployed: (payload: ContractDeployedPayload) => void;
}

/**
 * Injectable dependencies for {@link createDeployHandler} — every side effect is a seam. The
 * deploy key is NEVER here: it flows only into the pipeline's server-side executor (constitution
 * III / D50).
 */
export interface DeployHandlerDeps {
  /**
   * Per-request pipeline FACTORY (§2). Given the emit sinks (which the handler binds to the
   * requesting `ctx`), returns the pipeline whose `runDeploy` drives one explicit deploy. A
   * factory (not a fixed pipeline) so the pipeline's `deploy:status`/`contract:deployed` reach
   * the connection that sent `deploy:request` — US1 wires `createDeployPipeline` behind it.
   */
  readonly makePipeline: (sinks: DeployPipelineSinks) => Pick<DeployPipeline, "runDeploy">;
  /**
   * The project's latest persisted green build (compile + tests passing), or `null` when the
   * project has none (FR-054 / scenario 3). The real impl reads US7 persistence + the compile
   * pipeline's green outcome; it is an OWNER-GATED/US-wiring seam. Tests inject a fixed value.
   */
  readonly getLatestGreenBuild: (projectId: string) => Promise<DeployArtifacts | null>;
  /** The pre-deploy funds gate (EC-38) — `assertCanDeploy` rejects when the fee wallet is dry. */
  readonly wallet: Pick<DeployWalletMonitor, "assertCanDeploy">;
  /** The queue-during-turn seam (EC-40 / FR-058); real impl couples to the turn coordinator. */
  readonly turnGate: TurnGate;
  /** The `deploy:status` correlation id (D62); injected so tests are deterministic. */
  readonly newRequestId: () => string;
  /** Event clock for the emitted `deploy:status` `ts`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Bounded ceiling (ms) on the queue-during-turn wait (M2). If the project's active turn never
   * goes idle within this window — a genuine turn hang, where {@link TurnGate.runWhenIdle}'s idle
   * queue never drains — the queued deploy is failed (flag released + terminal `deploy:status`) so
   * a hung turn cannot permanently wedge every future deploy. Defaults to
   * {@link DEFAULT_QUEUE_TIMEOUT_MS}.
   */
  readonly queueTimeoutMs?: number;
  /**
   * The bounded-wait timer seam (M2) — mirrors the turn coordinator / compile client: resolves
   * after `ms`. Defaults to an UNREF'd `setTimeout` so a live wait never pins the process; tests
   * inject a hand-driven delay to fire the queued-wait timeout deterministically.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Structured error sink for the never-reject backstop — an UNEXPECTED throw in {@link run}
   * (`getLatestGreenBuild`, `makePipeline`, or anything else) is logged LOUDLY here (never
   * silently swallowed, never onto the wire) before the client is given a terminal `failed`
   * status. Defaults to a structured `process.stderr` line (mirrors the deploy pipeline +
   * `index.ts`); tests inject a spy to assert the loud log fired.
   */
  readonly logError?: (message: string, detail: Record<string, unknown>) => void;
}

/** The handler's public surface — a `handlers(router)` hook the buildServer task registers. */
export interface DeployHandler {
  /** Register the `deploy:request` handler on a connection's router. */
  readonly handlers: (router: EventRouter) => void;
}

/**
 * Wire-safe, client-facing `deploy:status.detail` messages for the handler's four GATING
 * statuses (constitution III — no internals, no secrets). `platform` reuses the deploy wallet's
 * platform-framed message so an EC-38 outage is NEVER surfaced as a user fault.
 */
export const DEPLOY_HANDLER_DETAIL = {
  /** FR-054 / scenario 3 — the project has no compile+tests-passing build to deploy. */
  noGreenBuild: "no green build — compile and tests must pass first",
  /** FR-058 / scenario 7 — a deploy is already in flight for this project (rejected, not queued). */
  inProgress: "a deploy is already in progress",
  /** EC-40 — the deploy is queued behind the project's active turn; it starts when the turn ends. */
  queued: "deploy queued — it will start when the current turn finishes",
  /** M2 — the queued deploy's turn never finished within the bounded wait; the deploy was released. */
  turnTimeout: "the turn didn't finish in time — try the deploy again",
  /** EC-38 — the platform's deploy wallet could not fund the deploy (platform-side, not the user). */
  platform: PLATFORM_REFUELLING_MESSAGE,
  /**
   * Never-reject backstop — an UNEXPECTED throw from a handler seam (`getLatestGreenBuild`,
   * `makePipeline`, or anything else in {@link run}). A wire-safe constant, NEVER the raw error or
   * any key (constitution III); the raw fault goes ONLY to the loud {@link DeployHandlerDeps.logError}
   * log. Steered as retriable so the client can simply try again.
   */
  unexpected: "deploy failed unexpectedly — try again",
} as const;

/**
 * Default ceiling on the queue-during-turn wait (M2) — five minutes. Generous enough that a
 * healthy turn (compile + verify) always settles first, tight enough that a genuinely hung turn
 * releases the wedged deploy in bounded time rather than never. Overridable via
 * {@link DeployHandlerDeps.queueTimeoutMs}.
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60_000;

/** The default bounded-wait timer — an UNREF'd `setTimeout` so a queued wait never pins the process. */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * The default structured error sink for the never-reject backstop: a single JSON line to
 * `process.stderr` (mirrors the deploy pipeline + `index.ts`). `Error` values render to
 * `{ name, message, stack }` and any stray `bigint` to a decimal string, so the log line itself
 * can NEVER throw and block the client's terminal status.
 */
function defaultLogError(message: string, detail: Record<string, unknown>): void {
  const rendered: Record<string, unknown> = { level: "error", source: "deploy-handler", message };
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
 * Build the deploy request handler over its injected seams. Maintains a per-project in-flight
 * set so at most one deploy runs per project at a time (FR-058); the returned `handlers` hook
 * registers the `deploy:request` handler and is side-effect-free until a frame arrives.
 */
export function createDeployHandler(deps: DeployHandlerDeps): DeployHandler {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? defaultDelay;
  const queueTimeoutMs = deps.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const logError = deps.logError ?? defaultLogError;
  // Per-PROJECT in-flight guard (FR-058): a project id is present iff a deploy is in flight (or
  // queued) for it. Claimed atomically (has+add, no await between) so two racing requests can
  // never both start; released when the deploy settles / is blocked / is rejected.
  const inFlight = new Set<string>();

  /**
   * Send one server→client frame, swallowing a dead-socket throw (mirrors the turn coordinator's
   * `safeEmit`). `ws.send` on a CLOSED socket throws synchronously; a mid-deploy disconnect / D40
   * takeover must NOT let that abort the gate machine — a gone client is a NO-OP (the deploy still
   * runs + records server-side; `GET /projects/:id/deploys` is authoritative).
   */
  function safeSend(ctx: ConnectionContext, event: ServerToClientEvent): void {
    try {
      ctx.send(event);
    } catch {
      // Dead socket — drop the frame; the deploy continues + records server-side.
    }
  }

  /** Emit one `deploy:status`, omitting `detail` when absent (exactOptionalPropertyTypes). */
  function sendStatus(
    ctx: ConnectionContext,
    requestId: string,
    phase: DeployStatusPhase,
    detail?: string,
  ): void {
    const payload: DeployStatusPayload =
      detail === undefined ? { requestId, phase } : { requestId, phase, detail };
    safeSend(ctx, { type: "deploy:status", payload, ts: now() });
  }

  /**
   * Run one single-in-flight deploy at DEPLOY time: the AUTHORITATIVE greenness read (H2), then
   * the EC-38 pre-deploy funds gate, then the pipeline. Greenness is read HERE — not at request
   * time — so a QUEUED deploy derives it POST-idle (after the turn it waited behind), never a
   * pre-turn stale build; a `null` build rejects with `noGreenBuild` and deploys nothing. A
   * funds-gate rejection is surfaced as a PLATFORM fault (never user-blame) and stops the deploy;
   * the pipeline owns its own phase stream + `contract:deployed`.
   *
   * NEVER-REJECT: the whole body is wrapped in a catch-all so ANY unexpected throw
   * (`getLatestGreenBuild`, a sync `makePipeline`, or anything else) becomes a LOUD `logError` +
   * a terminal wire-safe `failed` status — `run` RESOLVES on every path, never rejects, so both
   * `await run(...)` (immediate) and `void run(...)` (queued) are safe and the queued path can
   * never produce a process-killing unhandled rejection. The `finally` releases the in-flight flag
   * on EVERY path (no-green, funds-blocked, settled, unexpected throw), so a project is never wedged.
   */
  async function run(ctx: ConnectionContext, projectId: string, requestId: string): Promise<void> {
    try {
      try {
        // Greenness (FR-054 / scenario 3) — the AUTHORITATIVE read, at DEPLOY time (H2). For a
        // queued deploy this runs POST-idle, so the build reflects the project AFTER the turn that
        // mutated its green state — never the pre-turn, now-stale build. A `null` here (the turn
        // left the project non-green, or it never had a green build) rejects the deploy: the
        // pipeline (and the funds gate below) is never touched.
        const greenBuild = await deps.getLatestGreenBuild(projectId);
        if (greenBuild === null) {
          sendStatus(ctx, requestId, "failed", DEPLOY_HANDLER_DETAIL.noGreenBuild);
          return;
        }
        try {
          await deps.wallet.assertCanDeploy();
        } catch (error) {
          // I2: log the funds-gate fault LOUDLY (it used to be swallowed silently). Name ONLY
          // (SC-031: a real balance-SDK error could echo the signing key in its message/stack, so
          // never pass the raw error here — only its class name + key-free context).
          logError("deploy funds gate failed — surfacing a platform fault", {
            projectId,
            requestId,
            errorName: errorNameOf(error),
          });
          // EC-38: an exhausted deploy wallet (or any funds-gate fault) is a PLATFORM issue, never
          // the user's fault — surface the platform-framed message and deploy nothing (no pipeline
          // is even built, so no `contract:deployed`).
          const detail =
            error instanceof InsufficientDeployFundsError
              ? error.platformFaultMessage()
              : DEPLOY_HANDLER_DETAIL.platform;
          sendStatus(ctx, requestId, "failed", detail);
          return;
        }
        // Build the pipeline for THIS request (§2): its emit sinks are bound to the requesting
        // `ctx` via `safeSend`, so the pipeline's own phase stream + exactly-once `contract:deployed`
        // reach the connection that asked to deploy. The pipeline owns those emits; the handler does
        // not re-emit them. The terminal DeployResult only clears the in-flight flag.
        const pipeline = deps.makePipeline({
          emit: (status) => {
            safeSend(ctx, { type: "deploy:status", payload: status, ts: now() });
          },
          emitContractDeployed: (payload) => {
            safeSend(ctx, { type: "contract:deployed", payload, ts: now() });
          },
        });
        await pipeline.runDeploy({ projectId, requestId, greenBuild });
      } catch (error) {
        // Never-reject backstop (mirrors the pipeline's `unexpectedFailure` + the coordinator
        // backstop): an UNEXPECTED throw from `getLatestGreenBuild`, a sync `makePipeline` throw,
        // or any other stray fault must NOT escape `run`. On the QUEUED path `run` is invoked as
        // `void run(...)`, so an escaping rejection is an UNHANDLED rejection → under Node's default
        // `--unhandled-rejections=throw` it KILLS THE PROCESS, taking down every other connection.
        // Log LOUDLY (never the raw error on the wire, constitution III), emit a terminal wire-safe
        // `failed` status (via `safeSend`, itself throw-safe), and RESOLVE.
        logError(
          "deploy failed UNEXPECTEDLY in the handler (getLatestGreenBuild/makePipeline threw) — emitting a terminal failed status so the client never hangs and the process never dies",
          { projectId, requestId, error },
        );
        sendStatus(ctx, requestId, "failed", DEPLOY_HANDLER_DETAIL.unexpected);
      }
    } finally {
      inFlight.delete(projectId);
    }
  }

  /**
   * Handle one `deploy:request`. Targets `ctx.projectId` (the ownership-checked connect project),
   * never a client-supplied project. Gates: one-in-flight claim → queue-during-turn (bounded) →
   * run (which reads greenness at DEPLOY time). Never throws for a designed outcome (each is a
   * `deploy:status`); the router swallows any stray rejection at its boundary.
   */
  async function handleDeployRequest(ctx: ConnectionContext): Promise<void> {
    const projectId = ctx.projectId;
    const requestId = deps.newRequestId();

    // 1. One-in-flight per project (FR-058 / scenario 7) — claim atomically. The `has`+`add` runs
    // with NO await between, so two racing requests can never both claim: the loser sees the flag
    // and is REJECTED as in-progress (not queued — one deploy per project). Greenness is derived
    // later, at deploy time inside `run` (H2), so it reflects the project AS DEPLOYED.
    if (inFlight.has(projectId)) {
      sendStatus(ctx, requestId, "failed", DEPLOY_HANDLER_DETAIL.inProgress);
      return;
    }
    inFlight.add(projectId);

    // 2. Queue-during-turn, bounded (EC-40 / FR-058 / M2) — a deploy must not race the project's
    // active turn. Emit a queued status and defer the run to turn-idle, HOLDING the flag across the
    // wait (a 2nd request while queued is still rejected in-progress). The idle callback and a
    // `queueTimeoutMs` timer RACE: `settleOnce` runs exactly one of them (whichever fires first)
    // and makes the loser a no-op. On idle, `run` executes (and releases the flag). On timeout —
    // the turn hung and the idle queue would never drain — the flag is released here + a terminal
    // `failed` is emitted, so a hung turn can never wedge every future deploy.
    if (deps.turnGate.isTurnActive(projectId)) {
      sendStatus(ctx, requestId, "validating", DEPLOY_HANDLER_DETAIL.queued);
      let settled = false;
      const settleOnce = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };
      deps.turnGate.runWhenIdle(projectId, () => {
        settleOnce(() => {
          void run(ctx, projectId, requestId);
        });
      });
      void delay(queueTimeoutMs).then(() => {
        settleOnce(() => {
          // Timeout: the turn never went idle (a genuine hang, not a throw — a throw would settle
          // the turn and drain the idle queue). Release the flag + emit a terminal failure so the
          // project is not permanently wedged and the client gets a terminal status; a later idle
          // callback is now a no-op (`settled`).
          inFlight.delete(projectId);
          sendStatus(ctx, requestId, "failed", DEPLOY_HANDLER_DETAIL.turnTimeout);
        });
      });
      return;
    }

    // 3. No active turn — run now. Greenness is fetched INSIDE `run` at deploy time (H2).
    await run(ctx, projectId, requestId);
  }

  const handlers = (router: EventRouter): void => {
    router.on("deploy:request", (_event, ctx) => handleDeployRequest(ctx));
  };

  return { handlers };
}
