/**
 * End-to-end turn-trace audit (T135/T146) — a full cold "counter DApp" turn driven
 * through the REAL supervisor via the coordinator's WS handlers, with EVERYTHING else
 * mocked (no models, no Compile Service, no WebContainer; constitution III/IV).
 *
 * The harness records an ordered TRACE of every outbound frame, every compile CHECK,
 * and every `test:results` delivered, then asserts the turn-lifecycle invariants a
 * human reviewer would check by reading the transcript:
 *  - SC-002 — the contract was CHECK-compiled within the turn BEFORE any done frame
 *    (compile-before-surface: a "done" is never presented on un-compiled code).
 *  - SC-015 — the done-presentation is paired with a GREEN `test:results` in the same
 *    turn (a turn that never goes green never presents "done").
 *  - the full compile + `artifacts:ready` fire exactly once, only after green (D35).
 *  - `verify:run` is emitted BEFORE the client's `test:results` is awaited (US4).
 *  - a declined turn emits a terminal `turn:settled { consumed:"0" }` (client unlocks)
 *    with NO ledger settlement (D25).
 *  - every emitted frame is JSON-safe — money crosses as decimal STRINGS, never a
 *    `bigint` that would throw in `JSON.stringify`.
 */
import { describe, expect, it } from "vitest";
import {
  ProjectIdSchema,
  TurnIdSchema,
  type ChatMessage,
  type ClientToServerEvent,
  type PromptSubmitEvent,
  type ServerToClientEvent,
  type TestFailure,
} from "@nyx/protocol";
import { createTurnCoordinator } from "../../src/turn/coordinator.js";
import type { TurnCoordinatorDeps, TurnCoordinatorMcp } from "../../src/turn/coordinator.js";
import type { ModelRouter } from "../../src/agents/routing.js";
import type {
  IntentResult,
  SubAgentCycleContext,
  SubAgentWork,
  SubAgents,
} from "../../src/agents/supervisor.js";
import { createCompileResultsInbox } from "../../src/compile/index.js";
import type { ArtifactManifest, CompileClient } from "../../src/compile/index.js";
import type { Balance, LedgerEntryRecord, LedgerStore, Turn } from "../../src/ledger/ledger.js";
import type { ChatStore, ChatWrite } from "../../src/projects/chat.js";
import type { ConnectionContext, EventRouter } from "../../src/protocol/router.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const PROJECT = "proj-counter";
const ADDRESS = "addr-owner-e2e";
const FLAT_RESERVE = 100n;
const TS = 1_700_000_000_000;

const MANIFEST: ArtifactManifest = {
  sourceHash: "sh-counter",
  compilerVersion: "0.24.0",
  circuits: [{ name: "increment", proof: true }],
  files: [
    { path: "increment.zkir", sha256: "abc", bytes: 42, contentType: "application/octet-stream" },
  ],
};

// ── Trace ────────────────────────────────────────────────────────────────────────

/** One ordered observation of the turn: an emitted frame, a compile check, or a delivered verdict. */
type TraceEntry =
  | { readonly kind: "send"; readonly event: ServerToClientEvent }
  | { readonly kind: "check"; readonly ok: boolean }
  | { readonly kind: "deliver"; readonly pass: boolean };

/** A scripted per-cycle verdict the harness delivers after each `verify:run`. */
interface Verdict {
  readonly pass: boolean;
  readonly failures: TestFailure[];
}

// ── Fakes ────────────────────────────────────────────────────────────────────────

const stubModelRouter: ModelRouter = {
  model: () => {
    throw new Error("modelRouter.model() should not be called — the swarm is mocked");
  },
};

const stubMcp: TurnCoordinatorMcp = {
  toolchain: { call: () => Promise.reject(new Error("toolchain.call unexpected")) },
  tome: { call: () => Promise.reject(new Error("tome.call unexpected")) },
  mnm: { call: () => Promise.reject(new Error("mnm.call unexpected")) },
};

const neverDelay = (): Promise<void> => new Promise<void>(() => undefined);

