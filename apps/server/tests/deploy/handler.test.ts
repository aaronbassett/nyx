/**
 * Deploy request handler tests (T160, US8) — deterministic, in-memory, NO chain, NO prover,
 * NO deploy key. These drive {@link createDeployHandler} through its narrow, injected seams
 * (`makePipeline`, `getLatestGreenBuild`, `wallet`, `turnGate`, `newRequestId`) to pin the
 * connection-scoped `deploy:request` → pipeline glue US8 depends on (FR-054/058, EC-40,
 * scenarios 1/3/7):
 *
 *  - HAPPY (scenario 1) — green build present + no active turn ⇒ `runDeploy` is driven with
 *    EXACTLY `{ projectId: ctx.projectId, requestId, greenBuild }`, and the pipeline's phases +
 *    exactly-once `contract:deployed` stream to the connection through the handler's ctx-bound
 *    emit sinks (§2 — the handler builds the pipeline per-request with `emit`/`emitContractDeployed`
 *    bound to the requesting `ctx`);
 *  - scenario 3 / FR-054 — no persisted green build ⇒ a named `deploy:status failed` and the
 *    pipeline is NEVER built (factory untouched) and the funds gate NEVER touched;
 *  - scenario 7 / FR-058 — a 2nd `deploy:request` while one is in flight ⇒ an in-progress
 *    `deploy:status failed`, and the pipeline is built + run EXACTLY ONCE (one deploy per project);
 *  - EC-40 / FR-058 — an ACTIVE turn ⇒ the deploy is QUEUED (a `validating` status + a
 *    `runWhenIdle` registration) and only runs when the turn goes idle;
 *  - EC-38 — the deploy wallet cannot fund the deploy ⇒ a PLATFORM-fault `deploy:status
 *    failed` (never user-blame), the pipeline is NEVER built, and NO `contract:deployed`;
 *  - ownership — the handler targets `ctx.projectId` (the ownership-checked connect project),
 *    NEVER a client-supplied project (the `deploy:request` payload is empty by construction);
 *  - H2 (stale-build fix) — greenness is read at DEPLOY time INSIDE `run` (after turn-idle for a
 *    queued deploy), so a deploy queued behind a turn ships the POST-turn build; a post-idle `null`
 *    green build rejects terminally with the pipeline never built; the immediate path fetches in
 *    `run` too (exactly once, no request-time capture);
 *  - M2 (turn-hang fix) — a queued deploy whose turn never goes idle is released after the bounded
 *    `queueTimeoutMs` (driven via the injected `delay`): the in-flight flag is freed + a terminal
 *    `failed` is emitted, and a LATE idle callback after the timeout is a no-op (no double-run).
 *
 * The pipeline + wallet + turn gate are Nyx-internal seams — the fake pipeline factory receives
 * the handler's REAL emit sinks and streams the frames it would emit in production through them,
 * so "phases + contract:deployed reach the socket" is observed through the actual handler wiring
 * (US1 wires `createDeployPipeline` behind `makePipeline`). Everything is deterministic: outcomes
 * come from the injected seams, ids from the injected `newRequestId`, timestamps from `now`.
 */
import { describe, expect, it } from "vitest";
import { ContractAddressSchema } from "@nyx/protocol";
import type {
  ClientToServerEvent,
  DeployRequestEvent,
  DeployStatusPayload,
  ServerToClientEvent,
} from "@nyx/protocol";
import { createDeployHandler, DEPLOY_HANDLER_DETAIL } from "../../src/deploy/handler.js";
import type { DeployHandlerDeps, DeployPipelineSinks, TurnGate } from "../../src/deploy/handler.js";
import type {
  DeployArtifacts,
  DeployInput,
  DeployPipeline,
  DeployResult,
} from "../../src/deploy/pipeline.js";
import {
  InsufficientDeployFundsError,
  PLATFORM_REFUELLING_MESSAGE,
} from "../../src/deploy/wallet.js";
import type { DeployWalletMonitor, WalletBalanceStatus } from "../../src/deploy/wallet.js";
import type { ConnectionContext, EventRouter } from "../../src/protocol/router.js";

