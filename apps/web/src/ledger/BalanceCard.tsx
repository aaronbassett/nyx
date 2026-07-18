/**
 * The NYXT balance summary card (US12, FR-070, scenario 1 / D34).
 *
 * Renders the server-derived `available` and `reserved` figures DISTINCTLY and
 * verbatim (FR-070) — it never derives a value from them. The only inspection it
 * makes is a sign check on `available`: a NEGATIVE available balance (final-cycle
 * overage, D34) means prompts are blocked, so the card switches to a "prompts
 * blocked" panel with a top-up call-to-action (`onTopUp`). A sign comparison is
 * not balance arithmetic — no new figure is computed.
 */
import { Ban, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { formatNyxt } from "./format";

/** Props for {@link BalanceCard}. */
export interface BalanceCardProps {
  /** Available balance (server-derived); may be negative (D34). */
  readonly available: bigint | undefined;
  /** Reserved holdings (server-derived); non-negative. */
  readonly reserved: bigint | undefined;
  /** Consumption from the most recent `turn:settled` (server value; display-only). */
  readonly lastConsumed?: bigint | undefined;
  /** Invoked when the user chooses to top up (links to the top-up flow). */
  readonly onTopUp?: () => void;
}

/** One labelled monetary figure — server value rendered verbatim (FR-070). */
function Figure(props: {
  readonly label: string;
  readonly value: bigint | undefined;
  readonly testId: string;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs tracking-wide uppercase">{props.label}</span>
      <span
        data-testid={props.testId}
        className={
          props.emphasis
            ? "text-foreground font-mono text-lg font-semibold"
            : "text-foreground font-mono text-base"
        }
      >
        {props.value === undefined ? "—" : formatNyxt(props.value)}
      </span>
    </div>
  );
}

export function BalanceCard({ available, reserved, lastConsumed, onTopUp }: BalanceCardProps) {
  // Sign check only — NOT a computed balance (FR-070). Negative available means
  // final-cycle overage (D34): prompts are paused until the user tops up.
  const blocked = available !== undefined && available < 0n;

  return (
    <Card data-testid="ledger-balance" className="max-w-md">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Wallet className="size-6 shrink-0 text-primary" aria-hidden="true" />
          <CardTitle>NYXT balance</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-6">
          <Figure label="Available" value={available} testId="ledger-available" emphasis />
          <Figure label="Reserved" value={reserved} testId="ledger-reserved" />
        </div>

        {lastConsumed !== undefined ? (
          <p data-testid="ledger-last-consumed" className="text-muted-foreground text-xs">
            {/* Server value from the last turn:settled, rendered verbatim (FR-070). */}
            Last turn consumed{" "}
            <span className="text-foreground font-mono">{formatNyxt(lastConsumed)}</span>
          </p>
        ) : null}

        {blocked ? (
          <div
            data-testid="ledger-blocked"
            role="alert"
            className="border-destructive/40 bg-destructive/10 space-y-3 rounded-md border p-3"
          >
            <div className="text-destructive flex items-center gap-2 text-sm font-medium">
              <Ban className="size-4 shrink-0" aria-hidden="true" />
              <span>Prompts are paused</span>
            </div>
            <p className="text-muted-foreground text-sm">
              Your available balance is negative after your last turn, so new prompts are blocked.
              Top up NYXT to continue building.
            </p>
            {onTopUp !== undefined ? (
              <Button data-testid="ledger-topup" onClick={onTopUp}>
                <Wallet className="size-4" aria-hidden="true" />
                Top up NYXT
              </Button>
            ) : null}
          </div>
        ) : onTopUp !== undefined ? (
          <Button data-testid="ledger-topup" variant="outline" onClick={onTopUp}>
            <Wallet className="size-4" aria-hidden="true" />
            Top up
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
