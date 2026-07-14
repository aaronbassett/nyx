/**
 * Supervisor + turn state-machine tests (US1 — the MVP orchestration core, T138).
 *
 * These drive {@link createSupervisor} through FULLY-INJECTED seams — a fake
 * ledger, a per-cycle compile CHECK + a green-only FULL compile, chat store, intent
 * classifier, sub-agent swarm, and `awaitTestResults` — so the whole deterministic
 * turn lifecycle is pinned with NO model call, NO Compile Service, and NO
 * WebContainer (constitution III/IV).
 *
 * The decisions pinned here:
 *  - D24/FR-009 — a single active turn per project: a second prompt while one is
 *    live is REJECTED (input locked), never opening a second turn.
 *  - D25/FR-010 — an off-domain prompt is declined: no reserve, no settle.
 *  - D34/EC-01 — an accepted prompt reserves; a below-gate reserve surfaces a
 *    top-up CTA and does NOT settle (nothing ran).
 *  - D21/D35/FR-029 — the ≤3-cycle verify loop; a green suite is the sole trigger
 *    for the ONE full compile + done-presentation; exhaustion ends honestly.
 *  - D34 — every non-declined/non-insufficient outcome settles at ACTUAL
 *    consumption (the SUM of sub-agent tokens), emitting encoded (string-money)
 *    `turn:settled` + `ledger:update`.
 *  - Scenario 5 — a thrown infra fault retries with backoff, then fails LOUDLY
 *    naming the service, and STILL settles.
 */
import { describe, expect, it } from "vitest";
import { encodeTurnSettledEvent, TestResultsPayloadSchema } from "@nyx/protocol";
import type { LedgerEntryRecord, Balance, Turn } from "../../src/ledger/ledger.js";
import { InsufficientAvailableError } from "../../src/ledger/ledger.js";
import type { ChatMessage } from "@nyx/protocol";
import type { ChatStore, ChatWrite } from "../../src/projects/chat.js";
import type { CompileOutcome, CompileTurnInput } from "../../src/compile/index.js";
import type { TestResultsPayload } from "@nyx/protocol";
import { createSupervisor } from "../../src/agents/supervisor.js";
import type {
  CheckCompiler,
  CheckOutcome,
  FullCompiler,
  IntentResult,
  OutboundEvent,
  SubAgentCycleContext,
  SubAgentWork,
  SubAgents,
  SupervisorContext,
  SupervisorDeps,
  SupervisorLedger,
} from "../../src/agents/supervisor.js";

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT = "proj-1";
const ADDRESS = "addr-owner-1";
const FLAT_RESERVE = 100n;
const FIXED_TS = 1_700_000_000_000;

/** A representative green terminal compile outcome (kind:"ready"). */
const READY_OUTCOME: CompileOutcome = {
  kind: "ready",
  urlPrefix: "https://r2.nyx.test/proj-1/abc123",
  reused: false,
  compilerVersion: "0.24.0",
  circuits: [{ name: "increment", proof: true }],
  announced: true,
  telemetry: { compilerVersion: "0.24.0", checkLatencyMs: 5, checkDurationMs: 4, progress: [] },
};

/** A clean per-cycle CHECK outcome — proceed to the behavioural tests. */
const CHECK_OK: CheckOutcome = { ok: true, diagnostics: [] };

/** A failed per-cycle CHECK outcome carrying one diagnostic (fed forward to the next cycle). */
const CHECK_FAILED: CheckOutcome = {
  ok: false,
  diagnostics: [
    {
      severity: "error",
      source: "compactc",
      message: "unbound identifier `foo`",
      file: "src/counter.compact",
      raw: false,
    },
  ],
};

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Records every event the supervisor sends, plus the raw send handler. */
interface CtxHarness {
  readonly ctx: SupervisorContext;
  readonly sent: OutboundEvent[];
}

