/**
 * US6 (T124, D34/D37/D62) — NYXT top-up flow.
 *
 * A user tops up their NYXT balance by pre-registering a deposit, running a
 * single wallet signing ceremony (SDK tx build + Lace sign + prover-proxy
 * proving), and waiting for the off-chain credit to land on finalized on-chain
 * SUCCESS (D45 — no on-chain write in the per-prompt path; credit is off-chain).
 *
 * The lifecycle is a PURE state machine ({@link useTopUp} over a `useReducer`)
 * driven by four INJECTABLE seams, so the whole flow is unit-testable with fakes
 * and no live network / wallet / browser:
 *
 *   1. {@link DepositClient}       — REST: `POST /deposits`, `GET /deposits/:ref`.
 *   2. {@link DepositCeremony}     — the SINGLE signing ceremony (OWNER-GATED real
 *                                    adapter; see {@link createOwnerGatedCeremony}).
 *   3. {@link DepositSubscription} — the live `ledger:update` seam (credit/failure).
 *   4. {@link TopUpClock}          — elapsed-time + TTL, injected for determinism.
 *
 * Balances are ALWAYS server-derived: the credited state only ever surfaces the
 * `available` / `reserved` / credited `amount` that arrive on a `ledger:update`
 * payload (FR-070). The hook never sums or derives a balance locally — a credit
 * observed via the status poll (which carries no balance) shows NO balance.
 *
 * `@nyx/protocol` DTOs are imported TYPE-ONLY, so no runtime zod enters the web
 * bundle. The container/presenter split mirrors the US5 wallet components.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { CircleCheck, Clock3, LoaderCircle, TriangleAlert, Wallet } from "lucide-react";
import type {
  CreateDepositResponse,
  DepositRef,
  DepositStatusResponse,
  LedgerUpdatePayload,
} from "@nyx/protocol";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// ============================================================================
// Seams
// ============================================================================

/**
 * The REST surface the flow needs. Both calls are session-authenticated via the
 * same-origin HttpOnly cookie; the real adapter sends `credentials: "include"`,
 * but the seam is injected so tests drive it with fakes (mirroring `auth.ts`).
 */
export interface DepositClient {
  /** `POST /deposits { amount }` — pre-register the ref (D45). */
  createDeposit(amount: bigint): Promise<CreateDepositResponse>;
  /** `GET /deposits/:ref` — poll the deposit lifecycle (D45/D46). */
  getDepositStatus(ref: DepositRef): Promise<DepositStatusResponse>;
}

/** Inputs to the signing ceremony: the pre-registered ref and the amount. */
export interface CeremonyParams {
  readonly depositRef: DepositRef;
  readonly amount: bigint;
}

/** The result of a successful ceremony — the submitted transaction reference. */
export interface CeremonyResult {
  readonly txRef: string;
}

/**
 * The SINGLE wallet signing ceremony (D37/D62): build the `deposit(ref, amount)`
 * transaction, run the one Lace signing prompt, and prove via the
 * session-authenticated same-origin prover proxy (`POST /prover/prove`).
 *
 * Contract: RESOLVES `{ txRef }` once the deposit transaction is submitted;
 * REJECTS when the user declines the prompt or proving fails (→ actionable
 * error, never a false "pending"). The finalized on-chain outcome (success →
 * credit, failure → scenario 6) is observed later via {@link DepositSubscription},
 * not here.
 */
export interface DepositCeremony {
  runCeremony(params: CeremonyParams): Promise<CeremonyResult>;
}

/**
 * A live update about the tracked deposit, delivered by the subscription seam.
 *
 * NOTE (protocol gap, documented deviation): `@nyx/protocol` models neither a
 * `failed` `DepositStatus` nor a failure `LedgerEntryKind`, so a finalized
 * on-chain FAILURE cannot be a raw `ledger:update`. This seam therefore emits a
 * small deposit-scoped union — the `credited` variant carries the verbatim
 * `LedgerUpdatePayload` (so server balances stay authoritative, FR-070), and the
 * `failed` variant carries the server's finalized-failure diagnostic. The real
 * (OWNER-GATED) adapter maps `ledger:update` (kind `deposit_credit`, matching
 * `ref`) → `credited` and the server's failure signal → `failed`.
 */
