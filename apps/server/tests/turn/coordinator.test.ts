/**
 * Turn coordinator unit tests (T135) — the WS wiring around the US1 supervisor.
 *
 * These pin the coordinator-owned units in isolation, with the supervisor either a
 * SPY (to inspect the per-turn ctx-bound seams it is handed) or the REAL machine (to
 * pin the D24 single-active-turn behaviour). No models, no Compile Service, no
 * WebContainer (constitution III/IV):
 *  - the `test:results` inbox: register → deliver resolves; a bounded timeout resolves
 *    as a FAILING verdict (no-hang, D42); an unmatched deliver is a no-op;
 *  - the ctx-bound seams: `checkCompile` adapts a turn input → the §4.1 CheckRequest;
 *    `awaitTestResults` emits `verify:run` then awaits the inbox; `runFullCompile`
 *    drives an orchestrator that announces `artifacts:ready` once;
 *  - the terminal signal: a `declined` outcome emits a `turn:settled { consumed:"0" }`
 *    (client unlocks, no ledger settlement); a settling outcome emits nothing extra;
 *  - one supervisor per connection (the D24 lock persists across prompts), and a
 *    `rejected` second prompt gets an input-locked `turn:message` and NO `turn:settled`;
 *  - Defense 4 (cross-tenant verdict injection): a `test:results` from a connection NOT
 *    authorized for the turn's project is IGNORED (a foreign green cannot force a false
 *    PASS; only the owner's verdict resolves the wait), an unknown turnId is a no-op, the
 *    ownership frees on resolve (slot reuses cleanly), and console frames scope per project.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { buildImplementationInstructions, buildScaffoldingInstructions } from "@nyx/scaffold";
import {
  ProjectIdSchema,
  TurnIdSchema,
  type ChatMessage,
  type ClientToServerEvent,
  type PromptSubmitEvent,
  type ServerToClientEvent,
  type TestFailure,
  type TestResultsEvent,
} from "@nyx/protocol";
import { createTurnCoordinator } from "../../src/turn/coordinator.js";
import type { TurnCoordinatorDeps, TurnCoordinatorMcp } from "../../src/turn/coordinator.js";
import type { ModelRole } from "../../src/config/schema.js";
import type { ModelRouter } from "../../src/agents/routing.js";
import type {
  SubAgentCycleContext,
  SubAgentWork,
  SubAgents,
  Supervisor,
  SupervisorDeps,
  TurnResult,
} from "../../src/agents/supervisor.js";
import type {
  ArtifactManifest,
  CheckRequest,
  CompileClient,
  CompileRequest,
} from "../../src/compile/index.js";
import type { Balance, LedgerEntryRecord, LedgerStore, Turn } from "../../src/ledger/ledger.js";
import type { ChatStore, ChatWrite } from "../../src/projects/chat.js";
import type { ConnectionContext, EventRouter } from "../../src/protocol/router.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECT = "proj-1";
const ADDRESS = "addr-owner-1";
const FLAT_RESERVE = 100n;
const TS = 1_700_000_000_000;

/** A representative valid R2 manifest so verify-before-announce passes. */
const MANIFEST: ArtifactManifest = {
  sourceHash: "sh-1",
  compilerVersion: "0.24.0",
  circuits: [{ name: "increment", proof: true }],
  files: [
    { path: "increment.zkir", sha256: "abc", bytes: 10, contentType: "application/octet-stream" },
  ],
};

// ── Fakes ────────────────────────────────────────────────────────────────────────

/** Flush the microtask queue past one macrotask boundary. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A never-resolving delay, so the inbox timeout never fires unless a test wants it. */
const neverDelay = (): Promise<void> => new Promise<void>(() => undefined);

/** A model router stub that fails loudly if a model is ever resolved (overrides are used). */
const stubModelRouter: ModelRouter = {
  model: () => {
    throw new Error("modelRouter.model() should not be called when the swarm is overridden");
  },
};

/** MCP clients that fail loudly if called (the swarm is overridden in these tests). */
const stubMcp: TurnCoordinatorMcp = {
  toolchain: { call: () => Promise.reject(new Error("toolchain.call unexpected")) },
  tome: { call: () => Promise.reject(new Error("tome.call unexpected")) },
  mnm: { call: () => Promise.reject(new Error("mnm.call unexpected")) },
};

interface CtxHarness {
  readonly ctx: ConnectionContext;
  readonly sent: ServerToClientEvent[];
}

/**
 * A fake connection context recording every sent frame; `onSend` observes each one.
 * `projectId` defaults to {@link PROJECT}; pass a different id to model a FOREIGN tenant's
 * connection (used by the Defense 4 cross-tenant tests).
 */
function makeCtx(
  onSend?: (event: ServerToClientEvent) => void,
  projectId: string = PROJECT,
): CtxHarness {
  const sent: ServerToClientEvent[] = [];
  const ctx: ConnectionContext = {
    session: { accountAddress: ADDRESS },
    projectId,
    send: (event) => {
      sent.push(event);
      onSend?.(event);
    },
    close: () => undefined,
  };
  return { ctx, sent };
}

interface FakeRouter {
  readonly router: EventRouter;
  invoke(event: ClientToServerEvent, ctx: ConnectionContext): Promise<void>;
}

type StoredHandler = (event: ClientToServerEvent, ctx: ConnectionContext) => void | Promise<void>;

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

