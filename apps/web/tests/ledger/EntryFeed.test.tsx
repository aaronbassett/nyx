/**
 * US12 — EntryFeed (FR-072, EC-53/EC-54).
 *
 * Settlement rows link to their turn and show consumption; deposit_credit rows
 * show the credited amount + deposit ref; pending deposits (overlay) show a
 * "Requested" amount, txRef, and elapsed time (EC-53); and the feed paginates
 * (EC-54).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EntryFeed } from "@/ledger/EntryFeed";
import type { PendingDeposit } from "@/ledger/types";
import type { DepositRef, LedgerEntry, LedgerEntryKind, MidnightAddress } from "@nyx/protocol";

afterEach(cleanup);

const ADDR = "addr1" as MidnightAddress;

function entry(id: bigint, kind: LedgerEntryKind, amount: bigint, ref?: string): LedgerEntry {
  return ref === undefined
    ? { id, accountAddress: ADDR, kind, amount }
    : { id, accountAddress: ADDR, kind, amount, ref };
}

const noop = (): void => undefined;

describe("EntryFeed", () => {
  it("links a settlement row to its turn and shows consumption (FR-072)", () => {
    render(
      <EntryFeed
        entries={[entry(3n, "settlement", 42n, "turn-abc")]}
        now={0}
        visibleCount={20}
        onShowMore={noop}
      />,
    );
    const row = screen.getByTestId("ledger-entry-settlement");
    expect(row.textContent).toContain("42 NYXT");
    const link = screen.getByTestId("ledger-entry-turn-link");
    expect(link.textContent).toBe("turn-abc");
    expect(link.getAttribute("href")).toBe("#/turns/turn-abc");
  });

  it("shows a credited deposit with its deposit reference", () => {
    render(
      <EntryFeed
        entries={[entry(4n, "deposit_credit", 1000n, "dep-xyz")]}
        now={0}
        visibleCount={20}
        onShowMore={noop}
      />,
    );
    const row = screen.getByTestId("ledger-entry-deposit_credit");
    expect(row.textContent).toContain("1,000 NYXT");
    expect(screen.getByTestId("ledger-entry-ref").textContent).toBe("dep-xyz");
  });

  it("renders a pending deposit with requested amount, txRef, and elapsed time (EC-53)", () => {
    const pending: PendingDeposit = {
      depositRef: "dep-1" as DepositRef,
      requestedAmount: 500n,
      startedAt: 1000,
      txRef: "0xtx",
    };
    render(
      <EntryFeed
        entries={[]}
        pendingDeposits={[pending]}
        now={1000 + 65000}
        visibleCount={20}
        onShowMore={noop}
      />,
    );
    const row = screen.getByTestId("ledger-entry-pending");
    expect(row.textContent).toContain("Requested");
    expect(row.textContent).toContain("500 NYXT");
    expect(screen.getByTestId("ledger-pending-elapsed").textContent).toContain("1m 5s");
    expect(screen.getByTestId("ledger-pending-txref").textContent).toBe("0xtx");
    // EC-53/EC-30: an explanatory "this is safe" note must accompany the pending state.
    expect(screen.getByTestId("ledger-pending-explain").textContent).toMatch(/safe/i);
  });

  it("shows only the pending list (no empty box, no 'nothing yet') on a first pending deposit", () => {
    const pending: PendingDeposit = {
      depositRef: "dep-first" as DepositRef,
      requestedAmount: 500n,
      startedAt: 0,
    };
    render(
      <EntryFeed
        entries={[]}
        pendingDeposits={[pending]}
        now={0}
        visibleCount={20}
        onShowMore={noop}
      />,
    );
    // The pending row shows, but there must be NO empty "nothing yet" message competing with it…
    expect(screen.getByTestId("ledger-entry-pending")).not.toBeNull();
    expect(screen.queryByTestId("ledger-feed-empty")).toBeNull();
    // …and no empty entries list (the bordered box) rendered with zero rows (review M3/L6).
    expect(screen.queryByTestId("ledger-entry-settlement")).toBeNull();
    expect(screen.queryByTestId("ledger-entry-deposit_credit")).toBeNull();
  });

  it("paginates: only visibleCount entries, and Show more reveals the next page (EC-54)", () => {
    const onShowMore = vi.fn();
    const entries = [
      entry(5n, "settlement", 1n, "t5"),
      entry(4n, "settlement", 1n, "t4"),
      entry(3n, "settlement", 1n, "t3"),
    ];
    render(<EntryFeed entries={entries} now={0} visibleCount={2} onShowMore={onShowMore} />);
    expect(screen.getAllByTestId("ledger-entry-settlement")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("ledger-show-more"));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state with no entries and no pending deposits", () => {
    render(<EntryFeed entries={[]} now={0} visibleCount={20} onShowMore={noop} />);
    expect(screen.getByTestId("ledger-feed-empty")).not.toBeNull();
    expect(screen.queryByTestId("ledger-show-more")).toBeNull();
  });
});
