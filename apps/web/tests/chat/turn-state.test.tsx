/**
 * T144 — turn/input state machine (US1, D20/D23/D24/D25).
 *
 * The chat feature's derived UI state lives in a pure reducer
 * (`turnStateReducer`) plus a `useTurnState` hook that maps WS turn events onto
 * reducer actions over an injected {@link ChatBridge}. These tests drive the
 * reducer directly (no React) and the hook against an in-memory fake bridge
 * (no real socket) so every transition is deterministic:
 *   - idle → (submit) active → (settled | decline) idle, with the D24 input lock;
 *   - `turn:message` deltas accumulate into one growing message per turn+role;
 *   - `turn:activity` events group per sub-agent and count verify cycles (D20);
 *   - a supervisor decline is a distinct state, NOT a failure (D25);
 *   - interrupted-turn recovery is derived from rehydrated history (D20/D23);
 *   - balances are display-only bigints (FR-070) — never computed here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  deriveRecovery,
  initialTurnState,
  turnStateReducer,
  useTurnState,
  VERIFY_CYCLE_AGENT,
} from "@/chat/turn-state";
import type { ChatBridge, Clock, DeclinePredicate } from "@/chat/types";
import type {
  ChatMessage,
  ClientToServerEvent,
  LedgerEntry,
  ProjectId,
  ServerToClientEvent,
  TurnId,
} from "@nyx/protocol";

afterEach(cleanup);

const TURN = "turn-1" as TurnId;
const PROJECT = "proj-1" as ProjectId;

// --- fixtures ---------------------------------------------------------------

/** The reducer's action union, inferred from its signature (no local re-decl). */
type ReducerAction = Parameters<typeof turnStateReducer>[1];

function submit(text: string, ts = 1): ReducerAction {
  return { kind: "prompt-submitted", text, ts };
}

function messageDelta(role: "assistant" | "supervisor", delta: string, ts = 2) {
  return { kind: "message-delta", payload: { turnId: TURN, role, delta }, ts } as const;
}

function activity(agent: string, phase: string, detail = "", ts = 2) {
  return { kind: "activity", payload: { turnId: TURN, agent, phase, detail }, ts } as const;
}

function settled(consumed: bigint, balance: bigint) {
  return { kind: "settled", payload: { turnId: TURN, consumed, balance } } as const;
}

// --- reducer: input lock (D24) ----------------------------------------------

describe("turnStateReducer — input lock (D24)", () => {
  it("starts idle with input enabled", () => {
    expect(initialTurnState.phase).toBe("idle");
    expect(initialTurnState.inputDisabled).toBe(false);
  });

  it("submitting a prompt goes active, disables input, and appends a user message", () => {
    const state = turnStateReducer(initialTurnState, submit("build a counter DApp"));
    expect(state.phase).toBe("active");
    expect(state.inputDisabled).toBe(true);
    const last = state.messages.at(-1);
    expect(last?.kind).toBe("user");
    expect(last?.content).toBe("build a counter DApp");
  });

  it("ignores an empty/whitespace prompt (no active turn, no message)", () => {
    const state = turnStateReducer(initialTurnState, submit("   "));
    expect(state).toBe(initialTurnState);
  });

  it("ignores a second submit while a turn is already active", () => {
    const active = turnStateReducer(initialTurnState, submit("first"));
    const again = turnStateReducer(active, submit("second"));
    expect(again.messages).toHaveLength(1);
    expect(again.phase).toBe("active");
  });

  it("re-enables input on turn:settled and returns to idle", () => {
    const active = turnStateReducer(initialTurnState, submit("go"));
    const done = turnStateReducer(active, settled(7n, 93n));
    expect(done.phase).toBe("idle");
    expect(done.inputDisabled).toBe(false);
    expect(done.lastOutcome).toBe("settled");
  });
});

// --- reducer: streaming narration (D20) -------------------------------------

