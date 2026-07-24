/**
 * Indexer deposit-observation INTEGRATION test (P3 Task 7, Step 7) — `DEVNET_URL`-gated.
 *
 * Exercises the REAL {@link createDevnetDepositIndexerQuery} against a running local devnet: it
 * runs the SPIKE-2-verified `contractAction(address)` GraphQL query live and asserts the
 * transport + query shape work against indexer `4.2.1` (`/api/v4/graphql`). Skips cleanly when
 * `DEVNET_URL` is unset — the same gate idiom as `pg-deposits.test.ts` — so CI (no devnet) never
 * runs it.
 *
 * ⚠️ The full `findDeposits([ref]) → finalized success with the on-chain amount` assertion is
 * OWNER-GATED on the same boundary as P3 Task 5's ceremony: the per-ref amount decode
 * ({@link DepositsStateReader}) needs the compiled NyxtVault module + the
 * `@midnight-ntwrk/midnight-js-indexer-public-data-provider` (neither installed in the server),
 * plus a deployed vault (`NYXT_VAULT_ADDRESS`) with a landed deposit (SPIKE-2 §C, or the Task 5
 * ceremony run). So with `DEVNET_URL` (+ `NYXT_VAULT_ADDRESS`) set this file confirms the live
 * indexer answers the verified query without a transport error, and leaves the amount-decode
 * green path as an explicit `todo` that unblocks the moment the SDK packages + vault land.
 */
import { describe, expect, it } from "vitest";

import {
  createDevnetDepositIndexerQuery,
  DepositIndexerNotWiredError,
} from "../../src/ledger/indexer-observation.js";

const DEVNET_URL = process.env.DEVNET_URL;
const runLive = DEVNET_URL !== undefined && DEVNET_URL !== "";

describe.skipIf(!runLive)("devnet indexer deposit query (live)", () => {
  const INDEXER_URL = DEVNET_URL ?? "http://localhost:8088";
  const VAULT_ADDRESS = process.env.NYXT_VAULT_ADDRESS ?? "";

  it("runs the verified contractAction query against the live indexer without a transport error", async () => {
    const query = createDevnetDepositIndexerQuery({
      indexerUrl: INDEXER_URL,
      // A deployed vault address is required for a meaningful decode; when absent we still
      // prove the transport by querying a well-formed (possibly non-existent) address.
      vaultAddress: VAULT_ADDRESS || "0".repeat(68),
      // Decode omitted → the query rejects owner-gated IF (and only if) the contract has state;
      // an unknown/empty contract returns `[]` (no state to decode) with no transport error.
    });

    // Either the contract has no on-chain action (→ `[]`) or it has state but the decode is
    // owner-gated (→ DepositIndexerNotWiredError). Both prove the live GraphQL transport works;
    // neither is an IndexerUnavailableError (which would mean the indexer is unreachable).
    try {
      const observations = await query.findDeposits(["aa".repeat(32)]);
      expect(observations).toEqual([]);
    } catch (error) {
      expect(error).toBeInstanceOf(DepositIndexerNotWiredError);
    }
  });

  // The green end-to-end — inject the real `readDepositsState` (SDK decode), point at a deployed
  // vault with a landed deposit, and assert a finalized success observation carrying the on-chain
  // amount as a bigint — unblocks when the SDK packages + vault fixture land (owner-gated).
  it.todo("returns a finalized success observation with the on-chain amount for a landed deposit");
});
