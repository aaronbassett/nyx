/**
 * The once-per-session low-balance nudge banner (US12, FR-073).
 *
 * Purely presentational: it renders when `visible` is `true` and nothing
 * otherwise. The "at most once per session" latch lives in the ledger reducer
 * ({@link useLedger}) — this component only reflects the current `visible` flag
 * and forwards the dismiss / top-up intents. The threshold is shown verbatim
 * (server/config figure) so the copy is honest about what "low" means.
 */
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";

import { formatNyxt } from "./format";

/** Props for {@link LowBalanceNudge}. */
export interface LowBalanceNudgeProps {
  /** Whether the banner is shown (the reducer's once-per-session latch). */
  readonly visible: boolean;
  /** The configured low-balance threshold, for the copy; may be undefined. */
  readonly threshold: bigint | undefined;
  /** Dismiss the banner for the rest of the session. */
  readonly onDismiss: () => void;
  /** Invoked when the user chooses to top up. */
  readonly onTopUp?: () => void;
}

export function LowBalanceNudge({ visible, threshold, onDismiss, onTopUp }: LowBalanceNudgeProps) {
  if (!visible) {
    return null;
  }
  return (
    <div
      data-testid="ledger-nudge"
      role="status"
      className="border-primary/40 bg-primary/5 flex max-w-md items-start gap-3 rounded-md border p-3"
    >
      <Sparkles className="text-primary size-5 shrink-0" aria-hidden="true" />
      <div className="flex-1 space-y-2">
        <p className="text-sm">
          Your NYXT balance is running low
          {threshold !== undefined ? ` (below ${formatNyxt(threshold)})` : ""}. Top up to keep
          building without interruption.
        </p>
        {onTopUp !== undefined ? (
          <Button data-testid="ledger-nudge-topup" size="sm" onClick={onTopUp}>
            Top up
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="ledger-nudge-dismiss"
        aria-label="Dismiss low-balance notice"
        onClick={onDismiss}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