function makeCtx(): CtxHarness {
  const sent: OutboundEvent[] = [];
  const ctx: SupervisorContext = {
    session: { address: ADDRESS },
    projectId: PROJECT,
    send: (event) => {
      sent.push(event);
    },
    now: () => FIXED_TS,
  };
  return { ctx, sent };
}

/** A minimal {@link Turn} row the fake ledger hands back from `openTurn`. */
function makeTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    projectId: PROJECT,
    status,
    cyclesUsed: 0,
    reserveEntry: null,
    settleEntry: null,
    startedAt: FIXED_TS,
    endedAt: null,
  };
}

interface LedgerHarness {
  readonly ledger: SupervisorLedger;
  readonly calls: {
    openTurn: number;
    decline: string[];
    placeReserve: { address: string; turnId: string; flat: bigint | undefined }[];
    settle: { address: string; turnId: string; amount: bigint }[];
  };
}

/**
 * A deterministic in-memory ledger seam. `insufficient` forces a below-gate reserve reject
 * (EC-01); `reserveError` forces a NON-InsufficientAvailableError reserve fault (the
 * reserve-time infra path); `settleError` forces every `settle` to reject (the settle-retry
 * path).
 */
function makeLedger(
  opts: {
    insufficient?: boolean;
    balance?: Balance;
    reserveError?: Error;
    settleError?: Error;
  } = {},
): LedgerHarness {
  const balance: Balance = opts.balance ?? { available: 500n, reserved: 0n };
  const entries: LedgerEntryRecord[] = [];
  let nextId = 1n;
  let nextTurn = 1;
  const calls: LedgerHarness["calls"] = {
    openTurn: 0,
    decline: [],
    placeReserve: [],
    settle: [],
  };
  const ledger: SupervisorLedger = {
    openTurn: (projectId) => {
      calls.openTurn += 1;
      void projectId;
      const id = `turn-${String(nextTurn)}`;
      nextTurn += 1;
      return Promise.resolve(makeTurn(id, "classifying"));
    },
    decline: (turnId) => {
      calls.decline.push(turnId);
      return Promise.resolve(makeTurn(turnId, "declined"));
    },
    placeReserve: (address, turnId, flat) => {
      calls.placeReserve.push({ address, turnId, flat });
      if (opts.insufficient === true) {
        return Promise.reject(new InsufficientAvailableError(address, 0n, flat ?? FLAT_RESERVE));
      }
      if (opts.reserveError !== undefined) {
        return Promise.reject(opts.reserveError);
      }
      return Promise.resolve(balance);
    },
    settle: (address, turnId, amount) => {
      calls.settle.push({ address, turnId, amount });
      if (opts.settleError !== undefined) {
        return Promise.reject(opts.settleError);
      }
      entries.push({
        id: nextId,
        accountAddress: address,
        kind: "reserve_release",
        amount: FLAT_RESERVE,
        ref: turnId,
        createdAt: FIXED_TS,
      });
      nextId += 1n;
      entries.push({
        id: nextId,
        accountAddress: address,
        kind: "settlement",
        amount,
        ref: turnId,
        createdAt: FIXED_TS,
      });
      nextId += 1n;
      return Promise.resolve(balance);
    },
    getEntries: (address) =>
      Promise.resolve(entries.filter((entry) => entry.accountAddress === address)),
  };
  return { ledger, calls };
}

interface ChatHarness {
  readonly chat: ChatStore;
  readonly messages: (ChatWrite & { projectId: string })[];
}

/** A deterministic in-memory chat store. `seed` pre-fills history (a warm project). */
function makeChat(seed: (ChatWrite & { projectId: string })[] = []): ChatHarness {
  const messages: (ChatWrite & { projectId: string })[] = [...seed];
  let seq = 0;
  const chat: ChatStore = {
    appendChat: (projectId, message) => {
      messages.push({ projectId, ...message });
      seq += 1;
      const base: ChatMessage = {
        seq,
        role: message.role,
        content: message.content,
        createdAt: FIXED_TS,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      } as ChatMessage;
      return Promise.resolve(base);
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
                createdAt: FIXED_TS,
                ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
              }) as ChatMessage,
          ),
      ),
  };
  return { chat, messages };
}

