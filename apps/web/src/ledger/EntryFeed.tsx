/**
 * The append-only ledger feed (US12, FR-072, EC-53/EC-54).
 *
 * Renders the server-derived ledger entries and, ABOVE them, the injected
 * in-flight pending-deposit overlay:
 *
 *  - settlement rows LINK to their turn (the entry's `ref` is the turnId) and
 *    show actual consumption (FR-072);
 *  - deposit rows show credited state with the deposit's on-chain reference,
 *    while a still-pending deposit (the overlay) shows its txRef + elapsed time
 *    (EC-53);
 *  - reserve / reserve-release rows show the hold placed / freed at turn edges.
 *
 * Every amount is a server `bigint` rendered verbatim by {@link formatNyxt}
 * (FR-070) — EXCEPT a pending deposit's `requestedAmount`, which is the
 * client-entered figure and is explicitly labelled "Requested" so it can never
 * be mistaken for a settled server balance. The feed is PAGINATED client-side
 * (`visibleCount` / `onShowMore`, EC-54); the balance totals live in
 * {@link BalanceCard} and are never affected by pagination.
 */
import type { LedgerEntry, LedgerEntryKind } from "@nyx/protocol";

import { Button } from "@/components/ui/button";

import { formatElapsed, formatNyxt } from "./format";
import type { PendingDeposit } from "./types";

/** Props for {@link EntryFeed}. */
export interface EntryFeedProps {
  /** Server-derived entries, newest-first (as ordered by the reducer). */
  readonly entries: readonly LedgerEntry[];
  /** In-flight deposits not yet credited (EC-53); defaults to none. */
  readonly pendingDeposits?: readonly PendingDeposit[];
  /** Current epoch-ms for the EC-53 elapsed display (from {@link useNow}). */
  readonly now: number;
  /** How many entries to reveal (EC-54). */
  readonly visibleCount: number;
  /** Reveal the next page (EC-54). */
  readonly onShowMore: () => void;
}

/** The rendered shape of one ledger entry, derived purely from its `kind`. */
interface EntryRowView {
  readonly title: string;
  readonly amountLabel: string;
  readonly refLabel: string;
  /** Whether the `ref` is a turnId that should render as a link (FR-072). */
  readonly refIsTurnLink: boolean;
}

/** Map an entry kind to its display copy. Exhaustive over {@link LedgerEntryKind}. */
function describeKind(kind: LedgerEntryKind): EntryRowView {
  switch (kind) {
    case "settlement":
      return {
        title: "Turn settled",
        amountLabel: "Consumed",
        refLabel: "Turn",
        refIsTurnLink: true,
      };
    case "deposit_credit":
      return {
        title: "Deposit credited",
        amountLabel: "Credited",
        refLabel: "Deposit ref",
        refIsTurnLink: false,
      };
    case "reserve":
      return {
        title: "Reserved for turn",
        amountLabel: "Reserved",
        refLabel: "Turn",
        refIsTurnLink: false,
      };
    case "reserve_release":
      return {
        title: "Reserve released",
        amountLabel: "Released",
        refLabel: "Turn",
        refIsTurnLink: false,
      };
  }
}

/** The reference cell: a link to the turn for settlements, else plain text. */
function ReferenceCell(props: {
  readonly label: string;
  readonly value: string;
  readonly asTurnLink: boolean;
}) {
  return (
    <span className="text-muted-foreground text-xs">
      {props.label}:{" "}
      {props.asTurnLink ? (
        <a
          data-testid="ledger-entry-turn-link"
          href={`#/turns/${props.value}`}
          className="text-primary font-mono underline-offset-2 hover:underline"
        >
          {props.value}
        </a>
      ) : (
        <code data-testid="ledger-entry-ref" className="font-mono" title={props.value}>
          {props.value}
        </code>
      )}
    </span>
  );
}

/** One server-derived entry row. */
function EntryRow(props: { readonly entry: LedgerEntry }) {
  const { entry } = props;
  const view = describeKind(entry.kind);
  return (
    <li
      data-testid={`ledger-entry-${entry.kind}`}
      className="flex flex-col gap-1 border-b py-3 last:border-b-0"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{view.title}</span>
        <span className="text-muted-foreground text-xs">
          {view.amountLabel}{" "}
          <span className="text-foreground font-mono">{formatNyxt(entry.amount)}</span>
        </span>
      </div>
      {entry.ref !== undefined ? (
        <ReferenceCell label={view.refLabel} value={entry.ref} asTurnLink={view.refIsTurnLink} />
      ) : null}
    </li>
  );
}

/** One pending-deposit overlay row (EC-53). */
function PendingRow(props: { readonly deposit: PendingDeposit; readonly now: number }) {
  const { deposit, now } = props;
  return (
    <li
      data-testid="ledger-entry-pending"
      className="border-primary/30 bg-primary/5 flex flex-col gap-1 rounded-md border px-3 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Deposit pending</span>
        <span className="text-muted-foreground text-xs">
          {/* Client-entered REQUEST, not a settled balance (FR-070). */}
          Requested{" "}
          <span className="text-foreground font-mono">{formatNyxt(deposit.requestedAmount)}</span>
        </span>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span data-testid="ledger-pending-elapsed">
          Elapsed <span className="font-mono">{formatElapsed(now - deposit.startedAt)}</span>
        </span>
        {deposit.txRef !== undefined ? (
          <span>
            Tx:{" "}
            <code data-testid="ledger-pending-txref" className="font-mono" title={deposit.txRef}>
              {deposit.txRef}
            </code>
          </span>
        ) : null}
      </div>
      {/* EC-53 / EC-30: reassure the user that a pending deposit is safe during indexer lag. */}
      <p data-testid="ledger-pending-explain" className="text-muted-foreground text-xs">
        Deposits can take a few minutes to confirm during network activity — this is safe and will
        credit automatically once finalized.
      </p>
    </li>
  );
}

export function EntryFeed({
  entries,
  pendingDeposits,
  now,
  visibleCount,
  onShowMore,
}: EntryFeedProps) {
  const pending = pendingDeposits ?? [];
  const visible = entries.slice(0, visibleCount);
  const hasMore = entries.length > visibleCount;

  return (
    <div data-testid="ledger-feed" className="max-w-md space-y-3">
      {pending.length > 0 ? (
        <ul className="space-y-2" data-testid="ledger-pending-list">
          {pending.map((deposit) => (
            <PendingRow key={deposit.depositRef} deposit={deposit} now={now} />
          ))}
        </ul>
      ) : null}

      {/* The entries list renders ONLY when there are entries — a pending-but-no-entries
          first-run state must not leave an empty bordered box (review). The "nothing yet"
          message shows only when there is truly no activity of either kind. */}
      {entries.length > 0 ? (
        <ul className="rounded-md border px-3">
          {visible.map((entry) => (
            <EntryRow key={entry.id.toString()} entry={entry} />
          ))}
        </ul>
      ) : pending.length === 0 ? (
        <p data-testid="ledger-feed-empty" className="text-muted-foreground text-sm">
          No ledger activity yet. Deposits, reserves, and settlements appear here.
        </p>
      ) : null}

      {hasMore ? (
        <Button data-testid="ledger-show-more" variant="outline" size="sm" onClick={onShowMore}>
          Show more
        </Button>
      ) : null}
    </div>
  );
}