function makeTurn(id: string): Turn {
  return {
    id,
    projectId: PROJECT,
    status: "classifying",
    cyclesUsed: 0,
    reserveEntry: null,
    settleEntry: null,
    startedAt: TS,
    endedAt: null,
  };
}

interface LedgerHarness {
  readonly ledger: LedgerStore;
  readonly settleCalls: { turnId: string; amount: bigint }[];
}

function makeLedger(balance: Balance = { available: 500n, reserved: 0n }): LedgerHarness {
  const settleCalls: LedgerHarness["settleCalls"] = [];
  const entries: LedgerEntryRecord[] = [];
  let nextTurn = 1;
  let nextId = 1n;
  const ledger: LedgerStore = {
    openTurn: () => {
      const id = `turn-${String(nextTurn)}`;
      nextTurn += 1;
      return Promise.resolve(makeTurn(id));
    },
    getTurn: () => Promise.resolve(null),
    creditDeposit: () => Promise.reject(new Error("creditDeposit unexpected")),
    placeReserve: () => Promise.resolve(balance),
    settle: (address, turnId, amount) => {
      settleCalls.push({ turnId, amount });
      entries.push({
        id: nextId,
        accountAddress: address,
        kind: "reserve_release",
        amount: FLAT_RESERVE,
        ref: turnId,
        createdAt: TS,
      });
      nextId += 1n;
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
    decline: (turnId) => Promise.resolve({ ...makeTurn(turnId), status: "declined" }),
    getBalance: () => Promise.resolve(balance),
    getEntries: (address) =>
      Promise.resolve(entries.filter((entry) => entry.accountAddress === address)),
  };
  return { ledger, settleCalls };
}

function makeChat(): ChatStore {
  const messages: (ChatWrite & { projectId: string })[] = [];
  let seq = 0;
  return {
    appendChat: (projectId, message) => {
      messages.push({ projectId, ...message });
      seq += 1;
      // `ChatMessage.turnId` is a branded `TurnId`; cast the plain-string write here.
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

/** A cold-start counter swarm: canned files + tokens; Implementation writes the `.compact`. */
function makeSubAgents(): SubAgents {
  const make =
    (role: string, path: string) =>
    (ctx: SubAgentCycleContext): Promise<SubAgentWork> =>
      Promise.resolve({
        files: [{ path, content: `// ${role} — cycle ${String(ctx.cycle)}` }],
        tokensConsumed: 10n,
        narration: `${role} did its work`,
      });
  return {
    scaffolding: make("scaffolding", "package.json"),
    planning: make("planning", "PLAN.md"),
    implementation: make("implementation", "src/counter.compact"),
    review: make("review", "src/counter.test.ts"),
  };
}

/** A fake {@link CompileClient} that records each check into the trace and always succeeds. */
function makeFakeCompileClient(trace: TraceEntry[]): CompileClient {
  return {
    check: () => {
      trace.push({ kind: "check", ok: true });
      return Promise.resolve({
        ok: true,
        diagnostics: [],
        compilerVersion: "0.24.0",
        durationMs: 3,
      });
    },
    compile: () => Promise.resolve({ jobId: "job-1", status: "queued", sourceHash: "sh-counter" }),
    pollCompile: () =>
      Promise.resolve({
        jobId: "job-1",
        status: "succeeded",
        sourceHash: "sh-counter",
        result: {
          urlPrefix: "https://r2.nyx.test/proj-counter/abc/",
          sourceHash: "sh-counter",
          compilerVersion: "0.24.0",
          reused: false,
          circuits: [{ name: "increment", proof: true }],
        },
      }),
    version: () => Promise.reject(new Error("version() not expected")),
  };
}

const fetchArtifact: typeof fetch = (_input, init) =>
  (init?.method ?? "GET") === "HEAD"
    ? Promise.resolve(new Response(null, { status: 200 }))
    : Promise.resolve(
        new Response(JSON.stringify(MANIFEST), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

type StoredHandler = (event: ClientToServerEvent, ctx: ConnectionContext) => void | Promise<void>;

interface Harness {
  readonly trace: TraceEntry[];
  invoke(event: PromptSubmitEvent): Promise<void>;
  readonly settleCalls: { turnId: string; amount: bigint }[];
}

/**
 * Wire a coordinator to a fake connection + router. After each `verify:run` the harness
 * delivers the next scripted verdict (on a microtask, so the supervisor's `register` has
 * already run) — reproducing the client's WebContainer replying with `test:results`.
 */
function makeHarness(options: { intent: IntentResult; verdicts: Verdict[] }): Harness {
  const trace: TraceEntry[] = [];
  const verdicts = [...options.verdicts];
  const ledger = makeLedger();

  const compileClient = makeFakeCompileClient(trace);
  const deps: TurnCoordinatorDeps = {
    modelRouter: stubModelRouter,
    makeCompileClient: () => ({ forTurn: () => compileClient }),
    compileInbox: createCompileResultsInbox({ delay: neverDelay }),
    ledger: ledger.ledger,
    chat: makeChat(),
    projectStore: {
      commit: () => Promise.resolve({ version: 1 }),
      recordGreenBuild: () => Promise.resolve(),
    },
    mcp: stubMcp,
    flatReserve: FLAT_RESERVE,
    now: () => TS,
    delay: neverDelay,
    fetchArtifact,
    classifyIntent: () => Promise.resolve(options.intent),
    subAgents: makeSubAgents(),
  };
  const coordinator = createTurnCoordinator(deps);

  const ctx: ConnectionContext = {
    session: { accountAddress: ADDRESS },
    projectId: PROJECT,
    send: (event) => {
      trace.push({ kind: "send", event });
      if (event.type === "verify:run") {
        const turnId = event.payload.turnId;
        const verdict = verdicts.shift() ?? { pass: false, failures: [] };
        queueMicrotask(() => {
          trace.push({ kind: "deliver", pass: verdict.pass });
          coordinator.inbox.deliver({
            turnId: TurnIdSchema.parse(turnId),
            pass: verdict.pass,
            failures: verdict.failures,
          });
        });
      }
    },
    close: () => undefined,
  };

  const handlers = new Map<ClientToServerEvent["type"], StoredHandler>();
  const router: EventRouter = {
    on(type, handler) {
      handlers.set(type, handler as StoredHandler);
      return router;
    },
    dispatch() {
      throw new Error("EventRouter.dispatch is not exercised in this harness");
    },
  };
  coordinator.handlers(router);

  return {
    trace,
    settleCalls: ledger.settleCalls,
    async invoke(event) {
      const handler = handlers.get(event.type);
      if (handler === undefined) {
        throw new Error("prompt:submit handler was not registered");
      }
      await handler(event, ctx);
    },
  };
}

function promptEvent(text: string): PromptSubmitEvent {
  return {
    type: "prompt:submit",
    payload: { projectId: ProjectIdSchema.parse(PROJECT), text },
    ts: TS,
  };
}

/** The sent frames in order (the transcript). */
function sends(trace: TraceEntry[]): ServerToClientEvent[] {
  return trace.flatMap((entry) => (entry.kind === "send" ? [entry.event] : []));
}

/** Index in the trace of the first frame matching `predicate` (or -1). */
function traceIndexOfSend(
  trace: TraceEntry[],
  predicate: (event: ServerToClientEvent) => boolean,
): number {
  return trace.findIndex((entry) => entry.kind === "send" && predicate(entry.event));
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("full cold counter turn (green)", () => {
  it("compiles before surfacing, verifies green, announces once, and settles (SC-002/SC-015)", async () => {
    const harness = makeHarness({
      intent: { kind: "dapp" },
      verdicts: [{ pass: true, failures: [] }],
    });
    await harness.invoke(promptEvent("build a private counter DApp"));

    const trace = harness.trace;
    const doneIndex = traceIndexOfSend(
      trace,
      (event) => event.type === "turn:message" && event.payload.delta.includes("preview is live"),
    );
    const firstCheckIndex = trace.findIndex((entry) => entry.kind === "check" && entry.ok);
    const greenDeliverIndex = trace.findIndex((entry) => entry.kind === "deliver" && entry.pass);
    const verifyRunIndex = traceIndexOfSend(trace, (event) => event.type === "verify:run");
    const artifactsIndex = traceIndexOfSend(trace, (event) => event.type === "artifacts:ready");

    // The done-presentation exists...
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    // SC-002 — a successful CHECK precedes the done-presentation (compile-before-surface).
    expect(firstCheckIndex).toBeGreaterThanOrEqual(0);
    expect(firstCheckIndex).toBeLessThan(doneIndex);
    // SC-015 — the done-presentation is paired with a GREEN verdict delivered earlier.
    expect(greenDeliverIndex).toBeGreaterThanOrEqual(0);
    expect(greenDeliverIndex).toBeLessThan(doneIndex);
    // verify:run is emitted BEFORE the client's test:results is awaited/delivered.
    expect(verifyRunIndex).toBeGreaterThanOrEqual(0);
    expect(verifyRunIndex).toBeLessThan(greenDeliverIndex);
    // The full compile + artifacts:ready fire exactly once, only AFTER green.
    const artifactsFrames = sends(trace).filter((event) => event.type === "artifacts:ready");
    expect(artifactsFrames).toHaveLength(1);
    expect(artifactsIndex).toBeGreaterThan(greenDeliverIndex);
    // A green turn settles exactly once.
    expect(harness.settleCalls).toHaveLength(1);
    // Every emitted frame is JSON-safe (money is a decimal string, never a bigint).
    for (const event of sends(trace)) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
    // The settled/ledger frames carry STRING money.
    const settled = sends(trace).find((event) => event.type === "turn:settled");
    const wire = JSON.parse(JSON.stringify(settled)) as { payload: { consumed: string } };
    expect(typeof wire.payload.consumed).toBe("string");
  });
});

describe("a turn that never goes green", () => {
  it("never presents done and never announces artifacts (SC-015 negative)", async () => {
    const failing: Verdict = {
      pass: false,
      failures: [{ name: "counter > increments", message: "expected 1, got 0" }],
    };
    const harness = makeHarness({
      intent: { kind: "dapp" },
      verdicts: [failing, failing, failing],
    });
    await harness.invoke(promptEvent("build a private counter DApp"));

    const frames = sends(harness.trace);
    // No done-presentation, and no artifacts were ever announced.
    expect(
      frames.some(
        (event) => event.type === "turn:message" && event.payload.delta.includes("preview is live"),
      ),
    ).toBe(false);
    expect(frames.some((event) => event.type === "artifacts:ready")).toBe(false);
    // The exhausted turn is still real work — it settles honestly (D21/D34).
    expect(harness.settleCalls).toHaveLength(1);
    expect(frames.some((event) => event.type === "turn:settled")).toBe(true);
    // Three failing cycles were delivered (the budget was fully spent, D21).
    expect(harness.trace.filter((entry) => entry.kind === "deliver")).toHaveLength(3);
    for (const event of frames) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });
});

describe("a declined turn", () => {
  it("emits a zero-consumed terminal turn:settled with no settlement, no verify, no artifacts (D25)", async () => {
    const harness = makeHarness({
      intent: { kind: "off-domain", reason: "not a Midnight DApp" },
      verdicts: [],
    });
    await harness.invoke(promptEvent("what is the capital of France"));

    const frames = sends(harness.trace);
    const settled = frames.filter((event) => event.type === "turn:settled");
    // Exactly one terminal turn:settled (the coordinator's "nothing charged" unlock signal).
    expect(settled).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(settled[0])) as { payload: { consumed: string } };
    expect(wire.payload.consumed).toBe("0");
    // Nothing was settled on the ledger, and the verify/compile pipeline never ran.
    expect(harness.settleCalls).toHaveLength(0);
    expect(frames.some((event) => event.type === "verify:run")).toBe(false);
    expect(frames.some((event) => event.type === "artifacts:ready")).toBe(false);
    // A decline is explained to the user.
    expect(frames.some((event) => event.type === "turn:message")).toBe(true);
    for (const event of frames) {
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });
});
