/**
 * Devnet round-trip test for the real deploy executor (P4 Task 2, Step 6) — `DEVNET_URL`-gated.
 *
 * This is the Independent Test for the deploy executor's SDK boundary. It skips cleanly without
 * `DEVNET_URL` (the same gate idiom as `ledger/indexer-observation.devnet.test.ts` and
 * `pg-registry.test.ts`), so CI — which has no devnet — never runs it.
 *
 * WHAT IT ASSERTS LIVE (verified, wallet-free): the real `sdk-adapter.ts` `queryFinality` transport
 * — the recipe-verified indexer `transactions(offset:{ identifier })` GraphQL poll [recipe element
 * 4] — runs against the live devnet indexer (`4.2.1`, `/api/v4/graphql`) without a transport error,
 * and a not-yet-seen tx id resolves to `{ status: "pending" }` (the finality signal's "absent ⇒
 * not finalized" leg). This proves the finality poll loop `awaitFinality` drives is wired to a real
 * indexer.
 *
 * ⚠️ OWNER-GATED (the full green deploy). `prove → signAndSubmit → awaitFinality:{finalized,address}`
 * needs the SDK build + wallet-facade submit seams (`buildUnprovenDeploy` / `submitProvenDeploy` in
 * `sdk-adapter.ts`) wired against a FUNDED, DUST-registered deploy wallet — P5 has not run, so the
 * owner runs this leg with a genesis seed per SPIKE-2 §Funding (seeds `0x…01`–`0x…03` are the only
 * genesis-funded ones on this devnet; `…01`=SPIKE-1, `…03`=SPIKE-2, `…02`=P4 Task 1's live runs, so
 * a NEW consumer funds a child wallet from a genesis seed). Left as an explicit `todo` that unblocks
 * the moment those two seams + the funded wallet land — mirroring the `indexer-observation` devnet
 * test's owner-gated green-path todo. This deploy spends devnet-only tDUST.
 */
import { describe, expect, it } from "vitest";
import type { NetworkProfile } from "../../src/config/index.js";
import {
  createDeploySdkAdapter,
  DeployIndexerUnavailableError,
} from "../../src/deploy/sdk-adapter.js";

const DEVNET_URL = process.env.DEVNET_URL;
const runLive = DEVNET_URL !== undefined && DEVNET_URL !== "";

describe.skipIf(!runLive)("devnet deploy executor (live)", () => {
  const network: NetworkProfile = {
    id: "local-devnet",
    networkId: "Undeployed",
    nodeUrl: process.env.NYX_NODE_URL ?? "http://localhost:9944",
    indexerUrl: DEVNET_URL ?? "http://localhost:8088",
    proofServerUrl: process.env.NYX_PROOF_SERVER_URL ?? "http://localhost:6300",
  };

  it("queryFinality runs the verified transactions query against the live indexer (unseen tx ⇒ pending)", async () => {
    const sdk = createDeploySdkAdapter();
    // A well-formed but almost-certainly-unseen tx identifier: absent from the indexer ⇒ the
    // finality signal's "not yet finalized" leg. A transport failure would be a
    // DeployIndexerUnavailableError (indexer down / wrong endpoint), not this.
    try {
      const result = await sdk.queryFinality({ txRef: "00".repeat(35), network });
      expect(result).toEqual({ status: "pending" });
    } catch (error) {
      // If the live indexer's `transactions` selection set differs from the recipe-verified shape,
      // surface it loudly here rather than passing silently — but never as a false green.
      expect(error).toBeInstanceOf(DeployIndexerUnavailableError);
      throw error;
    }
  });

  // The green end-to-end — wire `buildUnprovenDeploy` + `submitProvenDeploy` (sdk-adapter.ts) against
  // a funded genesis-seeded wallet, seed a real compiled contract's artifacts into a local
  // ArtifactStore, then run `prove → signAndSubmit → awaitFinality` and assert
  // `{ outcome: "finalized", address }` with a nonempty address. Unblocks when P5's funded wallet +
  // the two owner-gated SDK seams land (owner-gated; spends devnet tDUST).
  it.todo("deploys a real contract to the devnet and awaits finality to a nonempty address");

  // The real tDUST balance read (P4 Task 3) — build the deploy wallet from a genesis seed via
  // `createDevnetBalanceQuery`, wire `balance-sdk-adapter.ts`'s `readWalletBalance` seam
  // (MidnightWalletProvider.build + .start() ~30 s sync + firstValueFrom(wallet.state()) →
  // state.dust.balance(now), recipe element 5), then assert the query resolves a `bigint > 0n` for a
  // genesis-funded, DUST-registered seed (`0x…01`–`0x…03`; NIGHT auto-registers for DUST on
  // `.start()`). Unblocks with P5's funded wallet + the wired read seam (owner-gated; reads live
  // wallet state, ~30 s wallet sync — no tDUST spent).
  it.todo("reads the funded deploy wallet's tDUST balance from the devnet as a positive bigint");
});
