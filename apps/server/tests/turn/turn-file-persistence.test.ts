/**
 * Turn-end file persistence tests (Task 4 — closes the "turn loop never calls
 * ProjectStore.commit" gap).
 *
 * A settled agent turn must leave `project_file_versions` rows so the US13 exports
 * (archive + git clone) and the future US14 editor read a REAL project, not a hollow
 * one. Three things are pinned here:
 *
 *  1. A full green turn driven THROUGH the coordinator with the in-memory
 *     {@link InMemoryProjectStore} persists the turn's files as ONE agent-authored
 *     commit (`author: "agent"`, one version) — the coordinator's `projectStore`
 *     wiring reaching the store (SC-026).
 *  2. An EXHAUSTED turn still commits its work-in-progress files (D21 keeps WIP), so
 *     even a turn that never went green is no longer hollow.
 *  3. ⚠️ THE MONEY-PATH INVARIANT: a commit that THROWS must NEVER block or break
 *     `turn:settled`. The persistence failure is logged LOUDLY onto the activity feed
 *     and swallowed; the turn still settles and the files still live in the client VFS.
 *
 * Everything is deterministic + fully seam-injected (constitution III/IV): no model,
 * no Compile Service, no WebContainer.
 */
import { describe, expect, it, vi } from "vitest";
import { ProjectIdSchema, TurnIdSchema } from "@nyx/protocol";
import type {
  ChatMessage,
  ClientToServerEvent,
  PromptSubmitEvent,
  ServerToClientEvent,
} from "@nyx/protocol";
import { createTurnCoordinator } from "../../src/turn/coordinator.js";
import type { TurnCoordinatorDeps, TurnCoordinatorMcp } from "../../src/turn/coordinator.js";
import { createSupervisor } from "../../src/agents/supervisor.js";
import type {
  CheckOutcome,
  IntentResult,
  OutboundEvent,
  SubAgentCycleContext,
  SubAgentWork,
  SubAgents,
  SupervisorContext,
  SupervisorDeps,
  SupervisorLedger,
} from "../../src/agents/supervisor.js";
import type { ArtifactManifest, CompileClient } from "../../src/compile/index.js";
import type { Balance, LedgerEntryRecord, LedgerStore, Turn } from "../../src/ledger/ledger.js";
import type { ChatStore, ChatWrite } from "../../src/projects/chat.js";
import type { CommitResult, FileWrite } from "../../src/projects/store.js";
import type { ConnectionContext, EventRouter } from "../../src/protocol/router.js";
import { InMemoryProjectStore } from "../projects/helpers.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const ADDRESS = "addr-owner-1";
const FLAT_RESERVE = 100n;
const TS = 1_700_000_000_000;

/** A representative valid R2 manifest so the green FULL compile's verify-before-announce passes. */
const MANIFEST: ArtifactManifest = {
  sourceHash: "sh-1",
  compilerVersion: "0.24.0",
  circuits: [{ name: "increment", proof: true }],
  files: [
    { path: "increment.zkir", sha256: "abc", bytes: 10, contentType: "application/octet-stream" },
  ],
};

/** A clean per-cycle CHECK outcome — proceed to the behavioural tests. */
const CHECK_OK: CheckOutcome = { ok: true, diagnostics: [] };

// ── Fakes ────────────────────────────────────────────────────────────────────────

/** Flush the microtask queue past one macrotask boundary. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A never-resolving delay, so the inbox timeout never fires unless a test wants it. */
const neverDelay = (): Promise<void> => new Promise<void>(() => undefined);

/** A model router stub that fails loudly if resolved (the swarm is always overridden here). */
const stubModelRouter = {
  model: () => {
    throw new Error("modelRouter.model() should not be called when the swarm is overridden");
  },
};

/** MCP clients that fail loudly if called (the swarm is overridden). */
const stubMcp: TurnCoordinatorMcp = {
  toolchain: { call: () => Promise.reject(new Error("toolchain.call unexpected")) },
  tome: { call: () => Promise.reject(new Error("tome.call unexpected")) },
  mnm: { call: () => Promise.reject(new Error("mnm.call unexpected")) },
};

