/**
 * Chat presentational surface (US1, T143, D20/D23/D24/D25).
 *
 * A pure composition over a {@link TurnState}: the persistent tab-alive
 * indicator (FR-006), the read-only balance (FR-070), the message stream with
 * its interrupted-turn recovery notice (D20/D23), the collapsible per-sub-agent
 * activity feed (D20), and the prompt input (locked per D24). All side effects
 * arrive as the single `onSubmit` callback, so the view renders deterministically
 * off props with no bridge and no hook.
 */
import { Info } from "lucide-react";

import { ActivityFeed } from "./ActivityFeed";
import { BalanceDisplay } from "./BalanceDisplay";
import { MessageList } from "./MessageList";
import { PromptInput } from "./PromptInput";
import { TabAliveIndicator } from "./TabAliveIndicator";
import type { TurnState } from "./types";

export interface ChatViewProps {
  readonly state: TurnState;
  /** Report a submitted prompt (the container sends `prompt:submit`). */
  readonly onSubmit: (text: string) => void;
}

export function ChatView({ state, onSubmit }: ChatViewProps) {
  return (
    <div data-testid="chat" className="flex h-full flex-col gap-3">
      <TabAliveIndicator />
      <BalanceDisplay balance={state.balance} />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <MessageList messages={state.messages} />

        {state.recovery !== undefined ? (
          <div
            role="status"
            data-testid="chat-recovery"
            className="flex gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
          >
            <Info className="text-primary size-4 shrink-0" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium">Recovering your last session</p>
              <p className="text-muted-foreground">{state.recovery.message}</p>
              <p className="text-muted-foreground">
                Interrupted prompt:{" "}
                <span className="text-foreground italic">“{state.recovery.lostPromptContent}”</span>
              </p>
            </div>
          </div>
        ) : null}

        <ActivityFeed groups={state.activity} cyclesCompleted={state.cyclesCompleted} />
      </div>

      <PromptInput disabled={state.inputDisabled} onSubmit={onSubmit} />
    </div>
  );
}
