/**
 * Chat container (US1, T143/T144, D20/D23/D24/D25).
 *
 * Binds the {@link useTurnState} state machine to the pure {@link ChatView}.
 * This is the only chat module that holds live wiring: it is handed the WS
 * {@link ChatBridge} (a live `PreviewBridge` in the app, a fake in tests), the
 * {@link LoadHistory} rehydration seam, and the optional clock / decline
 * classifier — all injectable so the whole feature unit-tests with no socket and
 * no network.
 */
import { useTurnState } from "./turn-state";
import { ChatView } from "./ChatView";
import type { ChatBridge, Clock, DeclinePredicate, LoadHistory } from "./types";
import type { ProjectId } from "@nyx/protocol";

export interface ChatProps {
  /** The WS bridge (send `prompt:submit`, subscribe to turn events). */
  readonly bridge: ChatBridge;
  /** The project this chat belongs to. */
  readonly projectId: ProjectId;
  /** Rehydrate persisted chat history on mount (D23). */
  readonly loadHistory: LoadHistory;
  /** Timestamp source; defaults to `Date.now`. */
  readonly clock?: Clock | undefined;
  /** Off-domain decline classifier (D25); defaults to never. */
  readonly isDecline?: DeclinePredicate | undefined;
}

export function Chat({ bridge, projectId, loadHistory, clock, isDecline }: ChatProps) {
  const { state, submitPrompt } = useTurnState({
    bridge,
    projectId,
    loadHistory,
    clock,
    isDecline,
  });
  return <ChatView state={state} onSubmit={submitPrompt} />;
}
