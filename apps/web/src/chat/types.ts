/**
 * Chat feature seams and view models (US1, T143/T144, D20/D23/D24/D25).
 *
 * The chat UI is split into a pure state layer (`turn-state`), presentational
 * components, and a container — all wired through the injectable seams declared
 * here so tests drive turn events synchronously against in-memory fakes with no
 * real WebSocket and no network:
 *
 *  - {@link ChatBridge} is the narrow `{ send, on }` subset of the container's
 *    `PreviewBridge`. The real bridge (`@/container/ws-client`) is a structural
 *    superset, so a live `PreviewBridge` satisfies it without a cast; tests pass
 *    a fake. Chat SENDS `prompt:submit` and SUBSCRIBES to the server → client
 *    turn stream (`turn:message`, `turn:activity`, `turn:settled`,
 *    `ledger:update`).
 *  - {@link LoadHistory} is the D23 rehydration seam (chat history → view).
 *  - {@link Clock} sources timestamps so tests stay deterministic.
 *  - {@link DeclinePredicate} classifies a supervisor `turn:message` as an
 *    off-domain decline (D25). The current protocol carries no dedicated decline
 *    marker, so this is injectable and defaults to "never" (see `turn-state`);
 *    the reducer's decline path is fully implemented and can be wired the moment
 *    the server's decline signal is finalised.
 *
 * Money fields on the wire are decoded to `bigint` by `@nyx/protocol`; here they
 * are treated as bigint and are DISPLAY-only — never recomputed (FR-070).
 */
import type {
  ChatMessage,
  ClientToServerEvent,
  LedgerUpdatePayload,
  ProjectId,
  ServerToClientEvent,
  TurnActivityPayload,
  TurnId,
  TurnMessagePayload,
  TurnMessageRole,
  TurnSettledPayload,
} from "@nyx/protocol";

/** Removes a previously-registered bridge listener. */
export type Unsubscribe = () => void;

/** A server → client event narrowed to a specific `type`. */
export type ServerEventOf<T extends ServerToClientEvent["type"]> = Extract<
  ServerToClientEvent,
  { type: T }
>;

/**
 * The WS surface the chat feature depends on: send client → server events
 * (only `prompt:submit` here) and subscribe to server → client turn events. A
 * live `PreviewBridge` is a structural superset, so it is assignable without a
 * cast; tests supply an in-memory fake.
 */
export interface ChatBridge {
  send(event: ClientToServerEvent): void;
  on<T extends ServerToClientEvent["type"]>(
    type: T,
    handler: (event: ServerEventOf<T>) => void,
  ): Unsubscribe;
}

/** Rehydrate persisted chat history for a project (D23). */
export type LoadHistory = (projectId: ProjectId) => Promise<ChatMessage[]>;

/** A monotonic wall-clock source (injected so tests are deterministic). */
export interface Clock {
  now(): number;
}

/**
 * Classifies a supervisor `turn:message` as an off-domain decline (D25).
 * Returns `true` when the message is a decline (turn ends, nothing charged),
 * `false` when it is ordinary narration to accumulate.
 */
export type DeclinePredicate = (payload: TurnMessagePayload) => boolean;

// --- view models ------------------------------------------------------------

/** The kind of a rendered chat row (drives its label and styling). */
export type DisplayMessageKind = TurnMessageRole | "user" | "decline";

/**
 * One rendered chat row. Streamed narration accumulates into a single row per
 * turn+role whose `content` grows as deltas arrive (`streaming` true until the
 * turn settles). `turnId` is `undefined` for user rows.
 */
export interface DisplayMessage {
  /** Stable React key: `stream:<turnId>:<role>` for narration, `user:<seq>` for prompts. */
  readonly id: string;
  readonly kind: DisplayMessageKind;
  readonly content: string;
  readonly turnId: TurnId | undefined;
  /** Whether this row is still receiving deltas (a live narration). */
  readonly streaming: boolean;
  /** Epoch-ms of the first delta / the submit. */
  readonly ts: number;
}

/** One entry in a sub-agent's activity log. */
export interface ActivityEntry {
  readonly phase: string;
  readonly detail: string;
  readonly ts: number;
}

/** All activity for a single sub-agent (scaffolding/planning/implementation/review). */
export interface AgentActivityGroup {
  readonly agent: string;
  readonly entries: readonly ActivityEntry[];
}

/**
 * Server-derived NYXT balances for read-only display (FR-070). Every field is a
 * `bigint` produced by the server; the client renders them and NEVER computes a
 * derived figure (e.g. `available - reserved`).
 */
export interface BalanceView {
  /** Post-settlement / live available balance (may be negative on overage, D34). */
  readonly available: bigint;
  /** Currently reserved holdings. */
  readonly reserved: bigint;
  /** Consumed magnitude from the most recent settlement, if any. */
  readonly lastConsumed: bigint | undefined;
}

/** Explains an interrupted turn recovered from rehydrated history (D20/D23). */
export interface RecoveryNotice {
  /** The last unanswered user prompt whose response was lost. */
  readonly lostPromptContent: string;
  /** User-facing explanation of what completed and what was lost. */
  readonly message: string;
}

/** Whether a turn is in flight. The input lock (D24) is `phase === "active"`. */
export type TurnPhase = "idle" | "active";

/** How the most recently ended turn concluded. */
export type TurnOutcome = "settled" | "declined";

/** The complete derived chat UI state (single source of truth for the views). */
export interface TurnState {
  readonly phase: TurnPhase;
  /** True while a turn is active — the D24 chat-input lock. */
  readonly inputDisabled: boolean;
  /** The turn id adopted from the first server event of the active turn. */
  readonly activeTurnId: TurnId | undefined;
  readonly messages: readonly DisplayMessage[];
  /** Per-sub-agent activity for the CURRENT turn (reset on each submit). */
  readonly activity: readonly AgentActivityGroup[];
  /** Verify cycles observed this turn (D20/D21). */
  readonly cyclesCompleted: number;
  readonly balance: BalanceView | undefined;
  readonly recovery: RecoveryNotice | undefined;
  readonly lastOutcome: TurnOutcome | undefined;
  /** Internal monotonic counter for stable user-message ids. */
  readonly seq: number;
}

/** The reducer action union — the semantic turn-event stream (see `turn-state`). */
export type ChatAction =
  | { readonly kind: "history-loaded"; readonly messages: readonly ChatMessage[] }
  | { readonly kind: "prompt-submitted"; readonly text: string; readonly ts: number }
  | { readonly kind: "message-delta"; readonly payload: TurnMessagePayload; readonly ts: number }
  | { readonly kind: "activity"; readonly payload: TurnActivityPayload; readonly ts: number }
  | { readonly kind: "settled"; readonly payload: TurnSettledPayload }
  | { readonly kind: "declined"; readonly payload: TurnMessagePayload; readonly ts: number }
  | { readonly kind: "ledger-update"; readonly payload: LedgerUpdatePayload };
