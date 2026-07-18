/**
 * Public surface of the US12 token-ledger UI (FR-070..073, EC-52..54).
 *
 * A pure re-export barrel: the formatter, the `GET /ledger` client, the state
 * machine (reducer + `useLedger` + `useNow`), the presentational components, and
 * the `LedgerPanel` container, plus every seam and view-model type, are surfaced
 * here so consumers import from `@/ledger` rather than reaching into files. The
 * panel is intentionally NOT wired into the app Shell (owner-gated placeholder).
 */
export { formatNyxt, formatElapsed } from "./format";

export { createHttpLedgerClient, LedgerFetchError } from "./client";
export type { HttpLedgerClientDeps, LedgerClient, LedgerFetchReason, LedgerView } from "./client";

export {
  createInitialLedgerState,
  ledgerReducer,
  useLedger,
  useNow,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TICK_MS,
} from "./state";
export type { UseLedger, UseLedgerOptions, UseNowOptions } from "./state";

export { BalanceCard } from "./BalanceCard";
export type { BalanceCardProps } from "./BalanceCard";
export { EntryFeed } from "./EntryFeed";
export type { EntryFeedProps } from "./EntryFeed";
export { LowBalanceNudge } from "./LowBalanceNudge";
export type { LowBalanceNudgeProps } from "./LowBalanceNudge";
export { LedgerPanel } from "./LedgerPanel";
export type { LedgerPanelProps } from "./LedgerPanel";

export type {
  LedgerAction,
  LedgerBridge,
  LedgerBridgeEventType,
  LedgerClock,
  LedgerLoadStatus,
  LedgerUiState,
  LowBalanceNudgeState,
  PendingDeposit,
  ServerEventOf,
  Unsubscribe,
} from "./types";