interface SubAgentHarness {
  readonly subAgents: SubAgents;
  readonly calls: { role: string; cycle: number }[];
}

/** Sub-agents that each contribute one file + fixed tokens; records every call. */
function makeSubAgents(tokensPerAgent = 10n): SubAgentHarness {
  const calls: { role: string; cycle: number }[] = [];
  const make =
    (role: string, path: string) =>
    (ctx: SubAgentCycleContext): Promise<SubAgentWork> => {
      calls.push({ role, cycle: ctx.cycle });
      return Promise.resolve({
        files: [{ path, content: `// ${role} cycle ${String(ctx.cycle)}` }],
        tokensConsumed: tokensPerAgent,
        narration: `${role} narration`,
        activity: [
          { agent: role, phase: `cycle ${String(ctx.cycle)}`, detail: `${role} did work` },
        ],
      });
    };
  const subAgents: SubAgents = {
    scaffolding: make("scaffolding", "package.json"),
    planning: make("planning", "PLAN.md"),
    implementation: make("implementation", "src/counter.compact"),
    review: make("review", "src/counter.test.ts"),
  };
  return { subAgents, calls };
}

/** The per-cycle CHECK seam: returns queued check outcomes (or throws on a "throw" item). */
function makeCheckCompiler(outcomes: (CheckOutcome | "throw")[]): {
  checkCompile: CheckCompiler;
  calls: CompileTurnInput[];
} {
  const calls: CompileTurnInput[] = [];
  let index = 0;
  return {
    checkCompile: (input) => {
      calls.push(input);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome === "throw" || outcome === undefined) {
        return Promise.reject(new Error("compile service unreachable"));
      }
      return Promise.resolve(outcome);
    },
    calls,
  };
}

/**
 * The green-only FULL compile seam (keys, zkir, R2 upload, the one `artifacts:ready`).
 * Records every invocation so a test can assert it fires ONLY on a green suite — never
 * on a mere check-pass, never before the behavioural tests run (the BUG 1 regression).
 */
function makeFullCompiler(outcome: CompileOutcome | "throw" = READY_OUTCOME): {
  runFullCompile: FullCompiler;
  calls: CompileTurnInput[];
} {
  const calls: CompileTurnInput[] = [];
  return {
    runFullCompile: (input) => {
      calls.push(input);
      if (outcome === "throw") {
        return Promise.reject(new Error("compile service unreachable"));
      }
      return Promise.resolve(outcome);
    },
    calls,
  };
}

/** `awaitTestResults` seam returning queued verdicts for successive cycles. */
function makeTestResults(
  verdicts: { pass: boolean; failures?: { name: string; message: string }[] }[],
): (turnId: string) => Promise<TestResultsPayload> {
  let index = 0;
  return (turnId) => {
    const verdict = verdicts[Math.min(index, verdicts.length - 1)] ?? { pass: false };
    index += 1;
    // Mint the branded `TurnId` (and validate the shape) through the protocol schema —
    // an `as TestResultsPayload` cast would not brand `turnId` (TS2352).
    return Promise.resolve(
      TestResultsPayloadSchema.parse({
        turnId,
        pass: verdict.pass,
        failures: verdict.failures ?? [],
      }),
    );
  };
}

/** Assemble supervisor deps from harnesses with sensible defaults for the rest. */
function makeDeps(overrides: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    ledger: makeLedger().ledger,
    checkCompile: makeCheckCompiler([CHECK_OK]).checkCompile,
    runFullCompile: makeFullCompiler(READY_OUTCOME).runFullCompile,
    chat: makeChat().chat,
    flatReserve: FLAT_RESERVE,
    classifyIntent: () => Promise.resolve<IntentResult>({ kind: "dapp" }),
    subAgents: makeSubAgents().subAgents,
    awaitTestResults: makeTestResults([{ pass: true }]),
    retryDelay: () => Promise.resolve(),
    ...overrides,
  };
}