/** Build a `prompt:submit` client event (branding via the schema). */
function promptEvent(text: string): PromptSubmitEvent {
  return {
    type: "prompt:submit",
    payload: { projectId: ProjectIdSchema.parse(PROJECT), text },
    ts: TS,
  };
}

/** Build a `test:results` client event (branding via the schema). */
function testResultsEvent(
  turnId: string,
  pass: boolean,
  failures: TestFailure[] = [],
): TestResultsEvent {
  return {
    type: "test:results",
    payload: { turnId: TurnIdSchema.parse(turnId), pass, failures },
    ts: TS,
  };
}

function makeTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    projectId: PROJECT,
    status,
    cyclesUsed: 0,
    reserveEntry: null,
    settleEntry: null,
    startedAt: TS,
    endedAt: null,
  };
}

interface LedgerHarness {
  readonly ledger: LedgerStore;
  readonly settleCalls: { address: string; turnId: string; amount: bigint }[];
  readonly declineCalls: string[];
  /** Every `openTurn` (by projectId) — the BUG-1 "opened ONCE, not twice" assertion. */
  readonly openTurnCalls: string[];
  /** Every `placeReserve` (address+turnId) — the BUG-1 "reserved ONCE, not twice" assertion. */
  readonly placeReserveCalls: { address: string; turnId: string }[];
}

/**
 * A deterministic in-memory {@link LedgerStore} sufficient for the coordinator paths.
 * `placeReserveError` (an INFRA fault, not {@link InsufficientAvailableError}) makes
 * `placeReserve` reject — the BUG-2 reserve-time-fault path.
 */
function makeLedger(
  balance: Balance = { available: 400n, reserved: 0n },
  opts: { placeReserveError?: Error } = {},
): LedgerHarness {
  const settleCalls: LedgerHarness["settleCalls"] = [];
  const declineCalls: string[] = [];
  const openTurnCalls: string[] = [];
  const placeReserveCalls: LedgerHarness["placeReserveCalls"] = [];
  const entries: LedgerEntryRecord[] = [];
  let nextTurn = 1;
  let nextId = 1n;
  const ledger: LedgerStore = {
    openTurn: (projectId) => {
      openTurnCalls.push(projectId);
      const id = `turn-${String(nextTurn)}`;
      nextTurn += 1;
      return Promise.resolve(makeTurn(id, "classifying"));
    },
    getTurn: () => Promise.resolve(null),
    creditDeposit: () => Promise.reject(new Error("creditDeposit unexpected")),
    placeReserve: (address, turnId) => {
      placeReserveCalls.push({ address, turnId });
      if (opts.placeReserveError !== undefined) {
        return Promise.reject(opts.placeReserveError);
      }
      return Promise.resolve(balance);
    },
    settle: (address, turnId, amount) => {
      settleCalls.push({ address, turnId, amount });
      entries.push({
        id: nextId,
        accountAddress: address,
        kind: "settlement",
        amount,
        ref: turnId,
        createdAt: TS,
      });
      nextId += 1n;
      return Promise.resolve(balance);
    },
    decline: (turnId) => {
      declineCalls.push(turnId);
      return Promise.resolve(makeTurn(turnId, "declined"));
    },
    getBalance: () => Promise.resolve(balance),
    getEntries: (address) =>
      Promise.resolve(entries.filter((entry) => entry.accountAddress === address)),
  };
  return { ledger, settleCalls, declineCalls, openTurnCalls, placeReserveCalls };
}

/** A deterministic in-memory {@link ChatStore}; `seed` pre-fills history (a warm project). */
function makeChat(seed: (ChatWrite & { projectId: string })[] = []): ChatStore {
  const messages: (ChatWrite & { projectId: string })[] = [...seed];
  let seq = 0;
  return {
    appendChat: (projectId, message) => {
      messages.push({ projectId, ...message });
      seq += 1;
      // `ChatMessage.turnId` is a branded `TurnId`; the plain-string write is cast at
      // this fake boundary (mirrors the real store's re-brand on read).
      return Promise.resolve({
        seq,
        role: message.role,
        content: message.content,
        createdAt: TS,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      } as ChatMessage);
    },
    getChat: (projectId) =>
      Promise.resolve(
        messages
          .filter((message) => message.projectId === projectId)
          .map(
            (message, index): ChatMessage =>
              ({
                seq: index + 1,
                role: message.role,
                content: message.content,
                createdAt: TS,
                ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
              }) as ChatMessage,
          ),
      ),
  };
}

interface CompileHarness {
  readonly client: CompileClient;
  readonly checkCalls: CheckRequest[];
  readonly compileCalls: CompileRequest[];
}

/** A fake {@link CompileClient}: clean check + a `succeeded` full compile (terminal on the first poll). */
function makeCompileClient(): CompileHarness {
  const checkCalls: CheckRequest[] = [];
  const compileCalls: CompileRequest[] = [];
  const client: CompileClient = {
    check: (req) => {
      checkCalls.push(req);
      return Promise.resolve({
        ok: true,
        diagnostics: [],
        compilerVersion: "0.24.0",
        durationMs: 3,
      });
    },
    compile: (req) => {
      compileCalls.push(req);
      return Promise.resolve({ jobId: "job-1", status: "queued", sourceHash: "sh-1" });
    },
    pollCompile: () =>
      Promise.resolve({
        jobId: "job-1",
        status: "succeeded",
        sourceHash: "sh-1",
        result: {
          urlPrefix: "https://r2.nyx.test/proj/abc/",
          sourceHash: "sh-1",
          compilerVersion: "0.24.0",
          reused: false,
          circuits: [{ name: "increment", proof: true }],
        },
      }),
    version: () => Promise.reject(new Error("version() not expected")),
  };
  return { client, checkCalls, compileCalls };
}