/** A fake artifact `fetch`: the manifest on GET, a 200 on every file HEAD. */
const fetchArtifact: typeof fetch = (_input, init) =>
  (init?.method ?? "GET") === "HEAD"
    ? Promise.resolve(new Response(null, { status: 200 }))
    : Promise.resolve(
        new Response(JSON.stringify(MANIFEST), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

function makeTurn(projectId: string, id: string, status: Turn["status"]): Turn {
  return {
    id,
    projectId,
    status,
    cyclesUsed: 0,
    reserveEntry: null,
    settleEntry: null,
    startedAt: TS,
    endedAt: null,
  };
}

/** A deterministic in-memory {@link LedgerStore} sufficient for both drive paths. */
function makeLedgerStore(projectId: string): LedgerStore {
  const entries: LedgerEntryRecord[] = [];
  const balance: Balance = { available: 400n, reserved: 0n };
  let nextTurn = 1;
  let nextId = 1n;
  return {
    openTurn: () => {
      const id = `turn-${String(nextTurn)}`;
      nextTurn += 1;
      return Promise.resolve(makeTurn(projectId, id, "classifying"));
    },
    getTurn: () => Promise.resolve(null),
    creditDeposit: () => Promise.reject(new Error("creditDeposit unexpected")),
    placeReserve: () => Promise.resolve(balance),
    settle: (address, turnId, amount) => {
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
    decline: (turnId) => Promise.resolve(makeTurn(projectId, turnId, "declined")),
    getBalance: () => Promise.resolve(balance),
    getEntries: (address) =>
      Promise.resolve(entries.filter((entry) => entry.accountAddress === address)),
  };
}

/** The {@link SupervisorLedger} subset for the supervisor-direct scenarios. */
function makeSupervisorLedger(projectId: string): SupervisorLedger {
  const store = makeLedgerStore(projectId);
  return {
    openTurn: (pid) => store.openTurn(pid),
    decline: (turnId) => store.decline(turnId),
    placeReserve: (address, turnId, flat) => store.placeReserve(address, turnId, flat),
    settle: (address, turnId, amount) => store.settle(address, turnId, amount),
    getEntries: (address) => store.getEntries(address),
  };
}

/** A deterministic in-memory {@link ChatStore}; empty history ⇒ a cold-start project. */
function makeChat(): ChatStore {
  const messages: (ChatWrite & { projectId: string })[] = [];
  let seq = 0;
  return {
    appendChat: (projectId, message) => {
      messages.push({ projectId, ...message });
      seq += 1;
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

/** A fake {@link CompileClient}: clean check + a `succeeded` full compile (terminal on first poll). */
function makeCompileClient(): CompileClient {
  return {
    check: () =>
      Promise.resolve({ ok: true, diagnostics: [], compilerVersion: "0.24.0", durationMs: 3 }),
    compile: () => Promise.resolve({ jobId: "job-1", status: "queued", sourceHash: "sh-1" }),
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
}

/**
 * Sub-agents producing exactly TWO distinct files across a cycle (`contract.compact` +
 * `src/App.tsx`): two agents write, two contribute nothing, so the merged/accumulated set
 * is deterministic and small enough to assert on directly.
 */
function makeSubAgents(): SubAgents {
  const writer =
    (role: string, path: string) =>
    (ctx: SubAgentCycleContext): Promise<SubAgentWork> =>
      Promise.resolve({
        files: [{ path, content: `// ${role} cycle ${String(ctx.cycle)}` }],
        tokensConsumed: 10n,
      });
  const empty = (): Promise<SubAgentWork> => Promise.resolve({ files: [], tokensConsumed: 5n });
  return {
    scaffolding: writer("scaffolding", "contract.compact"),
    planning: empty,
    implementation: writer("implementation", "src/App.tsx"),
    review: empty,
  };
}

interface CtxHarness {
  readonly ctx: ConnectionContext;
  readonly sent: ServerToClientEvent[];
}

/** A fake connection context recording every sent frame. */
function makeCtx(projectId: string): CtxHarness {
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

/** Build a `prompt:submit` client event (branding via the schema). */
function promptEvent(projectId: string, text: string): PromptSubmitEvent {
  return {
    type: "prompt:submit",
    payload: { projectId: ProjectIdSchema.parse(projectId), text },
    ts: TS,
  };
}

/** Base coordinator deps wired to the given project store; overrides drive each scenario. */
function coordinatorDeps(
  projectStore: TurnCoordinatorDeps["projectStore"],
  overrides: Partial<TurnCoordinatorDeps> = {},
): TurnCoordinatorDeps {
  return {
    modelRouter: stubModelRouter,
    compileClient: makeCompileClient(),
    ledger: overrides.ledger ?? makeLedgerStore("proj-1"),
    chat: makeChat(),
    mcp: stubMcp,
    flatReserve: FLAT_RESERVE,
    now: () => TS,
    delay: neverDelay,
    fetchArtifact,
    classifyIntent: () => Promise.resolve<IntentResult>({ kind: "dapp" }),
    subAgents: makeSubAgents(),
    projectStore,
    ...overrides,
  };
}

// ── Supervisor-direct deps (scenarios 2 + 3) ─────────────────────────────────────

interface SupervisorCtxHarness {
  readonly ctx: SupervisorContext;
  readonly sent: OutboundEvent[];
}

function makeSupervisorCtx(projectId: string): SupervisorCtxHarness {
  const sent: OutboundEvent[] = [];
  const ctx: SupervisorContext = {
    session: { address: ADDRESS },
    projectId,
    send: (event) => {
      sent.push(event);
    },
    now: () => TS,
  };
  return { ctx, sent };
}

/** Assemble supervisor deps with the given `commitFiles` seam + verdict/check overrides. */
function supervisorDeps(
  projectId: string,
  commitFiles: SupervisorDeps["commitFiles"],
  overrides: Partial<SupervisorDeps> = {},
): SupervisorDeps {
  return {
    ledger: makeSupervisorLedger(projectId),
    checkCompile: () => Promise.resolve(CHECK_OK),
    runFullCompile: () =>
      Promise.resolve({
        kind: "ready",
        urlPrefix: "https://r2.nyx.test/proj-1/abc123",
        reused: false,
        compilerVersion: "0.24.0",
        circuits: [{ name: "increment", proof: true }],
        announced: true,
        telemetry: {
          compilerVersion: "0.24.0",
          checkLatencyMs: 5,
          checkDurationMs: 4,
          progress: [],
        },
      }),
    chat: makeChat(),
    flatReserve: FLAT_RESERVE,
    classifyIntent: () => Promise.resolve<IntentResult>({ kind: "dapp" }),
    subAgents: makeSubAgents(),
    awaitTestResults: (turnId) =>
      Promise.resolve({ turnId: TurnIdSchema.parse(turnId), pass: true, failures: [] }),
    retryDelay: () => Promise.resolve(),
    commitFiles,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("Turn-end file persistence — commitFiles → ProjectStore.commit", () => {
  it("a green turn through the coordinator commits its files as ONE agent version (US13 no-longer-hollow)", async () => {
    const store = new InMemoryProjectStore({
      clock: () => TS,
      maxFileBytes: 1_000_000,
      maxProjectBytes: 10_000_000,
      projectQuotaPerAccount: 10,
      versionRetentionCount: 50,
      versionRetentionDays: 365,
      deletionRecoveryDays: 30,
    });
    // The commit target must EXIST; use the project's own id for the connection + prompt.
    const project = await store.createProject(ADDRESS, "counter");
    const projectId = project.id;

    const coordinator = createTurnCoordinator(
      coordinatorDeps(store, { ledger: makeLedgerStore(projectId) }),
    );
    const fake = makeFakeRouter();
    coordinator.handlers(fake.router);
    const { ctx } = makeCtx(projectId);

    // Drive the turn; it parks at awaitTestResults → deliver a passing verdict → green.
    const done = fake.invoke(promptEvent(projectId, "build a counter"), ctx);
    await tick();
    coordinator.inbox.deliver({ turnId: TurnIdSchema.parse("turn-1"), pass: true, failures: [] });
    await done;

    const versions = await store.getVersionHistory(projectId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.author).toBe("agent");
    expect(versions[0]?.files.map((file) => file.path).sort()).toEqual([
      "contract.compact",
      "src/App.tsx",
    ]);

    // US13 no-longer-hollow proof: the current file set is non-empty.
    const files = await store.getFiles(projectId);
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((file) => file.path).sort()).toEqual(["contract.compact", "src/App.tsx"]);

    // Task 5: the green FULL compile's `ready` outcome was persisted as the latest green
    // build (FR-054), so the US8 deploy handler's greenness gate reads it at deploy time.
    await expect(store.getLatestGreenBuild(projectId)).resolves.toEqual({
      urlPrefix: "https://r2.nyx.test/proj/abc/",
      compilerVersion: "0.24.0",
    });
  });

  it("an EXHAUSTED turn still commits its work-in-progress files (D21 keeps WIP)", async () => {
    const commitFiles = vi.fn<
      (projectId: string, files: readonly FileWrite[]) => Promise<CommitResult>
    >(() => Promise.resolve({ version: 1 }));
    const { ctx, sent } = makeSupervisorCtx("proj-1");
    const supervisor = createSupervisor(
      supervisorDeps("proj-1", commitFiles, {
        // Never green: every behavioural suite fails ⇒ the 3-cycle budget exhausts (D21).
        awaitTestResults: (turnId) =>
          Promise.resolve({
            turnId: TurnIdSchema.parse(turnId),
            pass: false,
            failures: [{ name: "counter.test.ts", message: "still failing" }],
          }),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, { projectId: "proj-1", text: "build" });

    expect(result.kind).toBe("exhausted");
    // The WIP was persisted exactly once, as the accumulated (deduped) file set.
    expect(commitFiles).toHaveBeenCalledTimes(1);
    const [committedProjectId, committedFiles] = commitFiles.mock.calls[0] ?? [];
    expect(committedProjectId).toBe("proj-1");
    expect((committedFiles ?? []).map((file) => file.path).sort()).toEqual([
      "contract.compact",
      "src/App.tsx",
    ]);
    // The turn still settled (charged for real work, D34).
    expect(sent.some((event) => event.type === "turn:settled")).toBe(true);
  });

  it("a commit that THROWS never blocks turn:settled — logged onto the activity feed + swallowed", async () => {
    const commitError = new Error("project store unreachable");
    const commitFiles = vi.fn<
      (projectId: string, files: readonly FileWrite[]) => Promise<CommitResult>
    >(() => Promise.reject(commitError));
    const { ctx, sent } = makeSupervisorCtx("proj-1");
    const supervisor = createSupervisor(supervisorDeps("proj-1", commitFiles));

    // A green turn whose persistence FAILS must not reject and must still reach `green`.
    const result = await supervisor.handlePrompt(ctx, { projectId: "proj-1", text: "build" });

    expect(result.kind).toBe("green");
    expect(commitFiles).toHaveBeenCalledTimes(1);

    // ⚠️ THE INVARIANT: settle wins. The terminal `turn:settled` was still emitted.
    expect(sent.some((event) => event.type === "turn:settled")).toBe(true);

    // The failure was logged LOUDLY onto the activity feed (never silently swallowed).
    const persistActivity = sent.filter(
      (event) => event.type === "turn:activity" && event.payload.phase === "persist",
    );
    expect(persistActivity).toHaveLength(1);
    const detail =
      persistActivity[0]?.type === "turn:activity" ? persistActivity[0].payload.detail : "";
    expect(detail).toContain("file persistence failed");
    expect(detail).toContain("project store unreachable");
  });
});