// --- Fixtures ---------------------------------------------------------------

const PROJECT = "proj-1";
const ADDRESS = "addr-owner-1";
const TS = 1_700_000_000_000;
const GREEN_BUILD: DeployArtifacts = {
  urlPrefix: "https://r2.nyx.test/proj-1/abc123",
  compilerVersion: "0.24.0",
};
/** A healthy wallet status — the pre-deploy funds gate passes. */
const HEALTHY: WalletBalanceStatus = { available: 100n, level: "ok" };

/** Flush the microtask queue past one macrotask boundary (for deferred/queued paths). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- Fake connection context ------------------------------------------------

interface CtxHarness {
  readonly ctx: ConnectionContext;
  readonly sent: ServerToClientEvent[];
}

/** A fake connection recording every outbound frame; `projectId` defaults to {@link PROJECT}. */
function makeCtx(projectId: string = PROJECT): CtxHarness {
  const sent: ServerToClientEvent[] = [];
  const ctx: ConnectionContext = {
    session: { accountAddress: ADDRESS },
    projectId,
    send: (event) => {
      sent.push(event);
    },
    close: () => undefined,
  };
  return { ctx, sent };
}

// --- Fake router ------------------------------------------------------------

type StoredHandler = (event: ClientToServerEvent, ctx: ConnectionContext) => void | Promise<void>;

interface FakeRouter {
  readonly router: EventRouter;
  invoke(event: ClientToServerEvent, ctx: ConnectionContext): Promise<void>;
}

/** A minimal {@link EventRouter} that captures handlers so a test can invoke them directly. */
function makeFakeRouter(): FakeRouter {
  const handlers = new Map<ClientToServerEvent["type"], StoredHandler>();
  const router: EventRouter = {
    on(type, handler) {
      handlers.set(type, handler as StoredHandler);
      return router;
    },
    dispatch() {
      throw new Error("EventRouter.dispatch is not exercised in these tests");
    },
  };
  return {
    router,
    async invoke(event, ctx) {
      const handler = handlers.get(event.type);
      if (handler === undefined) {
        throw new Error(`no handler registered for ${event.type}`);
      }
      await handler(event, ctx);
    },
  };
}

/** The empty `deploy:request` client event (the payload is empty by protocol construction). */
function deployRequestEvent(): DeployRequestEvent {
  return { type: "deploy:request", payload: {}, ts: TS };
}

// --- Fake pipeline factory --------------------------------------------------

interface PipelineHarness {
  /** The per-request pipeline factory injected as `makePipeline` (§2). */
  readonly makePipeline: (sinks: DeployPipelineSinks) => Pick<DeployPipeline, "runDeploy">;
  readonly calls: DeployInput[];
  /** How many times the factory was invoked (once per STARTED deploy — never for a rejected one). */
  factoryCalls(): number;
  /** Resolve a `deferred` run so the awaiting handler settles (in-flight test cleanup). */
  settle(): void;
}

/**
 * A fake pipeline FACTORY. Each built pipeline's `runDeploy` records its input and — mirroring the
 * real pipeline — streams the four `deploy:status` phases (and, when `announce`, the exactly-once
 * `contract:deployed`) through the handler-supplied {@link DeployPipelineSinks}, which the handler
 * has bound to the requesting `ctx`. `deferred` keeps the run pending until {@link PipelineHarness.settle}.
 */
function makePipelineHarness(
  opts: { deferred?: boolean; announce?: boolean } = {},
): PipelineHarness {
  const calls: DeployInput[] = [];
  let factoryCallCount = 0;
  let resolvePending: (() => void) | undefined;
  const result: DeployResult = {
    kind: "deployed",
    address: ContractAddressSchema.parse(ADDRESS),
    version: 1n,
  };
  const makePipeline = (sinks: DeployPipelineSinks): Pick<DeployPipeline, "runDeploy"> => {
    factoryCallCount += 1;
    return {
      runDeploy(input: DeployInput): Promise<DeployResult> {
        calls.push(input);
        for (const phase of ["validating", "proving", "submitting", "awaiting_finality"] as const) {
          sinks.emit({ requestId: input.requestId, phase });
        }
        if (opts.announce === true) {
          sinks.emitContractDeployed({ address: result.address });
        }
        if (opts.deferred === true) {
          return new Promise<DeployResult>((resolve) => {
            resolvePending = () => {
              resolve(result);
            };
          });
        }
        return Promise.resolve(result);
      },
    };
  };
  return {
    makePipeline,
    calls,
    factoryCalls: () => factoryCallCount,
    settle() {
      resolvePending?.();
    },
  };
}

