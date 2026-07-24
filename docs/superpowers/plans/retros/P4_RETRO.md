# P4 Retro — Contract Deploy Engine

Plan: `docs/superpowers/plans/2026-07-23-p4-deploy-engine.md` (as re-planned by Task 0) · Branch: `demo/p4-deploy-engine` · Base: `307e3cb` (post-P3 main)

All eight tasks completed; no deferrals. Commits: re-plan → `1634612` (verified recipe + SDK deps) → `c6f9414` (executor + mutex) → `165063f` (balance query) → `af534b2` (vault state reader) → `be504c5` (boot wiring) → `40dc40d` (scaffold steering) → review fixes + this retro.

## Deviations from the plan

1. **Task 0 ratified two placement decisions:** the P3 deposit-decode un-gating (Task 3b) landed in P4 (the SPIKE-pinned SDK installs here — the P3 retro's "same boundary as the deploy executor"); P5 has no server-source landing zone. The real ceremony un-gating went to P6 Task 5b.
2. **Task 1 (recipe gate) ran on Fable with the devnet live.** 4 of 5 recipe elements confirmed-live (build/prove/sign+submit/tDUST-balance — including a fresh NyxtVault deploy at block 132 on today's chain); the SC-029 "finalized strictly past reorg depth" signal is confirmed by source + a live invariant (indexer serves only GRANDPA-finalized state) but the true fork/reorg behavior is owner-gated (a single-node local devnet cannot fork); EC-38 out-of-funds is confirmed-live verbatim (`Wallet.InsufficientFunds` / `Insufficient Funds: could not balance dust`, client-side, tx never reaches the node).
3. **The real deploy bodies stay owner-gated, but every SDK shape is verified.** Following the Task 2 precedent, `sdk-adapter.ts`/`balance-sdk-adapter.ts`/`vault-state-reader.ts` keep the SDK-orchestration bodies behind named `*NotWiredError`s (the whole build→prove→sign→submit split needs P5's funded wallet + deployed vault) while the live-verifiable parts (finality query, decode over the deposits map) are real. Constitution I honored — no hand-written unverified SDK orchestration; deterministic tests drive the pipeline/mutex/finality logic through fakes.
4. **Task 5 `devWalletRule`** was added to `buildScaffoldingInstructions()` (not only Implementation) because the skeleton already wires the wallet path; trivially movable if the skeleton is later made wallet-agnostic.

## Discoveries

- **CONSTITUTION-I CATCH (Task 2, corrected in Task 3b):** the recipe's _prose_ SDK field names were wrong — live indexer introspection showed `Transaction` is a GraphQL interface with `transactionResult` only on the `RegularTransaction` inline fragment, and the raw status enum is `SUCCESS`/`PARTIAL_SUCCESS`/`FAILURE` (not the SDK's mapped `SucceedEntirely`). Written from the prose it would have been a silent finality-query bug; the live devnet caught it. `sdk-recipe.md` Element 4 was corrected. **Standing rule for all indexer-touching code: verify field names against live introspection, never recipe prose.**
- **⚠️ Genesis seed `0x…04` is EMPTY on this devnet** — only `0x…01`–`0x…03` are funded (SPIKE-2's "seeds 01–04" overstated). Partition in use: 01 = SPIKE-1, 03 = SPIKE-2, 02 = P4. **P5's funding must use funded seeds and a clean partition** (server deploy wallet vs user dev wallet on distinct funded seeds).
- **Finality is one definition, two consumers:** the deploy `awaitFinality` and the deposit `DepositsStateReader.finalized` both derive from the same signal (indexer-served state = GRANDPA-finalized). Never a hardcoded `finalized:true` (the P3 I1 lesson) — the store's SC-021 gate stays live, proven end-to-end through the real query + store on the false path. The stricter node-finalized-head cross-check is a documented body-only hardening seam.
- **`getLatestGreenBuild` is real end-to-end now** (P1 store + migration 0005), so the deploy greenness gate reads real rows — the Phase-10 stub is fully retired.
- **Install side-effects P0's hardening surfaced:** the SDK install flipped the hoisted `@types/node` to 18.x (transitive via testkit's `@types/ssh2`) breaking `infra` typecheck → pinned `@types/node@26.1.1` in `infra/`; pnpm's allowlist ignored `classic-level`'s native build (add to `onlyBuiltDependencies` with justification if a devnet-gated test needs it, never lower the gate).

## Deferred items

None within plan scope. Owner-gated (the whole real-deploy path): the executor's build→prove→sign→submit bodies, the wallet balance read (needs a funded + DUST-registered + ~30 s-synced deploy wallet), and the vault deposits-map decode (needs P5's deployed vault + its compiled module in `vaultArtifactsDir`) — all behind named `*NotWiredError`s that fault loud and do nothing until wired; the true reorg-depth finality confirmation (needs a multi-node/forking network); the node-level underfunded-rejection shape (unreachable via the wallet facade). All pipeline/mutex/finality-exactly-once/decode logic is deterministically tested against fakes; the DEVNET_URL-gated round-trips skip cleanly (and passed live where run this session).

## Impact on remaining plans

- **P5 (demo orchestrator):** un-gates everything by (a) funding the deploy wallet + user dev wallet from _funded_ genesis seeds (01–03; SPIKE-2 §Funding: transfer NIGHT → register DUST → ~12 s accrual; lowercase `undeployed`; serialize per-wallet), (b) deploying the NyxtVault (→ `NYXT_VAULT_ADDRESS`) and copying its native-toolchain `contract/` + `keys/` + `zkir/` into `VAULT_ARTIFACTS_DIR`, (c) providing `DEPLOY_KEY`/`signingKey` for the deploy wallet, (d) setting all P3/P4 env. The server executor/balance/decode then run for real. `classic-level` native build may need an allowlist entry.
- **P6 (UI):** the deploy loop's `deploy:request`/`deploy:status`/`contract:deployed` events surface real deploys once P5 funds the wallet; wire the deploy UI + the P3 ceremony (Task 5b) against the now-real seams.
