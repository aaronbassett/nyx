/**
 * Deploy-wallet balance SDK-boundary tests (P4 Task 3) — deterministic, NO chain, NO SDK loaded.
 *
 * `balance-sdk-adapter.ts` is the ONE module that WILL touch the Midnight wallet SDK to read the
 * deploy wallet's tDUST/NIGHT balance. Reading a balance needs a FUNDED, DUST-registered, SYNCED
 * wallet (`MidnightWalletProvider.build` + `.start()` + `firstValueFrom(wallet.state())`, ~30 s) —
 * a credential P5 provides — so the real read is OWNER-GATED behind the injectable
 * {@link ReadWalletBalance} seam. These tests pin the two shapes that matter WITHOUT a wallet:
 *
 *  - the DEFAULT adapter (no seam wired) REJECTS with {@link BalanceSdkNotWiredError} on every read
 *    (an unwired adapter can never be mistaken for a `0n` balance — fail-closed);
 *  - an INJECTED {@link ReadWalletBalance} is delegated to verbatim (the shape the owner wires).
 */
import { describe, expect, it } from "vitest";
import type { NetworkProfile } from "../../src/config/index.js";
import {
  BalanceSdkNotWiredError,
  createBalanceSdkAdapter,
  type ReadWalletBalance,
} from "../../src/deploy/balance-sdk-adapter.js";

const NETWORK: NetworkProfile = {
  id: "local-devnet",
  networkId: "Undeployed",
  nodeUrl: "http://localhost:9944",
  indexerUrl: "http://localhost:8088",
  proofServerUrl: "http://localhost:6300",
};

const AT = new Date("2026-07-24T12:00:00.000Z");

describe("createBalanceSdkAdapter", () => {
  it("rejects with BalanceSdkNotWiredError when the real read is not wired (fail-closed)", async () => {
    const sdk = createBalanceSdkAdapter();

    await expect(
      sdk.readBalance({ signingKey: "any", network: NETWORK, at: AT }),
    ).rejects.toBeInstanceOf(BalanceSdkNotWiredError);
  });

  it("the not-wired rejection never leaks the signing key (SC-031)", async () => {
    // Teeth (Opus-2): the key-leak assertion lives only inside `.catch()`, so pin the assertion
    // count — if the adapter ever STOPS rejecting, the catch never runs and this test FAILS loudly
    // (rather than passing vacuously).
    expect.assertions(1);
    const sdk = createBalanceSdkAdapter();
    const key = "secret-deploy-key-1234567890";

    await sdk.readBalance({ signingKey: key, network: NETWORK, at: AT }).catch((error: unknown) => {
      const text =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
          : String(error);
      expect(text).not.toContain(key);
    });
  });

  it("delegates to an injected ReadWalletBalance seam verbatim", async () => {
    const calls: { signingKey: string; network: NetworkProfile; at: Date }[] = [];
    const readWalletBalance: ReadWalletBalance = (input) => {
      calls.push(input);
      return Promise.resolve({ dust: 2n ** 65n, night: 250_000_000_000_000n });
    };
    const sdk = createBalanceSdkAdapter({ readWalletBalance });

    const reading = await sdk.readBalance({ signingKey: "k", network: NETWORK, at: AT });

    expect(reading).toEqual({ dust: 2n ** 65n, night: 250_000_000_000_000n });
    expect(calls).toEqual([{ signingKey: "k", network: NETWORK, at: AT }]);
  });
});
