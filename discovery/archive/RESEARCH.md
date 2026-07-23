# Research Log: nyx-platform

*Chronological record of all research conducted during discovery.*

---

[Research entries will be added as research is conducted]

## R1: PRD ingestion: .sdd/PRD.initial.md as ground truth — 2026-07-10

**Purpose**: Seed discovery from the owner-authored PRD rather than a blank problem exploration

**Approach**: Full read of .sdd/PRD.initial.md (482 lines); extracted problem statement, personas, constraints, 15 settled decisions (D1-D15), 11 open questions (Q1-Q11), and a 12-story candidate backlog mapped to PRD phases

**Findings**:
PRD is prescriptive: architecture, tooling spine (MNE/Tome/mnm), verification loop, token economy, sync protocol, and phasing are all settled. Central technical risk is Compact hallucination; retrieval-first agents are the countermeasure. Standing rules in PRD section 16 bind the building agent (never hand-write Compact from memory, secrets never cross server boundary, no on-chain per-prompt writes, disagree out loud)

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
Discovery focuses on story crystallization and resolving the 11 open questions, not problem exploration. PRD warns web search is near-useless for MNE/Tome/mnm - read repos and docs sites directly

**Stories Informed**: [Stories not specified]

**Related Questions**: Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11

---

## R2: External tooling spine: MNE, Tome, mnm (PRD section 3) — 2026-07-10

**Purpose**: Record the three owner-built tools the agent architecture depends on, their roles, and their canonical sources

**Approach**: Extracted from PRD section 3; repos and docs sites are the canonical sources - PRD warns web search is near-useless for these tools (built in the open, not publicised) and that unrelated same-named projects exist (Runebook Tome, dead third-party midnight-mcp)

**Findings**:
MNE (midnightntwrk.expert, github.com/devrelaicom/midnight-expert): Claude Code plugin marketplace, ~37k lines of Compact/DApp reference - the doing layer. Tome (tome-mcp.com, github.com/devrelaicom/tome): Rust CLI + MCP server, local semantic index over plugin catalogs, search-then-load flow (search_skills -> get_skill_info -> get_skill) - projects MNE skills into the non-Claude-Code AI SDK harness. mnm (manual.midnightntwrk.expert, github.com/devrelaicom/midnight-manual): cited, trust-ranked docs Q&A, hosted MCP by default, in preview - the knowing layer

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
Division of labour: mnm answers how things work, MNE writes/verifies code, Tome routes agents to the right skill. Tome retrieval quality is load-bearing for the Scaffolding agent cold start (Q5). Note: this entry also anchors the R2 identifier so prose mentions of Cloudflare R2 do not dangle in the cross-reference validator

**Stories Informed**: [Stories not specified]

**Related Questions**: Q5

---

## R3: Cloudflare R2 CORS/CORP/Cache-Control facts for zk artifact serving under COEP — 2026-07-10

**Purpose**: Close the compile-round-trip header question: what R2 config makes FetchZkConfigProvider fetches succeed from a cross-origin-isolated page

**Approach**: Background research subagent; RTFM over developers.cloudflare.com R2/Cache/Rules docs and MDN COEP/CORP, plus direct source inspection of the SDK's fetch-zk-config-provider. Full cited report: discovery/archive/R3-r2-headers-full-report.md

**Findings**:
(1) The SDK fetches artifacts in cors mode (verified in midnight-js source), and cors-mode requests are exempt from COEP require-corp - so bucket CORS with wildcard origin suffices and CORP is strictly optional (add via one Transform Rule as belt-and-braces). (2) Cache-Control must be set as R2 object metadata at upload (public, max-age=31536000, immutable) - Transform-Rule Cache-Control does not affect edge caching. (3) CRITICAL: .prover/.verifier/.bzkir extensions are not on Cloudflare's default-cache list, so without an explicit Cache Rule nothing is edge-cached and the PRD section 9 CDN-fast assumption silently fails. (4) r2.dev is throttled and rule-less - production requires a custom domain in the same account. (5) SDK rejects text/html responses, so correct Content-Type metadata is mandatory. (6) Files over 512MB never edge-cache on non-Enterprise plans

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
Story 2 requirements: artifact uploads set Cache-Control+Content-Type metadata; the artifact domain carries the CORS policy, one CORP Transform Rule, and the mandatory Cache Rule; Smart Tiered Cache enabled. D7's content-hashed immutable strategy is confirmed workable exactly as designed

**Stories Informed**: Story 2, Story 3

**Related Questions**: Q3

---

## R4: NYXT deposit contract design brief (Q6) — 2026-07-10

**Purpose**: Translate owner's deposit intent (D32) into Midnight-native architecture ahead of Story 6

**Approach**: Background design subagent using installed MNE skills (compact-tokens, code-examples, data-models, tokenomics) plus live Midnight docs. Full brief: discovery/archive/BRIEF-nyxt-deposit-design.md