export type DepositUpdate =
  | { readonly kind: "credited"; readonly ledger: LedgerUpdatePayload }
  | { readonly kind: "failed"; readonly detail: string };

/** Receives {@link DepositUpdate}s for the tracked deposit. */
export type DepositUpdateListener = (update: DepositUpdate) => void;

/** The live `ledger:update` subscription seam (narrow, injected, deposit-scoped). */
export interface DepositSubscription {
  /**
   * Subscribe to updates for `depositRef`. Returns an unsubscribe function that
   * MUST be idempotent. Tests drive `onUpdate` synchronously; the real adapter
   * reuses the US3 `PreviewBridge` / ws-client `/ws` transport.
   */
  subscribe(depositRef: DepositRef, onUpdate: DepositUpdateListener): () => void;
}

/** Injected clock — the sole time source for elapsed-time (EC-53) and TTL (EC-29). */
export interface TopUpClock {
  /** Current epoch-ms. */
  now(): number;
}

// ============================================================================
// State
// ============================================================================

/** Why a top-up attempt ended in an actionable error (not a deposit outcome). */
export type TopUpErrorReason =
  /** The ceremony was declined or proving failed (EC-24). */
  | "ceremony-rejected"
  /** Pre-registration never reached a verdict (fetch threw / unexpected status). */
  | "network";

/** The server-provided ledger snapshot shown on a credited deposit (FR-070). */
export interface CreditedLedger {
  /** The amount credited by the `deposit_credit` entry. */
  readonly creditedAmount: bigint;
  /** Available balance after the credit — server-derived, never computed here. */
  readonly available: bigint;
  /** Reserved balance after the credit — server-derived, never computed here. */
  readonly reserved: bigint;
}

/**
 * The discriminated top-up state (one deposit). Exactly one named phase — adding
 * a phase without a reducer / view branch is a type error.
 */
export type TopUpState =
  /** The amount form. `validationError` is present after a rejected submit. */
  | { readonly phase: "idle"; readonly validationError?: string }
  /** `POST /deposits` in flight. */
  | { readonly phase: "preregistering"; readonly amount: bigint }
  /** The single signing ceremony is running (one Lace prompt). */
  | {
      readonly phase: "awaiting-signature";
      readonly amount: bigint;
      readonly depositRef: DepositRef;
      readonly expiresAt: number;
    }
  /** Submitted; awaiting the off-chain credit (D45). Reflects elapsed time (EC-53). */
  | {
      readonly phase: "pending";
      readonly amount: bigint;
      readonly depositRef: DepositRef;
      readonly expiresAt: number;
      readonly txRef: string;
      readonly startedAt: number;
      readonly elapsedMs: number;
    }
  /** Credited. `ledger` present only when observed via `ledger:update` (FR-070). */
  | {
      readonly phase: "credited";
      readonly amount: bigint;
      readonly depositRef: DepositRef;
      readonly txRef?: string;
      readonly ledger?: CreditedLedger;
    }
  /** Finalized on-chain FAILURE (scenario 6) with server diagnostics. */
  | {
      readonly phase: "failed";
      readonly amount: bigint;
      readonly depositRef: DepositRef;
      readonly detail: string;
    }
  /**
   * The ref TTL expired (EC-29).
   *
   * `txRef` PRESENT — expiry AFTER the deposit tx was submitted (from `pending`):
   * this is the "finalizing" phase. The in-flight tx may still finalize and
   * late-credit (the server credits even an expired ref), so (1) the view must NOT
   * invite a re-submit (double-spend footgun, M2), and (2) the hook KEEPS the
   * `ledger:update` subscription AND the status poll alive — exactly as in
   * `pending` — so the late credit is observed and upgrades this to `credited`
   * (via `credited-ledger` / `credited-poll`). Only the PRESENTATION differs from
   * `pending`; the watchers do not stop until the credit lands.
   *
   * `txRef` ABSENT — expiry BEFORE any submission (from `awaiting-signature`):
   * terminal. Nothing was submitted, so a fresh top-up is safe to offer and no
   * watcher is kept alive.
   */
  | {
      readonly phase: "expired";
      readonly amount: bigint;
      readonly depositRef: DepositRef;
      readonly txRef?: string;
    }
  /** An actionable error before submission — offer a retry. */
  | { readonly phase: "error"; readonly amount: bigint; readonly reason: TopUpErrorReason };

