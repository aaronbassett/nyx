/**
 * Deploy-wallet monitor contract tests (T161, US8) — deterministic, in-memory, NO chain.
 * Pins the tDUST fee-wallet monitoring + EC-38 platform-fault semantics the deploy
 * pipeline depends on (FR-059, EC-38):
 *
 *  - a balance ABOVE `lowThreshold` classifies `ok` and fires NO alert (steady state);
 *  - a balance BELOW `lowThreshold` (but able to fund a deploy) classifies `low` and
 *    fires a structured {@link WalletAlert} so ops is notified (FR-059);
 *  - a balance at/below zero OR below the per-deploy floor classifies `exhausted` and
 *    fires an alert (the wallet can no longer fund a deploy);
 *  - `assertCanDeploy` REJECTS an exhausted wallet with {@link InsufficientDeployFundsError}
 *    flagged as a PLATFORM fault carrying a user-safe message (EC-38 — the outage is
 *    surfaced as platform-side, NEVER as a user fault), and RESOLVES when fundable;
 *  - every classification is deterministic: the balance ({@link WalletBalanceStatus}) comes
 *    from an injected `queryBalance` seam and every timestamp from an injected clock — no
 *    wall-clock, no randomness, no real chain (constitution I/IV).
 *
 * The `queryBalance` seam is a Nyx-internal function returning `bigint` base units; the REAL
 * Midnight SDK/indexer balance adapter is owner-gated (never hand-written from memory).
 */
import { describe, expect, it } from "vitest";
import {
  classifyBalance,
  createDeployWalletMonitor,
  DEFAULT_MIN_DEPLOY_BALANCE,
  InsufficientDeployFundsError,
  PLATFORM_REFUELLING_MESSAGE,
} from "../../src/deploy/wallet.js";
import type {
  DeployWalletMonitorDeps,
  WalletAlert,
  WalletBalanceStatus,
} from "../../src/deploy/wallet.js";

const LOW_THRESHOLD = 1_000n;
const FIXED_TS = 1_700_000_000_000;

// --- Test doubles -----------------------------------------------------------

/** A recording alert sink so FR-059 notifications are assertable. */
function recordingAlert(): { sink: (alert: WalletAlert) => void; alerts: WalletAlert[] } {
  const alerts: WalletAlert[] = [];
  return {
    sink: (alert: WalletAlert): void => {
      alerts.push(alert);
    },
    alerts,
  };
}

/**
 * Build a monitor over a FIXED balance + injected clock/alert sink. `available` is the
 * value the (owner-gated in production) `queryBalance` seam returns.
 */
function monitorForBalance(
  available: bigint,
  overrides: Partial<Pick<DeployWalletMonitorDeps, "lowThreshold" | "minDeployBalance">> = {},
): { monitor: ReturnType<typeof createDeployWalletMonitor>; alerts: WalletAlert[] } {
  const { sink, alerts } = recordingAlert();
  const deps: DeployWalletMonitorDeps = {
    queryBalance: () => Promise.resolve(available),
    lowThreshold: overrides.lowThreshold ?? LOW_THRESHOLD,
    alert: sink,
    now: () => FIXED_TS,
    ...(overrides.minDeployBalance === undefined
      ? {}
      : { minDeployBalance: overrides.minDeployBalance }),
  };
  return { monitor: createDeployWalletMonitor(deps), alerts };
}

// --- classifyBalance (pure) -------------------------------------------------

describe("classifyBalance", () => {
  it("classifies a balance above the low threshold as ok", () => {
    expect(classifyBalance(5_000n, LOW_THRESHOLD, DEFAULT_MIN_DEPLOY_BALANCE)).toBe("ok");
  });

  it("treats a balance exactly AT the low threshold as ok (strict <)", () => {
    expect(classifyBalance(LOW_THRESHOLD, LOW_THRESHOLD, DEFAULT_MIN_DEPLOY_BALANCE)).toBe("ok");
  });

  it("classifies a balance below the low threshold as low", () => {
    expect(classifyBalance(500n, LOW_THRESHOLD, DEFAULT_MIN_DEPLOY_BALANCE)).toBe("low");
  });

  it("classifies a zero balance as exhausted", () => {
    expect(classifyBalance(0n, LOW_THRESHOLD, DEFAULT_MIN_DEPLOY_BALANCE)).toBe("exhausted");
  });

  it("classifies a positive balance below the per-deploy floor as exhausted", () => {
    // Positive but cannot cover a single deploy → exhausted (the min-deploy floor branch).
    expect(classifyBalance(100n, LOW_THRESHOLD, 500n)).toBe("exhausted");
  });
});

