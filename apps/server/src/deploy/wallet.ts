/**
 * Deploy-wallet balance monitor (T161, US8) — tDUST fee-wallet health + EC-38 framing.
 *
 * The server DEPLOY WALLET (the deploy key's on-chain account, D52) pays the tDUST fees for
 * every DApp deploy. FR-059 requires its tDUST balance to be MONITORED WITH ALERTING, and —
 * critically — that an exhaustion failure present as a PLATFORM-SIDE issue, NEVER a user
 * fault (EC-38: "Deploy fails loudly as a platform-side issue; ops alert fires; refunding is
 * a runbook item"). This module is exactly that monitor: query → classify → alert, plus a
 * pre-deploy gate that rejects a broke wallet with the EC-38 framing baked in.
 *
 * The monitor is a FOCUSED read-and-notify surface — it performs NO on-chain writes and
 * holds NO deploy key. It runs on two paths:
 *  - {@link DeployWalletMonitor.checkBalance} — a scheduled/on-demand poll: it classifies the
 *    balance ({@link WalletBalanceStatus}) and, on `low`/`exhausted`, fires the injected
 *    {@link WalletAlert} sink so ops is notified BEFORE deploys start failing (FR-059);
 *  - {@link DeployWalletMonitor.assertCanDeploy} — a pre-deploy gate the deploy pipeline/handler
 *    calls: it re-checks (so a deploy attempt against a broke wallet ALSO fires the ops
 *    alert, per EC-38) and, when the wallet cannot fund a deploy, REJECTS with a named
 *    {@link InsufficientDeployFundsError} flagged as a PLATFORM fault and carrying a user-safe
 *    message ({@link PLATFORM_REFUELLING_MESSAGE}) that frames the outage as platform-side —
 *    never "you are out of funds".
 *
 * CONSTITUTION I — the balance itself is read through a NARROW, Nyx-INTERNAL seam
 * ({@link BalanceQuery}: `() => Promise<bigint>` base units). This is deliberately NOT any
 * `@midnight-ntwrk/*` wallet/indexer type; the REAL SDK/indexer balance-query adapter is
 * OWNER-GATED and MUST NOT be hand-written from memory. Everything here is deterministic —
 * the balance comes from the injected query, every timestamp from the injected clock, and
 * the alert goes to the injected sink — so the monitoring/messaging logic is fully testable
 * without a chain, wall-clock, or randomness (constitution IV).
 *
 * Thresholds are injectable (never hardcoded, mirroring the D47 deposit tunables). The
 * `lowThreshold` (warn ops while deploys still work) is REQUIRED; the per-deploy floor
 * ({@link DeployWalletMonitorDeps.minDeployBalance}) defaults to
 * {@link DEFAULT_MIN_DEPLOY_BALANCE}. tDUST is valueless on pre-prod/devnet (D51): this is
 * about the platform's own fee wallet not STRANDING deploys, not about user funds.
 */

/**
 * The tDUST balance-query seam (constitution I). Returns the deploy wallet's spendable
 * balance in base units. The production implementation reads the Midnight SDK/indexer and is
 * OWNER-GATED — it is NEVER hand-written from memory. Tests inject a fixed-value stub.
 */
export type BalanceQuery = () => Promise<bigint>;

/**
 * A balance classification. `ok` = healthy; `low` = below {@link DeployWalletMonitorDeps.lowThreshold}
 * but still able to fund a deploy (warn ops, deploys continue); `exhausted` = at/below zero
 * OR below the per-deploy floor (the wallet can no longer fund a deploy).
 */
export type WalletBalanceLevel = "ok" | "low" | "exhausted";

/** The two levels that raise an alert (a `WalletBalanceLevel` minus the healthy `ok`). */
export type WalletAlertLevel = "low" | "exhausted";

/**
 * The result of {@link DeployWalletMonitor.checkBalance}: the observed balance and its
 * classification. Deterministic — `available` is exactly what the injected query returned.
 */
export interface WalletBalanceStatus {
  /** The deploy wallet's spendable tDUST balance in base units, as observed. */
  readonly available: bigint;
  /** The classification of `available` (see {@link WalletBalanceLevel}). */
  readonly level: WalletBalanceLevel;
}