// --- Deps builder -----------------------------------------------------------

/** Build handler deps; every seam is a deterministic default overridable per test. */
function makeDeps(overrides: Partial<DeployHandlerDeps> = {}): DeployHandlerDeps {
  let counter = 0;
  const wallet: Pick<DeployWalletMonitor, "assertCanDeploy"> = {
    assertCanDeploy: () => Promise.resolve(HEALTHY),
  };
  const turnGate: TurnGate = {
    isTurnActive: () => false,
    runWhenIdle: (_projectId, fn) => {
      fn();
    },
  };
  return {
    makePipeline: overrides.makePipeline ?? makePipelineHarness().makePipeline,
    getLatestGreenBuild: overrides.getLatestGreenBuild ?? (() => Promise.resolve(GREEN_BUILD)),
    wallet: overrides.wallet ?? wallet,
    turnGate: overrides.turnGate ?? turnGate,
    newRequestId: overrides.newRequestId ?? (() => `req-${String(++counter)}`),
    now: overrides.now ?? (() => TS),
    // Optional seams — only included when overridden (exactOptionalPropertyTypes) so the default
    // path exercises the handler's real `defaultDelay` / `DEFAULT_QUEUE_TIMEOUT_MS` / `defaultLogError`.
    ...(overrides.delay === undefined ? {} : { delay: overrides.delay }),
    ...(overrides.queueTimeoutMs === undefined ? {} : { queueTimeoutMs: overrides.queueTimeoutMs }),
    ...(overrides.logError === undefined ? {} : { logError: overrides.logError }),
  };
}

