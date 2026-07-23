# Phase 0 Research: Nyx platform

> Phase 0 was executed as a full discovery process on 2026-07-10 (spec-writer workflow) — this file consolidates it in /sdd:plan format. Primary sources: `discovery/archive/DECISIONS.md` (D1–D61), `discovery/archive/RESEARCH.md` (R1–R8), two executed PoCs on branch `worktree-agent-ab47e5ba8f8087738`. **Zero NEEDS CLARIFICATION markers remain.** Four research items are deliberately deferred as pre-implementation gates (bottom).

## Consolidated decisions

### Agent architecture
- **Decision**: Vercel AI SDK supervisor swarm (Scaffolding/Planning/Implementation/Review); per-agent provider+model in a server-side config file; MCP-only tool surface (toolchain, Tome, mnm)
- **Rationale**: model-swappability is the product requirement; Tome projects MNE's Claude-Code-format skills into the non-Claude-Code harness; config+redeploy is the simplest swap mechanism
- **Alternatives considered**: Claude Code headless (rejected: no model choice); live admin UI for routing (rejected: needless surface); BYOK (descoped by owner, D57)
- **Refs**: D3, D19, D57

### Turn & charging model
- **Decision**: single active turn per project; ≤3 compile+test cycles with honest failure; token-metered reserve-then-settle (flat reserve after classification, settle at actual, no credit-backs); declines cost nothing
- **Rationale**: bounded worst case; settlement-is-reconciliation removes the refund path entirely; fairest pricing
- **Alternatives**: flat per-prompt and tiered pricing (rejected by owner); credit-backs (superseded — REV-001 rewrote Story 1)
- **Refs**: D21, D24, D25, D34, REV-001

### Execution environment
- **Decision**: WebContainers in an iframe under COOP/COEP with a `/webcontainer/connect/*` carve-out served `unsafe-none`; feedback via process streams, never in-container network; full manifest-diff resync; one auto-reboot crash policy; last-tab-wins sessions
- **Rationale**: PoC-verified (R6): crossOriginIsolated boot ~2s, dev-ready ~26s; the carve-out and stream-path findings are empirical, not assumed
- **Alternatives**: cloud sandboxes (rejected: cost, PRD §6); sequence-numbered event replay (rejected: buffer/divergence complexity)
- **Refs**: D4, D38, D39, D40, R6; license not required at present (D29)

### Compile pipeline
- **Decision**: owner's toolchain MCP, contract-only spec: check mode per iteration, full artifacts on green; content-hashed R2 prefixes; artifacts:ready once per green turn; expiry → reopen guidance
- **Rationale**: proving-key generation is the heavy path and simulator tests consume no artifacts; concurrency/sizing are the owner's MCP implementation domain
- **Refs**: D6, D7, D30, D31, D35, D36

### R2/COEP artifact serving — **empirically nailed (R3)**
- **Decision**: custom domain + bucket CORS policy (wildcard OK — SDK fetches are cors-mode credentialless, verified in midnight-js source) + CORP Transform Rule (belt-and-braces) + **mandatory Cache Rule** (`.prover`/`.verifier`/`.bzkir` are not default-cached extensions) + object-metadata `Cache-Control: public, max-age=31536000, immutable` + Smart Tiered Cache
- **Gotchas**: r2.dev is throttled/rule-less (dev only); >512 MB never edge-caches on non-Enterprise; SDK rejects `text/html` responses (Content-Type metadata mandatory)
- **Full report**: `discovery/archive/R3-r2-headers-full-report.md` (all claims cited)

### Wallet, proving & the interim posture
- **Decision**: SIWE-style auth; accounts keyed by unshielded address; 7-day sliding sessions; connector v4 required; four-state connect UX (no extension / unauthorized / **authorized-but-unavailable** / wrong network); **interim Nyx-hosted prover** behind session-bound tokens, flip-back to in-wallet proving when upstream fixes land
- **Rationale**: live-wallet runs (R7/R8) proved connector v4 + `getProvingProvider` are real on installed Lace, but a wallet-sdk tx-history migration bug (`InMemoryTransactionHistoryStorage.restore` ParseError on legacy `[hash, tx]`-pair format) bricks the wallet store for DApps — root-caused to source, owner chose the hosted interim
- **Refs**: D13, D37, D43, D44, D52; R5, R7, R8. Upstream bug report to `input-output-hk/lace` / wallet-sdk still to file
- **PoC**: `pocs/lace-proving/` — 4-step DApp with in-wallet vs proof-server toggle, ready for retest at flip-back time

