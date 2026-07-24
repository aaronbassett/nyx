/**
 * NyxtVault deposits-state reader INTEGRATION test (P4 Task 3b, Step 1) — `DEVNET_URL`-gated.
 *
 * Exercises the REAL {@link createNyxtVaultStateReader} with its real default seams (the
 * `indexerPublicDataProvider.queryContractState` read + the compiled-module `ledger()` decode)
 * against a running local devnet. It un-gates the `it.todo` left in
 * `indexer-observation.devnet.test.ts`: the amount decode the P3 poller needs.
 *
 * Gating (mirrors `indexer-observation.devnet.test.ts` + `pg-deposits.test.ts`):
 *  - no `DEVNET_URL` → the whole suite SKIPS (CI has no devnet);
 *  - `DEVNET_URL` but no `NYXT_VAULT_ADDRESS` → only the live-indexer transport case runs (a
 *    well-formed placeholder address has no state → an empty map, proving the real provider path);
 *  - `DEVNET_URL` + `NYXT_VAULT_ADDRESS` + a local compiled module (`compact:build`) → the full
 *    decode case runs: a deployed vault with a landed deposit decodes to a finalized bigint entry.
 *
 * The compiled NyxtVault module is read from the LOCAL native build (`packages/nyxt-vault/build/…`,
 * gitignored); P5 copies the same `contract/` layout into `config.vaultArtifactsDir` at the demo
 * boot. This deploy-adjacent live read is the Independent Test for this task.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createNyxtVaultStateReader } from "../../src/ledger/vault-state-reader.js";

const DEVNET_URL = process.env.DEVNET_URL;
const runLive = DEVNET_URL !== undefined && DEVNET_URL !== "";

describe.skipIf(!runLive)("nyxt-vault deposits-state reader (live)", () => {
  const INDEXER_URL = DEVNET_URL ?? "http://localhost:8088";
  const VAULT_ADDRESS = process.env.NYXT_VAULT_ADDRESS ?? "";
  const hasVault = VAULT_ADDRESS !== "";

  // The local native build (gitignored); P5 copies this layout into config.vaultArtifactsDir.
  const moduleDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../packages/nyxt-vault/build/nyxt-vault",
  );
  const hasModule = existsSync(join(moduleDir, "contract", "index.js"));

  it("reads live contract state via the real provider (empty map for a stateless address)", async () => {
    const reader = createNyxtVaultStateReader({
      indexerUrl: INDEXER_URL,
      vaultModuleDir: moduleDir,
    });
    // A well-formed (32-byte = 64 hex char) but (almost certainly) stateless contract address →
    // the provider returns null → an empty map, no transport error. Proves the real
    // indexerPublicDataProvider path works (assertIsContractAddress requires exactly 32 bytes).
    const map = await reader("0".repeat(64));
    expect(map.size).toBe(0);
  });

  it.skipIf(!hasVault || !hasModule)(
    "decodes a landed deposit to a finalized entry with a native bigint amount",
    async () => {
      const reader = createNyxtVaultStateReader({
        indexerUrl: INDEXER_URL,
        vaultModuleDir: moduleDir,
      });
      const map = await reader(VAULT_ADDRESS);

      // A deployed vault with a landed deposit has at least one entry; every entry is a
      // lowercase-hex ref → { native bigint amount, finalized: true (indexer-served) }.
      expect(map.size).toBeGreaterThan(0);
      for (const [ref, entry] of map) {
        expect(ref).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof entry.amount).toBe("bigint");
        expect(entry.amount).toBeGreaterThan(0n);
        expect(entry.finalized).toBe(true);
      }
    },
  );
});