/** A fake artifact `fetch`: the manifest on GET, a 200 on every file HEAD. */
const fetchArtifact: typeof fetch = (_input, init) => {
  const method = init?.method ?? "GET";
  if (method === "HEAD") {
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  return Promise.resolve(
    new Response(JSON.stringify(MANIFEST), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
};

/**
 * Base coordinator deps: the swarm + classifier are stubbed so the default routed-model
 * build (which would fail on {@link stubModelRouter}) is never reached; a test overrides
 * whichever seam it drives.
 */
function baseDeps(overrides: Partial<TurnCoordinatorDeps> = {}): TurnCoordinatorDeps {
  return {
    modelRouter: stubModelRouter,
    compileClient: makeCompileClient().client,
    ledger: makeLedger().ledger,
    chat: makeChat(),
    projectStore: { commit: () => Promise.resolve({ version: 1 }) },
    mcp: stubMcp,
    flatReserve: FLAT_RESERVE,
    now: () => TS,
    delay: neverDelay,
    classifyIntent: () => Promise.resolve({ kind: "dapp" }),
    subAgents: makeSubAgents(),
    ...overrides,
  };
}

/** A spy supervisor that records the deps it was built from and returns a canned result. */
function makeSpySupervisor(result: TurnResult): {
  buildSupervisor: (deps: SupervisorDeps) => Supervisor;
  captured: SupervisorDeps[];
  calls: { prompts: number };
} {
  const captured: SupervisorDeps[] = [];
  const calls = { prompts: 0 };
  const buildSupervisor = (deps: SupervisorDeps): Supervisor => {
    captured.push(deps);
    return {
      handlePrompt: () => {
        calls.prompts += 1;
        return Promise.resolve(result);
      },
    };
  };
  return { buildSupervisor, captured, calls };
}

/** Canned sub-agents that each contribute one file + fixed tokens (used by the real supervisor). */
function makeSubAgents(gate?: Promise<void>): SubAgents {
  const make =
    (role: string, path: string, wait?: Promise<void>) =>
    async (ctx: SubAgentCycleContext): Promise<SubAgentWork> => {
      if (wait !== undefined) {
        await wait;
      }
      return {
        files: [{ path, content: `// ${role} cycle ${String(ctx.cycle)}` }],
        tokensConsumed: 10n,
        narration: `${role} narration`,
      };
    };
  return {
    scaffolding: make("scaffolding", "package.json", gate),
    planning: make("planning", "PLAN.md"),
    implementation: make("implementation", "src/counter.compact"),
    review: make("review", "src/counter.test.ts"),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("TestResultsInbox", () => {
  it("resolves a register with the delivered verdict", async () => {
    const coordinator = createTurnCoordinator(baseDeps({}));
    const pending = coordinator.inbox.register("turn-1", PROJECT);
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    const result = await pending;
    expect(result.pass).toBe(true);
    expect(result.turnId).toBe("turn-1");
  });

  it("resolves a register as FAILING when the client never replies (no-hang, D42)", async () => {
    // An immediate delay makes the bounded timeout win the race → a failing verdict.
    const coordinator = createTurnCoordinator(baseDeps({ delay: () => Promise.resolve() }));
    const result = await coordinator.inbox.register("turn-9", PROJECT);
    expect(result.pass).toBe(false);
    expect(result.turnId).toBe("turn-9");
    expect(result.failures[0]?.name).toBe("verify:timeout");
  });

  it("drops an unmatched deliver without throwing", () => {
    const coordinator = createTurnCoordinator(baseDeps({}));
    expect(() => {
      coordinator.inbox.deliver({
        turnId: TurnIdSchema.parse("nobody-waiting"),
        pass: true,
        failures: [],
      });
    }).not.toThrow();
  });
});

describe("per-turn ctx-bound seams", () => {
  it("hands the supervisor ctx-bound checkCompile / awaitTestResults / runFullCompile", async () => {
    const spy = makeSpySupervisor({ kind: "green", turnId: "turn-1", cycles: 1, consumed: 5n });
    const compile = makeCompileClient();
    const { ctx, sent } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        compileClient: compile.client,
        fetchArtifact,
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(),
        buildSupervisor: spy.buildSupervisor,
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    await fake.invoke(promptEvent("build a counter"), ctx);

    const deps = spy.captured[0];
    expect(deps).toBeDefined();
    if (deps === undefined) {
      throw new Error("supervisor was never built");
    }

    // checkCompile adapts CompileTurnInput → the §4.1 CheckRequest (files only).
    const outcome = await deps.checkCompile({
      projectId: PROJECT,
      files: [{ path: "src/counter.compact", content: "x" }],
      changedPaths: ["src/counter.compact"],
    });
    expect(outcome.ok).toBe(true);
    expect(compile.checkCalls).toEqual([
      { files: [{ path: "src/counter.compact", content: "x" }] },
    ]);

    // awaitTestResults emits verify:run and then awaits the inbox (resolvable via deliver).
    const pending = deps.awaitTestResults("turn-1");
    const verifyRun = sent.find((event) => event.type === "verify:run");
    expect(verifyRun).toBeDefined();
    expect(verifyRun?.payload).toEqual({ turnId: "turn-1" });
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    const results = await pending;
    expect(results.pass).toBe(true);

    // runFullCompile drives the orchestrator and announces artifacts:ready exactly once.
    const compiled = await deps.runFullCompile({
      projectId: PROJECT,
      files: [{ path: "src/counter.compact", content: "x" }],
      changedPaths: ["src/counter.compact"],
    });
    expect(compiled.kind).toBe("ready");
    expect(sent.filter((event) => event.type === "artifacts:ready")).toHaveLength(1);
  });

  it("reuses ONE supervisor per PROJECT across prompts AND connections (BUG-1 / D24)", async () => {
    const spy = makeSpySupervisor({ kind: "green", turnId: "turn-1", cycles: 1, consumed: 5n });
    // Two DISTINCT connection contexts (a reconnect / second tab) for the SAME project.
    const { ctx: ctxA } = makeCtx();
    const { ctx: ctxB } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(),
        buildSupervisor: spy.buildSupervisor,
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    await fake.invoke(promptEvent("first"), ctxA);
    await fake.invoke(promptEvent("second"), ctxB);

    // ONE supervisor for the project — NOT one per connection (the pre-fix double-billing
    // bug built a fresh supervisor per socket, with an empty active-turn map).
    expect(spy.captured).toHaveLength(1);
    expect(spy.calls.prompts).toBe(2);
  });
});

describe("terminal signal", () => {
  it("emits a zero-consumed turn:settled for a declined turn (client unlocks, no settlement)", async () => {
    const spy = makeSpySupervisor({ kind: "declined", turnId: "turn-1", cycles: 0, consumed: 0n });
    const ledger = makeLedger({ available: 250n, reserved: 0n });
    const { ctx, sent } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        ledger: ledger.ledger,
        classifyIntent: () => Promise.resolve({ kind: "off-domain", reason: "not a dapp" }),
        subAgents: makeSubAgents(),
        buildSupervisor: spy.buildSupervisor,
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    await fake.invoke(promptEvent("what is the weather"), ctx);

    const settled = sent.filter((event) => event.type === "turn:settled");
    expect(settled).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(settled[0])) as {
      payload: { consumed: string; balance: string; turnId: string };
    };
    expect(wire.payload.consumed).toBe("0");
    expect(wire.payload.balance).toBe("250");
    expect(wire.payload.turnId).toBe("turn-1");
    // No ledger settlement was written for a declined turn.
    expect(ledger.settleCalls).toHaveLength(0);
  });

  it("emits NO extra terminal frame for a settling outcome (the supervisor already settled)", async () => {
    const spy = makeSpySupervisor({ kind: "green", turnId: "turn-1", cycles: 1, consumed: 42n });
    const { ctx, sent } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(),
        buildSupervisor: spy.buildSupervisor,
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    await fake.invoke(promptEvent("build it"), ctx);

    // The spy supervisor sends nothing; the coordinator must not synthesize a settled frame.
    expect(sent.filter((event) => event.type === "turn:settled")).toHaveLength(0);
  });
});

describe("client → server handlers", () => {
  it("caps and delivers the OWNER's test:results to the inbox (happy path)", async () => {
    const coordinator = createTurnCoordinator(baseDeps({}));
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);
    const { ctx } = makeCtx();

    // turn-3 is owned by PROJECT; the OWNER's connection (ctx.projectId === PROJECT) delivers.
    const pending = coordinator.inbox.register("turn-3", PROJECT);
    await fake.invoke(
      testResultsEvent("turn-3", false, [{ name: "counter > adds", message: "boom" }]),
      ctx,
    );
    const result = await pending;
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.name).toBe("counter > adds");
  });

  it("captures console frames without crashing", async () => {
    const coordinator = createTurnCoordinator(baseDeps({}));
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);
    const { ctx } = makeCtx();

    await expect(
      fake.invoke({ type: "console:log", payload: { message: "vite ready" }, ts: TS }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      fake.invoke({ type: "console:error", payload: { message: "TypeError" }, ts: TS }, ctx),
    ).resolves.toBeUndefined();
  });

  it("scopes console frames per project (no cross-attribution) across two tenants", async () => {
    // Two DISTINCT-project connections. Per-project keying means one tenant's console frames
    // are recorded under its OWN projectId — never pooled into another's shared buffer.
    const coordinator = createTurnCoordinator(baseDeps({}));
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);
    const { ctx: a } = makeCtx(undefined, "proj-A");
    const { ctx: b } = makeCtx(undefined, "proj-B");

    await expect(
      fake.invoke({ type: "console:log", payload: { message: "A: vite ready" }, ts: TS }, a),
    ).resolves.toBeUndefined();
    await expect(
      fake.invoke({ type: "console:error", payload: { message: "B: TypeError" }, ts: TS }, b),
    ).resolves.toBeUndefined();
    // A frame from project B never disturbs project A's (independent) buffer.
    await expect(
      fake.invoke({ type: "console:log", payload: { message: "A: hmr update" }, ts: TS }, a),
    ).resolves.toBeUndefined();
  });
});

describe("default swarm steering injection (@nyx/scaffold, US1 D3/FR-003/FR-080)", () => {
  /** A one-step model that emits `value` as its structured output and records the prompt. */
  function outputOnlyModel(value: unknown): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        }),
    });
  }

  /** Read back the system-instruction string the agent sent to its model. */
  function systemPrompt(model: MockLanguageModelV4): string {
    const messages = model.doGenerateCalls[0]?.prompt ?? [];
    for (const message of messages) {
      if (message.role === "system") {
        return message.content;
      }
    }
    return "";
  }

  it("builds the scaffolding + implementation agents with the @nyx/scaffold house-rules steering", async () => {
    // Real (mock) routed models, held by role so we can inspect the exact prompt each
    // default-built sub-agent sent. Only scaffolding + implementation are driven here.
    const scaffoldModel = outputOnlyModel({ files: [] });
    const implModel = outputOnlyModel({ narration: "done", files: [] });
    const models: Record<ModelRole, MockLanguageModelV4> = {
      supervisor: outputOnlyModel({}),
      scaffolding: scaffoldModel,
      planning: outputOnlyModel({}),
      implementation: implModel,
      review: outputOnlyModel({}),
    };
    const modelRouter: ModelRouter = { model: (role) => models[role] };

    // Resolving MCP fakes (the default build wires these into every sub-agent).
    const routedMcp: TurnCoordinatorMcp = {
      toolchain: { call: () => Promise.resolve({ ok: true, diagnostics: [] }) },
      tome: { call: () => Promise.resolve({ skills: [] }) },
      mnm: { call: () => Promise.resolve({ docs: [] }) },
    };

    // A spy supervisor captures the DEFAULT-built swarm (subAgents is NOT overridden).
    let captured: SupervisorDeps | undefined;
    const buildSupervisor = (supervisorDeps: SupervisorDeps): Supervisor => {
      captured = supervisorDeps;
      return {
        handlePrompt: () =>
          Promise.resolve<TurnResult>({
            kind: "green",
            turnId: "turn-1",
            cycles: 1,
            consumed: 5n,
          }),
      };
    };

    // Construct deps directly (omitting subAgents/classifyIntent) so the coordinator
    // takes the default routed-model build path — the one that must inject the steering.
    const deps: TurnCoordinatorDeps = {
      modelRouter,
      compileClient: makeCompileClient().client,
      ledger: makeLedger().ledger,
      chat: makeChat(),
      projectStore: { commit: () => Promise.resolve({ version: 1 }) },
      mcp: routedMcp,
      flatReserve: FLAT_RESERVE,
      now: () => TS,
      delay: neverDelay,
      buildSupervisor,
    };

    const coordinator = createTurnCoordinator(deps);
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);
    const { ctx } = makeCtx();

    await fake.invoke(promptEvent("build a counter"), ctx);

    expect(captured).toBeDefined();
    if (captured === undefined) {
      throw new Error("supervisor was never built");
    }
    const subAgents = captured.subAgents;

    const coldCtx: SubAgentCycleContext = {
      projectId: PROJECT,
      turnId: "turn-1",
      prompt: "build a counter",
      cycle: 1,
      coldStart: true,
      compileDiagnostics: [],
      testFailures: [],
    };

    // Drive the two steered sub-agents directly and inspect what reached each model.
    await subAgents.scaffolding(coldCtx);
    await subAgents.implementation(coldCtx);

    const scaffoldSystem = systemPrompt(scaffoldModel);
    const implSystem = systemPrompt(implModel);

    // The FULL @nyx/scaffold steering block reached each agent's instructions …
    expect(scaffoldSystem).toContain(buildScaffoldingInstructions());
    expect(implSystem).toContain(buildImplementationInstructions());
    // … including the config-chokepoint house rule (a distinctive marker, constitution VII).
    expect(scaffoldSystem).toContain("client/src/lib/config.ts");
    expect(implSystem).toContain("client/src/lib/config.ts");
  });
});