### Token economy (NyxtVault)
- **Decision**: single NyxtVault contract, one guaranteed-phase `deposit(depositRef, amount)` circuit (receive tNIGHT + mint unshielded NYXT to `kernel.self()` + record ref); attribution via preregistered refs matched on finalized SUCCESS indexer observations, exactly-once; orphans table, no auto-credit; daily batched burn per consumed watermark
- **Rationale**: Compact has no events and no trustworthy `msg.sender`; the public deposits map is Midnight's memo; one signature per top-up beats the two-step by half
- **Alternatives**: PRD-literal lock-only (no on-chain NYXT); owner's original two-step token+vault (2 signatures); shielded NYXT (rejected: attribution needs a public record; upstream shielded token modules archived)
- **Refs**: D45, D46, D47, D55, D56; full brief `discovery/archive/BRIEF-nyxt-deposit-design.md` (R4)

### Persistence & handoff
- **Decision**: Postgres rows authoritative (turn-scoped transactional commits, version history retained), manifest endpoint as the single convergence surface, soft-delete 30d, archives + token-URL git clones with history synthesized from turn versions
- **Refs**: D26, D38, D48, D49, D58, D59

### Deploys
- **Decision**: orchestrator-direct with server-held key (toolchain MCP stays secret-free); explicit requests only; green-build precondition; finality-gated `contract:deployed`; registry with exactly-one-active-address invariant; free on pre-prod
- **Refs**: D9, D50, D51

### Verification loop
- **Decision**: OZ Compact simulator under Vitest in-container; green = passing suite (steering-owned quality, per-circuit coverage as telemetry only); no retries, 120s kill
- **Refs**: D5, D41, D42

### Release process (DS-004)
- **Decision**: emulate the release-plz flow verified in `devrelaicom/tome` and `devrelaicom/midnight-manual` `release-plz.toml` (2026-07-10): front-end Release PR as single approval gate (conventional commits → git-cliff grouped changelog, breaking commits protected), tag fires back-end release workflow owning builds/GitHub Release/publish, publish gated behind green builds
- **Tooling**: release-plz for Rust components; process mirrored for TS (tooling at implementation)
- **Refs**: D61

## Deferred research — pre-implementation gates (deliberate, not unresolved)

| Gate | Story | Method | Status |
|---|---|---|---|
| ⛔ Q3: Lace injects `window.midnight` into top-level preview origin | S9 (HARD, D54) | Run `pocs/webcontainer-lace/` `./run.sh` in a Lace-equipped profile; read per-origin banners | PoC built + headless-verified (R6); owner run pending |
| Vault funding: Lace/`balanceUnsealedTransaction` funds contract-side `receiveUnshielded` | S6 | ~1-day spike on pre-prod (R4 flags the exact link) | Pending; currently also hostage to the owner's wallet state (R8) |
| Burn circuit design | S10 | mnm/MNE retrieval at implementation — never memory | Scheduled at S10 implementation |
| On-chain teardown semantics for superseded contracts | S8 | mnm query at implementation | Scheduled at S8 implementation |

---

## T155 addendum (US8 gate) — On-chain teardown/supersede semantics for deployed contracts (mnm/source-verified, NOT memory) — 2026-07-14

**Verified against**: midnight-ledger `ledger-8` source (`structure.rs` `contract-action[v6]`, `semantics.rs`), ADR-0021 (Contract Maintenance Authorities), proposal 0014 (SNARK upgrade), midnight-js governance + E2E tests, docs.midnight.network. All CONFIRMED except the proposal-stage CMA extras (update delays / ZKVM fallback — UNCERTAIN, not shipped).

**Findings:**
1. **Deployed contracts are PERMANENT.** `ContractAction = Call | Deploy | Maintain` — there is NO delete/self-destruct/teardown variant. A contract is a forever-resident entry in the ledger `contract: Map<ContractAddress, ContractState>`; no code path removes it. State only evolves via `Call`.
2. **Redeploy = a NEW contract at a NEW address** (`ContractAddress = Hash<ContractDeploy{initial_state, nonce}>`, randomised nonce). The old contract persists deployed-but-abandoned. NO on-chain supersede/replace/upgrade-of-state. Re-deploying onto an existing address FAILS (`ContractAlreadyDeployed`).
3. **CMA** (k-of-n multisig) can only insert/remove/replace VERIFIER KEYS + replace the authority — preserving address/state/balance. OFF by default (empty committee → non-upgradable). It's for proof-system survival, NOT state replacement, NOT self-destruct. Protocol has no pause (only an app-level pattern).
4. **Realistic teardown = OFF-CHAIN bookkeeping.** Removing all VKs (only if a CMA was set at deploy) can "brick" calls but still leaves the contract on-chain — unnecessary + costs an attack surface for ephemeral generated DApps.