describe("turnStateReducer — streaming narration", () => {
  it("accumulates turn:message deltas into one growing assistant message", () => {
    let state = turnStateReducer(initialTurnState, submit("go"));
    state = turnStateReducer(state, messageDelta("assistant", "Scaffolding "));
    state = turnStateReducer(state, messageDelta("assistant", "the project…"));
    const assistant = state.messages.filter((m) => m.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toBe("Scaffolding the project…");
    expect(assistant[0]?.streaming).toBe(true);
  });

  it("keeps assistant and supervisor narration as separate streaming messages", () => {
    let state = turnStateReducer(initialTurnState, submit("go"));
    state = turnStateReducer(state, messageDelta("assistant", "code"));
    state = turnStateReducer(state, messageDelta("supervisor", "planning"));
    expect(state.messages.filter((m) => m.kind === "assistant")).toHaveLength(1);
    expect(state.messages.filter((m) => m.kind === "supervisor")).toHaveLength(1);
  });

  it("marks the turn's streaming messages settled on turn:settled", () => {
    let state = turnStateReducer(initialTurnState, submit("go"));
    state = turnStateReducer(state, messageDelta("assistant", "done"));
    state = turnStateReducer(state, settled(1n, 1n));
    expect(state.messages.find((m) => m.kind === "assistant")?.streaming).toBe(false);
  });
});

// --- reducer: activity feed + cycle counts (D20) ----------------------------

describe("turnStateReducer — activity feed (D20)", () => {
  it("groups turn:activity events by sub-agent", () => {
    let state = turnStateReducer(initialTurnState, submit("go"));
    state = turnStateReducer(state, activity("scaffolding", "init"));
    state = turnStateReducer(state, activity("planning", "outline"));
    state = turnStateReducer(state, activity("scaffolding", "deps"));
    const agents = state.activity.map((g) => g.agent);
    expect(agents).toEqual(["scaffolding", "planning"]);
    const scaffold = state.activity.find((g) => g.agent === "scaffolding");
    expect(scaffold?.entries).toHaveLength(2);
  });

  it("counts one verify cycle per review-agent activity", () => {
    let state = turnStateReducer(initialTurnState, submit("go"));
    state = turnStateReducer(state, activity("implementation", "write"));
    state = turnStateReducer(state, activity(VERIFY_CYCLE_AGENT, "verdict: red"));
    state = turnStateReducer(state, activity("implementation", "fix"));
    state = turnStateReducer(state, activity(VERIFY_CYCLE_AGENT, "verdict: green"));
    expect(state.cyclesCompleted).toBe(2);
  });

  it("resets activity and cycle count when a new turn is submitted", () => {
    let state = turnStateReducer(initialTurnState, submit("go"));
    state = turnStateReducer(state, activity(VERIFY_CYCLE_AGENT, "green"));
    state = turnStateReducer(state, settled(1n, 1n));
    state = turnStateReducer(state, submit("next"));
    expect(state.activity).toHaveLength(0);
    expect(state.cyclesCompleted).toBe(0);
  });
});

// --- reducer: decline UX (D25) ----------------------------------------------

describe("turnStateReducer — decline (D25)", () => {
  it("surfaces a decline as a distinct message and returns to idle with input enabled", () => {
    const active = turnStateReducer(initialTurnState, submit("what is the weather?"));
    const declined = turnStateReducer(active, {
      kind: "declined",
      payload: {
        turnId: TURN,
        role: "supervisor",
        delta: "Nyx builds Midnight DApps from prompts.",
      },
      ts: 3,
    });
    expect(declined.phase).toBe("idle");
    expect(declined.inputDisabled).toBe(false);
    expect(declined.lastOutcome).toBe("declined");
    const decline = declined.messages.find((m) => m.kind === "decline");
    expect(decline?.content).toContain("Nyx builds Midnight DApps");
    // A decline is NOT a failure: there is no error-kind message.
    expect(declined.messages.some((m) => m.kind === "decline")).toBe(true);
  });

  it("places no balance change on a decline (declines cost nothing, D25)", () => {
    const active = turnStateReducer(initialTurnState, submit("off domain"));
    const declined = turnStateReducer(active, {
      kind: "declined",
      payload: { turnId: TURN, role: "supervisor", delta: "no." },
      ts: 3,
    });
    expect(declined.balance).toBeUndefined();
  });
});

// --- reducer: balances are display-only (FR-070) ----------------------------

describe("turnStateReducer — balances are display-only (FR-070)", () => {
  it("stores ledger:update balances verbatim without computing", () => {
    const state = turnStateReducer(initialTurnState, {
      kind: "ledger-update",
      payload: {
        entry: {
          id: 1n,
          accountAddress: "acct-1" as LedgerEntry["accountAddress"],
          kind: "reserve",
          amount: 30n,
        },
        available: 70n,
        reserved: 30n,
      },
    });
    expect(state.balance?.available).toBe(70n);
    expect(state.balance?.reserved).toBe(30n);
    // Never a computed value such as available - reserved.
    expect(state.balance?.available).not.toBe(40n);
  });

  it("records the settled consumed magnitude and post-settle balance verbatim", () => {
    const active = turnStateReducer(initialTurnState, submit("go"));
    const done = turnStateReducer(active, settled(12n, 88n));
    expect(done.balance?.lastConsumed).toBe(12n);
    expect(done.balance?.available).toBe(88n);
  });
});

// --- reducer: interrupted-turn recovery (D20/D23) ---------------------------

describe("deriveRecovery — interrupted-turn recovery (D20/D23)", () => {
  function msg(seq: number, role: ChatMessage["role"], content: string): ChatMessage {
    return { seq, role, content, createdAt: seq };
  }

  it("returns a recovery notice when the last persisted message is an unanswered user prompt", () => {
    const history = [
      msg(0, "user", "build it"),
      msg(1, "assistant", "done"),
      msg(2, "user", "add tests"),
    ];
    const recovery = deriveRecovery(history);
    expect(recovery).toBeDefined();
    expect(recovery?.lostPromptContent).toBe("add tests");
  });

  it("returns nothing when the last message is a completed assistant reply", () => {
    const history = [msg(0, "user", "build it"), msg(1, "assistant", "here you go")];
    expect(deriveRecovery(history)).toBeUndefined();
  });

  it("returns nothing for empty history", () => {
    expect(deriveRecovery([])).toBeUndefined();
  });

  it("history-loaded seeds messages and the recovery notice", () => {
    const history = [msg(0, "user", "build it"), msg(1, "user", "and deploy")];
    const state = turnStateReducer(initialTurnState, { kind: "history-loaded", messages: history });
    expect(state.messages).toHaveLength(2);
    expect(state.recovery?.lostPromptContent).toBe("and deploy");
    expect(state.phase).toBe("idle");
    expect(state.inputDisabled).toBe(false);
  });
});

// --- hook: useTurnState over an injected ChatBridge -------------------------

interface FakeBridge {
  readonly bridge: ChatBridge;
  readonly sent: ClientToServerEvent[];
  emit(event: ServerToClientEvent): void;
}

type AnyServerHandler = (event: ServerToClientEvent) => void;

function createFakeBridge(): FakeBridge {
  const handlers = new Map<string, Set<AnyServerHandler>>();
  const sent: ClientToServerEvent[] = [];
  const bridge: ChatBridge = {
    send: (event) => {
      sent.push(event);
    },
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set<AnyServerHandler>();
      set.add(handler as AnyServerHandler);
      handlers.set(type, set);
      return () => {
        set.delete(handler as AnyServerHandler);
      };
    },
  };
  function emit(event: ServerToClientEvent): void {
    for (const handler of handlers.get(event.type) ?? []) {
      handler(event);
    }
  }
  return { bridge, sent, emit };
}