/** Count events of a given `type` in the captured send buffer. */
function eventsOfType(sent: OutboundEvent[], type: string): OutboundEvent[] {
  return sent.filter((event) => event.type === type);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Supervisor — D24/FR-009: a single active turn per project", () => {
  it("rejects a second prompt while one is live and never opens a second turn", async () => {
    const { ctx, sent } = makeCtx();
    const ledger = makeLedger();

    // Park cycle 1 at awaitTestResults via a manually-controlled deferred.
    let releaseResults: (payload: TestResultsPayload) => void = () => undefined;
    const gate = new Promise<TestResultsPayload>((resolve) => {
      releaseResults = resolve;
    });

    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        awaitTestResults: () => gate,
      }),
    );

    const first = supervisor.handlePrompt(ctx, { projectId: PROJECT, text: "build a counter" });
    // Let the first turn advance through openTurn → reserve → cycle → awaitTestResults.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "and add a reset",
    });
    expect(second.kind).toBe("rejected");
    if (second.kind === "rejected") {
      expect(second.reason).toBe("turn-active");
    }
    // Exactly one turn was opened — the second prompt never reached openTurn.
    expect(ledger.calls.openTurn).toBe(1);
    // An input-locked supervisor message was surfaced.
    const messages = eventsOfType(sent, "turn:message");
    expect(
      messages.some((event) => event.type === "turn:message" && /lock/i.test(event.payload.delta)),
    ).toBe(true);

    // Release cycle 1 (green) so the first turn settles cleanly. Mint the branded
    // `TurnId` through the schema (an `as TestResultsPayload` cast would not brand it).
    releaseResults(TestResultsPayloadSchema.parse({ turnId: "turn-1", pass: true, failures: [] }));
    const firstResult = await first;
    expect(firstResult.kind).toBe("green");
  });
});

describe("Supervisor — D25/FR-010: an off-domain prompt is declined with no charge", () => {
  it("declines, reserves nothing, and settles nothing", async () => {
    const { ctx, sent } = makeCtx();
    const ledger = makeLedger();
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        classifyIntent: () =>
          Promise.resolve<IntentResult>({ kind: "off-domain", reason: "asked for a poem" }),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "write me a poem",
    });

    expect(result.kind).toBe("declined");
    expect(ledger.calls.decline).toEqual(["turn-1"]);
    expect(ledger.calls.placeReserve).toHaveLength(0);
    expect(ledger.calls.settle).toHaveLength(0);
    // A decline message explaining what Nyx is for was surfaced.
    expect(eventsOfType(sent, "turn:message")).not.toHaveLength(0);
    // No settlement events at all.
    expect(eventsOfType(sent, "turn:settled")).toHaveLength(0);
  });
});

describe("Supervisor — D34/EC-01: a below-gate reserve surfaces a top-up CTA", () => {
  it("returns insufficient-balance, emits a top-up message, and never settles", async () => {
    const { ctx, sent } = makeCtx();
    const ledger = makeLedger({ insufficient: true });
    const supervisor = createSupervisor(makeDeps({ ledger: ledger.ledger }));

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("insufficient-balance");
    expect(ledger.calls.placeReserve).toHaveLength(1);
    expect(ledger.calls.settle).toHaveLength(0);
    expect(eventsOfType(sent, "turn:message")).not.toHaveLength(0);
    expect(eventsOfType(sent, "turn:settled")).toHaveLength(0);
  });
});

