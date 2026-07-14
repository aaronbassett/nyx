/**
 * Turn/input state machine (US1, T144, D20/D23/D24/D25).
 *
 * `turnStateReducer` is a pure fold over the semantic turn-event stream
 * ({@link ChatAction}); `useTurnState` wires it to an injected {@link ChatBridge}
 * and {@link LoadHistory}, translating live WS turn events into actions. Keeping
 * the reducer pure makes every transition deterministic and unit-testable with
 * no React, and keeps the container thin.
 *
 * Lifecycle (there is no explicit "turn:started" event, D62): a turn becomes
 * `active` when the user submits and returns to `idle` on `turn:settled` OR a
 * decline. While active, chat input is locked (D24, `inputDisabled`). A decline
 * (D25) is a distinct, non-failure state; interrupted-turn recovery (D20/D23) is
 * derived from rehydrated history.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";

import type { PromptSubmitEvent } from "@nyx/protocol";

import type {
  AgentActivityGroup,
  ChatAction,
  ChatBridge,
  Clock,
  DeclinePredicate,
  DisplayMessage,
  LoadHistory,
  RecoveryNotice,
  TurnState,
  Unsubscribe,
} from "./types";
import type { ChatMessage, ProjectId } from "@nyx/protocol";

/**
 * The sub-agent whose activity marks the end of one verify cycle (D20/D21).
 * Each verify cycle (check-compile → write → simulate → verdict) closes with a
 * `review` activity, so cycles are counted from this agent's events.
 */
export const VERIFY_CYCLE_AGENT = "review";

/** The idle starting state: input enabled, nothing streamed yet. */
export const initialTurnState: TurnState = {
  phase: "idle",
  inputDisabled: false,
  activeTurnId: undefined,
  messages: [],
  activity: [],
  cyclesCompleted: 0,
  balance: undefined,
  recovery: undefined,
  lastOutcome: undefined,
  seq: 0,
};

/**
 * Derive an interrupted-turn recovery notice from rehydrated history (D20/D23).
 * A turn was in flight when the tab closed iff the last persisted message is an
 * unanswered user prompt — a completed turn always ends with assistant or
 * supervisor narration. Returns the notice, or `undefined` when nothing was lost.
 */
export function deriveRecovery(messages: readonly ChatMessage[]): RecoveryNotice | undefined {
  const last = messages.at(-1);
  if (last === undefined) {
    return undefined;
  }
  if (last.role !== "user") {
    return undefined;
  }
  return {
    lostPromptContent: last.content,
    message:
      "This tab closed while Nyx was still working on your last request, so that turn's " +
      "result was lost. Nothing was left half-applied — re-send the prompt to continue.",
  };
}

/** Map a persisted {@link ChatMessage} to a rendered row. */
function historyRow(message: ChatMessage): DisplayMessage {
  return {
    id: `history:${message.seq.toString()}`,
    kind: message.role,
    content: message.content,
    turnId: message.turnId,
    streaming: false,
    ts: message.createdAt,
  };
}

/** Append `delta` to the row matching `id`, or start a new row when absent. */
function accumulateRow(
  messages: readonly DisplayMessage[],
  id: string,
  delta: string,
  seed: () => DisplayMessage,
): readonly DisplayMessage[] {
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) {
    return [...messages, seed()];
  }
  const existing = messages[index];
  if (existing === undefined) {
    return messages;
  }
  const next = [...messages];
  next[index] = { ...existing, content: existing.content + delta };
  return next;
}