/**
 * A structured ops alert (FR-059). Emitted to the injected sink whenever the balance falls
 * to `low` or `exhausted` so ops can top up the deploy wallet before (or as) deploys start
 * failing. Carries enough context to page/route without a follow-up query.
 */
export interface WalletAlert {
  /** Which floor was breached — `low` (warning) or `exhausted` (deploys can't be funded). */
  readonly level: WalletAlertLevel;
  /** The observed balance in base units at the time of the alert. */
  readonly available: bigint;
  /**
   * The threshold that was breached: `lowThreshold` for a `low` alert, or the per-deploy
   * floor for an `exhausted` alert. Together with `available` it quantifies the shortfall.
   */
  readonly threshold: bigint;
  /** Epoch-ms timestamp from the injected clock (never a wall-clock read in tests). */
  readonly ts: number;
}

/** The alert sink seam — injected so FR-059 notifications are routed (and assertable). */
export type WalletAlertSink = (alert: WalletAlert) => void;

/** Construction config for {@link createDeployWalletMonitor} (injectable seams + thresholds). */
export interface DeployWalletMonitorDeps {
  /**
   * The tDUST balance seam (constitution I). Returns base units. The real Midnight
   * SDK/indexer adapter is OWNER-GATED — never hand-written from memory.
   */
  readonly queryBalance: BalanceQuery;
  /**
   * The low-water threshold in base units: below it (but at/above the per-deploy floor) the
   * balance is `low` and an alert fires while deploys still succeed. Injected (never
   * hardcoded); US1 wires the operational value.
   */
  readonly lowThreshold: bigint;
  /** The ops alert sink (FR-059). Called on every `low`/`exhausted` classification. */
  readonly alert: WalletAlertSink;
  /**
   * The minimum balance in base units that can fund a SINGLE deploy's tDUST fees. Below it
   * (or at/below zero) the balance is `exhausted` and {@link DeployWalletMonitor.assertCanDeploy}
   * rejects. Optional; defaults to {@link DEFAULT_MIN_DEPLOY_BALANCE}. The REAL per-deploy
   * fee reserve is owner-gated (never a fee magnitude from memory) — US1/config injects it.
   */
  readonly minDeployBalance?: bigint;
  /** Epoch-ms clock; defaults to {@link Date.now}. Injected for deterministic timestamps. */
  readonly now?: () => number;
}

/** The monitor surface the deploy pipeline consumes. */
export interface DeployWalletMonitor {
  /**
   * Query the deploy wallet, classify the balance, and — on `low`/`exhausted` — fire the
   * ops alert (FR-059). Resolves with the {@link WalletBalanceStatus}. A `queryBalance` seam
   * failure propagates as a rejection (no alert is fired for a query fault).
   */
  checkBalance(): Promise<WalletBalanceStatus>;
  /**
   * Pre-deploy gate. Re-checks the balance (so a deploy attempt against a broke wallet also
   * fires the ops alert, EC-38), then: resolves with the status when the wallet can fund a
   * deploy (`ok` or `low`), or REJECTS with an {@link InsufficientDeployFundsError} — a
   * PLATFORM fault carrying a user-safe message — when `exhausted`.
   */
  assertCanDeploy(): Promise<WalletBalanceStatus>;
}

/**
 * Default per-deploy floor: `0n`. Without a configured fee reserve, `exhausted` means the
 * wallet is LITERALLY empty (`available <= 0n`). This is a deliberately conservative
 * placeholder — the true per-deploy tDUST fee reserve depends on the live fee model and is
 * OWNER-GATED (never a fee magnitude from memory, constitution I); US1/config injects the
 * real floor via {@link DeployWalletMonitorDeps.minDeployBalance} once it is known.
 */
export const DEFAULT_MIN_DEPLOY_BALANCE = 0n;

/**
 * The user-facing message for an exhausted deploy wallet (EC-38). It frames the outage as a
 * PLATFORM-side issue and is deliberately free of any user-fault language ("you"/"your"/"out
 * of funds") — a deploy failing because the platform's fee wallet is empty is NEVER the
 * user's fault.
 */