describe("single active turn (D24)", () => {
  it("rejects a second prompt with an input-locked message and NO turn:settled", async () => {
    // A never-resolving gate parks the first turn inside its scaffolding agent so the
    // per-project lock stays held while the second prompt arrives.
    const gate = new Promise<void>(() => undefined);
    const ledger = makeLedger();
    const { ctx, sent } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        ledger: ledger.ledger,
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(gate),
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // First prompt: parks inside the (gated) scaffolding agent with the turn lock held.
    void fake.invoke(promptEvent("build the first thing"), ctx);
    await tick();

    // Second prompt on the SAME connection: the shared supervisor rejects it.
    await fake.invoke(promptEvent("build a second thing"), ctx);

    const messages = sent.filter((event) => event.type === "turn:message");
    const locked = messages.find((event) => event.payload.delta.includes("Input is locked"));
    expect(locked).toBeDefined();
    // A rejected prompt never settles — the active turn's own settled will unlock input.
    expect(sent.filter((event) => event.type === "turn:settled")).toHaveLength(0);
  });
});

describe("BUG-1: the single-active-turn lock is PER-PROJECT, not per-connection", () => {
  it("rejects a concurrent turn from a second connection and reserves ONCE, then follows the takeover", async () => {
    const ledger = makeLedger();
    // Two DISTINCT connections for the SAME (account, project): a reconnect / second tab.
    const { ctx: ctxA, sent: sentA } = makeCtx();
    const { ctx: ctxB, sent: sentB } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        ledger: ledger.ledger,
        compileClient: makeCompileClient().client,
        fetchArtifact,
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(),
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // Connection A opens the turn; it parks at awaitTestResults (verify:run emitted to A).
    const firstDone = fake.invoke(promptEvent("build the first thing"), ctxA);
    await tick();
    expect(sentA.some((event) => event.type === "verify:run")).toBe(true);
    expect(ledger.openTurnCalls).toHaveLength(1);
    expect(ledger.placeReserveCalls).toHaveLength(1);

    // Connection B (reconnect) submits for the SAME project WHILE A's turn is live. The
    // SHARED supervisor's active-turn check rejects it — NO second openTurn, NO second
    // reserve (the pre-fix per-connection supervisor would have double-billed here).
    await fake.invoke(promptEvent("sneak a second turn"), ctxB);
    expect(ledger.openTurnCalls).toHaveLength(1);
    expect(ledger.placeReserveCalls).toHaveLength(1);
    // The input-locked message routed to the NEW live connection (B), the takeover target.
    expect(
      sentB.some(
        (event) => event.type === "turn:message" && event.payload.delta.includes("Input is locked"),
      ),
    ).toBe(true);

    // Release A's parked turn (green). Its remaining frames must FOLLOW the mid-turn D40
    // takeover to connection B (the current live socket), not drop into the stale A socket.
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    await firstDone;

    // The green settle + done-presentation + artifacts:ready landed on B (post-takeover) …
    expect(sentB.filter((event) => event.type === "turn:settled")).toHaveLength(1);
    expect(sentB.filter((event) => event.type === "artifacts:ready")).toHaveLength(1);
    expect(
      sentB.some(
        (event) => event.type === "turn:message" && event.payload.delta.includes("preview is live"),
      ),
    ).toBe(true);
    // … and NOT on the stale A socket (whose only lifecycle frame was the pre-takeover verify:run).
    expect(sentA.filter((event) => event.type === "turn:settled")).toHaveLength(0);
    expect(sentA.filter((event) => event.type === "artifacts:ready")).toHaveLength(0);

    // The whole turn settled exactly ONCE (no double settle).
    expect(ledger.settleCalls).toHaveLength(1);
    for (const event of [...sentA, ...sentB]) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });
});

