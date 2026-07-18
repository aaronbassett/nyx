/**
 * US12 — LedgerPanel container integration (FR-070..073, EC-52).
 *
 * Drives the real container against in-memory fake seams (no socket, no
 * network): initial load → balances render; a live `ledger:update` propagates
 * without reload; a negative available blocks prompts (scenario 1); the nudge
 * fires once and dismisses; and an initial-load failure shows a retry path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LedgerPanel } from "@/ledger/LedgerPanel";
import type { LedgerClient, LedgerView } from "@/ledger/client";
import type { LedgerBridge, ServerEventOf } from "@/ledger/types";
import type { DepositRef, LedgerEntry, LedgerEntryKind, MidnightAddress } from "@nyx/protocol";

afterEach(cleanup);

const ADDR = "addr1" as MidnightAddress;

function entry(id: bigint, kind: LedgerEntryKind, amount: bigint, ref?: string): LedgerEntry {
  return ref === undefined
    ? { id, accountAddress: ADDR, kind, amount }
    : { id, accountAddress: ADDR, kind, amount, ref };
}

function view(available: bigint, reserved: bigint, entries: LedgerEntry[]): LedgerView {
  return { available, reserved, entries };
}

type LedgerBridgeEvent = "ledger:update" | "turn:settled";

interface FakeBridge {
  readonly bridge: LedgerBridge;
  emit<T extends LedgerBridgeEvent>(type: T, event: ServerEventOf<T>): void;
}

function createFakeBridge(): FakeBridge {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const bridge: LedgerBridge = {
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set<(event: unknown) => void>();
      set.add(handler as (event: unknown) => void);
      handlers.set(type, set);
      return () => {
        set.delete(handler as (event: unknown) => void);
      };
    },
    onReconnect: () => () => undefined,
  };
  return {
    bridge,
    emit: (type, event) => {
      for (const handler of handlers.get(type) ?? []) {
        handler(event);
      }
    },
  };
}

function resolvingClient(v: LedgerView): LedgerClient {
  return { fetchLedger: () => Promise.resolve(v) };
}

describe("LedgerPanel", () => {
  it("loads and renders balances, then folds a live ledger:update (FR-071)", async () => {
    const fake = createFakeBridge();
    render(<LedgerPanel client={resolvingClient(view(100n, 0n, []))} bridge={fake.bridge} />);

    await waitFor(() => {
      expect(screen.getByTestId("ledger-available").textContent).toBe("100 NYXT");
    });

    act(() => {
      fake.emit("ledger:update", {
        type: "ledger:update",
        payload: {
          entry: entry(1n, "deposit_credit", 900n, "dep-1"),
          available: 1000n,
          reserved: 0n,
        },
        ts: 1,
      });
    });

    expect(screen.getByTestId("ledger-available").textContent).toBe("1,000 NYXT");
    expect(screen.getByTestId("ledger-entry-deposit_credit")).not.toBeNull();
  });

  it("blocks prompts when available is negative (scenario 1 / D34)", async () => {
    const fake = createFakeBridge();
    const onTopUp = vi.fn();
    render(
      <LedgerPanel
        client={resolvingClient(view(-25n, 0n, []))}
        bridge={fake.bridge}
        onTopUp={onTopUp}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ledger-blocked")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("ledger-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("fires the low-balance nudge once and dismisses it (FR-073)", async () => {
    const fake = createFakeBridge();
    render(
      <LedgerPanel
        client={resolvingClient(view(50n, 0n, []))}
        bridge={fake.bridge}
        lowBalanceThreshold={100n}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ledger-nudge")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("ledger-nudge-dismiss"));
    expect(screen.queryByTestId("ledger-nudge")).toBeNull();

    // Dipping below again must NOT re-nag (once-per-session latch).
    act(() => {
      fake.emit("ledger:update", {
        type: "ledger:update",
        payload: {
          entry: entry(2n, "settlement", 10n, "turn-2"),
          available: 40n,
          reserved: 0n,
        },
        ts: 2,
      });
    });
    expect(screen.queryByTestId("ledger-nudge")).toBeNull();
  });

  it("shows a retry path when the initial load fails outright", async () => {
    const fake = createFakeBridge();
    let calls = 0;
    const client: LedgerClient = {
      fetchLedger: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve(view(77n, 0n, []));
      },
    };
    render(<LedgerPanel client={client} bridge={fake.bridge} />);

    await waitFor(() => {
      expect(screen.getByTestId("ledger-error")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("ledger-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("ledger-available").textContent).toBe("77 NYXT");
    });
  });

  it("renders pending deposits with elapsed time from the injected clock (EC-53)", async () => {
    const fake = createFakeBridge();
    render(
      <LedgerPanel
        client={resolvingClient(view(100n, 0n, []))}
        bridge={fake.bridge}
        clock={{ now: () => 1000 + 3000 }}
        pendingDeposits={[
          {
            depositRef: "dep-p" as DepositRef,
            requestedAmount: 200n,
            startedAt: 1000,
            txRef: "0xabc",
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ledger-entry-pending")).not.toBeNull();
    });
    expect(screen.getByTestId("ledger-pending-elapsed").textContent).toContain("3s");
  });
});