/** A recorded `logError` call (the loud never-reject backstop log). */
interface LoggedError {
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

/** The `deploy:status` frames recorded on a ctx, narrowed to their payloads. */
function deployStatuses(sent: ServerToClientEvent[]): DeployStatusPayload[] {
  return sent
    .filter(
      (event): event is Extract<ServerToClientEvent, { type: "deploy:status" }> =>
        event.type === "deploy:status",
    )
    .map((event) => event.payload);
}

// --- Tests ------------------------------------------------------------------

describe("createDeployHandler", () => {
  it("drives runDeploy with { projectId, requestId, greenBuild } and streams phases + contract:deployed (scenario 1)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness({ announce: true });
    const handler = createDeployHandler(
      makeDeps({ makePipeline: pipe.makePipeline, newRequestId: () => "req-42" }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);

    expect(pipe.calls).toHaveLength(1);
    expect(pipe.calls[0]).toEqual({
      projectId: PROJECT,
      requestId: "req-42",
      greenBuild: GREEN_BUILD,
    });
    // The pipeline's phases reached the connection in order, through the handler's ctx-bound
    // emit sink (§2 — US1 wires the real pipeline's emit to this same connection).
    expect(deployStatuses(sent).map((status) => status.phase)).toEqual([
      "validating",
      "proving",
      "submitting",
      "awaiting_finality",
    ]);
    // The pipeline's exactly-once `contract:deployed` reached the same connection (new emit seam).
    expect(sent.some((event) => event.type === "contract:deployed")).toBe(true);
  });

  it("rejects with a no-green-build status and never builds the pipeline or touches the funds gate (scenario 3/FR-054)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    const walletCalls: number[] = [];
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        getLatestGreenBuild: () => Promise.resolve(null),
        wallet: {
          assertCanDeploy: () => {
            walletCalls.push(1);
            return Promise.resolve(HEALTHY);
          },
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);

    expect(pipe.calls).toHaveLength(0);
    expect(pipe.factoryCalls()).toBe(0);
    expect(walletCalls).toHaveLength(0);
    const statuses = deployStatuses(sent);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      phase: "failed",
      detail: DEPLOY_HANDLER_DETAIL.noGreenBuild,
    });
  });

  it("rejects a 2nd deploy:request while one is in flight, building + running the pipeline exactly once (scenario 7/FR-058)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness({ deferred: true });
    const handler = createDeployHandler(makeDeps({ makePipeline: pipe.makePipeline }));
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    // First deploy runs and hangs (deferred pipeline); the second arrives while it is in flight.
    const first = fr.invoke(deployRequestEvent(), ctx);
    const second = fr.invoke(deployRequestEvent(), ctx);
    await second;

    // Exactly one deploy is driven; the second is rejected as in-progress (NOT queued).
    expect(pipe.calls).toHaveLength(1);
    expect(pipe.factoryCalls()).toBe(1);
    const rejected = deployStatuses(sent).filter(
      (status) => status.phase === "failed" && status.detail === DEPLOY_HANDLER_DETAIL.inProgress,
    );
    expect(rejected).toHaveLength(1);

    // Cleanup: settle the held deploy so the first handler resolves (no dangling promise).
    pipe.settle();
    await first;
  });

  it("clears the in-flight flag once a deploy settles so a later deploy runs (FR-058)", async () => {
    const { ctx } = makeCtx();
    const pipe = makePipelineHarness();
    const handler = createDeployHandler(makeDeps({ makePipeline: pipe.makePipeline }));
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    // Each deploy settles synchronously (non-deferred), releasing the flag, so both run.
    await fr.invoke(deployRequestEvent(), ctx);
    await fr.invoke(deployRequestEvent(), ctx);
    expect(pipe.calls).toHaveLength(2);
    expect(pipe.factoryCalls()).toBe(2);
  });

  it("queues the deploy while a turn is active and runs it once the turn goes idle (EC-40/FR-058)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    const idle: (() => void)[] = [];
    const turnGate: TurnGate = {
      isTurnActive: () => true,
      runWhenIdle: (_projectId, fn) => {
        idle.push(fn);
      },
    };
    const handler = createDeployHandler(makeDeps({ makePipeline: pipe.makePipeline, turnGate }));
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);

    // Queued: a validating status is emitted, runWhenIdle is registered, nothing deployed yet.
    expect(pipe.calls).toHaveLength(0);
    expect(idle).toHaveLength(1);
    const queued = deployStatuses(sent);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ phase: "validating", detail: DEPLOY_HANDLER_DETAIL.queued });

    // The turn ends → the queued deploy runs.
    idle[0]?.();
    await tick();
    expect(pipe.calls).toHaveLength(1);
    expect(pipe.calls[0]).toMatchObject({ projectId: PROJECT, greenBuild: GREEN_BUILD });
  });

  it("emits a platform-fault status when the deploy wallet cannot fund the deploy, and never builds the pipeline (EC-38)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        wallet: { assertCanDeploy: () => Promise.reject(new InsufficientDeployFundsError(0n, 1n)) },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);

    expect(pipe.calls).toHaveLength(0);
    expect(pipe.factoryCalls()).toBe(0);
    expect(sent.some((event) => event.type === "contract:deployed")).toBe(false);
    const failed = deployStatuses(sent).filter((status) => status.phase === "failed");
    expect(failed).toHaveLength(1);
    // Platform-framed message (constitution III / EC-38) — never a user-blaming "out of funds".
    expect(failed[0]?.detail).toBe(PLATFORM_REFUELLING_MESSAGE);
  });

  it("I2: logs the funds-gate fault loudly with the error NAME only (never the raw error / key)", async () => {
    const { ctx } = makeCtx();
    const pipe = makePipelineHarness();
    const logs: LoggedError[] = [];
    // A funds-gate fault whose MESSAGE maliciously echoes a key-like string (a real balance-SDK
    // error could) — the handler must log the NAME only, never the raw error.
    const leaky = new Error("balance read failed key=SECRET-DEPLOY-KEY-abc");
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        wallet: { assertCanDeploy: () => Promise.reject(leaky) },
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);

    // The funds-gate fault was logged loudly, name-only — the raw error (and its key-bearing
    // message) never reached the sink.
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail.errorName).toBe("Error");
    expect(JSON.stringify(logs)).not.toContain("SECRET-DEPLOY-KEY-abc");
    // Still deploys nothing (platform-fault path unchanged).
    expect(pipe.factoryCalls()).toBe(0);
  });

  it("targets ctx.projectId (the ownership-checked connect project), never a client-supplied project", async () => {
    const { ctx } = makeCtx("owned-project");
    const pipe = makePipelineHarness();
    const greenCalls: string[] = [];
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        getLatestGreenBuild: (projectId) => {
          greenCalls.push(projectId);
          return Promise.resolve(GREEN_BUILD);
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    // A hostile/misrouted frame carrying a foreign projectId is ignored — the payload is empty
    // by schema, and the handler reads ONLY ctx.projectId.
    const rogue = {
      type: "deploy:request",
      payload: { projectId: "attacker-project" },
      ts: TS,
    } as unknown as DeployRequestEvent;
    await fr.invoke(rogue, ctx);

    expect(greenCalls).toEqual(["owned-project"]);
    expect(pipe.calls).toHaveLength(1);
    expect(pipe.calls[0]?.projectId).toBe("owned-project");
  });

  it("re-fetches the green build inside run at deploy time — after turn-idle, not at request time (H2)", async () => {
    const { ctx } = makeCtx();
    const pipe = makePipelineHarness();
    const idle: (() => void)[] = [];
    const turnGate: TurnGate = {
      isTurnActive: () => true,
      runWhenIdle: (_projectId, fn) => {
        idle.push(fn);
      },
    };
    const greenCalls: string[] = [];
    // The build the TURN produces — the handler must derive it POST-idle, not capture a pre-turn
    // build at request time (the whole H2 defect: the turn is exactly what mutates the green state).
    const postTurnBuild: DeployArtifacts = {
      urlPrefix: "https://r2.nyx.test/proj-1/post-turn",
      compilerVersion: "0.24.0",
    };
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        turnGate,
        getLatestGreenBuild: (projectId) => {
          greenCalls.push(projectId);
          return Promise.resolve(postTurnBuild);
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);
    // Queued: the green build is NOT fetched at request time (H2 — no pre-turn capture).
    expect(greenCalls).toHaveLength(0);
    expect(idle).toHaveLength(1);

    // The turn ends → run fetches the green build POST-idle and deploys exactly THAT build.
    idle[0]?.();
    await tick();
    expect(greenCalls).toEqual([PROJECT]);
    expect(pipe.calls).toHaveLength(1);
    expect(pipe.calls[0]?.greenBuild).toEqual(postTurnBuild);
  });

  it("rejects a queued deploy when the post-idle green build is null — pipeline never built (H2/FR-054)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    const idle: (() => void)[] = [];
    const turnGate: TurnGate = {
      isTurnActive: () => true,
      runWhenIdle: (_projectId, fn) => {
        idle.push(fn);
      },
    };
    // The turn left the project non-green (or it never had a green build): the POST-idle fetch is
    // null, so the queued deploy must reject terminally and never touch the pipeline.
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        turnGate,
        getLatestGreenBuild: () => Promise.resolve(null),
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);
    idle[0]?.();
    await tick();

    expect(pipe.calls).toHaveLength(0);
    expect(pipe.factoryCalls()).toBe(0);
    const statuses = deployStatuses(sent);
    // The queued `validating` first, then the terminal no-green failure derived POST-idle.
    expect(statuses.map((status) => status.phase)).toEqual(["validating", "failed"]);
    expect(statuses[1]).toMatchObject({
      phase: "failed",
      detail: DEPLOY_HANDLER_DETAIL.noGreenBuild,
    });
  });

  it("fetches the green build inside run on the immediate (no active turn) path, exactly once (H2)", async () => {
    const { ctx } = makeCtx();
    const pipe = makePipelineHarness();
    const greenCalls: string[] = [];
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        getLatestGreenBuild: (projectId) => {
          greenCalls.push(projectId);
          return Promise.resolve(GREEN_BUILD);
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);
    // Exactly one fetch (in run — no separate request-time capture), and the deploy ran with it.
    expect(greenCalls).toEqual([PROJECT]);
    expect(pipe.calls).toHaveLength(1);
    expect(pipe.calls[0]?.greenBuild).toEqual(GREEN_BUILD);
  });

  it("releases the in-flight flag and emits a terminal failure when a queued turn never goes idle (M2)", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    let turnActive = true;
    const idle: (() => void)[] = [];
    const turnGate: TurnGate = {
      isTurnActive: () => turnActive,
      runWhenIdle: (_projectId, fn) => {
        idle.push(fn);
      },
    };
    // A hand-driven timer: the handler's bounded queued-wait resolves only when the test fires it
    // (assignable to `(ms: number) => Promise<void>` — the ignored `ms` is the real `queueTimeoutMs`).
    let fireTimeout: (() => void) | undefined;
    const delay = (): Promise<void> =>
      new Promise<void>((resolve) => {
        fireTimeout = resolve;
      });
    const handler = createDeployHandler(
      makeDeps({ makePipeline: pipe.makePipeline, turnGate, delay, queueTimeoutMs: 1000 }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    await fr.invoke(deployRequestEvent(), ctx);
    // Queued: a validating status, an idle registration, and the bounded timer armed; nothing run.
    expect(deployStatuses(sent).map((status) => status.phase)).toEqual(["validating"]);
    expect(idle).toHaveLength(1);
    expect(fireTimeout).toBeDefined();

    // The turn never goes idle → the bounded timer fires → terminal failure + the flag released.
    fireTimeout?.();
    await tick();
    const afterTimeout = deployStatuses(sent);
    expect(afterTimeout.map((status) => status.phase)).toEqual(["validating", "failed"]);
    expect(afterTimeout[1]).toMatchObject({
      phase: "failed",
      detail: DEPLOY_HANDLER_DETAIL.turnTimeout,
    });
    expect(pipe.calls).toHaveLength(0);

    // A LATE idle callback (after the timeout won) is a no-op — no double-run, no double-status.
    idle[0]?.();
    await tick();
    expect(pipe.calls).toHaveLength(0);
    expect(deployStatuses(sent)).toHaveLength(2);

    // The flag was released (not wedged): a fresh request — turn now idle — deploys normally.
    turnActive = false;
    await fr.invoke(deployRequestEvent(), ctx);
    expect(pipe.calls).toHaveLength(1);
  });

  // --- BUG 1: run() never-reject backstop (getLatestGreenBuild / makePipeline throws) ----------

  it("BUG 1: a THROWING getLatestGreenBuild on the QUEUED path resolves run, emits a terminal failed, releases the flag, and leaks NO unhandled rejection", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    const idle: (() => void)[] = [];
    let turnActive = true;
    const turnGate: TurnGate = {
      isTurnActive: () => turnActive,
      runWhenIdle: (_projectId, fn) => {
        idle.push(fn);
      },
    };
    const logs: LoggedError[] = [];
    const boom = new Error("green-build DB read blew up");
    let throwOnGreen = true;
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        turnGate,
        getLatestGreenBuild: () =>
          throwOnGreen ? Promise.reject(boom) : Promise.resolve(GREEN_BUILD),
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    // Guard: assert NO unhandled rejection escapes the queued path's `void run(...)`.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await fr.invoke(deployRequestEvent(), ctx);
      // Queued: nothing run yet, an idle callback registered.
      expect(pipe.calls).toHaveLength(0);
      expect(idle).toHaveLength(1);

      // The turn ends → `void run(...)` executes and `getLatestGreenBuild` throws. The catch-all
      // must catch it: run RESOLVES, so no unhandled rejection is produced.
      idle[0]?.();
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    // run's backstop fired: a terminal failed status (wire-safe), the loud log, and NO rejection.
    const statuses = deployStatuses(sent);
    expect(statuses.map((status) => status.phase)).toEqual(["validating", "failed"]);
    expect(statuses[1]).toMatchObject({
      phase: "failed",
      detail: DEPLOY_HANDLER_DETAIL.unexpected,
    });
    expect(logs.some((entry) => entry.detail.error === boom)).toBe(true);
    expect(rejections).toEqual([]);

    // The flag was released (finally) — the project is NOT wedged: a fresh, healthy deploy runs.
    throwOnGreen = false;
    turnActive = false;
    await fr.invoke(deployRequestEvent(), ctx);
    expect(pipe.calls).toHaveLength(1);
  });

  it("BUG 1: a THROWING makePipeline on the queued path resolves run to a terminal failed and un-wedges the project", async () => {
    const { ctx, sent } = makeCtx();
    const goodPipe = makePipelineHarness();
    const idle: (() => void)[] = [];
    let turnActive = true;
    const turnGate: TurnGate = {
      isTurnActive: () => turnActive,
      runWhenIdle: (_projectId, fn) => {
        idle.push(fn);
      },
    };
    const logs: LoggedError[] = [];
    const boom = new Error("pipeline construction blew up");
    let throwOnMake = true;
    const makePipeline: DeployHandlerDeps["makePipeline"] = (sinks: DeployPipelineSinks) => {
      if (throwOnMake) {
        throw boom;
      }
      return goodPipe.makePipeline(sinks);
    };
    const handler = createDeployHandler(
      makeDeps({
        makePipeline,
        turnGate,
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await fr.invoke(deployRequestEvent(), ctx);
      expect(idle).toHaveLength(1);
      // The turn ends → run builds the pipeline, whose factory throws synchronously; the catch-all
      // catches it (run RESOLVES), so `void run(...)` produces no unhandled rejection.
      idle[0]?.();
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    const statuses = deployStatuses(sent);
    expect(statuses.map((status) => status.phase)).toEqual(["validating", "failed"]);
    expect(statuses[1]).toMatchObject({
      phase: "failed",
      detail: DEPLOY_HANDLER_DETAIL.unexpected,
    });
    expect(logs.some((entry) => entry.detail.error === boom)).toBe(true);
    expect(rejections).toEqual([]);

    // Not wedged: with makePipeline now healthy and no active turn, a fresh deploy runs.
    throwOnMake = false;
    turnActive = false;
    await fr.invoke(deployRequestEvent(), ctx);
    expect(goodPipe.calls).toHaveLength(1);
  });

  it("BUG 1: a THROWING getLatestGreenBuild on the IMMEDIATE path resolves (never rejects) with a terminal failed", async () => {
    const { ctx, sent } = makeCtx();
    const pipe = makePipelineHarness();
    const logs: LoggedError[] = [];
    const boom = new Error("green-build DB read blew up");
    let throwOnGreen = true;
    // No active turn (makeDeps default) ⇒ the immediate path: `await run(...)` inside the handler.
    const handler = createDeployHandler(
      makeDeps({
        makePipeline: pipe.makePipeline,
        getLatestGreenBuild: () =>
          throwOnGreen ? Promise.reject(boom) : Promise.resolve(GREEN_BUILD),
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fr = makeFakeRouter();
    handler.handlers(fr.router);

    // The immediate path awaits run; because run RESOLVES, invoke resolves (does not reject).
    await expect(fr.invoke(deployRequestEvent(), ctx)).resolves.toBeUndefined();

    expect(pipe.calls).toHaveLength(0);
    const statuses = deployStatuses(sent);
    expect(statuses.map((status) => status.phase)).toEqual(["failed"]);
    expect(statuses[0]).toMatchObject({
      phase: "failed",
      detail: DEPLOY_HANDLER_DETAIL.unexpected,
    });
    expect(logs.some((entry) => entry.detail.error === boom)).toBe(true);

    // The flag was released (finally): a fresh, healthy deploy runs (project not wedged).
    throwOnGreen = false;
    await fr.invoke(deployRequestEvent(), ctx);
    expect(pipe.calls).toHaveLength(1);
  });
});