describe("Supervisor — happy path: accept → reserve → green → settle", () => {
  it("runs one cycle, triggers the full compile once, and settles with string money", async () => {
    const { ctx, sent } = makeCtx();
    const ledger = makeLedger();
    const checker = makeCheckCompiler([CHECK_OK]);
    const fullCompiler = makeFullCompiler(READY_OUTCOME);
    const subAgents = makeSubAgents(10n);
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        checkCompile: checker.checkCompile,
        runFullCompile: fullCompiler.runFullCompile,
        subAgents: subAgents.subAgents,
        awaitTestResults: makeTestResults([{ pass: true }]),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("green");
    if (result.kind === "green") {
      expect(result.cycles).toBe(1);
      // Cold-start cycle 1 = scaffolding+planning+implementation+review → 4 agents × 10.
      expect(result.consumed).toBe(40n);
    }

    // Settled once at the summed consumption.
    expect(ledger.calls.settle).toEqual([{ address: ADDRESS, turnId: "turn-1", amount: 40n }]);

    // BUG 1 regression: the per-cycle path ran the fast CHECK once; the FULL compile
    // (keys/zkir/R2/artifacts:ready) fired EXACTLY once — only on the green suite.
    expect(checker.calls).toHaveLength(1);
    expect(fullCompiler.calls).toHaveLength(1);

    // turn:settled + ledger:update were emitted, encoded, and JSON-serializable.
    const settled = eventsOfType(sent, "turn:settled");
    const ledgerUpdate = eventsOfType(sent, "ledger:update");
    expect(settled).toHaveLength(1);
    expect(ledgerUpdate).toHaveLength(1);

    const settledEvent = settled[0];
    if (settledEvent?.type !== "turn:settled") {
      throw new Error("expected a turn:settled event");
    }
    // Money fields are STRINGS on the wire (encoded), so JSON.stringify never throws.
    expect(typeof settledEvent.payload.consumed).toBe("string");
    expect(typeof settledEvent.payload.balance).toBe("string");
    expect(() => JSON.stringify(settledEvent)).not.toThrow();
    expect(settledEvent.payload.consumed).toBe("40");

    const ledgerEvent = ledgerUpdate[0];
    if (ledgerEvent?.type !== "ledger:update") {
      throw new Error("expected a ledger:update event");
    }
    expect(typeof ledgerEvent.payload.available).toBe("string");
    expect(typeof ledgerEvent.payload.reserved).toBe("string");
    expect(typeof ledgerEvent.payload.entry.amount).toBe("string");
    expect(() => JSON.stringify(ledgerEvent)).not.toThrow();

    // file:write emitted for the cycle's files; done-presentation surfaced.
    expect(eventsOfType(sent, "file:write")).not.toHaveLength(0);
    expect(eventsOfType(sent, "turn:activity")).not.toHaveLength(0);
    const assistantDone = eventsOfType(sent, "turn:message").some(
      (event) => event.type === "turn:message" && event.payload.role === "assistant",
    );
    expect(assistantDone).toBe(true);
  });
});

describe("Supervisor — BUG1: the full compile is gated on green TESTS, not the check", () => {
  it("runs only the CHECK per cycle and fires the full compile only after test:results goes green", async () => {
    const { ctx } = makeCtx();
    const ledger = makeLedger();
    const checker = makeCheckCompiler([CHECK_OK]);
    const fullCompiler = makeFullCompiler(READY_OUTCOME);

    // Park the turn at awaitTestResults so we can observe the moment AFTER a clean check
    // but BEFORE the behavioural verdict — the window where the buggy code would have
    // already run the full compile + announced artifacts.
    let releaseResults: (payload: TestResultsPayload) => void = () => undefined;
    const gate = new Promise<TestResultsPayload>((resolve) => {
      releaseResults = resolve;
    });

    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        checkCompile: checker.checkCompile,
        runFullCompile: fullCompiler.runFullCompile,
        awaitTestResults: () => gate,
      }),
    );

    const turn = supervisor.handlePrompt(ctx, { projectId: PROJECT, text: "build a counter" });
    // Advance through sub-agents → CHECK → park at awaitTestResults.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The fast CHECK ran; the FULL compile has NOT — the tests have not gone green yet.
    expect(checker.calls).toHaveLength(1);
    expect(fullCompiler.calls).toHaveLength(0);

    // Now the client's suite passes → the ONE full compile fires (D35/FR-029).
    releaseResults(TestResultsPayloadSchema.parse({ turnId: "turn-1", pass: true, failures: [] }));
    const result = await turn;

    expect(result.kind).toBe("green");
    expect(checker.calls).toHaveLength(1);
    expect(fullCompiler.calls).toHaveLength(1);
    // The full compile ran with the same input the cycle's check saw.
    expect(fullCompiler.calls[0]).toEqual(checker.calls[0]);
  });
});