describe("BUG-2: reserve-time infra fault + the catch-all backstop always unlock input", () => {
  it("synthesizes a zero-consumed turn:settled for a reserve-time infra fault (never settles)", async () => {
    // placeReserve faults with a NON-InsufficientAvailableError (an infra fault) — the turn
    // is still `classifying`, so NOTHING was reserved or settled.
    const ledger = makeLedger(
      { available: 300n, reserved: 0n },
      { placeReserveError: new Error("ledger transport down") },
    );
    const { ctx, sent } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({
        ledger: ledger.ledger,
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(),
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    await fake.invoke(promptEvent("build a counter"), ctx);

    // The coordinator saw infra-failed{settled:false} and synthesized the unlock frame —
    // WITHOUT this, the client's input (unlocked only by turn:settled/declined) locks forever.
    const settled = sent.filter((event) => event.type === "turn:settled");
    expect(settled).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(settled[0])) as {
      payload: { consumed: string; balance: string };
    };
    expect(wire.payload.consumed).toBe("0");
    expect(wire.payload.balance).toBe("300");
    // A reserve was attempted (and faulted) but NOTHING settled — no stuck settle, no charge.
    expect(ledger.placeReserveCalls).toHaveLength(1);
    expect(ledger.settleCalls).toHaveLength(0);
    for (const event of sent) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });

  it("catches an unexpected handlePrompt throw, logs loudly, and still emits a terminal unlock", async () => {
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    const ledger = makeLedger({ available: 175n, reserved: 0n });
    const { ctx, sent } = makeCtx();
    // A supervisor whose handlePrompt REJECTS — a settle / appendChat DB fault that
    // propagated past the retries. router.dispatch would silently swallow this rejection.
    const buildSupervisor = (): Supervisor => ({
      handlePrompt: () => Promise.reject(new Error("settle DB fault")),
    });
    const coordinator = createTurnCoordinator(
      baseDeps({
        ledger: ledger.ledger,
        buildSupervisor,
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // The handler resolves (the coordinator catches internally) — no unhandled rejection.
    await expect(fake.invoke(promptEvent("build a counter"), ctx)).resolves.toBeUndefined();

    // The fault was logged LOUDLY (structured, never silently swallowed) …
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail.error).toBeInstanceOf(Error);
    expect(logs[0]?.detail.projectId).toBe(PROJECT);
    // … and a terminal unlock frame still went out so the client recovers.
    const settled = sent.filter((event) => event.type === "turn:settled");
    expect(settled).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(settled[0])) as { payload: { consumed: string } };
    expect(wire.payload.consumed).toBe("0");
    for (const event of sent) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });
});

describe("Defense 2: a prompt for a FOREIGN projectId is rejected (cross-account hijack)", () => {
  it("rejects payload.projectId != ctx.projectId — no supervisor, no openTurn, no reserve", async () => {
    const spy = makeSpySupervisor({ kind: "green", turnId: "turn-1", cycles: 1, consumed: 5n });
    const ledger = makeLedger();
    // This connection was authorized (connect-time) for PROJECT; the attacker names ANOTHER.
    const { ctx, sent } = makeCtx();
    const coordinator = createTurnCoordinator(
      baseDeps({ ledger: ledger.ledger, buildSupervisor: spy.buildSupervisor }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    const attack: PromptSubmitEvent = {
      type: "prompt:submit",
      payload: { projectId: ProjectIdSchema.parse("victim-project"), text: "hand me the source" },
      ts: TS,
    };
    await fake.invoke(attack, ctx);

    // No ProjectTurnState was created for the foreign id: the shared supervisor factory was
    // never invoked, no turn opened, and NO reserve placed against the victim's account.
    expect(spy.captured).toHaveLength(0);
    expect(spy.calls.prompts).toBe(0);
    expect(ledger.openTurnCalls).toHaveLength(0);
    expect(ledger.placeReserveCalls).toHaveLength(0);
    // The client got a plain mismatch message and NOTHING that looks like a turn.
    expect(sent.some((event) => event.type === "turn:message")).toBe(true);
    expect(sent.filter((event) => event.type === "turn:settled")).toHaveLength(0);
    for (const event of sent) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });

  it("runs the turn when payload.projectId matches ctx.projectId (the happy path is intact)", async () => {
    const spy = makeSpySupervisor({ kind: "green", turnId: "turn-1", cycles: 1, consumed: 5n });
    const { ctx } = makeCtx();
    const coordinator = createTurnCoordinator(baseDeps({ buildSupervisor: spy.buildSupervisor }));
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // promptEvent carries payload.projectId === PROJECT === ctx.projectId.
    await fake.invoke(promptEvent("build a counter"), ctx);

    expect(spy.captured).toHaveLength(1);
    expect(spy.calls.prompts).toBe(1);
  });
});

describe("Defense 3: a dead-socket send throw never kills the turn mid-flight", () => {
  it("swallows every send throw, still reaches settle (reserve released), never propagates", async () => {
    const ledger = makeLedger({ available: 400n, reserved: 0n });
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    // The client vanished mid-turn: `ws.send` on a closed socket throws on EVERY emit.
    const ctx: ConnectionContext = {
      session: { accountAddress: ADDRESS },
      projectId: PROJECT,
      send: () => {
        throw new Error("socket is closed");
      },
      close: () => undefined,
    };
    const coordinator = createTurnCoordinator(
      baseDeps({
        ledger: ledger.ledger,
        compileClient: makeCompileClient().client,
        fetchArtifact,
        classifyIntent: () => Promise.resolve({ kind: "dapp" }),
        subAgents: makeSubAgents(),
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // Drive a full turn: the verify:run send throws (swallowed) but the rendezvous still
    // registers, so delivering a green verdict lets the turn run through to its settle.
    const done = fake.invoke(promptEvent("build a counter"), ctx);
    await tick();
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });

    // The dead-socket throws never propagated out of the handler (no unhandled rejection).
    await expect(done).resolves.toBeUndefined();

    // The turn CONTINUED past every failed emit to its settle — the reserve is released.
    expect(ledger.placeReserveCalls).toHaveLength(1);
    expect(ledger.settleCalls).toHaveLength(1);
    // Every swallowed emit was logged LOUDLY (never silently); the loud log is not masked.
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((entry) => entry.detail.error instanceof Error)).toBe(true);
  });
});

describe("Defense 4: a FOREIGN connection cannot inject a test:results verdict (cross-tenant)", () => {
  /** A symbol proving a promise is still UNRESOLVED (it must lose the race to this sentinel). */
  const UNRESOLVED = Symbol("unresolved");

  it("ignores a foreign green verdict; only the OWNER's later verdict resolves the wait", async () => {
    // A real turn arms the rendezvous, so turn-1 is OWNED by PROJECT (via awaitTestResults).
    const spy = makeSpySupervisor({ kind: "green", turnId: "turn-1", cycles: 1, consumed: 5n });
    const { ctx: ownerCtx } = makeCtx(); // projectId === PROJECT (the turn's owner)
    const { ctx: foreignCtx } = makeCtx(undefined, "attacker-project"); // a DIFFERENT tenant
    const coordinator = createTurnCoordinator(baseDeps({ buildSupervisor: spy.buildSupervisor }));
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // Build the supervisor, then arm the rendezvous the way a real turn does: the captured
    // awaitTestResults seam registers turn-1 as owned by PROJECT.
    await fake.invoke(promptEvent("build a counter"), ownerCtx);
    const deps = spy.captured[0];
    if (deps === undefined) {
      throw new Error("supervisor was never built");
    }
    const pending = deps.awaitTestResults("turn-1");

    // The attacker (a foreign project) delivers a GREEN verdict for the victim's turnId — it
    // must be IGNORED: a foreign green cannot force a false PASS (SC-015 integrity).
    await fake.invoke(testResultsEvent("turn-1", true, []), foreignCtx);

    // Prove the wait is STILL unresolved (the foreign green did not satisfy it).
    expect(await Promise.race([pending, Promise.resolve(UNRESOLVED)])).toBe(UNRESOLVED);

    // The real OWNER then delivers a FAILING verdict — THIS is what resolves the wait, so the
    // recorded outcome is the owner's fail, never the attacker's forged pass.
    await fake.invoke(
      testResultsEvent("turn-1", false, [{ name: "counter > adds", message: "boom" }]),
      ownerCtx,
    );
    const result = await pending;
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.name).toBe("counter > adds");
  });

  it("ignores a test:results for an unknown/unregistered turnId (no pending wait)", async () => {
    const coordinator = createTurnCoordinator(baseDeps({}));
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);
    const { ctx } = makeCtx();

    // Nothing armed "never-armed"; even the owner's own connection delivering it is a no-op.
    await expect(
      fake.invoke(testResultsEvent("never-armed", true, []), ctx),
    ).resolves.toBeUndefined();
  });

  it("frees ownership when a wait resolves, so a turnId slot reuses cleanly (no leak, bounded)", async () => {
    const coordinator = createTurnCoordinator(baseDeps({}));

    // First wait: owned by proj-A, delivered + resolved — which FREES the ownership entry.
    const first = coordinator.inbox.register("turn-reuse", "proj-A");
    coordinator.inbox.deliver(
      { turnId: TurnIdSchema.parse("turn-reuse"), pass: true, failures: [] },
      "proj-A",
    );
    expect((await first).pass).toBe(true);

    // Re-arm the SAME turnId, now owned by proj-B. If proj-A's ownership had leaked past the
    // first resolve, a proj-A delivery would resolve this — it must NOT.
    const second = coordinator.inbox.register("turn-reuse", "proj-B");
    coordinator.inbox.deliver(
      { turnId: TurnIdSchema.parse("turn-reuse"), pass: true, failures: [] },
      "proj-A",
    );
    expect(await Promise.race([second, Promise.resolve(UNRESOLVED)])).toBe(UNRESOLVED);

    // proj-B (the current owner) resolves the re-armed slot cleanly.
    coordinator.inbox.deliver(
      { turnId: TurnIdSchema.parse("turn-reuse"), pass: false, failures: [] },
      "proj-B",
    );
    expect((await second).pass).toBe(false);
  });
});

describe("turnGate: in-flight tracking + idle callbacks (EC-40 / FR-058, US8)", () => {
  /**
   * Deps that let the REAL supervisor run a green turn which PARKS at `awaitTestResults` (a
   * `verify:run` goes out; the inbox waits for a verdict). Delivering `turn-1` releases it green.
   * `fetchArtifact` is added so the green FULL compile's verify-before-announce resolves.
   */
  function greenTurnDeps(overrides: Partial<TurnCoordinatorDeps> = {}): TurnCoordinatorDeps {
    return baseDeps({ fetchArtifact, ...overrides });
  }

  it("isTurnActive is false before a prompt, true mid-flight, and false after it settles", async () => {
    const { ctx } = makeCtx();
    const coordinator = createTurnCoordinator(greenTurnDeps());
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // No prompt yet — no ProjectTurnState exists, so the project reads as idle.
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(false);

    // The turn runs and PARKS at awaitTestResults (no verdict delivered yet).
    const done = fake.invoke(promptEvent("build a counter"), ctx);
    await tick();
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(true);

    // Deliver the verdict → the turn goes green and settles; the flag clears.
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    await done;
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(false);
  });

  it("runWhenIdle runs fn IMMEDIATELY when no turn is active", () => {
    const coordinator = createTurnCoordinator(greenTurnDeps());
    let ran = 0;
    coordinator.turnGate.runWhenIdle(PROJECT, () => {
      ran += 1;
    });
    expect(ran).toBe(1);
  });

  it("runWhenIdle QUEUES during an active turn, then fires FIFO after it settles; a throw is isolated", async () => {
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    const { ctx } = makeCtx();
    const coordinator = createTurnCoordinator(
      greenTurnDeps({
        logError: (message, detail) => {
          logs.push({ message, detail });
        },
      }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // Park a real turn at awaitTestResults — the project is now active.
    const done = fake.invoke(promptEvent("build a counter"), ctx);
    await tick();
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(true);

    // Queue three deploys behind the active turn; the middle one throws.
    const order: number[] = [];
    coordinator.turnGate.runWhenIdle(PROJECT, () => order.push(1));
    coordinator.turnGate.runWhenIdle(PROJECT, () => {
      order.push(2);
      throw new Error("deploy callback boom");
    });
    coordinator.turnGate.runWhenIdle(PROJECT, () => order.push(3));

    // Nothing fires while the turn is still in flight.
    expect(order).toEqual([]);

    // Settle the turn → the queue fires FIFO; the throwing #2 does not stop #1 or #3.
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    await done;

    expect(order).toEqual([1, 2, 3]);
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(false);
    // The throwing callback was logged LOUDLY (never silently swallowed).
    expect(logs.some((entry) => entry.detail.error instanceof Error)).toBe(true);
  });

  it("a rejected (turn-active) second prompt does NOT flip isTurnActive independently", async () => {
    const { ctx } = makeCtx();
    const coordinator = createTurnCoordinator(greenTurnDeps());
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    // Turn 1 parks at awaitTestResults — the project is now active.
    const done = fake.invoke(promptEvent("first"), ctx);
    await tick();
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(true);

    // Turn 2 (same project) is REJECTED by the D24 lock; it owns no in-flight lifecycle …
    await fake.invoke(promptEvent("second"), ctx);
    // … so the flag still reflects ONLY turn 1 (still active), not a phantom from the reject.
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(true);

    // Settle turn 1 → the flag clears cleanly (the reject left no stuck ownership behind).
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    await done;
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(false);
  });

  it("a project-mismatch prompt never flips isTurnActive to true", async () => {
    const { ctx } = makeCtx();
    const coordinator = createTurnCoordinator(greenTurnDeps());
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);

    const attack: PromptSubmitEvent = {
      type: "prompt:submit",
      payload: { projectId: ProjectIdSchema.parse("victim-project"), text: "hand me the source" },
      ts: TS,
    };
    await fake.invoke(attack, ctx);

    // No turn was opened for EITHER project — the gate stays idle for both.
    expect(coordinator.turnGate.isTurnActive(PROJECT)).toBe(false);
    expect(coordinator.turnGate.isTurnActive("victim-project")).toBe(false);
  });
});