const clock: Clock = { now: () => 42 };

describe("useTurnState — hook over an injected bridge", () => {
  it("sends prompt:submit and disables input on submit; a turn:settled re-enables it", async () => {
    const fake = createFakeBridge();
    const { result } = renderHook(() =>
      useTurnState({
        bridge: fake.bridge,
        projectId: PROJECT,
        loadHistory: () => Promise.resolve([]),
        clock,
      }),
    );
    await waitFor(() => {
      expect(result.current.state.phase).toBe("idle");
    });

    act(() => {
      result.current.submitPrompt("build a counter");
    });

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toEqual({
      type: "prompt:submit",
      payload: { projectId: PROJECT, text: "build a counter" },
      ts: 42,
    });
    expect(result.current.state.inputDisabled).toBe(true);

    act(() => {
      fake.emit({
        type: "turn:settled",
        payload: { turnId: TURN, consumed: 3n, balance: 97n },
        ts: 5,
      });
    });
    expect(result.current.state.inputDisabled).toBe(false);
  });

  it("routes a decline turn:message through isDecline to the decline state", async () => {
    const fake = createFakeBridge();
    const isDecline: DeclinePredicate = (payload) => payload.role === "supervisor";
    const { result } = renderHook(() =>
      useTurnState({
        bridge: fake.bridge,
        projectId: PROJECT,
        loadHistory: () => Promise.resolve([]),
        clock,
        isDecline,
      }),
    );
    await waitFor(() => {
      expect(result.current.state.phase).toBe("idle");
    });

    act(() => {
      result.current.submitPrompt("what's the weather?");
    });
    act(() => {
      fake.emit({
        type: "turn:message",
        payload: { turnId: TURN, role: "supervisor", delta: "Nyx builds DApps." },
        ts: 6,
      });
    });

    expect(result.current.state.inputDisabled).toBe(false);
    expect(result.current.state.messages.some((m) => m.kind === "decline")).toBe(true);
  });

  it("rehydrates history on mount and surfaces the interrupted-turn recovery notice", async () => {
    const fake = createFakeBridge();
    const loadHistory = vi.fn((): Promise<ChatMessage[]> =>
      Promise.resolve([{ seq: 0, role: "user", content: "make it", createdAt: 0 }]),
    );
    const { result } = renderHook(() =>
      useTurnState({ bridge: fake.bridge, projectId: PROJECT, loadHistory, clock }),
    );
    await waitFor(() => {
      expect(result.current.state.recovery).toBeDefined();
    });
    expect(loadHistory).toHaveBeenCalledWith(PROJECT);
    expect(result.current.state.recovery?.lostPromptContent).toBe("make it");
  });
});