describe("Supervisor — D21: three failing cycles exhaust the budget honestly", () => {
  it("ends exhausted, keeps WIP, offers a next prompt, and settles at actual", async () => {
    const { ctx, sent } = makeCtx();
    const ledger = makeLedger();
    const subAgents = makeSubAgents(10n);
    const checker = makeCheckCompiler([CHECK_OK]);
    const fullCompiler = makeFullCompiler(READY_OUTCOME);
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        subAgents: subAgents.subAgents,
        // Check passes each cycle; the client's suite fails three times.
        checkCompile: checker.checkCompile,
        runFullCompile: fullCompiler.runFullCompile,
        awaitTestResults: makeTestResults([
          { pass: false, failures: [{ name: "increments", message: "expected 1, got 0" }] },
        ]),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("exhausted");
    if (result.kind === "exhausted") {
      expect(result.cycles).toBe(3);
      // 3 cold-start cycles: cycle 1 has 4 agents, cycles 2-3 have 3 → 4+3+3 = 10 × 10.
      expect(result.consumed).toBe(100n);
    }
    // BUG 1 regression: the check passed all three cycles, but the FULL compile NEVER
    // fired because the behavioural tests never went green (D35/FR-029).
    expect(checker.calls).toHaveLength(3);
    expect(fullCompiler.calls).toHaveLength(0);
    // Settled once at actual (D34, no credit-back).
    expect(ledger.calls.settle).toEqual([{ address: ADDRESS, turnId: "turn-1", amount: 100n }]);
    expect(eventsOfType(sent, "turn:settled")).toHaveLength(1);
    // Honest failure summary surfaced (WIP kept + next prompt) — nothing done.
    const exhaustedMessage = eventsOfType(sent, "turn:message").some(
      (event) =>
        event.type === "turn:message" && /work in progress|kept|next/i.test(event.payload.delta),
    );
    expect(exhaustedMessage).toBe(true);
    const assistantDone = eventsOfType(sent, "turn:message").some(
      (event) => event.type === "turn:message" && event.payload.role === "assistant",
    );
    expect(assistantDone).toBe(false);
  });
});

describe("Supervisor — compile-before-surface: a check failure counts as a cycle", () => {
  it("feeds diagnostics forward, then greens on the next cycle", async () => {
    const { ctx } = makeCtx();
    const ledger = makeLedger();
    const subAgents = makeSubAgents(10n);
    // Cycle 1 check fails; cycle 2 check passes → tests green.
    const checker = makeCheckCompiler([CHECK_FAILED, CHECK_OK]);
    const fullCompiler = makeFullCompiler(READY_OUTCOME);
    const seenDiagnostics: number[] = [];
    const recordingSubAgents: SubAgents = {
      scaffolding: (cycleCtx) => subAgents.subAgents.scaffolding(cycleCtx),
      planning: (cycleCtx) => {
        seenDiagnostics.push(cycleCtx.compileDiagnostics.length);
        return subAgents.subAgents.planning(cycleCtx);
      },
      implementation: (cycleCtx) => subAgents.subAgents.implementation(cycleCtx),
      review: (cycleCtx) => subAgents.subAgents.review(cycleCtx),
    };
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        subAgents: recordingSubAgents,
        checkCompile: checker.checkCompile,
        runFullCompile: fullCompiler.runFullCompile,
        // Only reached on cycle 2 (cycle 1 fails the check before tests run).
        awaitTestResults: makeTestResults([{ pass: true }]),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("green");
    if (result.kind === "green") {
      expect(result.cycles).toBe(2);
    }
    // Cycle 1 saw no prior diagnostics; cycle 2 received the check-failure diagnostics.
    expect(seenDiagnostics[0]).toBe(0);
    expect(seenDiagnostics[1]).toBe(1);
    // BUG 1 regression: a failed CHECK is never done work — the FULL compile fired only
    // once (on cycle 2's green suite), never on the cycle-1 check failure.
    expect(checker.calls).toHaveLength(2);
    expect(fullCompiler.calls).toHaveLength(1);
  });
});