**DECISION ADDENDUM (proposed — protocol-forced; owner-confirmable):** Teardown of a superseded/soft-deleted project's contract is **off-chain only**: (a) flip the deploy-registry row to `superseded`/`inactive`; (b) stop resolving `VITE_CONTRACT_ADDRESS` to it (config.ts chokepoint, D10); (c) tear down the indexer subscription for that address; (d) GC off-chain artifacts (R2 prefix, private-state rows). The **on-chain "contract teardown" cascade seam (US7 `projects/lifecycle.ts` T054 stub) is a documented NO-OP BY DESIGN** — there is nothing on-chain to do and no delete primitive exists. Do NOT build an on-chain "delete contract" path; do NOT default to a CMA just to enable a brick-on-delete. **Redeploy supersede is a registry status flip, not an on-chain action.** This resolves the T155 gate.

## T172 addendum (US10 gate) — Orchestrator-only `burn` circuit authorization + burn primitive (mnm/MNE + installed-toolchain + `midnight-verify`-Confirmed, NOT memory) — 2026-07-14

The reconcile job's batched burn (D55/FR-068) needs an **orchestrator-only, exactly-once-per-watermark** `burn` circuit on NyxtVault — the platform's second dogfood circuit. The spec pins *that* it must be orchestrator-only but defers the *how* to implementation (Compact has no `msg.sender`/trustworthy caller identity). Designed + verified via a `compact-core:compact-dev` agent against compiler **0.31.1** / language **0.23.0** + mnm/MNE source + `/midnight-verify:verify` (Confirmed by execution: witness-verifier + contract-writer). Circuit: `export circuit burn(amount: Uint<64>, watermark: Bytes<32>): []`.

1. **Authorization = the witness-secret authority-commitment pattern (the zkloan pattern), NOT `ownPublicKey()`.** `ownPublicKey()` is the prover-supplied Zswap coin public key, unbound to the tx signer → an `ownPublicKey()`-based owner gate is bypassable (a documented anti-pattern). Instead: a `witness orchestratorSecret(): OrchestratorSecretKey` (32-byte secret in the orchestrator's private state, NEVER on-chain); the `constructor()` pins `orchestratorAuthority = disclose(deriveOrchestratorAuthority(orchestratorSecret()))` — a domain-separated `persistentHash<Vector<2,Bytes<32>>>([pad(32,"nyx:nyxt:orchestrator:v1"), sk.bytes])` — into a **`sealed`** (write-once) ledger field; `burn` re-derives the commitment from the caller's secret INSIDE the circuit and asserts equality. **Soundness:** only a prover holding the exact secret whose hash was pinned reproduces the equality in the ZK proof; a forged secret hashes differently and the assert rejects. No `disclose()` on the auth assert (only pass/fail is observable). Source: compact-security `witness-trust-boundary.md` (zkloan) + verified `[[reference-secure-witness-identity-pattern]]`.
2. **Burn primitive = `sendUnshielded` to the all-zero `UserAddress`, NOT `burnUnshieldedToken`.** The stdlib exposes **no** `burnUnshieldedToken` (verified: `unbound identifier`). The verified unshielded burn is `sendUnshielded(tokenType(nyxtDomainSep(), kernel.self()), amt as Uint<128>, right<ContractAddress,UserAddress>(default<UserAddress>))` — the unshielded analog of the stdlib `shieldedBurnAddress()` (all-zero coin key). Sending to the all-zero `UserAddress` registers an unshielded OUTPUT of `amount` with NO auto-receive (recipient ≠ `kernel.self()`), so the vault's net balance falls by exactly `amount` into an unspendable address. Over-burn rejected by `unshieldedBalanceGte(color, amt)` (start-of-execution `kernel.balance`). Verified against `LFDT-Minokawa/compact` stdlib source AND execution (`unshieldedInputs[color]==1000`, not 2000).
3. **Watermark idempotency = `export ledger burnedWatermarks: Set<Bytes<32>>`** — `burn` asserts `!burnedWatermarks.member(wm)` then `.insert(wm)`, mirroring `deposit`'s `depositRef` dedup. A replayed watermark is rejected ON-CHAIN. This is the third, ultimate leg of the reconcile exactly-once (SC-037): the off-chain `ReconcileStore.getRun` short-circuit + `reconcile_runs.watermark` UNIQUE cover the DB, and this on-chain Set covers the crash-between-burn-and-record window — so the server `BurnExecutor` contract ("a re-submitted watermark RESOLVES with the original txRef, never double-burns") is on-chain-enforced.

Results: check + full-ZK compile exit 0 (keys+zkir for `burn` and `deposit`); simulator 38/38 (16 deposit unchanged + 22 burn); `midnight-verify` **SUPPORTED/Confirmed**. Owner-gated residual: the real deploy→deposit→burn E2E on the local devnet (real prover + orchestrator secret held off-chain) — beneficial, not required; the in-process pipeline establishes correctness. This resolves the T172 gate.