/** The phases in which a new `submit` must be ignored (a flow is already active). */
function isActivePhase(phase: TopUpState["phase"]): boolean {
  return phase === "preregistering" || phase === "awaiting-signature" || phase === "pending";
}

// ============================================================================
// Reducer (pure)
// ============================================================================

type TopUpAction =
  | { readonly type: "validation-fail"; readonly message: string }
  | { readonly type: "preregister-start"; readonly amount: bigint }
  | { readonly type: "preregister-ok"; readonly depositRef: DepositRef; readonly expiresAt: number }
  | { readonly type: "ceremony-ok"; readonly txRef: string; readonly now: number }
  | { readonly type: "credited-ledger"; readonly ledger: LedgerUpdatePayload }
  | { readonly type: "credited-poll"; readonly txRef: string | undefined }
  | { readonly type: "failed"; readonly detail: string }
  | { readonly type: "expired" }
  | { readonly type: "error"; readonly reason: TopUpErrorReason }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "reset" };

const INITIAL_STATE: TopUpState = { phase: "idle" };

/**
 * The pure top-up transition function. Unknown or stale actions (e.g. a credit
 * for a deposit we already left) return the state unchanged, so late seam
 * callbacks can never resurrect a terminated flow.
 */
export function topUpReducer(state: TopUpState, action: TopUpAction): TopUpState {
  switch (action.type) {
    case "validation-fail":
      return { phase: "idle", validationError: action.message };

    case "preregister-start":
      return { phase: "preregistering", amount: action.amount };

    case "preregister-ok":
      if (state.phase !== "preregistering") {
        return state;
      }
      return {
        phase: "awaiting-signature",
        amount: state.amount,
        depositRef: action.depositRef,
        expiresAt: action.expiresAt,
      };

    case "ceremony-ok":
      if (state.phase !== "awaiting-signature") {
        return state;
      }
      return {
        phase: "pending",
        amount: state.amount,
        depositRef: state.depositRef,
        expiresAt: state.expiresAt,
        txRef: action.txRef,
        startedAt: action.now,
        elapsedMs: 0,
      };

    case "credited-ledger": {
      const ledger: CreditedLedger = {
        creditedAmount: action.ledger.entry.amount,
        available: action.ledger.available,
        reserved: action.ledger.reserved,
      };
      // pending → credited, carrying the authoritative server balances (FR-070).
      if (state.phase === "pending") {
        return {
          phase: "credited",
          amount: state.amount,
          depositRef: state.depositRef,
          txRef: state.txRef,
          ledger,
        };
      }
      // finalizing → credited: expiry AFTER submission (`expired` WITH a `txRef`)
      // keeps the subscription alive, and the late credit the "still finalizing"
      // copy promised has now landed. Carry the submitted `txRef` and the
      // authoritative server balances (FR-070).
      if (state.phase === "expired" && state.txRef !== undefined) {
        return {
          phase: "credited",
          amount: state.amount,
          depositRef: state.depositRef,
          txRef: state.txRef,
          ledger,
        };
      }
      // Late UPGRADE (M1): a status poll already flipped us to `credited` WITHOUT
      // a ledger, so the view was surfacing the client-entered "Requested" amount.
      // When the authoritative `ledger:update` finally lands, replace it with the
      // server-derived figures. Only upgrade a credited-WITHOUT-ledger state —
      // never downgrade a credited-with-ledger one.
      if (state.phase === "credited" && state.ledger === undefined) {
        const base = {
          phase: "credited",
          amount: state.amount,
          depositRef: state.depositRef,
          ledger,
        } as const;
        return state.txRef !== undefined ? { ...base, txRef: state.txRef } : base;
      }
      return state;
    }

    case "credited-poll": {
      // A poll credit upgrades a live `pending` deposit — and also a `finalizing`
      // one (`expired` AFTER submission): its submitted tx just credited, exactly
      // what the "still finalizing" copy promised.
      if (state.phase === "pending") {
        const base = {
          phase: "credited",
          amount: state.amount,
          depositRef: state.depositRef,
        } as const;
        return action.txRef !== undefined ? { ...base, txRef: action.txRef } : base;
      }
      if (state.phase === "expired" && state.txRef !== undefined) {
        // The finalizing deposit already carries a submitted `txRef`; keep it (the
        // poll's own `txRef`, when present, refers to the same tx). A poll carries
        // no server ledger → the credited view shows the "Requested" fallback (M1),
        // never a fabricated balance (FR-070).
        const txRef = action.txRef ?? state.txRef;
        return { phase: "credited", amount: state.amount, depositRef: state.depositRef, txRef };
      }
      return state;
    }

    case "failed":
      if (state.phase !== "pending") {
        return state;
      }
      return {
        phase: "failed",
        amount: state.amount,
        depositRef: state.depositRef,
        detail: action.detail,
      };

    case "expired":
      // Expiry AFTER submission (from `pending`, a tx exists): carry the txRef so
      // the view shows a "still finalizing" state instead of inviting a re-submit
      // — the submitted tx may still late-credit (M2).
      if (state.phase === "pending") {
        return {
          phase: "expired",
          amount: state.amount,
          depositRef: state.depositRef,
          txRef: state.txRef,
        };
      }
      // Expiry BEFORE submission (no tx submitted): a fresh top-up is safe.
      if (state.phase === "awaiting-signature") {
        return { phase: "expired", amount: state.amount, depositRef: state.depositRef };
      }
      return state;

    case "error":
      if (state.phase !== "preregistering" && state.phase !== "awaiting-signature") {
        return state;
      }
      return { phase: "error", amount: state.amount, reason: action.reason };

    case "tick": {
      if (state.phase !== "pending") {
        return state;
      }
      if (action.now >= state.expiresAt) {
        // Expiry while pending → a tx was submitted; carry the txRef (M2).
        return {
          phase: "expired",
          amount: state.amount,
          depositRef: state.depositRef,
          txRef: state.txRef,
        };
      }
      return { ...state, elapsedMs: Math.max(0, action.now - state.startedAt) };
    }

    case "reset":
      return INITIAL_STATE;
  }
}

