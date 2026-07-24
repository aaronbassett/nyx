/**
 * Deploy-wallet tDUST `BalanceQuery` contract tests (P4 Task 3) — deterministic, NO chain, NO SDK.
 *
 * `createDevnetBalanceQuery` fills the real deploy-wallet {@link BalanceQuery} seam that the EC-38
 * monitor (`wallet.ts`) consumes. The whole point of the seam is fail-CLOSED money safety, so these
 * tests pin exactly that, all behind an injected FAKE {@link BalanceSdk} (the SDK boundary) so no
 * `@midnight-ntwrk/*`, no wallet, no devnet is ever touched:
 *
 *  - the query returns the DUST balance as an EXACT `bigint` — a value > 2^63 round-trips with no
 *    `Number()` truncation (fees are spent in DUST, so the monitor's floor gates on DUST);
 *  - the DUST read is TIME-DEPENDENT (DUST accrues from registered NIGHT), so the injected clock's
 *    instant is threaded to the SDK as the evaluation `at` Date;
 *  - the deploy `signingKey` + `network` are threaded to the SDK and NOTHING else reads them;
 *  - an SDK rejection PROPAGATES as a rejection — NEVER resolved as `0n`. A zero balance means
 *    "exhausted", an error means "unknown"; the monitor's {@link classifyBalance} must not conflate
 *    them, so the query fails closed (a rejection is the loud "balance unavailable");
 *  - the signing key NEVER appears in any rejection (constitution III / SC-031);
 *  - with NO injected SDK the default is the lazily-loaded real adapter, which is OWNER-GATED and
 *    REJECTS with {@link BalanceSdkNotWiredError} (never a false `0n`) until a funded deploy wallet
 *    lands — proving the unwired default is fail-closed and key-free.
 */
import { describe, expect, it } from "vitest";
import type { NetworkProfile } from "../../src/config/index.js";
import {
  createDevnetBalanceQuery,
  type BalanceReading,
  type BalanceSdk,
} from "../../src/deploy/balance.js";
import { BalanceSdkNotWiredError } from "../../src/deploy/balance-sdk-adapter.js";

// A canary signing key we assert is NEVER echoed into a rejection (SC-031).
const CANARY_KEY = "canary-deploy-signing-key-000000000000000000000000000000000000";

const NETWORK: NetworkProfile = {
  id: "local-devnet",
  networkId: "Undeployed",
  nodeUrl: "http://localhost:9944",
  indexerUrl: "http://localhost:8088",
  proofServerUrl: "http://localhost:6300",
};

/** A recording fake {@link BalanceSdk}: returns a fixed reading and captures each call's input. */
function fakeSdk(reading: BalanceReading): {
  sdk: BalanceSdk;
  calls: { signingKey: string; network: NetworkProfile; at: Date }[];
} {
  const calls: { signingKey: string; network: NetworkProfile; at: Date }[] = [];
  return {
    sdk: {
      readBalance: (input) => {
        calls.push({ signingKey: input.signingKey, network: input.network, at: input.at });
        return Promise.resolve(reading);
      },
    },
    calls,
  };
}

describe("createDevnetBalanceQuery", () => {
  it("returns the DUST balance as an exact bigint (no Number() truncation above 2^63)", async () => {
    // A value that overflows a signed 64-bit int — a `Number()` anywhere would corrupt it.
    const hugeDust = 2n ** 70n + 123_456_789n;
    const { sdk } = fakeSdk({ dust: hugeDust, night: 999n });
    const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY, sdk });

    const balance = await query();

    expect(balance).toBe(hugeDust);
    expect(typeof balance).toBe("bigint");
  });

  it("gates on DUST (fees are DUST), not NIGHT — returns the dust field even when it differs", async () => {
    const { sdk } = fakeSdk({ dust: 42n, night: 1_000_000n });
    const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY, sdk });

    await expect(query()).resolves.toBe(42n);
  });

  it("threads the injected clock's instant to the SDK as the time-dependent evaluation `at`", async () => {
    const { sdk, calls } = fakeSdk({ dust: 1n, night: 1n });
    const fixed = new Date("2026-07-24T12:00:00.000Z");
    const query = createDevnetBalanceQuery({
      network: NETWORK,
      signingKey: CANARY_KEY,
      sdk,
      now: () => fixed,
    });

    await query();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.at).toBe(fixed);
  });

  it("re-evaluates the clock on every call (DUST accrues over time)", async () => {
    const { sdk, calls } = fakeSdk({ dust: 1n, night: 1n });
    const instants = [new Date("2026-07-24T12:00:00.000Z"), new Date("2026-07-24T12:05:00.000Z")];
    const fallback = new Date("2026-07-24T12:10:00.000Z");
    let i = 0;
    const query = createDevnetBalanceQuery({
      network: NETWORK,
      signingKey: CANARY_KEY,
      sdk,
      now: () => instants[i++] ?? fallback,
    });

    await query();
    await query();

    expect(calls.map((c) => c.at)).toEqual(instants);
  });

  it("threads the signingKey + network to the SDK", async () => {
    const { sdk, calls } = fakeSdk({ dust: 1n, night: 1n });
    const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY, sdk });

    await query();

    expect(calls[0]?.signingKey).toBe(CANARY_KEY);
    expect(calls[0]?.network).toBe(NETWORK);
  });

  it("propagates an SDK rejection (fail-closed) — NEVER resolves 0n on error", async () => {
    const boom = new Error("indexer unreachable");
    const sdk: BalanceSdk = { readBalance: () => Promise.reject(boom) };
    const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY, sdk });

    await expect(query()).rejects.toBe(boom);
  });

  it("never echoes the signing key into a propagated rejection (SC-031)", async () => {
    // Even a maliciously key-echoing SDK error must not gain the key FROM our wrapper; and our
    // wrapper must add nothing that leaks it. We assert the wrapper adds no key-bearing frame.
    const sdk: BalanceSdk = {
      readBalance: () => Promise.reject(new Error("balance read failed")),
    };
    const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY, sdk });

    await expect(query()).rejects.toThrow();
    await query().catch((error: unknown) => {
      const text =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      expect(text).not.toContain(CANARY_KEY);
    });
  });

  describe("default (unwired) SDK — owner-gated, fail-closed", () => {
    it("rejects with BalanceSdkNotWiredError (never a false 0n)", async () => {
      const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY });

      await expect(query()).rejects.toBeInstanceOf(BalanceSdkNotWiredError);
    });

    it("the not-wired rejection never leaks the signing key", async () => {
      // Teeth (Opus-2): the key-leak assertion runs only inside `.catch()`, so pin the count — if
      // the query ever STOPS rejecting, the catch never fires and this test FAILS instead of
      // passing vacuously.
      expect.assertions(1);
      const query = createDevnetBalanceQuery({ network: NETWORK, signingKey: CANARY_KEY });

      await query().catch((error: unknown) => {
        const text =
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
            : String(error);
        expect(text).not.toContain(CANARY_KEY);
      });
    });
  });
});