**Findings**:
Recommends Architecture C: a single NyxtVault contract with one guaranteed-phase deposit(depositRef, amount) circuit that atomically receives tNIGHT (receiveUnshielded), mints UNSHIELDED NYXT to the contract's own vault (mintUnshieldedToken to kernel.self()), and records an orchestrator-issued depositRef in public ledger state. Attribution: Compact has no events and no msg.sender (ownPublicKey() is prover-supplied - forbidden for identity); the public deposits Map<Bytes<32>,Uint<128>> acts as the memo - orchestrator pre-registers a random per-top-up depositRef in Postgres and matches it via the indexer contractActions subscription (entryPoint deposit, status SUCCESS), gated on GRANDPA finality (~1-2 blocks). Exactly 1 signing ceremony per top-up (owner's literal two-step shape B needs 2). Shielded NYXT rejected: attribution needs public record, tNIGHT leg is transparent anyway, and upstream ShieldedERC20 is archived/do-not-use

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
Story 6 deep-dive starts from Architecture C. Flagged blocking pre-Story-6 spike: Lace/balanceUnsealedTransaction funding a CONTRACT's native-token receive end-to-end on pre-prod is documented-but-unexercised. Also to settle: indexer finalized-vs-best-chain semantics, unshielded-NYXT burn at settle time

**Stories Informed**: Story 6, Story 10

**Related Questions**: Q6

---

## R5: Lace in-wallet proving PoC (Q2): built, type-verified, awaiting live wallet run — 2026-07-10

**Purpose**: Empirically answer Q2 and verify the PRD section 10 provider names against the real SDK

**Approach**: Background subagent built pocs/lace-proving (branch worktree-agent-ab47e5ba8f8087738, commit 0ef0a21): 4-step DApp (connect, deploy, prove+increment, confirm on-chain) with in-wallet vs proof-server toggle and full log panel; counter contract compiled with Compact 0.31.1 full ZK artifacts; tsc clean against SDK 4.1.1; Playwright smoke passed

**Findings**:
All three PRD provider names EXIST as named: dappConnectorProofProvider (@midnight-ntwrk/midnight-js-dapp-connector-proof-provider - takes the connected wallet API, not window.midnight literally), FetchZkConfigProvider (@midnight-ntwrk/midnight-js-fetch-zk-config-provider), levelPrivateStateProvider (@midnight-ntwrk/midnight-js-level-private-state-provider, 4.x needs accountId + password provider). Decisive SDK-level finding: dapp-connector-api 4.0.1 exposes getProvingProvider() for in-wallet proving and Configuration.proverServerUri is optional and deprecated - the in-wallet mechanism is real and stable at the SDK level. No official window.midnight-to-WalletProvider helper exists; the adapter is hand-rolled over balanceUnsealedTransaction/submitTransaction. Network: pre-prod, setNetworkId('preprod') (string, not enum), indexer/RPC API v4

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
D8's provider suite is confirmed at type level; Q2 stays open pending the owner's live Lace run (README test script: in-wallet = no localhost:6300 traffic, Lace proving prompt, succeeds with proof server stopped). Caveat: balance/submit glue and Bech32m-to-hex conversion are unvalidated without a live wallet. The hand-rolled connector adapter is reusable design input for S5/S9

**Stories Informed**: Story 5, Story 9

**Related Questions**: Q2

---

## R6: WebContainer + Lace injection PoC (Q3): built, headless-verified; stack-boot half of Phase 0 item (c) CONFIRMED — 2026-07-10

**Purpose**: Verify a WebContainer boots the Vite + React 19 + shadcn + Tailwind v4 stack and detect Lace injection per origin

**Approach**: Background subagent built pocs/webcontainer-lace (commit 2226f53, same branch as the lace-proving PoC: worktree-agent-ab47e5ba8f8087738): Rust axum server with COOP/COEP middleware + WS log relay, host page booting @webcontainer/api 1.6.4, identical wallet check on both origins, findings as per-origin terminal banners. Verified headless via Playwright

