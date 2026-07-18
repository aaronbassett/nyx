/**
 * The composed token-ledger panel (US12) — the feature's container.
 *
 * Binds {@link useLedger} (server-derived balances + live updates + reconnect
 * refetch) and {@link useNow} (the EC-53 elapsed clock, ticking only while
 * pending deposits exist) to the presentational {@link BalanceCard},
 * {@link LowBalanceNudge}, and {@link EntryFeed}. It renders a loading state
 * before the first `GET /ledger` resolves and an error+retry state if it fails
 * outright; once any server figure is known it shows the full panel (a later
 * refetch failure surfaces inline without dropping the last-known balances).
 *
 * The real app wires the seams once — an `createHttpLedgerClient()`, a
 * `LedgerBridge` adapter over the ws-client, the injected low-balance threshold,
 * and the pending-deposit overlay bridged from the top-up flow — and mounts this;
 * tests inject fakes. It is deliberately NOT wired into the app Shell yet (the
 * Shell mount point is an owner-gated placeholder).
 */
import { LoaderCircle, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { BalanceCard } from "./BalanceCard";
import { EntryFeed } from "./EntryFeed";
import { LowBalanceNudge } from "./LowBalanceNudge";
import { useLedger, useNow } from "./state";
import type { LedgerBridge, LedgerClock, PendingDeposit } from "./types";
import type { LedgerClient } from "./client";

/** Props for {@link LedgerPanel} — the injected seams plus display tunables. */
export interface LedgerPanelProps {
  /** REST seam (`GET /ledger`). */
  readonly client: LedgerClient;
  /** Live-update seam (`ledger:update` / `turn:settled` / reconnect). */
  readonly bridge: LedgerBridge;
  /** Low-balance nudge threshold (config; injected). Omit to disable the nudge. */
  readonly lowBalanceThreshold?: bigint;
  /** Feed page size (EC-54); defaults to 20. */
  readonly pageSize?: number;
  /** In-flight deposits not yet credited (EC-53); defaults to none. */
  readonly pendingDeposits?: readonly PendingDeposit[];
  /** Time source for the elapsed clock (injected for determinism). */
  readonly clock?: LedgerClock;
  /** Elapsed-tick cadence in ms; defaults to 1000. */
  readonly tickIntervalMs?: number;
  /** Invoked when the user chooses to top up (links to the top-up flow). */
  readonly onTopUp?: () => void;
}

export function LedgerPanel({
  client,
  bridge,
  lowBalanceThreshold,
  pageSize,
  pendingDeposits,
  clock,
  tickIntervalMs,
  onTopUp,
}: LedgerPanelProps) {
  const { state, showMore, dismissNudge, retry } = useLedger({
    client,
    bridge,
    ...(lowBalanceThreshold !== undefined ? { lowBalanceThreshold } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  });

  const pending = pendingDeposits ?? [];
  const now = useNow({
    ...(clock !== undefined ? { clock } : {}),
    active: pending.length > 0,
    ...(tickIntervalMs !== undefined ? { intervalMs: tickIntervalMs } : {}),
  });

  // Nothing known yet: the very first load is still in flight.
  if (state.available === undefined && state.status === "loading") {
    return (
      <Card data-testid="ledger-loading" className="max-w-md">
        <CardHeader>
          <div className="flex items-center gap-3">
            <LoaderCircle
              className="size-6 shrink-0 animate-spin text-primary"
              aria-hidden="true"
            />
            <CardTitle>Loading balance…</CardTitle>
          </div>
        </CardHeader>
      </Card>
    );
  }

  // First load failed outright and we have nothing to show.
  if (state.available === undefined && state.status === "error") {
    return (
      <Card data-testid="ledger-error" className="max-w-md">
        <CardHeader>
          <div className="flex items-center gap-3">
            <TriangleAlert className="size-6 shrink-0 text-destructive" aria-hidden="true" />
            <CardTitle>Couldn't load your balance</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">{state.error}</p>
          <Button data-testid="ledger-retry" variant="outline" onClick={retry}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div data-testid="ledger-panel" className="space-y-4">
      <LowBalanceNudge
        visible={state.nudge.active}
        threshold={state.threshold}
        onDismiss={dismissNudge}
        {...(onTopUp !== undefined ? { onTopUp } : {})}
      />

      <BalanceCard
        available={state.available}
        reserved={state.reserved}
        {...(state.lastConsumed !== undefined ? { lastConsumed: state.lastConsumed } : {})}
        {...(onTopUp !== undefined ? { onTopUp } : {})}
      />

      {/* A refetch failed but we still have last-known figures (EC-52 fallback). */}
      {state.status === "error" ? (
        <p data-testid="ledger-stale-note" className="text-muted-foreground max-w-md text-xs">
          Couldn't refresh your balance just now — showing the last known figures.{" "}
          <button
            type="button"
            data-testid="ledger-stale-retry"
            onClick={retry}
            className="text-primary underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </p>
      ) : null}

      <EntryFeed
        entries={state.entries}
        pendingDeposits={pending}
        now={now}
        visibleCount={state.visibleCount}
        onShowMore={showMore}
      />
    </div>
  );
}
