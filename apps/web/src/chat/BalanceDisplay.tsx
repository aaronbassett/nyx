/**
 * Read-only NYXT balance display (US1, T143, FR-070).
 *
 * Renders the server-derived {@link BalanceView} bigints verbatim as strings.
 * These are DISPLAY-only: the client never computes a balance (e.g. never
 * derives `available - reserved`) — every figure comes straight from the server
 * via `ledger:update` / `turn:settled`. Renders nothing before any balance
 * arrives.
 */
import { Wallet } from "lucide-react";

import type { BalanceView } from "./types";

export interface BalanceDisplayProps {
  readonly balance: BalanceView | undefined;
}

export function BalanceDisplay({ balance }: BalanceDisplayProps) {
  if (balance === undefined) {
    return null;
  }
  return (
    <div
      data-testid="chat-balance"
      className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-xs"
    >
      <Wallet className="size-4 shrink-0" aria-hidden="true" />
      <span>
        Available{" "}
        <span
          data-testid="chat-balance-available"
          className="text-foreground font-mono font-medium"
        >
          {balance.available.toString()}
        </span>{" "}
        NYXT
      </span>
      <span>
        Reserved{" "}
        <span data-testid="chat-balance-reserved" className="text-foreground font-mono font-medium">
          {balance.reserved.toString()}
        </span>
      </span>
      {balance.lastConsumed !== undefined ? (
        <span>
          Last turn{" "}
          <span
            data-testid="chat-balance-consumed"
            className="text-foreground font-mono font-medium"
          >
            {balance.lastConsumed.toString()}
          </span>
        </span>
      ) : null}
    </div>
  );
}