// ============================================================================
// Helpers (pure)
// ============================================================================

/**
 * Parse a user-entered amount (NYXT base units) to a positive `bigint`, or
 * `undefined` when the input is empty, non-integer, or not strictly positive.
 */
export function parseAmountInput(raw: string): bigint | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = BigInt(trimmed);
  return value > 0n ? value : undefined;
}

/** Format an elapsed duration (ms) as `"3s"` or `"1m 5s"` for the pending state. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`;
}

/** The below-minimum validation message (shared by the hook and any caller). */
export function minimumAmountMessage(minimum: bigint): string {
  return `Minimum top-up is ${minimum.toString()} NYXT.`;
}

// ============================================================================
// Hook
// ============================================================================

/** Options for {@link useTopUp}: the four seams plus tunables. */
export interface UseTopUpOptions {
  /** REST seam (`/deposits`). */
  readonly client: DepositClient;
  /** The signing-ceremony seam (OWNER-GATED real adapter). */
  readonly ceremony: DepositCeremony;
  /** The live `ledger:update` seam. */
  readonly subscription: DepositSubscription;
  /** Minimum accepted amount in NYXT base units. */
  readonly minimumAmount: bigint;
  /** Time source; defaults to `Date.now`. */
  readonly clock?: TopUpClock;
  /** Status-poll cadence (ms) while pending; defaults to 5000. */
  readonly pollIntervalMs?: number;
  /** Elapsed-time refresh cadence (ms) while pending; defaults to 1000. */
  readonly tickIntervalMs?: number;
}

