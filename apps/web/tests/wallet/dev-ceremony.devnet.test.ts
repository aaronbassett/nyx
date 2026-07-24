// @vitest-environment node
/**
 * Dev wallet deposit-ceremony INTEGRATION test (P3 Task 5, Step 6) — `DEVNET_URL`-gated.
 *
 * Runs the REAL ceremony end-to-end against a running local devnet + the deployed dev
 * NyxtVault, then reads the on-chain `deposits` map back via the indexer to confirm the
 * ref landed (SPIKE-2 §C/§D recipe). Skips cleanly when `DEVNET_URL` is unset — the same
 * gate idiom as `apps/server/tests/ledger/pg-deposits.test.ts` — so CI (no devnet) never
 * runs it.
 *
 * ⚠️ The full E2E is OWNER-GATED on two prerequisites this repo does not yet satisfy:
 *   1. the SDK submit/build packages (`@midnight-ntwrk/midnight-js-contracts@4.1.1` +
 *      `@midnight-ntwrk/wallet-sdk@1.1.0`) are NOT installed in `apps/web` — until they
 *      are (and their `.d.ts` verified), `dev-ceremony-tx.ts`'s build/prove/submit legs
 *      reject owner-gated by design (constitution I);
 *   2. a funded + DUST-registered wallet (SPIKE-2 §Funding, P5's phase) and a deployed
 *      vault address (`NYXT_VAULT_ADDRESS`, from P5 state / the spike fixture).
 *
 * So with `DEVNET_URL` set this file pins the honest current contract — the selector wires
 * the real adapters and they reject owner-gated, never a false success — and leaves the
 * green end-to-end run as an explicit `todo` that unblocks the moment (1)+(2) land.
 */
import { describe, expect, it } from "vitest";
import type { DepositRef } from "@nyx/protocol";

import { selectDepositCeremony } from "@/wallet/ceremony-select";
import { DevCeremonyError } from "@/wallet/dev-ceremony";
import { createDevSigner, DEV_WALLET_ADDRESS_NETWORK, generateDevSeed } from "@/wallet/dev-signer";

const DEVNET_URL = process.env.DEVNET_URL;
const runLive = DEVNET_URL !== undefined && DEVNET_URL !== "";

describe.skipIf(!runLive)("dev ceremony against a live devnet", () => {
  const VAULT_ADDRESS = process.env.NYXT_VAULT_ADDRESS ?? "";

  it("wires the real adapters, which reject owner-gated until the SDK packages land", async () => {
    // A throwaway identity is enough to exercise the wiring — no funds needed for the
    // owner-gated rejection (the real green path needs the funded fixture, see `todo`).
    const signer = createDevSigner(generateDevSeed(), DEV_WALLET_ADDRESS_NETWORK);
    const ceremony = selectDepositCeremony({
      signer,
      env: { VITE_DEV_WALLET: "1" },
      contractAddress: VAULT_ADDRESS.length > 0 ? VAULT_ADDRESS : "0200vaultplaceholder",
    });

    const failure = (await ceremony
      .runCeremony({
        depositRef:
          "a66b22ac00000000000000000000000000000000000000000000000000d78240" as DepositRef,
        amount: 5000n,
      })
      .catch((err: unknown) => err)) as DevCeremonyError;

    expect(failure).toBeInstanceOf(DevCeremonyError);
    // The build leg is reached first; it rejects owner-gated (never a false pending).
    expect(failure.stage).toBe("build");
  });

  // Unblocks once midnight-js-contracts@4.1.1 + wallet-sdk@1.1.0 are installed and a
  // funded/DUST-registered wallet + deployed vault (NYXT_VAULT_ADDRESS) are provided:
  //   1. build the funded wallet against the same-origin WS relay (SPIKE-2 §Funding);
  //   2. run selectDepositCeremony({ signer, env:{VITE_DEV_WALLET:'1'} }).runCeremony(...);
  //   3. assert it resolves a { txRef };
  //   4. read the vault's `deposits` map via the indexer contractAction(address) and
  //      assert deposits.lookup(ref) === amount (SPIKE-2 §C/§D read-back).
  it.todo("resolves a txRef and the on-chain deposits map contains the ref (real E2E)");
});