describe("Supervisor — scenario 5: a thrown infra fault fails loudly but still settles", () => {
  it("retries with backoff, names the service, and settles at actual", async () => {
    const { ctx, sent } = makeCtx();
    const ledger = makeLedger();
    const subAgents = makeSubAgents(10n);
    // The per-cycle CHECK is the transport that faults (a throw → the infra path).
    const checker = makeCheckCompiler(["throw"]);
    const fullCompiler = makeFullCompiler(READY_OUTCOME);
    const delays: number[] = [];
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        subAgents: subAgents.subAgents,
        checkCompile: checker.checkCompile,
        runFullCompile: fullCompiler.runFullCompile,
        maxInfraRetries: 2,
        retryDelay: (attempt) => {
          delays.push(attempt);
          return Promise.resolve();
        },
      }),
    );

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("infra-failed");
    if (result.kind === "infra-failed") {
      // Sub-agents ran (cold-start cycle 1 = 4 agents × 10) before the compile threw.
      expect(result.consumed).toBe(40n);
      expect(result.service.length).toBeGreaterThan(0);
      // The verify-loop infra path settles at actual, so it ALREADY emitted turn:settled.
      expect(result.settled).toBe(true);
    }
    // 1 initial attempt + 2 retries = 3 CHECK calls; 2 backoff delays. The FULL
    // compile is never reached (the cycle never cleared its check).
    expect(checker.calls).toHaveLength(3);
    expect(fullCompiler.calls).toHaveLength(0);
    expect(delays).toEqual([0, 1]);
    // Still settles (D34).
    expect(ledger.calls.settle).toEqual([{ address: ADDRESS, turnId: "turn-1", amount: 40n }]);
    expect(eventsOfType(sent, "turn:settled")).toHaveLength(1);
    // The failure was surfaced loudly.
    expect(eventsOfType(sent, "turn:message")).not.toHaveLength(0);
  });
});

describe("Supervisor — token accounting: settle receives the summed consumption", () => {
  it("sums sub-agent tokens across multiple cycles", async () => {
    const { ctx } = makeCtx();
    const ledger = makeLedger();
    const subAgents = makeSubAgents(7n);
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        subAgents: subAgents.subAgents,
        // Check passes each cycle (the default full compile handles the green trigger).
        checkCompile: makeCheckCompiler([CHECK_OK]).checkCompile,
        // fail, then green → 2 cycles: cycle1 (4 agents) + cycle2 (3 agents) = 7 agents × 7.
        awaitTestResults: makeTestResults([
          { pass: false, failures: [{ name: "x", message: "y" }] },
          { pass: true },
        ]),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("green");
    expect(ledger.calls.settle).toEqual([{ address: ADDRESS, turnId: "turn-1", amount: 49n }]);
  });
});

describe("Supervisor — FR-003: scaffolding runs only on a cold-start turn", () => {
  it("skips scaffolding when the project already has chat history", async () => {
    const { ctx } = makeCtx();
    const subAgents = makeSubAgents(10n);
    const supervisor = createSupervisor(
      makeDeps({
        // A warm project: prior chat exists, so this is not the first turn.
        chat: makeChat([{ projectId: PROJECT, role: "user", content: "earlier prompt" }]).chat,
        subAgents: subAgents.subAgents,
        awaitTestResults: makeTestResults([{ pass: true }]),
      }),
    );

    const result = await supervisor.handlePrompt(ctx, { projectId: PROJECT, text: "add a reset" });

    expect(result.kind).toBe("green");
    // Warm project → no scaffolding agent runs; only planning/implementation/review.
    expect(subAgents.calls.some((call) => call.role === "scaffolding")).toBe(false);
    expect(subAgents.calls.map((call) => call.role)).toEqual([
      "planning",
      "implementation",
      "review",
    ]);
  });
});