export const PLATFORM_REFUELLING_MESSAGE =
  "Deploys are temporarily unavailable while the platform refuels. Please try again shortly.";

/**
 * Classify a deploy-wallet balance against its thresholds. `exhausted` (most severe) is
 * checked FIRST so a misconfigured `lowThreshold <= minDeployBalance` never masks it:
 *  - `exhausted` when `available <= 0n` OR `available < minDeployBalance` (cannot fund a
 *    single deploy);
 *  - `low` when `available < lowThreshold` (but fundable) — warn ops, deploys continue;
 *  - `ok` otherwise.
 *
 * Pure and total: no I/O, no clock, no randomness (fully deterministic).
 */
export function classifyBalance(
  available: bigint,
  lowThreshold: bigint,
  minDeployBalance: bigint,
): WalletBalanceLevel {
  if (available <= 0n || available < minDeployBalance) {
    return "exhausted";
  }
  if (available < lowThreshold) {
    return "low";
  }
  return "ok";
}

/**
 * A deploy blocked because the platform's deploy wallet cannot fund the tDUST fees (EC-38).
 * This is ALWAYS a PLATFORM fault, never a user fault: `platformFault` is a fixed `true`
 * (the typed reason the deploy handler branches on to surface EC-38 correctly), and
 * {@link platformFaultMessage} yields the user-safe, platform-framed message. The technical
 * `available`/`required` fields back the ops alert + refund runbook (they are NOT for the
 * end user). The `message` is a diagnostic for server logs — never the user-facing string.
 */
export class InsufficientDeployFundsError extends Error {
  /**
   * EC-38 discriminant: this fault is ALWAYS platform-side. A deploy handler reads this to
   * choose the platform-fault presentation path (never a user-fault one).
   */
  readonly platformFault = true as const;

  constructor(
    /** The observed deploy-wallet balance in base units (ops/runbook context, not user-facing). */
    readonly available: bigint,
    /** The per-deploy floor the balance fell short of, in base units (ops/runbook context). */
    readonly required: bigint,
  ) {
    super(
      `deploy wallet cannot fund a deploy: ${String(available)} < required floor ${String(required)}`,
    );
    this.name = "InsufficientDeployFundsError";
  }

  /**
   * The user-facing, platform-framed message (EC-38) — the ONLY string safe to show a user.
   * Never blames the user; presents the outage as platform-side and transient.
   */
  platformFaultMessage(): string {
    return PLATFORM_REFUELLING_MESSAGE;
  }
}

/**
 * Construct a {@link DeployWalletMonitor} (T161). Injects the (owner-gated) balance seam, the
 * thresholds, the alert sink, and the clock; US1 wires the operational thresholds + the real
 * balance adapter. Side-effect-free at construction — the query/alert only run on a call.
 */
export function createDeployWalletMonitor(deps: DeployWalletMonitorDeps): DeployWalletMonitor {
  const now = deps.now ?? (() => Date.now());
  const minDeployBalance = deps.minDeployBalance ?? DEFAULT_MIN_DEPLOY_BALANCE;

  async function checkBalance(): Promise<WalletBalanceStatus> {
    // The balance query is the owner-gated seam; a query fault propagates (no alert fired).
    const available = await deps.queryBalance();
    const level = classifyBalance(available, deps.lowThreshold, minDeployBalance);
    if (level !== "ok") {
      // Report the breached threshold: the per-deploy floor when exhausted, else lowThreshold.
      const threshold = level === "exhausted" ? minDeployBalance : deps.lowThreshold;
      deps.alert({ level, available, threshold, ts: now() });
    }
    return { available, level };
  }

  async function assertCanDeploy(): Promise<WalletBalanceStatus> {
    // Re-check on the deploy path so an attempt against a broke wallet ALSO alerts ops (EC-38).
    const status = await checkBalance();
    if (status.level === "exhausted") {
      throw new InsufficientDeployFundsError(status.available, minDeployBalance);
    }
    return status;
  }

  return { checkBalance, assertCanDeploy };
}
