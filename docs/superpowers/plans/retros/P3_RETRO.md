# P3 Retro — Dev Wallet & Money Path

Plan: `docs/superpowers/plans/2026-07-23-p3-dev-wallet-money.md` (as re-planned by Task 0) · Branch: `demo/p3-dev-wallet-money` · Base: `07ea18b` (post-P2 main)

All ten tasks completed; no deferrals. Commits: re-plan + `.claude/compact-check.json` exclusion → `75575ec` (devnet proxy) → `beb34c9` (signing core) → `a33aee4` (connector) → `3ee90f2` (proving seam) → `520e67d` (ceremony) → `07d31c2` (listOpenRefs) → `6c14c6f` (observation adapter) → `b3ebc0e` (boot wiring) → review fixes + this retro.

## Deviations from the plan

1. **Task 0 resolved all three carried contradictions with on-disk evidence:** wallet-sdk pinned **1.1.0** (top-level 1.0.0 is shadowed by testkit-js@4.1.1's nested exact-dep 1.1.0, which the executed spike scripts resolved); zkir provingProvider wires over the **published `@midnight-ntwrk/zkir-v2@2.1.0`** (`@nyx/compact-wasm` ships compiler-only — verified from its source); key material served via a **new `GET /vault-artifacts/*` route** cloning the P2 `/srs/*` pattern (the vault isn't a user project, so the `/artifacts/:projectId/...` prefix doesn't apply).
2. **Task 4 fallback adapter:** the brief named `httpClientProofProvider`, but its non-injectable `cross-fetch`, missing `credentials:"include"`, and status/URL-leaking errors were incompatible with the session-cookie/no-leak proxy the brief itself required. Hand-rolled the `{check,prove}` proxy but reused the **real ledger-v8 payload codecs** (`createCheckPayload`/`createProvingPayload`/`parseCheckResult` — the exact functions `httpClientProvingProvider` calls, verified from installed source) — constitution I honored, wire contract unfabricated.
3. **Task 8 additions:** a minimal `deposit:failed` S→C protocol event (strings-only, mirrors `deploy:status`; no server deposit-failure convention existed), and an optional `NYXT_VAULT_ADDRESS` config field (Task 7's query needs it) — both optional-with-default, no fixture breaks. `DepositLogger` landed as a structured stderr sink (matching the file's `logWalletAlert`/`logReconcileAlarm`) rather than `app.log`-backed, because `depositStore` is built before `buildServer` yields `app`.
4. **`.claude/compact-check.json`** committed to exclude `packages/compact-wasm/vendor/` from the compile-check hook — the vendored reference contracts (`counter`/`nyxt-vault`) were re-flagged on every branch op though they're vendored third-party copies (already excluded from lint/prettier); compiled directly with native `compact +0.31.1` to confirm before excluding.

## Discoveries

- **Two-derivation reconciliation (SPIKE-2 risk 6) resolved by architecture, not by forcing one identity:** the dev-signer (ledger-v8 raw signing key) and the wallet-sdk keystore (HD-derived) are DIFFERENT identities from the same seed. This is fine — the NyxtVault attributes deposits by the pre-registered `depositRef` (no `msg.sender`), so funding-wallet identity and SIWE/account identity are **decoupled by the ref**. "One identity" is not a correctness requirement. If the demo wants a single _displayed_ identity, P5 must build the funding wallet's keystore from the same ledger-v8 key (devnet-confirm).
- **WS relay is NECESSARY (Task 1 escape hatch does NOT fire):** `wallet.submitTransaction` uses the node WS transport (`ws://:9944`), so a raw HTTP forward of proven bytes is insufficient — the funded wallet must be constructed against the Task 1 same-origin WS relay. Keep the relay.
- **The dev wallet passes the UNMODIFIED server auth path:** Task 2's cross-package test feeds a dev-wallet BIP-340 signature straight into the server's `verifySignature` + `reconstructSignedBytes` recipe and it's accepted — the Lace concession preserves the real SIWE money-auth boundary.
- **Two network strings, both load-bearing:** address Bech32m segment is lowercase `undeployed`; the reported connection `networkId` is `Undeployed` (pinned from `EXPECTED_NETWORK_ID` so the FR-037 wrong-network gate passes). The tx-encoding path is the lowercase one (P1/SPIKE finding: capitalized → node reject 1010/Custom 166).

## Deferred items

None within plan scope. Owner-gated (needs installed SDK packages `midnight-js-contracts@4.1.1` + `wallet-sdk@1.1.0` in apps/web, a deployed vault, and a live devnet — the same boundary as the deploy executor): the real ceremony build/prove/submit bodies (~23–26 s k=13 prove, real worker host), the poller's on-chain `readDepositsState` decode (armed-but-gated behind `DepositIndexerNotWiredError` / empty `NYXT_VAULT_ADDRESS` — faults loud each tick, credits nothing until wired), and the live indexer GraphQL schema confirmation. All deterministic orchestration/state-machine/exactly-once logic is tested against fakes.

## Impact on remaining plans

- **P5 (demo orchestrator):** MUST set `VITE_DEV_WALLET=1` + `VITE_DEV_WALLET_SEED`, `NYXT_VAULT_ADDRESS`, `VAULT_ARTIFACTS_DIR` (native-toolchain `keys/`+`zkir/` from the vault build), and the devnet forwarding + WS-relay endpoints; encode SPIKE-2's funding/DUST recipe for the user wallet; if a single displayed identity is wanted, derive the funding wallet from the dev-signer's ledger-v8 key. Installing the two SDK packages is what un-gates the real ceremony + decode.
- **P4 (deploy engine):** shares the same owner-gated SDK-install boundary and the lowercase-`undeployed` tx rule; the observation/finality-CAS pattern here mirrors what the deploy finality path already does.
- **P6 (UI):** the `ledger:update` push on credit now surfaces finalized deposits to the merged ledger UI; the `deposit:failed` event's web consumer (topup `DepositSubscription`) is the owner-gated hook to wire.
