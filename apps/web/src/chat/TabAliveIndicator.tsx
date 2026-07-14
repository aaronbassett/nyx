/**
 * Persistent tab-alive indicator (US1, T143, D20/FR-006).
 *
 * The preview and tests run inside THIS browser tab (R6 — never a server-side
 * runner), so closing it interrupts the active turn. This banner is always
 * present, independent of turn phase.
 */
import { Radio } from "lucide-react";

export function TabAliveIndicator() {
  return (
    <div
      role="status"
      data-testid="chat-tab-alive"
      className="text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs"
    >
      <Radio className="text-primary size-4 shrink-0" aria-hidden="true" />
      <span>
        Your preview and tests run in this tab. Keep it open — closing it interrupts the current
        turn.
      </span>
    </div>
  );
}