/** The top-up surface exposed to components. */
export interface UseTopUp {
  /** The current discriminated state. */
  readonly state: TopUpState;
  /** The configured minimum amount (for the form). */
  readonly minimumAmount: bigint;
  /** Validate + pre-register + run the ceremony + enter pending. */
  readonly submit: (amount: bigint) => Promise<void>;
  /** Return a terminal state to idle for a fresh attempt. */
  readonly reset: () => void;
}

const DEFAULT_CLOCK: TopUpClock = { now: () => Date.now() };

/**
 * Drive the one-deposit top-up state machine over the injected seams. Pure state
 * transitions live in {@link topUpReducer}; this hook owns only the async
 * orchestration (`submit`) and the pending-phase effects (subscribe + poll +
 * elapsed tick + TTL), all reading the latest seams through a ref so their
 * identities never churn the effect.
 */
export function useTopUp(options: UseTopUpOptions): UseTopUp {
  const [state, dispatch] = useReducer(topUpReducer, INITIAL_STATE);

  // Latest seams/tunables, so the effects and `submit` never go stale.
  const depsRef = useRef(options);
  depsRef.current = options;

  // Latest phase, so `submit` can guard against re-entry without a dep on state.
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  // Synchronous in-flight latch (L3). The render-time `phaseRef` guard is only
  // reassigned during React's render pass, so two `submit()` calls in the SAME
  // tick (before the first `preregister-start` commits) can BOTH pass it →
  // duplicate `createDeposit` / ceremony / Lace prompts. This plain boolean ref
  // is set at `submit` entry (before the first await), checked at entry, and
  // cleared in `finally`, closing the window regardless of render timing.
  const inFlightRef = useRef(false);

  const submit = useCallback(async (amount: bigint): Promise<void> => {
    if (inFlightRef.current || isActivePhase(phaseRef.current)) {
      return;
    }
    inFlightRef.current = true;
    try {
      const deps = depsRef.current;
      if (amount < deps.minimumAmount) {
        dispatch({ type: "validation-fail", message: minimumAmountMessage(deps.minimumAmount) });
        return;
      }

      dispatch({ type: "preregister-start", amount });

      let created: CreateDepositResponse;
      try {
        created = await deps.client.createDeposit(amount);
      } catch {
        dispatch({ type: "error", reason: "network" });
        return;
      }
      dispatch({
        type: "preregister-ok",
        depositRef: created.depositRef,
        expiresAt: created.expiresAt,
      });

      let result: CeremonyResult;
      try {
        result = await deps.ceremony.runCeremony({ depositRef: created.depositRef, amount });
      } catch {
        dispatch({ type: "error", reason: "ceremony-rejected" });
        return;
      }
      const clock = depsRef.current.clock ?? DEFAULT_CLOCK;
      dispatch({ type: "ceremony-ok", txRef: result.txRef, now: clock.now() });
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    dispatch({ type: "reset" });
  }, []);

  // The deposit ref that needs a LIVE `ledger:update` subscription: while
  // `pending`; while `credited` WITHOUT a ledger (a status-poll credit that must
  // still be upgraded to server-authoritative balances when the late
  // `ledger:update` lands, M1); AND while `finalizing` — `expired` AFTER the tx
  // was submitted (`txRef` present). The server credits even an expired ref, so a
  // submitted deposit whose TTL elapsed MUST keep its credit-observation path
  // alive or the "still finalizing" copy would never reconcile. The ref value is
  // UNCHANGED across pending → finalizing → poll-credited, so this effect is not
  // torn down and re-armed, and the late credit is never dropped.
  const subscriptionRef =
    state.phase === "pending"
      ? state.depositRef
      : state.phase === "credited" && state.ledger === undefined
        ? state.depositRef
        : state.phase === "expired" && state.txRef !== undefined
          ? state.depositRef
          : undefined;

  useEffect(() => {
    if (subscriptionRef === undefined) {
      return;
    }
    const unsubscribe = depsRef.current.subscription.subscribe(subscriptionRef, (update) => {
      if (update.kind === "credited") {
        dispatch({ type: "credited-ledger", ledger: update.ledger });
      } else {
        dispatch({ type: "failed", detail: update.detail });
      }
    });
    return unsubscribe;
  }, [subscriptionRef]);

  // The deposit ref that needs the status poll: while `pending`, AND while
  // `finalizing` (`expired` AFTER submission). A submitted deposit whose TTL
  // elapsed can STILL credit server-side, so the poll keeps running past expiry to
  // observe that late credit (`credited-poll` upgrades finalizing → credited). The
  // ref value is unchanged across pending → finalizing, so the poll timer is not
  // torn down and re-armed at the boundary.
  const pollRef =
    state.phase === "pending"
      ? state.depositRef
      : state.phase === "expired" && state.txRef !== undefined
        ? state.depositRef
        : undefined;

  useEffect(() => {
    if (pollRef === undefined) {
      return;
    }
    const runPoll = async (): Promise<void> => {
      let status: DepositStatusResponse;
      try {
        status = await depsRef.current.client.getDepositStatus(pollRef);
      } catch {
        return; // A transient poll failure is non-fatal; the next poll retries.
      }
      if (status.status === "credited") {
        dispatch({ type: "credited-poll", txRef: status.txRef });
      } else if (status.status === "expired") {
        dispatch({ type: "expired" });
      }
    };

    const pollTimer = setInterval(() => {
      void runPoll();
    }, depsRef.current.pollIntervalMs ?? 5000);

    return () => {
      clearInterval(pollTimer);
    };
  }, [pollRef]);

  // Elapsed-time tick + TTL enforcement — `pending` ONLY (it needs `expiresAt` /
  // `startedAt`). A deposit already past its TTL on entering `pending` is expired
  // immediately; otherwise a tick advances `elapsedMs` and, once past `expiresAt`,
  // transitions to the finalizing `expired`-with-`txRef` state (M2). The poll and
  // subscription above keep watching that finalizing deposit for its late credit.
  const pendingRef = state.phase === "pending" ? state.depositRef : undefined;
  const pendingExpiresAt = state.phase === "pending" ? state.expiresAt : undefined;

  useEffect(() => {
    if (pendingRef === undefined || pendingExpiresAt === undefined) {
      return;
    }
    const deps = depsRef.current;
    const clock = deps.clock ?? DEFAULT_CLOCK;

    // A deposit that is already past its TTL when we enter pending is expired.
    if (clock.now() >= pendingExpiresAt) {
      dispatch({ type: "expired" });
      return;
    }

    const tickTimer = setInterval(() => {
      dispatch({ type: "tick", now: (depsRef.current.clock ?? DEFAULT_CLOCK).now() });
    }, deps.tickIntervalMs ?? 1000);

    return () => {
      clearInterval(tickTimer);
    };
  }, [pendingRef, pendingExpiresAt]);

  return { state, minimumAmount: options.minimumAmount, submit, reset };
}

// ============================================================================
// Presenter
// ============================================================================

/** Props for the pure {@link TopUpView}. */
export interface TopUpViewProps {
  /** The state to render. */
  readonly state: TopUpState;
  /** The minimum amount, for the form's guidance. */
  readonly minimumAmount: bigint;
  /** Submit a parsed amount (NYXT base units). */
  readonly onSubmit: (amount: bigint) => void;
  /** Reset a terminal state for a retry. */
  readonly onReset: () => void;
}

/** Shared panel chrome so every state reads as one system (mirrors the US5 view). */
function StatePanel(props: {
  readonly testId: string;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <Card data-testid={props.testId} className="max-w-md">
      <CardHeader>
        <div className="flex items-center gap-3">
          {props.icon}
          <CardTitle>{props.title}</CardTitle>
        </div>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      {props.children !== undefined ? (
        <CardContent className="space-y-3">{props.children}</CardContent>
      ) : null}
    </Card>
  );
}

/** The amount-entry form (idle). Parses locally; the hook is the authority. */
function AmountForm(props: {
  readonly minimumAmount: bigint;
  readonly validationError: string | undefined;
  readonly onSubmit: (amount: bigint) => void;
}) {
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | undefined>(undefined);

  const handleSubmit = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    const amount = parseAmountInput(raw);
    if (amount === undefined) {
      setParseError("Enter a whole NYXT amount greater than zero.");
      return;
    }
    setParseError(undefined);
    props.onSubmit(amount);
  };

  const error = parseError ?? props.validationError;

  return (
    <StatePanel
      testId="topup-idle"
      icon={<Wallet className="size-6 shrink-0 text-primary" aria-hidden="true" />}
      title="Top up NYXT"
      description={`Add NYXT to cover your prompts. Minimum ${props.minimumAmount.toString()} NYXT.`}
    >
      <form className="space-y-3" onSubmit={handleSubmit}>
        <div className="space-y-1">
          <label htmlFor="topup-amount" className="text-sm font-medium">
            Amount (NYXT base units)
          </label>
          <input
            id="topup-amount"
            data-testid="topup-amount"
            inputMode="numeric"
            className="border-input bg-background focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
            }}
            placeholder="1000"
          />
        </div>
        {error !== undefined ? (
          <p data-testid="topup-validation-error" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit">
          <Wallet className="size-4" aria-hidden="true" />
          Top up
        </Button>
      </form>
    </StatePanel>
  );
}