/** Pure reducer: fold one semantic turn-event onto the derived chat state. */
export function turnStateReducer(state: TurnState, action: ChatAction): TurnState {
  switch (action.kind) {
    case "history-loaded": {
      const messages = action.messages.map(historyRow);
      const maxSeq = action.messages.reduce((max, message) => Math.max(max, message.seq), -1);
      return {
        ...initialTurnState,
        messages,
        recovery: deriveRecovery(action.messages),
        seq: maxSeq + 1,
      };
    }

    case "prompt-submitted": {
      const trimmed = action.text.trim();
      if (trimmed.length === 0 || state.phase === "active") {
        return state;
      }
      const message: DisplayMessage = {
        id: `user:${state.seq.toString()}`,
        kind: "user",
        content: trimmed,
        turnId: undefined,
        streaming: false,
        ts: action.ts,
      };
      return {
        ...state,
        phase: "active",
        inputDisabled: true,
        activeTurnId: undefined,
        messages: [...state.messages, message],
        activity: [],
        cyclesCompleted: 0,
        recovery: undefined,
        lastOutcome: undefined,
        seq: state.seq + 1,
      };
    }

    case "message-delta": {
      const { turnId, role, delta } = action.payload;
      const id = `stream:${turnId}:${role}`;
      const messages = accumulateRow(state.messages, id, delta, () => ({
        id,
        kind: role,
        content: delta,
        turnId,
        streaming: true,
        ts: action.ts,
      }));
      return { ...state, activeTurnId: turnId, messages };
    }

    case "activity": {
      const { turnId, agent, phase, detail } = action.payload;
      const entry = { phase, detail, ts: action.ts };
      const index = state.activity.findIndex((group) => group.agent === agent);
      let activity: readonly AgentActivityGroup[];
      if (index === -1) {
        activity = [...state.activity, { agent, entries: [entry] }];
      } else {
        const group = state.activity[index];
        const next = [...state.activity];
        if (group !== undefined) {
          next[index] = { agent, entries: [...group.entries, entry] };
        }
        activity = next;
      }
      const cyclesCompleted =
        agent === VERIFY_CYCLE_AGENT ? state.cyclesCompleted + 1 : state.cyclesCompleted;
      return { ...state, activeTurnId: turnId, activity, cyclesCompleted };
    }

    case "settled": {
      const { turnId, consumed, balance } = action.payload;
      const messages = state.messages.map((message) =>
        message.turnId === turnId && message.streaming ? { ...message, streaming: false } : message,
      );
      return {
        ...state,
        phase: "idle",
        inputDisabled: false,
        activeTurnId: undefined,
        messages,
        balance: {
          available: balance,
          reserved: state.balance?.reserved ?? 0n,
          lastConsumed: consumed,
        },
        lastOutcome: "settled",
      };
    }

    case "declined": {
      const { turnId, delta } = action.payload;
      const id = `decline:${turnId}`;
      const messages = accumulateRow(state.messages, id, delta, () => ({
        id,
        kind: "decline",
        content: delta,
        turnId,
        streaming: false,
        ts: action.ts,
      }));
      return {
        ...state,
        phase: "idle",
        inputDisabled: false,
        activeTurnId: undefined,
        messages,
        lastOutcome: "declined",
      };
    }

    case "ledger-update": {
      const { available, reserved } = action.payload;
      return {
        ...state,
        balance: {
          available,
          reserved,
          lastConsumed: state.balance?.lastConsumed,
        },
      };
    }
  }
}

const defaultClock: Clock = { now: () => Date.now() };
const neverDecline: DeclinePredicate = () => false;

/** Options for {@link useTurnState}. */
export interface UseTurnStateOptions {
  /** The WS bridge (a live `PreviewBridge` or an in-memory fake). */
  readonly bridge: ChatBridge;
  /** The project this chat belongs to (`prompt:submit` target). */
  readonly projectId: ProjectId;
  /** Rehydrate persisted history on mount (D23). */
  readonly loadHistory: LoadHistory;
  /** Timestamp source; defaults to `Date.now`. */
  readonly clock?: Clock | undefined;
  /** Off-domain decline classifier (D25); defaults to never (see module doc). */
  readonly isDecline?: DeclinePredicate | undefined;
}

/** The chat surface exposed to the container. */
export interface UseTurnState {
  readonly state: TurnState;
  /** Send `prompt:submit` and lock input; a no-op while a turn is active. */
  readonly submitPrompt: (text: string) => void;
}

/**
 * Wire {@link turnStateReducer} to a live turn stream: subscribe to the four
 * server → client turn events, rehydrate history on mount, and expose a guarded
 * `submitPrompt` that emits `prompt:submit` (D62 entry point) and locks input.
 */
export function useTurnState(options: UseTurnStateOptions): UseTurnState {
  const { bridge, projectId, loadHistory } = options;
  const clock = options.clock ?? defaultClock;
  const isDecline = options.isDecline ?? neverDecline;

  const [state, dispatch] = useReducer(turnStateReducer, initialTurnState);

  // Latest phase for the submit guard, without re-creating the callback.
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  useEffect(() => {
    let cancelled = false;
    const unsubscribers: Unsubscribe[] = [
      bridge.on("turn:message", (event) => {
        if (isDecline(event.payload)) {
          dispatch({ kind: "declined", payload: event.payload, ts: event.ts });
        } else {
          dispatch({ kind: "message-delta", payload: event.payload, ts: event.ts });
        }
      }),
      bridge.on("turn:activity", (event) => {
        dispatch({ kind: "activity", payload: event.payload, ts: event.ts });
      }),
      bridge.on("turn:settled", (event) => {
        dispatch({ kind: "settled", payload: event.payload });
      }),
      bridge.on("ledger:update", (event) => {
        dispatch({ kind: "ledger-update", payload: event.payload });
      }),
    ];

    loadHistory(projectId)
      .then((messages) => {
        if (!cancelled) {
          dispatch({ kind: "history-loaded", messages });
        }
      })
      .catch(() => {
        // History rehydration failed: leave the stream empty rather than crash
        // the chat. A dedicated retry/notice is a later concern.
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [bridge, projectId, loadHistory, isDecline]);

  const submitPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || phaseRef.current === "active") {
        return;
      }
      const ts = clock.now();
      const event: PromptSubmitEvent = {
        type: "prompt:submit",
        payload: { projectId, text: trimmed },
        ts,
      };
      bridge.send(event);
      dispatch({ kind: "prompt-submitted", text: trimmed, ts });
    },
    [bridge, projectId, clock],
  );

  return { state, submitPrompt };
}
