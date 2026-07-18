/**
 * Ledger UI state machine (US12, FR-070..073, EC-52/EC-54).
 *
 * {@link ledgerReducer} is a PURE fold over the semantic ledger-event stream;
 * {@link useLedger} wires it to an injected {@link LedgerClient} (initial load +
 * reconnect refetch) and {@link LedgerBridge} (live `ledger:update` /
 * `turn:settled`). Keeping the reducer pure makes every transition deterministic
 * and unit-testable with no React and no socket.
 *
 * THE LOAD-BEARING INVARIANT (FR-070): balances are NEVER computed here. The
 * reducer only ever REPLACES `available` / `reserved` with the figures the server
 * put on a `ledger:update` (both balances) or `turn:settled` (available, as
 * `balance`) payload. It never adds an entry's `amount` to a running total, never
 * derives `available - reserved`, never sums entries. An entry's `amount` is
 * carried for DISPLAY only. (`turn:settled` omits `reserved`, so the last
 * server-provided `reserved` is retained unchanged — still a server value, never
 * recomputed; in practice the paired settlement `ledger:update` refreshes it.)
 *
 * {@link useNow} is a small ticking-clock hook for the EC-53 pending-deposit
 * elapsed display, over the injected {@link LedgerClock}; it ticks only while
 * `active`, so a ledger with no pending deposits does no timer work.
 *
 * ORDERING (EC-52 reconnect / replay staleness, review H1/M1). Two balance sources — the
 * `GET /ledger` snapshot and the live WS stream — are not mutually sequenced by the wire
 * protocol yet, so we defend client-side: `refetch` carries a monotonic GENERATION so a slow
 * older fetch never clobbers a newer one; and the reducer treats the entry `id` (a monotonic
 * bigserial) as a sequence CURSOR (`appliedThrough`) so an older snapshot or a replayed
 * `ledger:update` never reverts a fresher balance, and merges rather than replaces entries so
 * a live row arriving during a reconnect refetch is never dropped. RESIDUAL (owner-gated):
 * `turn:settled` carries no entry id or `reserved`, so a DROPPED settlement frame that does
 * not trigger a reconnect can leave `reserved` momentarily stale — a full fix needs the server
 * to stamp a monotonic sequence (and `reserved`) on the events + snapshot, which the wire DTOs
 * do not yet expose. Deposit rows also show `depositRef` once credited vs `txRef` while pending
 * (the wire `LedgerEntry` has no tx-hash field for a settled row) — an owner/protocol item.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { LedgerEntry } from "@nyx/protocol";

import { LedgerFetchError } from "./client";
import type { LedgerClient, LedgerView } from "./client";
import type {
  LedgerAction,
  LedgerBridge,
  LedgerClock,
  LedgerUiState,
  LowBalanceNudgeState,
  Unsubscribe,
} from "./types";

/** How many entries the feed reveals initially and per "show more" (EC-54). */
export const DEFAULT_PAGE_SIZE = 20;
/** Default elapsed-tick cadence for {@link useNow} (ms). */
export const DEFAULT_TICK_MS = 1000;

const DEFAULT_CLOCK: LedgerClock = { now: () => Date.now() };

const INITIAL_NUDGE: LowBalanceNudgeState = { active: false, seen: false };

/**
 * Map a `GET /ledger` failure to user-facing copy (M2). The typed {@link LedgerFetchError}
 * reason/status drive DISTINCT messages so an expired session (401/403 on this cookie-authed
 * money endpoint) prompts re-auth rather than the misleading "check your connection".
 */
export function loadErrorMessage(error: unknown): string {
  if (error instanceof LedgerFetchError) {
    if (error.reason === "http" && (error.status === 401 || error.status === 403)) {
      return "Your session has expired. Please sign in again to see your NYXT balance.";
    }
    if (error.reason === "http" || error.reason === "malformed") {
      return "Something went wrong loading your NYXT balance. Please retry.";
    }
  }
  return "We couldn't reach the server. Check your connection and retry.";
}

/** Build the initial (loading) state, seeded with the injected config. */
export function createInitialLedgerState(
  threshold: bigint | undefined,
  pageSize: number,
): LedgerUiState {
  return {
    status: "loading",
    available: undefined,
    reserved: undefined,
    entries: [],
    lastConsumed: undefined,
    error: undefined,
    nudge: INITIAL_NUDGE,
    threshold,
    visibleCount: pageSize,
    pageSize,
    appliedThrough: 0n,
  };
}