// --- checkBalance -----------------------------------------------------------

describe("createDeployWalletMonitor.checkBalance", () => {
  it("returns ok and fires NO alert when the balance is healthy", async () => {
    const { monitor, alerts } = monitorForBalance(5_000n);

    const status: WalletBalanceStatus = await monitor.checkBalance();

    expect(status).toEqual({ available: 5_000n, level: "ok" });
    expect(alerts).toHaveLength(0);
  });

  it("returns low and fires a structured alert below the low threshold (FR-059)", async () => {
    const { monitor, alerts } = monitorForBalance(500n);

    const status = await monitor.checkBalance();

    expect(status).toEqual({ available: 500n, level: "low" });
    expect(alerts).toEqual([
      { level: "low", available: 500n, threshold: LOW_THRESHOLD, ts: FIXED_TS },
    ]);
  });

  it("returns exhausted and fires an alert at a zero balance", async () => {
    const { monitor, alerts } = monitorForBalance(0n);

    const status = await monitor.checkBalance();

    expect(status).toEqual({ available: 0n, level: "exhausted" });
    expect(alerts).toEqual([
      { level: "exhausted", available: 0n, threshold: DEFAULT_MIN_DEPLOY_BALANCE, ts: FIXED_TS },
    ]);
  });

  it("returns exhausted below the per-deploy floor and reports the floor as the threshold", async () => {
    const { monitor, alerts } = monitorForBalance(100n, { minDeployBalance: 500n });

    const status = await monitor.checkBalance();

    expect(status).toEqual({ available: 100n, level: "exhausted" });
    expect(alerts).toEqual([
      { level: "exhausted", available: 100n, threshold: 500n, ts: FIXED_TS },
    ]);
  });

  it("propagates a queryBalance seam failure without firing an alert", async () => {
    const { sink, alerts } = recordingAlert();
    const seamFailure = new Error("indexer unreachable");
    const monitor = createDeployWalletMonitor({
      queryBalance: () => Promise.reject(seamFailure),
      lowThreshold: LOW_THRESHOLD,
      alert: sink,
      now: () => FIXED_TS,
    });

    await expect(monitor.checkBalance()).rejects.toBe(seamFailure);
    expect(alerts).toHaveLength(0);
  });
});

// --- assertCanDeploy --------------------------------------------------------

describe("createDeployWalletMonitor.assertCanDeploy", () => {
  it("resolves with the status when the wallet can fund a deploy", async () => {
    const { monitor, alerts } = monitorForBalance(5_000n);

    await expect(monitor.assertCanDeploy()).resolves.toEqual({
      available: 5_000n,
      level: "ok",
    });
    expect(alerts).toHaveLength(0);
  });

  it("resolves for a low (still fundable) wallet but fires the low alert", async () => {
    const { monitor, alerts } = monitorForBalance(500n);

    await expect(monitor.assertCanDeploy()).resolves.toEqual({
      available: 500n,
      level: "low",
    });
    expect(alerts).toHaveLength(1);
  });

  it("rejects an exhausted wallet as a PLATFORM fault and fires the ops alert (EC-38)", async () => {
    const { monitor, alerts } = monitorForBalance(0n);

    await expect(monitor.assertCanDeploy()).rejects.toBeInstanceOf(InsufficientDeployFundsError);
    // EC-38: the exhaustion still fires an ops alert (ops alert fires; refund is a runbook item).
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe("exhausted");
  });

  it("frames the rejection as platform-side and NEVER blames the user (EC-38)", async () => {
    const { monitor } = monitorForBalance(100n, { minDeployBalance: 500n });

    const error = await monitor.assertCanDeploy().then(
      () => {
        throw new Error("expected assertCanDeploy to reject");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InsufficientDeployFundsError);
    if (!(error instanceof InsufficientDeployFundsError)) {
      throw new Error("unreachable");
    }
    // The error is flagged a platform fault (typed reason the deploy handler branches on).
    expect(error.platformFault).toBe(true);
    // The technical fields are carried for ops/runbook use.
    expect(error.available).toBe(100n);
    expect(error.required).toBe(500n);
    // The user-facing message frames a platform-side outage — never a user fault.
    const userMessage = error.platformFaultMessage();
    expect(userMessage).toBe(PLATFORM_REFUELLING_MESSAGE);
    expect(userMessage.toLowerCase()).toContain("platform");
    // EC-38: it must NOT say the USER is out of funds / at fault.
    expect(userMessage).not.toMatch(/\byou\b|\byour\b|out of funds|insufficient funds/i);
  });
});
