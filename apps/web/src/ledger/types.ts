/**
 * Token-ledger UI seams and view models (US12, FR-070..073, EC-52..54).
 *
 * User Story 12 is a RENDERING story over the existing ledger machinery — there
 * are NO new ledger semantics here. Every monetary figure the UI shows is a
 * server-derived `bigint` rendered verbatim; the client NEVER computes a balance
 * (FR-070). The feature is split, following the established `chat/` pattern, into
 * a pure reducer + hook (`state`), a data-fetch client (`client`), a formatter
 * (`format`), and presentational components — all wired through the injectable
 * seams declared here so tests drive the whole surface synchronously against
 * in-memory fakes with no real socket and no network.
 *
 *  - {@link LedgerBridge} is the live-update seam: the two server → client ledger
 *    events (`ledger:update`, `turn:settled`) plus a reconnect hook (EC-52). It
 *    mirrors `chat`'s `ChatBridge` — a live `PreviewBridge` satisfies the `on`
 *    surface structurally; the `onReconnect` hook is a bespoke addition the app
 *    layer wires from the ws-client's (future) reconnect signal.
 *  - {@link LedgerClock} sources time for the EC-53 elapsed-time display, injected
 *    so tests stay deterministic.
 *  - {@link PendingDeposit} is the in-flight-deposit overlay: a deposit that has
 *    been submitted but not yet credited is NOT a ledger entry (only its eventual
 *    `deposit_credit` is), so pending rows come from this injected overlay — owned
 *    by the top-up flow (`@/wallet/topup`), not invented here. Its `requestedAmount`
 *    is the client-entered figure and is labelled "Requested", never mistaken for
 *    a settled server balance (FR-070).
 *
 * `@nyx/protocol` DTOs are imported TYPE-ONLY, so no runtime zod enters the web
 * bundle from this module; the sole runtime-zod decode is isolated in `client.ts`.
 */
import type {
  DepositRef,
  LedgerEntry,
  LedgerUpdatePayload,
  ServerToClientEvent,
  TurnSettledPayload,
} from "@nyx/protocol";

import type { LedgerView } from "./client";

/** Removes a previously-registered bridge listener. */
export type Unsubscribe = () => void;

/** A server → client event narrowed to a specific `type`. */
export type ServerEventOf<T extends ServerToClientEvent["type"]> = Extract<
  ServerToClientEvent,
  { type: T }
>;

/** The two server → client events the ledger UI folds live (FR-071). */
export type LedgerBridgeEventType = "ledger:update" | "turn:settled";

/**
 * The live-update surface the ledger UI depends on. `on` subscribes to the two
 * ledger events; `onReconnect` fires when the transport reconnects so the UI can
 * REFETCH `GET /ledger` and never show a stale balance (EC-52). A live
 * `PreviewBridge` is a structural superset of the `on` method, so it is
 * assignable there without a cast; tests supply an in-memory fake.
 */
export interface LedgerBridge {
  on<T extends LedgerBridgeEventType>(
    type: T,
    handler: (event: ServerEventOf<T>) => void,
  ): Unsubscribe;
  /** Subscribe to transport reconnects (EC-52). Returns an unsubscribe fn. */
  onReconnect(handler: () => void): Unsubscribe;
}

/** A monotonic wall-clock source (injected so EC-53 elapsed time is deterministic). */
export interface LedgerClock {
  now(): number;
}

/**
 * An in-flight deposit that has been submitted but not yet credited (EC-53). It
 * is NOT a ledger entry — the ledger feed only gains a `deposit_credit` entry
 * once the deposit finalises on-chain — so pending rows are supplied by this
 * overlay, owned by the top-up flow. `requestedAmount` is the client-entered
 * figure (labelled "Requested" by the feed) and is never summed into a balance.
 */
export interface PendingDeposit {
  /** The pre-registered deposit reference (D45). */
  readonly depositRef: DepositRef;
  /** The client-entered amount — a REQUEST, not a settled server balance (FR-070). */
  readonly requestedAmount: bigint;
  /** Epoch-ms the deposit was submitted; the anchor for the EC-53 elapsed clock. */
  readonly startedAt: number;
  /** The submitted transaction reference (the deposit's on-chain reference, FR-072). */
  readonly txRef?: string;
}

// --- reducer state ----------------------------------------------------------

/** Where the initial `GET /ledger` load stands. */
export type LedgerLoadStatus = "loading" | "ready" | "error";

/** The once-per-session low-balance nudge latch (FR-073). */
export interface LowBalanceNudgeState {
  /** Whether the nudge banner is currently showing. */
  readonly active: boolean;
  /**
   * Whether the nudge has ALREADY fired this session. Once `true` it never fires
   * again — dipping below the threshold a second time does not re-nag (FR-073).
   */
  readonly seen: boolean;
}

/**
 * The complete derived ledger UI state (single source of truth for the views).
 * Balances are server-derived `bigint`s or `undefined` before the first load —
 * they are only ever REPLACED from a server figure, never computed (FR-070).
 */
export interface LedgerUiState {
  readonly status: LedgerLoadStatus;
  /** Available balance; may be negative on final-cycle overage (D34). */
  readonly available: bigint | undefined;
  /** Reserved holdings; non-negative. */
  readonly reserved: bigint | undefined;
  /** Append-only entries, ordered newest-first by their monotonic `id`. */
  readonly entries: readonly LedgerEntry[];
  /** Consumed magnitude from the most recent `turn:settled`, display-only. */
  readonly lastConsumed: bigint | undefined;
  /** A user-facing message when the initial load failed. */
  readonly error: string | undefined;
  readonly nudge: LowBalanceNudgeState;
  /** The low-balance threshold (config; injected — there is no `GET /config`). */
  readonly threshold: bigint | undefined;
  /** How many entries the paginated feed currently reveals (EC-54). */
  readonly visibleCount: number;
  /** The page size used by `show-more` and the initial reveal (EC-54). */
  readonly pageSize: number;
  /**
   * INTERNAL ordering cursor: the highest entry `id` whose balance has been applied
   * (`0n` before the first). Entry ids are a monotonic bigserial, so they double as a
   * sequence — a `ledger:update`/snapshot carrying an id at or below this is STALE and its
   * balance is not re-applied (defeats the reconnect/replay staleness of H1/M1 without a
   * server sequence cursor, which the wire DTOs do not yet expose — see the module header).
   */
  readonly appliedThrough: bigint;
}

/**
 * The reducer action union — the semantic ledger-event stream. NOTE none of
 * these actions ever carry a client-computed balance: `ledger-update` and
 * `turn-settled` replace the balances from the SERVER payload verbatim (FR-070).
 */
export type LedgerAction =
  | { readonly kind: "loaded"; readonly view: LedgerView }
  | { readonly kind: "load-failed"; readonly message: string }
  | { readonly kind: "reloading" }
  | { readonly kind: "ledger-update"; readonly payload: LedgerUpdatePayload }
  | { readonly kind: "turn-settled"; readonly payload: TurnSettledPayload }
  | { readonly kind: "dismiss-nudge" }
  | { readonly kind: "show-more" };