/** A spinner row used by the in-flight phases. */
function Spinner(props: { readonly label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

/** A labelled monetary value row (server-provided amounts only, FR-070). */
function AmountRow(props: { readonly label: string; readonly value: bigint }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <code className="font-mono">{props.value.toString()}</code>
    </div>
  );
}

/**
 * Render the top-up surface for a given state. Exhaustive over {@link TopUpState}
 * — adding a phase without a branch is a type error.
 */
export function TopUpView({ state, minimumAmount, onSubmit, onReset }: TopUpViewProps) {
  switch (state.phase) {
    case "idle":
      return (
        <AmountForm
          minimumAmount={minimumAmount}
          validationError={state.validationError}
          onSubmit={onSubmit}
        />
      );

    case "preregistering":
      return (
        <StatePanel
          testId="topup-preregistering"
          icon={
            <LoaderCircle
              className="size-6 shrink-0 animate-spin text-primary"
              aria-hidden="true"
            />
          }
          title="Preparing deposit"
          description="Reserving a deposit reference…"
        >
          <Spinner label="Contacting the ledger service…" />
        </StatePanel>
      );

    case "awaiting-signature":
      return (
        <StatePanel
          testId="topup-awaiting-signature"
          icon={
            <LoaderCircle
              className="size-6 shrink-0 animate-spin text-primary"
              aria-hidden="true"
            />
          }
          title="Confirm in your wallet"
          description="Approve the deposit transaction in your wallet to continue."
        >
          <Spinner label="Waiting for signature and proof…" />
        </StatePanel>
      );

    case "pending":
      return (
        <StatePanel
          testId="topup-pending"
          icon={<Clock3 className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title="Deposit pending"
          description="Your deposit was submitted. Your balance updates once it is finalized on-chain."
        >
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Elapsed</span>
            <span className="font-mono">{formatElapsed(state.elapsedMs)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Transaction</span>
            <code className="font-mono" title={state.txRef}>
              {state.txRef}
            </code>
          </div>
        </StatePanel>
      );

    case "credited":
      return (
        <StatePanel
          testId="topup-credited"
          icon={<CircleCheck className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title="Top-up credited"
          description="Your deposit was credited to your NYXT balance."
        >
          {state.ledger !== undefined ? (
            <>
              <AmountRow label="Credited" value={state.ledger.creditedAmount} />
              <AmountRow label="Available" value={state.ledger.available} />
              <AmountRow label="Reserved" value={state.ledger.reserved} />
            </>
          ) : (
            // No server ledger yet (credited via the status poll, which carries no
            // balance). Label the client-entered figure "Requested" — NEVER
            // "Deposited"/"Credited" — so a typed amount can't be mistaken for the
            // settled server total (FR-070). The late `ledger:update` upgrades this.
            <AmountRow label="Requested" value={state.amount} />
          )}
        </StatePanel>
      );

    case "failed":
      return (
        <StatePanel
          testId="topup-failed"
          icon={<TriangleAlert className="size-6 shrink-0 text-destructive" aria-hidden="true" />}
          title="Deposit failed"
          description="The deposit transaction did not succeed on-chain. Your balance was not changed."
        >
          <p className="text-muted-foreground font-mono text-xs break-words">{state.detail}</p>
          <Button variant="outline" onClick={onReset}>
            Try again
          </Button>
        </StatePanel>
      );

    case "expired":
      // A submitted tx exists (txRef): the deposit may STILL late-credit, so we
      // must not offer a re-submit — a second deposit would double-charge (M2).
      return state.txRef !== undefined ? (
        <StatePanel
          testId="topup-expired-finalizing"
          icon={<Clock3 className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title="Still finalizing"
          description="This deposit reference's window elapsed, but your submitted transaction may still finalize and credit your balance. Do not start another top-up — this will reconcile automatically."
        >
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Transaction</span>
            <code className="font-mono" title={state.txRef}>
              {state.txRef}
            </code>
          </div>
        </StatePanel>
      ) : (
        // No tx was ever submitted (expiry before signature): a fresh top-up is safe.
        <StatePanel
          testId="topup-expired"
          icon={<Clock3 className="size-6 shrink-0 text-destructive" aria-hidden="true" />}
          title="Deposit reference expired"
          description="This deposit reference expired before a transaction was submitted. Start a new top-up to try again."
        >
          <Button variant="outline" onClick={onReset}>
            Try again
          </Button>
        </StatePanel>
      );

    case "error":
      return (
        <StatePanel
          testId="topup-error"
          icon={<TriangleAlert className="size-6 shrink-0 text-destructive" aria-hidden="true" />}
          title={
            state.reason === "ceremony-rejected"
              ? "Signature not completed"
              : "Could not start top-up"
          }
          description={
            state.reason === "ceremony-rejected"
              ? "The deposit was not signed. No transaction was submitted — you can try again."
              : "We could not reach the ledger service to start your top-up. Check your connection and try again."
          }
        >
          <Button variant="outline" onClick={onReset}>
            Try again
          </Button>
        </StatePanel>
      );
  }
}

// ============================================================================
// Container
// ============================================================================

/** Props for the {@link TopUp} container — the injected seams (see {@link UseTopUpOptions}). */
export type TopUpProps = UseTopUpOptions;

/**
 * Bind {@link useTopUp} to the pure {@link TopUpView}. The real app wires the
 * seams once (an `HttpDepositClient`, the OWNER-GATED ceremony, and the
 * `ledger:update` subscription) and mounts this; tests inject fakes.
 */
export function TopUp(props: TopUpProps) {
  const { state, minimumAmount, submit, reset } = useTopUp(props);

  const onSubmit = useCallback(
    (amount: bigint) => {
      void submit(amount);
    },
    [submit],
  );

  return (
    <TopUpView state={state} minimumAmount={minimumAmount} onSubmit={onSubmit} onReset={reset} />
  );
}

// ============================================================================
// OWNER-GATED real ceremony adapter (stub)
// ============================================================================

/**
 * TODO(owner-gated, T115 R4 spike): the REAL deposit signing ceremony.
 *
 * Building the `deposit(depositRef, amount)` transaction, running the single Lace
 * signing prompt, and proving via the session-authenticated same-origin prover
 * proxy (`POST /prover/prove`, D37/D62) all touch Midnight SDK tx shapes that
 * MUST NOT be written from memory (constitution I) and depend on the R4 Lace
 * vault-funding proof (the owner-run T115 spike). Until that lands, this adapter
 * throws so it can never be mistaken for a working implementation; every test
 * injects a fake {@link DepositCeremony} instead.
 */
export function createOwnerGatedCeremony(): DepositCeremony {
  return {
    runCeremony: () =>
      Promise.reject(
        new Error(
          "DepositCeremony is owner-gated (T115 R4 spike): the Midnight SDK tx build + Lace " +
            "signing + prover-proxy proving adapter is not implemented. Inject a real ceremony.",
        ),
      ),
  };
}