describe("Supervisor — determinism: injected now flows onto every emitted frame", () => {
  it("stamps every event with the injected clock (no wall-clock)", async () => {
    const { ctx, sent } = makeCtx();
    const supervisor = createSupervisor(makeDeps({}));

    await supervisor.handlePrompt(ctx, { projectId: PROJECT, text: "build a counter" });

    expect(sent.length).toBeGreaterThan(0);
    for (const event of sent) {
      expect(event.ts).toBe(FIXED_TS);
    }
    // The encoded turn:settled round-trips through JSON with string money.
    const settled = eventsOfType(sent, "turn:settled")[0];
    if (settled?.type !== "turn:settled") {
      throw new Error("expected a turn:settled event");
    }
    const reEncoded = JSON.parse(JSON.stringify(settled)) as { payload: { consumed: unknown } };
    expect(typeof reEncoded.payload.consumed).toBe("string");
    // The encoder is idempotent on the encoded frame's numeric shape.
    void encodeTurnSettledEvent;
  });
});

describe("Supervisor — BUG2: a reserve-time infra fault never settles (settled:false)", () => {
  it("returns infra-failed{settled:false}, reserves once, and settles nothing", async () => {
    const { ctx, sent } = makeCtx();
    // placeReserve faults with a NON-InsufficientAvailableError — the turn is still
    // `classifying`, so no reserve landed and settling would be invalid.
    const ledger = makeLedger({ reserveError: new Error("ledger transport down") });
    const supervisor = createSupervisor(makeDeps({ ledger: ledger.ledger }));

    const result = await supervisor.handlePrompt(ctx, {
      projectId: PROJECT,
      text: "build a counter",
    });

    expect(result.kind).toBe("infra-failed");
    if (result.kind === "infra-failed") {
      // The distinguishing flag: nothing was reserved/settled, so the COORDINATOR must
      // synthesize the terminal unlock (else the client's input locks forever).
      expect(result.settled).toBe(false);
      expect(result.consumed).toBe(0n);
      expect(result.cycles).toBe(0);
    }
    expect(ledger.calls.placeReserve).toHaveLength(1);
    // No settle — the reserve never landed (no double-charge, no stuck settlement).
    expect(ledger.calls.settle).toHaveLength(0);
    // The supervisor itself emitted NO turn:settled for this never-settled outcome.
    expect(eventsOfType(sent, "turn:settled")).toHaveLength(0);
  });
});

describe("Supervisor — BUG2: a persistent settle fault retries then propagates (stuck-reserve residual)", () => {
  it("retries settle within the infra budget, then rejects so the coordinator backstop unlocks", async () => {
    const { ctx } = makeCtx();
    // Every settle attempt faults (a persistent ledger/DB outage at settle time).
    const ledger = makeLedger({ settleError: new Error("settle write failed") });
    const delays: number[] = [];
    const supervisor = createSupervisor(
      makeDeps({
        ledger: ledger.ledger,
        maxInfraRetries: 2,
        retryDelay: (attempt) => {
          delays.push(attempt);
          return Promise.resolve();
        },
      }),
    );

    // The green turn reaches settle, which faults on every retry → the fault propagates OUT
    // of handlePrompt (past the verify-loop's InfraFailureError catch) to the coordinator
    // backstop. ⚠️ Residual: the reserve is left stranded `reserved` for a later reconcile.
    await expect(
      supervisor.handlePrompt(ctx, { projectId: PROJECT, text: "build a counter" }),
    ).rejects.toThrow(/settle failed/i);

    // 1 initial settle + 2 retries = 3 attempts; 2 backoff delays (deterministic).
    expect(ledger.calls.settle).toHaveLength(3);
    expect(delays).toEqual([0, 1]);
  });
});
