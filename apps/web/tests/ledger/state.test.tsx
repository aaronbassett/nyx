/**
 * US12 — ledger state machine (FR-070..073, EC-52/EC-54).
 *
 * Drives the pure reducer directly (no React) and the `useLedger` hook against
 * in-memory fake seams (no socket, no network). The load-bearing assertions:
 *   - `ledger:update` / `turn:settled` REPLACE the balance from the SERVER
 *     payload — proven by feeding an event balance that is NOT old ± amount and
 *     confirming the state shows the EVENT's figure (FR-070, no client math);
 *   - reconnect REFETCHES `GET /ledger` (EC-52);
 *   - the low-balance nudge fires at most ONCE per session (FR-073);
 *   - the feed paginates via `visibleCount` (EC-54).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  createInitialLedgerState,
  ledgerReducer,
  loadErrorMessage,
  useLedger,
  useNow,
} from "@/ledger/state";
import { LedgerFetchError } from "@/ledger/client";
import type { LedgerClient, LedgerView } from "@/ledger/client";
import type { LedgerBridge, ServerEventOf } from "@/ledger/types";
import type {
  LedgerEntry,
  LedgerEntryKind,
  LedgerUpdatePayload,
  MidnightAddress,
  TurnId,
  TurnSettledPayload,
} from "@nyx/protocol";

afterEach(cleanup);

const ADDR = "addr1" as MidnightAddress;

// --- fixtures ---------------------------------------------------------------

function entry(id: bigint, kind: LedgerEntryKind, amount: bigint, ref?: string): LedgerEntry {
  return ref === undefined
    ? { id, accountAddress: ADDR, kind, amount }
    : { id, accountAddress: ADDR, kind, amount, ref };
}

function ledgerUpdate(
  entryRow: LedgerEntry,
  available: bigint,
  reserved: bigint,
): LedgerUpdatePayload {
  return { entry: entryRow, available, reserved };
}

function turnSettled(balance: bigint, consumed: bigint): TurnSettledPayload {
  return { turnId: "turn-1" as TurnId, consumed, balance };
}

function view(available: bigint, reserved: bigint, entries: LedgerEntry[]): LedgerView {
  return { available, reserved, entries };
}

// --- reducer: initial load --------------------------------------------------

describe("ledgerReducer — load", () => {
  it("starts loading with nothing known", () => {
    const state = createInitialLedgerState(100n, 20);
    expect(state.status).toBe("loading");
    expect(state.available).toBeUndefined();
    expect(state.reserved).toBeUndefined();
    expect(state.entries).toEqual([]);
  });

  it("loads server figures and orders entries newest-first", () => {
    const initial = createInitialLedgerState(undefined, 20);
    const loaded = ledgerReducer(initial, {
      kind: "loaded",
      view: view(90n, 10n, [
        entry(1n, "deposit_credit", 100n, "dep-1"),
        entry(3n, "settlement", 5n, "turn-3"),
        entry(2n, "reserve", 8n, "turn-2"),
      ]),
    });
    expect(loaded.status).toBe("ready");
    expect(loaded.available).toBe(90n);
    expect(loaded.reserved).toBe(10n);
    expect(loaded.entries.map((e) => e.id)).toEqual([3n, 2n, 1n]);
  });

  it("surfaces a load failure without inventing a balance", () => {
    const initial = createInitialLedgerState(undefined, 20);
    const failed = ledgerReducer(initial, { kind: "load-failed", message: "boom" });
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("boom");
    expect(failed.available).toBeUndefined();
  });
});

// --- reducer: live updates REPLACE balances, never compute (FR-070) ----------

describe("ledgerReducer — no client-side balance arithmetic (FR-070)", () => {
  it("ledger:update shows the EVENT balance, not old ± amount", () => {
    const loaded = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(100n, 0n, []),
    });
    // Entry amount 5, but the server says available is 999 (deliberately NOT
    // 100 + 5). If the UI did arithmetic it would show 105; it must show 999.
    const next = ledgerReducer(loaded, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(7n, "deposit_credit", 5n, "dep-7"), 999n, 33n),
    });
    expect(next.available).toBe(999n);
    expect(next.reserved).toBe(33n);
    expect(next.entries.map((e) => e.id)).toEqual([7n]);
  });

  it("turn:settled shows the EVENT balance, not old − consumed", () => {
    const loaded = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(100n, 20n, []),
    });
    // consumed 5, but the server says balance is 42 (NOT 95). Must show 42.
    const settled = ledgerReducer(loaded, {
      kind: "turn-settled",
      payload: turnSettled(42n, 5n),
    });
    expect(settled.available).toBe(42n);
    expect(settled.lastConsumed).toBe(5n);
    // turn:settled carries no reserved → last server value retained, not recomputed.
    expect(settled.reserved).toBe(20n);
  });

  it("de-duplicates a re-delivered entry by id", () => {
    const loaded = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(0n, 0n, []),
    });
    const once = ledgerReducer(loaded, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(9n, "settlement", 1n, "turn-9"), 10n, 0n),
    });
    const twice = ledgerReducer(once, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(9n, "settlement", 1n, "turn-9"), 10n, 0n),
    });
    expect(twice.entries).toHaveLength(1);
  });
});

// --- reducer: ordering / staleness (review H1/M1) --------------------------

describe("ledgerReducer — ordering cursor defends against staleness", () => {
  it("ignores a REPLAYED/older ledger:update so a stale balance never reverts a newer one (M1)", () => {
    let s = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(0n, 0n, []),
    });
    // Newest update: entry 9, available 50.
    s = ledgerReducer(s, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(9n, "settlement", 1n, "turn-9"), 50n, 0n),
    });
    expect(s.available).toBe(50n);
    // A re-delivered/older update for the SAME entry id carrying a stale balance (100) is a
    // full no-op — the feed already has entry 9 AND the balance must not snap back to 100.
    const replay = ledgerReducer(s, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(9n, "settlement", 1n, "turn-9"), 100n, 0n),
    });
    expect(replay.available).toBe(50n);
    expect(replay.entries).toHaveLength(1);
  });

  it("merges a reconnect snapshot without dropping a live row, and an older snapshot does not revert the balance (H1)", () => {
    let s = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(200n, 0n, [entry(5n, "settlement", 1n, "turn-5")]),
    });
    // A live update (entry 6, available 150) arrives DURING a reconnect refetch.
    s = ledgerReducer(s, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(6n, "settlement", 1n, "turn-6"), 150n, 0n),
    });
    // The in-flight refetch resolves with an OLDER snapshot (max id 5, available 200) — it must
    // NOT drop entry 6 and must NOT revert available to 200.
    const reloaded = ledgerReducer(s, {
      kind: "loaded",
      view: view(200n, 0n, [entry(5n, "settlement", 1n, "turn-5")]),
    });
    expect(reloaded.available).toBe(150n); // fresher live balance kept
    expect(reloaded.entries.map((e) => e.id)).toEqual([6n, 5n]); // live row retained
  });

  it("applies a snapshot that IS fresher than the applied stream", () => {
    let s = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(100n, 0n, [entry(2n, "settlement", 1n)]),
    });
    // A newer snapshot (max id 4, available 80) is at/ahead of the cursor → applied.
    s = ledgerReducer(s, {
      kind: "loaded",
      view: view(80n, 5n, [entry(2n, "settlement", 1n), entry(4n, "settlement", 1n)]),
    });
    expect(s.available).toBe(80n);
    expect(s.entries.map((e) => e.id)).toEqual([4n, 2n]);
  });
});

// --- reducer: once-per-session nudge (FR-073) -------------------------------

describe("ledgerReducer — low-balance nudge (FR-073)", () => {
  it("fires once when available drops below the threshold, then never again", () => {
    // Below threshold on load → fires.
    const loaded = ledgerReducer(createInitialLedgerState(100n, 20), {
      kind: "loaded",
      view: view(50n, 0n, []),
    });
    expect(loaded.nudge).toEqual({ active: true, seen: true });

    // Dismiss it.
    const dismissed = ledgerReducer(loaded, { kind: "dismiss-nudge" });
    expect(dismissed.nudge).toEqual({ active: false, seen: true });

    // Dips below again → does NOT re-nag (seen is latched).
    const again = ledgerReducer(dismissed, {
      kind: "ledger-update",
      payload: ledgerUpdate(entry(1n, "settlement", 10n, "turn-1"), 40n, 0n),
    });
    expect(again.nudge).toEqual({ active: false, seen: true });
  });

  it("does not fire while available stays at or above the threshold", () => {
    const loaded = ledgerReducer(createInitialLedgerState(100n, 20), {
      kind: "loaded",
      view: view(150n, 0n, []),
    });
    expect(loaded.nudge).toEqual({ active: false, seen: false });
  });

  it("does not fire at the exact threshold boundary (strict less-than)", () => {
    const loaded = ledgerReducer(createInitialLedgerState(100n, 20), {
      kind: "loaded",
      view: view(100n, 0n, []), // available === threshold → NOT below → no nudge
    });
    expect(loaded.nudge).toEqual({ active: false, seen: false });
  });

  it("never fires when no threshold is configured", () => {
    const loaded = ledgerReducer(createInitialLedgerState(undefined, 20), {
      kind: "loaded",
      view: view(-500n, 0n, []),
    });
    expect(loaded.nudge).toEqual({ active: false, seen: false });
  });
});

// --- reducer: pagination (EC-54) -------------------------------------------

describe("ledgerReducer — pagination (EC-54)", () => {
  it("reveals the next page on show-more without touching totals", () => {
    const loaded = ledgerReducer(createInitialLedgerState(undefined, 2), {
      kind: "loaded",
      view: view(500n, 0n, [
        entry(1n, "settlement", 1n),
        entry(2n, "settlement", 1n),
        entry(3n, "settlement", 1n),
        entry(4n, "settlement", 1n),
      ]),
    });
    expect(loaded.visibleCount).toBe(2);
    const more = ledgerReducer(loaded, { kind: "show-more" });
    expect(more.visibleCount).toBe(4);
    // Totals untouched by pagination.
    expect(more.available).toBe(500n);
  });
});

// --- hook: live wiring + reconnect refetch (EC-52) --------------------------

type LedgerBridgeEvent = "ledger:update" | "turn:settled";

interface FakeBridge {
  readonly bridge: LedgerBridge;
  emit<T extends LedgerBridgeEvent>(type: T, event: ServerEventOf<T>): void;
  reconnect(): void;
}

function createFakeBridge(): FakeBridge {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const reconnectHandlers = new Set<() => void>();
  const bridge: LedgerBridge = {
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set<(event: unknown) => void>();
      set.add(handler as (event: unknown) => void);
      handlers.set(type, set);
      return (): void => {
        set.delete(handler as (event: unknown) => void);
      };
    },
    onReconnect: (handler) => {
      reconnectHandlers.add(handler);
      return (): void => {
        reconnectHandlers.delete(handler);
      };
    },
  };
  return {
    bridge,
    emit: (type, event) => {
      for (const handler of handlers.get(type) ?? []) {
        handler(event);
      }
    },
    reconnect: () => {
      for (const handler of reconnectHandlers) {
        handler();
      }
    },
  };
}

function fakeClient(views: LedgerView[]): { client: LedgerClient; calls: () => number } {
  let call = 0;
  const client: LedgerClient = {
    fetchLedger: () => {
      const v = views[Math.min(call, views.length - 1)];
      call += 1;
      return v === undefined ? Promise.reject(new Error("no view")) : Promise.resolve(v);
    },
  };
  return { client, calls: () => call };
}

describe("useLedger — live wiring", () => {
  it("loads the initial ledger on mount", async () => {
    const { client } = fakeClient([view(90n, 10n, [entry(1n, "deposit_credit", 100n, "dep-1")])]);
    const fake = createFakeBridge();
    const { result } = renderHook(() => useLedger({ client, bridge: fake.bridge }));

    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    expect(result.current.state.available).toBe(90n);
    expect(result.current.state.reserved).toBe(10n);
    expect(result.current.state.entries).toHaveLength(1);
  });

  it("folds a live ledger:update over the bridge", async () => {
    const { client } = fakeClient([view(100n, 0n, [])]);
    const fake = createFakeBridge();
    const { result } = renderHook(() => useLedger({ client, bridge: fake.bridge }));
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });

    act(() => {
      fake.emit("ledger:update", {
        type: "ledger:update",
        payload: ledgerUpdate(entry(2n, "settlement", 3n, "turn-2"), 55n, 12n),
        ts: 1,
      });
    });
    expect(result.current.state.available).toBe(55n);
    expect(result.current.state.reserved).toBe(12n);
  });

  it("refetches GET /ledger on reconnect (EC-52)", async () => {
    const { client, calls } = fakeClient([
      view(100n, 0n, []),
      view(250n, 5n, []), // the fresh figures after reconnect
    ]);
    const fake = createFakeBridge();
    const { result } = renderHook(() => useLedger({ client, bridge: fake.bridge }));
    await waitFor(() => {
      expect(result.current.state.available).toBe(100n);
    });
    expect(calls()).toBe(1);

    act(() => {
      fake.reconnect();
    });
    await waitFor(() => {
      expect(result.current.state.available).toBe(250n);
    });
    expect(calls()).toBe(2);
  });

  it("surfaces an initial load failure", async () => {
    const failing: LedgerClient = { fetchLedger: () => Promise.reject(new Error("down")) };
    const fake = createFakeBridge();
    const { result } = renderHook(() => useLedger({ client: failing, bridge: fake.bridge }));

    await waitFor(() => {
      expect(result.current.state.status).toBe("error");
    });
    expect(result.current.state.available).toBeUndefined();
    expect(result.current.state.error).not.toBeUndefined();
  });

  it("ignores a slow OLDER fetch resolving after a newer one (generation guard, H1)", async () => {
    // A client whose fetches resolve only when the test says so — to force out-of-order.
    const resolvers: ((v: LedgerView) => void)[] = [];
    const client: LedgerClient = {
      fetchLedger: () => new Promise<LedgerView>((resolve) => resolvers.push(resolve)),
    };
    const fake = createFakeBridge();
    const { result } = renderHook(() => useLedger({ client, bridge: fake.bridge }));

    // Mount fetch (gen 1) is pending. Trigger a reconnect → a second fetch (gen 2) is pending.
    await waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    act(() => {
      fake.reconnect();
    });
    await waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });

    // Resolve the NEWER (gen 2) first with the fresh figures…
    await act(async () => {
      resolvers[1]?.(view(250n, 5n, []));
      await Promise.resolve();
    });
    expect(result.current.state.available).toBe(250n);

    // …then resolve the OLDER (gen 1) with stale figures — it must be IGNORED.
    await act(async () => {
      resolvers[0]?.(view(100n, 0n, []));
      await Promise.resolve();
    });
    expect(result.current.state.available).toBe(250n); // not reverted to 100
  });
});

// --- loadErrorMessage — typed-error copy (M2) -------------------------------

describe("loadErrorMessage", () => {
  it("prompts re-auth on a 401/403", () => {
    expect(loadErrorMessage(new LedgerFetchError("http", "unauthorized", 401))).toMatch(
      /sign in again/i,
    );
    expect(loadErrorMessage(new LedgerFetchError("http", "forbidden", 403))).toMatch(
      /sign in again/i,
    );
  });

  it("gives a server-side message on other http / malformed", () => {
    expect(loadErrorMessage(new LedgerFetchError("http", "boom", 500))).toMatch(/went wrong/i);
    expect(loadErrorMessage(new LedgerFetchError("malformed", "bad shape"))).toMatch(/went wrong/i);
  });

  it("gives a connectivity message on a network error / unknown", () => {
    expect(loadErrorMessage(new LedgerFetchError("network", "offline"))).toMatch(/connection/i);
    expect(loadErrorMessage(new Error("weird"))).toMatch(/connection/i);
  });
});

// --- useNow — EC-53 elapsed clock ------------------------------------------

describe("useNow", () => {
  it("ticks on the interval while active and stops when inactive", () => {
    vi.useFakeTimers();
    try {
      let t = 1_000;
      const clock = { now: () => t };
      const { result, rerender } = renderHook(
        ({ active }: { active: boolean }) => useNow({ clock, active, intervalMs: 1_000 }),
        { initialProps: { active: true } },
      );
      expect(result.current).toBe(1_000);

      t = 2_000;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(result.current).toBe(2_000);

      // Going inactive clears the interval: further time does not update.
      rerender({ active: false });
      t = 9_000;
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(result.current).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