**Findings**:
CONFIRMED headless: crossOriginIsolated=true, WebContainer boots ~2s, container npm install ~20s, inner Vite dev ready ~26s from page load, DApp renders in a top-level tab, both origins report. Three architecture discoveries: (1) Top-level previews need a CONNECT BRIDGE - the preview tab auto-opens a popup to <host>/webcontainer/connect/<id> which must call setupConnect() from @webcontainer/api/connect and be served with COOP/COEP unsafe-none (blanket isolation severs the opener relay - stackblitz/webcontainer-core#1725); the popup fires without a user gesture so popup blockers can kill top-level previews. (2) The preview service worker rewrites localhost AND 127.0.0.1 URLs to container-port URLs - in-container code cannot reach local servers directly; working relay is container-filesystem based (Vite middleware appends ndjson, host fs.watches; the file must be in Vite watch.ignored or appends cause an infinite reload loop). (3) window.opener is null in the preview tab due to host COOP - no opener/postMessage channel between preview tab and host tab exists, by design

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
Story 3 must spec: the COOP/COEP carve-out for the connect route (headers cannot be blanket), popup-blocker UX for opening previews top-level, and agent feedback (test results, console) traveling via WebContainer process streams to the host page rather than network from inside the container. Story 9 can never rely on an opener channel between escape-hatch tab and host tab. Production main-app WSS is unaffected (public domain, not localhost). Q3's Lace-injection half awaits the owner run: ./run.sh in a Lace-equipped Chrome profile, read the two per-origin banners; if the preview tab says Unable to connect, allow popups for the preview origin and reload

**Stories Informed**: Story 3, Story 9

**Related Questions**: Q3

---

## R7: Live Lace run (Q2): connector v4 CONFIRMED on real wallet; connect failure root-caused in Lace source — 2026-07-10

**Purpose**: Interpret the owner's first live run of the lace-proving PoC and root-cause the 'Wallet is unavailable' failure

**Approach**: Systematic debugging: pinned the failing call via PoC logs and code (api.getConfiguration(), App.tsx:74 - its success log never appeared and the fields it populates stayed unset), then traced the thrown error to its source in input-output-hk/lace via GitHub code search

**Findings**:
PARTIAL Q2 CONFIRMATION ON REAL LACE: live wallet injects rdns io.lace.wallet, apiVersion 4.0.1, generation v4; connect('preprod') authorization succeeded; getProvingProvider() present on the connected API; no proverServerUri - the in-wallet proving capability is advertised by the real installed wallet, not just the SDK types. FAILURE ROOT CAUSE: Lace's ensureWallet() (packages/module/dapp-connector-midnight/src/store/dependencies/midnight-dapp-connector-api.ts) throws APIError InternalError 'Wallet is unavailable' when midnightWallets$ (BehaviorSubject starting empty; packages/contract/midnight-context/src/midnight-wallet.ts) holds no wallet after an unlock check. The store is populated per in-memory account only for Lace's CURRENTLY SELECTED Midnight network (watchMidnightAccountsInNetwork, packages/module/blockchain-midnight/src/store/side-effects/watch.ts), and wallet START failures are swallowed by catchError which logs 'Account watch failure:' to the extension service-worker console. Authorization never touches the wallet store; getConfiguration() is the first call that needs a wallet instance

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
Not a PoC bug, not an SDK gap - a Lace wallet-state precondition. Owner checklist: (1) retry Connect once - a freshly-woken extension may not have populated the store yet; (2) confirm Lace's Midnight side is on Pre-prod with a visible, synced account; (3) else read the Lace service-worker console for 'Account watch failure:' naming the real start error (e.g. indexer unreachable). PoC patched (commit 780a704): logs APIError code/reason and prints this checklist on that failure. Nyx design input for S5/S9: 'Wallet is unavailable' AFTER successful authorization is a real user-facing state - connect UX must map it to actionable guidance

**Stories Informed**: Story 5, Story 9

**Related Questions**: Q2

---

## R8: Q2 blocker root-caused end-to-end: wallet-sdk tx-history migration gap bricks Lace's Midnight side for DApps — 2026-07-10

**Purpose**: Interpret the 'Account watch failure' the owner found in Lace's service-worker console

**Approach**: Owner captured the SW-console error per R7 checklist; traced structure of the ParseError and confirmed via input-output-hk/lace source that InMemoryTransactionHistoryStorage comes from @midnight-ntwrk/wallet-sdk and is invoked with persisted data during account start

**Findings**:
Lace's account-watch failure is a ParseError from InMemoryTransactionHistoryStorage.restore (@midnight-ntwrk/wallet-sdk): persisted transaction history written by an older Lace/wallet-sdk build stores entries as [hash, tx] pairs (serialized Map; string fees; extra id field; stored tx dated 2026-02-24), while the current schema expects a plain array of tx objects with BigInt fees. restore() throws, Lace's watchSingleMidnightAccount catchError swallows it (SW-console-only log), midnightWallets store stays empty, and every dapp-connector call needing a wallet instance throws 'Wallet is unavailable' - indefinitely, not transiently

**Industry Patterns**:
[Patterns not provided]

**Relevant Examples**:
[Examples not provided]

**Implications**:
(1) Wallet-sdk bug worth filing upstream: restore() needs a migration or fallback-to-resync for legacy persisted formats, and Lace should surface account-start failures instead of swallowing them. (2) Owner recovery: clear the persisted Midnight state for the account so history re-syncs fresh from the indexer - surgical option via extension SW console storage inspection, or remove/re-add the Midnight account, or reinstall extension and restore from seed (BACK UP RECOVERY PHRASE FIRST in all cases). (3) Nyx S5/S9 design input: a user's wallet can be persistently broken-for-DApps through no fault of the DApp; connect UX must include a wallet-side-issue path, and the platform must never assume wallet history integrity

**Stories Informed**: Story 5, Story 9

**Related Questions**: Q2

---