/** Order entries newest-first by their monotonic bigserial `id` (the time proxy). */
function sortNewestFirst(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
}

/** The greatest entry `id` in a set, or `0n` if empty (the ordering cursor's basis). */
function maxEntryId(entries: readonly LedgerEntry[]): bigint {
  let max = 0n;
  for (const entry of entries) {
    if (entry.id > max) {
      max = entry.id;
    }
  }
  return max;
}

/**
 * Merge new entries into the existing set, de-duplicated by `id` and kept newest-first.
 * The ledger is append-only, so a UNION never loses a live row that arrived during a
 * reconnect refetch (H1) — the snapshot and the live stream both contribute.
 */
function mergeEntries(
  existing: readonly LedgerEntry[],
  incoming: readonly LedgerEntry[],
): readonly LedgerEntry[] {
  const byId = new Map<bigint, LedgerEntry>();
  for (const entry of existing) {
    byId.set(entry.id, entry);
  }
  for (const entry of incoming) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return sortNewestFirst([...byId.values()]);
}

/**
 * Re-evaluate the once-per-session low-balance nudge (FR-073). Fires (sets
 * `active` + latches `seen`) the FIRST time `available` drops below the injected
 * threshold; once `seen`, it never fires again this session — dipping below a
 * second time does not re-nag.
 */
function evaluateNudge(
  nudge: LowBalanceNudgeState,
  available: bigint | undefined,
  threshold: bigint | undefined,
): LowBalanceNudgeState {
  if (nudge.seen || threshold === undefined || available === undefined) {
    return nudge;
  }
  if (available < threshold) {
    return { active: true, seen: true };
  }
  return nudge;
}

/** Pure reducer: fold one ledger event onto the derived UI state. */
export function ledgerReducer(state: LedgerUiState, action: LedgerAction): LedgerUiState {
  switch (action.kind) {
    case "loaded": {
      const { available, reserved, entries } = action.view;
      // Merge (never replace) so a live entry that arrived DURING a reconnect refetch is not
      // dropped (H1). Apply the snapshot's balances ONLY if it is at least as fresh as the
      // live stream we've already applied — an older snapshot resolving after a newer live
      // event must not revert the balance (H1). Entry id doubles as the sequence.
      const snapshotMax = maxEntryId(entries);
      const fresher = snapshotMax >= state.appliedThrough;
      const nextAvailable = fresher ? available : state.available;
      const nextReserved = fresher ? reserved : state.reserved;
      return {
        ...state,
        status: "ready",
        available: nextAvailable,
        reserved: nextReserved,
        entries: mergeEntries(state.entries, entries),
        error: undefined,
        appliedThrough: fresher ? snapshotMax : state.appliedThrough,
        nudge: evaluateNudge(state.nudge, nextAvailable, state.threshold),
      };
    }

    case "load-failed":
      return { ...state, status: "error", error: action.message };

    case "reloading":
      // Refetch in flight (reconnect/retry): flag it without dropping the
      // last-known figures, so the UI can show "refreshing" over stale data
      // rather than flashing empty.
      return { ...state, status: "loading", error: undefined };

    case "ledger-update": {
      // REPLACE both balances from the server payload verbatim (FR-070) — the entry's amount
      // is NEVER added to a running total. But a REPLAYED/older update (entry id at or below
      // the cursor) is a full no-op: its balances are stale, so re-applying them would revert
      // a newer figure (M1). Entry id is the monotonic sequence.
      const { entry, available, reserved } = action.payload;
      if (entry.id <= state.appliedThrough) {
        return state;
      }
      return {
        ...state,
        status: "ready",
        available,
        reserved,
        entries: mergeEntries(state.entries, [entry]),
        error: undefined,
        appliedThrough: entry.id,
        nudge: evaluateNudge(state.nudge, available, state.threshold),
      };
    }

    case "turn-settled": {
      // REPLACE available from the server's post-settlement `balance` (FR-070).
      // `turn:settled` carries no `reserved`; keep the last server value (the
      // paired settlement `ledger:update` refreshes it). `consumed` is display-only.
      const { balance, consumed } = action.payload;
      return {
        ...state,
        status: "ready",
        available: balance,
        lastConsumed: consumed,
        error: undefined,
        nudge: evaluateNudge(state.nudge, balance, state.threshold),
      };
    }

    case "dismiss-nudge":
      // Hide the banner; `seen` stays latched so it never fires again (FR-073).
      return { ...state, nudge: { ...state.nudge, active: false } };

    case "show-more":
      return { ...state, visibleCount: state.visibleCount + state.pageSize };
  }
}

// --- hook -------------------------------------------------------------------

/** Options for {@link useLedger}. */
export interface UseLedgerOptions {
  /** REST seam (`GET /ledger`). */
  readonly client: LedgerClient;
  /** The live-update seam (`ledger:update` / `turn:settled` / reconnect). */
  readonly bridge: LedgerBridge;
  /**
   * Low-balance nudge threshold in NYXT base units (config; injected because
   * there is no `GET /config` route). When omitted, the nudge never fires.
   */
  readonly lowBalanceThreshold?: bigint;
  /** Feed page size (initial reveal + each "show more"); defaults to 20. */
  readonly pageSize?: number;
}

/** The ledger surface exposed to components. */
export interface UseLedger {
  readonly state: LedgerUiState;
  /** Reveal the next page of feed entries (EC-54). */
  readonly showMore: () => void;
  /** Dismiss the low-balance nudge for the rest of the session (FR-073). */
  readonly dismissNudge: () => void;
  /** Re-run the initial load after a failure. */
  readonly retry: () => void;
}

/**
 * Wire {@link ledgerReducer} to a live ledger: load `GET /ledger` on mount,
 * subscribe the two live events, and REFETCH on reconnect (EC-52). The seams are
 * read through a ref so the subscription effect runs exactly once and never
 * churns on a re-render.
 */
export function useLedger(options: UseLedgerOptions): UseLedger {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const [state, dispatch] = useReducer(ledgerReducer, undefined, () =>
    createInitialLedgerState(options.lowBalanceThreshold, pageSize),
  );

  const depsRef = useRef(options);
  depsRef.current = options;

  // Monotonic request generation: a slower/older `fetchLedger` resolving after a newer one
  // must be IGNORED, so a stale snapshot never clobbers fresher state (H1 fetch-vs-fetch).
  const genRef = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    const gen = (genRef.current += 1);
    let view: LedgerView;
    try {
      view = await depsRef.current.client.fetchLedger();
    } catch (error) {
      if (gen === genRef.current) {
        dispatch({ kind: "load-failed", message: loadErrorMessage(error) });
      }
      return;
    }
    if (gen === genRef.current) {
      dispatch({ kind: "loaded", view });
    }
  }, []);

  useEffect(() => {
    const { bridge } = depsRef.current;
    const unsubscribers: Unsubscribe[] = [
      bridge.on("ledger:update", (event) => {
        dispatch({ kind: "ledger-update", payload: event.payload });
      }),
      bridge.on("turn:settled", (event) => {
        dispatch({ kind: "turn-settled", payload: event.payload });
      }),
      bridge.onReconnect(() => {
        // EC-52: a reconnect may have missed live updates — refetch, never trust
        // the possibly-stale in-memory balance.
        dispatch({ kind: "reloading" });
        void refetch();
      }),
    ];
    void refetch();
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [refetch]);

  const showMore = useCallback(() => {
    dispatch({ kind: "show-more" });
  }, []);

  const dismissNudge = useCallback(() => {
    dispatch({ kind: "dismiss-nudge" });
  }, []);

  const retry = useCallback(() => {
    dispatch({ kind: "reloading" });
    void refetch();
  }, [refetch]);

  return { state, showMore, dismissNudge, retry };
}

// --- elapsed-time clock (EC-53) --------------------------------------------

/** Options for {@link useNow}. */
export interface UseNowOptions {
  /** Time source; defaults to `Date.now`. */
  readonly clock?: LedgerClock;
  /** Tick only while `true` (e.g. while pending deposits exist). */
  readonly active: boolean;
  /** Tick cadence in ms; defaults to {@link DEFAULT_TICK_MS}. */
  readonly intervalMs?: number;
}

/**
 * A ticking "now" for the EC-53 elapsed-time display. Returns the current epoch
 * ms, refreshed on an interval WHILE `active`; when inactive it holds its last
 * value and runs no timer. The clock and cadence are read through a ref so
 * changing them does not restart the interval mid-tick.
 */
export function useNow(options: UseNowOptions): number {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [now, setNow] = useState<number>(() => (options.clock ?? DEFAULT_CLOCK).now());

  useEffect(() => {
    if (!options.active) {
      return;
    }
    const read = (): number => (optsRef.current.clock ?? DEFAULT_CLOCK).now();
    setNow(read());
    const timer = setInterval(() => {
      setNow(read());
    }, optsRef.current.intervalMs ?? DEFAULT_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [options.active]);

  return now;
}
