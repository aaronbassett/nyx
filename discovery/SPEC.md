# Feature Specification: nyx-platform

**Feature Branch**: `feature/nyx-platform`
**Created**: 2026-07-10
**Last Updated**: 2026-07-10
**Status**: In Progress
**Discovery**: See `discovery/` folder for full context

---

## Problem Statement

Midnight Network developers have no prompt-to-DApp platform. Generic generative-UI tools (Bolt, Lovable, V0) are useless for Midnight because Compact — the language for data-protecting smart contracts — is not in any frontier model's training data: models hallucinate its syntax with total confidence and produce code that fails at compile time. Building a Midnight DApp today means hand-assembling a toolchain (Compact compiler, proving keys, simulator, Lace wallet integration, pre-prod deployment) with no AI assistance that can be trusted. Nyx closes this gap: a user connects their Lace wallet, deposits tNIGHT to buy NYXT credit, and prompts a multi-agent system that scaffolds, compiles, tests, and previews a full DApp — a Compact contract plus a React frontend — with contracts deployed to Midnight pre-prod. The central technical risk (Compact hallucination) is countered by a retrieval-first external tooling spine: MNE skills (doing), mnm cited docs Q&A (knowing), and Tome semantic skill routing (finding), all consumed over MCP (R1, R2).

**Ground truth**: `.sdd/PRD.initial.md` — settled decisions are logged as D1–D18 in `archive/DECISIONS.md` and are not re-decided silently.

## Personas

| Persona | Description | Primary Goals |
|---------|-------------|---------------|
| Midnight DApp builder | Developer targeting Midnight who knows what they want to build | Go from prompt to a compiling, tested, deployed Compact contract + React preview without fighting hallucinated syntax |
| Midnight explorer | Developer evaluating Midnight / prototyping an idea | Try a real DApp on pre-prod in minutes with zero local toolchain setup |
| ~~BYOK power user~~ | *(retired — BYOK descoped by owner, D57)* | Model choice remains an owner-level config concern (D19) |
| Platform operator (project owner) | Runs Nyx as a lean, for-profit product | Zero idle compute cost, zero-trust security boundaries, production quality throughout, owner-controlled scope |

---

## User Scenarios & Testing

<!--
  Stories are ordered by priority (P1 first).
  Each story is independently testable and delivers standalone value.
  Stories may be revised if later discovery reveals gaps - see REVISIONS.md
-->

### User Story 1 - Prompt-to-DApp agent swarm (Priority: P1)

**Revision**: v1.1

As a Midnight DApp builder, I want to prompt a chat interface so that a supervisor-led multi-agent system generates a complete DApp — a Compact contract plus a React frontend — grounded in retrieved reference material rather than model memory.

A Vercel AI SDK supervisor routes work to Scaffolding, Planning, Implementation, and Review sub-agents (D3). Model assignments are runtime data, not code: a server-side config file maps each agent role to a provider + model pair — OpenAI, Anthropic, Gemini (first-party AI SDK providers), OpenRouter, and owner-hosted OpenAI-compatible endpoints via `createOpenAICompatible` (D19). There is no template system: at project birth the Scaffolding agent orients via Tome (`search_skills` → `midnight-dapp-dev`, `compact-core`, …) and mnm. MNE verify/tooling capabilities are called as discrete MCP tool calls; MNE's internal orchestration is never reimplemented in the supervisor (D3). A turn spends at most 3 compile+test cycles and fails honestly on exhaustion (D21); infra unavailability triggers bounded retries, then a loud failure naming the service (D34). Charging is token-metered via reserve-then-settle: a flat NYXT reserve is placed after intent classification, and at turn end — success, honest failure, or infra failure alike — the ledger settles at actual token consumption; no credit-back mechanism exists (D34). The turn UX is a full activity stream with a persistent tab-alive session indicator (D20).

**Independent Test**: with a funded session, a WebContainer preview, and the compiler MCP reachable, a single cold prompt must produce a compiling, simulator-tested Compact contract plus a running Vite preview — no deploy loop (Story 8) required.

**Acceptance Scenarios**:

1. **Given** a new project and a sufficient NYXT balance, **When** the user prompts "build me a counter DApp", **Then** the Scaffolding agent retrieves relevant MNE skills via Tome (`search_skills` → `get_skill`) and produces the Vite + React 19 + shadcn + Tailwind v4 scaffold in the project VFS with no template involved
2. **Given** the Implementation agent is writing Compact, **When** it generates contract code, **Then** every Compact construct is grounded in MNE/mnm retrieval and the result is compiled via the compiler MCP before being surfaced to the user
3. **Given** a compile or test failure, **When** the agent iterates, **Then** it consults retrieval (mnm/MNE) rather than regenerating from memory, re-compiles and re-tests, and spends at most 3 compile+test cycles in the turn (D21)
4. **Given** the verify loop exhausts its 3-cycle budget without a passing state, **When** the turn ends, **Then** the failing state is summarized with diagnostics, work-in-progress files remain in the VFS, a suggested next prompt is offered, and nothing unverified is presented as done; the turn settles at actual token consumption (D21, D34)
5. **Given** Tome, mnm, or the compiler MCP is unreachable mid-turn, **When** 3 backoff retries fail, **Then** the turn fails loudly naming the unavailable service and settles at actual token consumption up to the failure point — no refund mechanism exists (D34)
6. **Given** a long-running agent turn, **When** the user watches the chat, **Then** they see streamed supervisor narration plus a collapsible per-sub-agent activity feed (compile attempts, test runs, verify iterations) and a persistent indicator that preview/tests run in this tab (D20)
7. **Given** the user closed the tab mid-turn, **When** they reopen the project, **Then** the persisted chat history rehydrates (D23) and an explicit interrupted-turn recovery message explains what completed and what was lost (D20)
8. **Given** a turn is running, **When** the user attempts to submit another prompt, **Then** chat input is disabled until the turn ends — single active turn per project (D24)
9. **Given** an off-domain prompt (not a DApp request), **When** the intent classifier declines it, **Then** the decline message explains what Nyx is for and no NYXT reserve is placed (D25, D34)

<details>
<summary>Supporting Decisions & Watching Items</summary>

- **D3**: AI SDK supervisor swarm shape and model-tier split
- **D12**: bidirectional WebSocket protocol carrying the agent feedback loop
- **D19**: per-agent model routing via static config file (config edit + redeploy)
- **D20**: full-activity-stream turn UX with tab-alive indicator and recovery message
- **D21**: 3-cycle verify budget with honest failure
- **D22** *(superseded by D34 — see REV-001)*: was infra-failure refunds / exhausted budgets charged
- **D23**: chat history persisted and rehydrated
- **D24**: single active turn per project (reject while busy)
- **D25**: declined off-domain prompts place no reserve; reserve is placed after classification
- **D34**: token-metered reserve-then-settle charging; flat reserve; settle at actual consumption; no credit-backs
- **Q5 (resolved via D27)**: Tome cold-start retrieval is assumed reliable — the owner develops Tome, and retrieval gaps are fixed upstream in Tome rather than worked around in Nyx. No fallback-retrieval scenario planned.

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 2 - Compile pipeline (Priority: P2)

**Revision**: v1.0

As a Midnight DApp builder, I want every contract iteration compiled through the toolchain MCP with artifacts published to the CDN, so that generated Compact is always statically valid and my preview can fetch proving artifacts instantly.

The toolchain MCP is the owner's in-development project (D30); this story specifies only the contract Nyx consumes (D31). The service is private-by-construction (Fly 6PN, no public IP), stateless, scale-to-zero, holds the **only** R2 write credentials, and pins + surfaces the compiler version (D6). The compile tool exposes two modes with fixed platform steering (D35): **check** (fast static validity, no key generation) on every verify-loop iteration, and **full** (proving keys, zkIR, integrity manifest → R2) when behavioural tests pass — so `artifacts:ready { urlPrefix }` (D12) fires at most once per successful turn. Artifacts land under a content-hashed prefix (`<project-id>/<content-hash>/`) in the FetchZkConfigProvider layout — `keys/<circuit>.prover|.verifier`, `zkir/<circuit>.bzkir`, integrity manifest — uploaded with `Cache-Control: public, max-age=31536000, immutable` and correct `Content-Type` as object metadata; the artifact domain carries the bucket CORS policy, CORP Transform Rule, and the mandatory Cache Rule (R3). D31 contract guarantees: concurrent calls are safe, and a call either completes within the tool budget or returns explicit queued/progress state — never a silent timeout.

**Independent Test**: with the toolchain MCP reachable and an R2 bucket configured per R3, submitting known-good and known-bad Compact source must yield, respectively, a complete fetchable artifact prefix and structured diagnostics — no agent swarm or preview required.

**Acceptance Scenarios**:

1. **Given** the Implementation agent produced Compact source, **When** it calls the compile tool in check mode (no key generation, D35), **Then** structured diagnostics (severity, file, line, message) return within the same turn, and a failure feeds the verify loop rather than reaching the user as done work
2. **Given** behavioural tests pass on a verify iteration, **When** the full compile runs (D35) and the toolchain MCP uploads prover/verifier keys, zkIR, and the integrity manifest to R2 under the content-hashed prefix with immutable Cache-Control and correct Content-Type, **Then** the tool response carries the urlPrefix plus compiler version, and `artifacts:ready` is emitted only after the upload set is complete and verified — at most once per successful turn
3. **Given** `artifacts:ready` pointed FetchZkConfigProvider at a fresh prefix, **When** the cross-origin-isolated preview fetches artifacts, **Then** every fetch succeeds under the R3 header configuration with no silent CORS/CORP failures
4. **Given** contract source whose content hash matches an existing artifact prefix, **When** compile is requested, **Then** existing artifacts are reused without re-running key generation
5. **Given** proving-key generation exceeds the inline tool budget, **When** the agent awaits the call, **Then** the tool returns explicit queued/progress state and never silently times out (D31)
6. **Given** the platform-pinned compiler version, **When** any compile returns, **Then** the response carries the exact compiler version for agent context (D6)
7. **Given** two projects compiling simultaneously, **When** both call the tool, **Then** both complete safely with artifact isolation by project-id + content-hash prefix (D31)
8. **Given** a preview session open past the artifact lifecycle window, **When** an artifact fetch fails on the stale prefix, **Then** the client surfaces a clear "reopen the project" error (reopen recompiles) rather than failing silently (D36)
9. **Given** a turn touching only frontend files (no `.compact` change), **When** the turn runs, **Then** no compile is invoked and no `artifacts:ready` fires

<details>
<summary>Supporting Decisions & Research</summary>

- **D6**: private compiler service — 6PN-only, scale-to-zero, stateless, sole R2 writer, pinned version
- **D7**: R2 content-hashed immutable artifact strategy, 1-day lifecycle, recompile on open
- **D12**: `artifacts:ready { urlPrefix }` in the sync protocol
- **D30**: toolchain behind the owner's in-development MCP; Nyx specs the consumed contract
- **D31**: contract-only guarantees — safe concurrency, no silent timeouts, benchmark-driven sizing
- **D35**: check mode per iteration, full mode on green
- **D36**: mid-session artifact expiry → reopen guidance, no protocol change
- **R3**: R2 CORS/COEP facts — cors-mode fetch exempt from COEP; object-metadata Cache-Control; mandatory Cache Rule for `.prover`/`.verifier`/`.bzkir`; full report in `archive/R3-r2-headers-full-report.md`
- **Watching**: compiler version-bump cadence — a pin bump can break recompile-on-open for older projects (handled as a normal compile failure, but cadence policy is operational)

*Full context: `discovery/archive/DECISIONS.md`, `discovery/archive/RESEARCH.md`*
</details>

---

### User Story 3 - WebContainer preview + file-sync protocol (Priority: P3)

**Revision**: v1.0

As a Midnight DApp builder, I want my generated app running in a live in-browser preview that stays in lockstep with the agent's file changes, so that I see every iteration instantly with no hosted runtime.

The WebContainer runs in an iframe on the chat page (D4) under COEP `require-corp` / COOP `same-origin`, with one carve-out: `/webcontainer/connect/*` is served with COOP/COEP `unsafe-none` — the bridge route top-level preview tabs need (R6; consumed by Story 9). Boot pipeline on project open: rehydrate VFS from the authoritative store (D26/S7) → mount → install → `vite dev`, with `dev:status` phases streamed to UI and agent (R6 measured ~2s container boot, ~26s to dev-ready cold). Server→client events (D12) mutate the VFS; `contract:deployed` routes through `.env.local` + the config.ts chokepoint (D10); `artifacts:ready` re-points FetchZkConfigProvider (at most once per green turn, D35). All agent feedback — `dev:status`, console streams, test results — travels via WebContainer process streams read by the host page, never network from inside the container (R6: the preview service worker rewrites localhost URLs). Reconnects converge by manifest diff (D38); crashes get exactly one auto-reboot (D39); one live session per project, last-tab-wins (D40); `node_modules` and compiled artifacts never sync (D26).

**Independent Test**: with a persisted project and no agent swarm, opening the project must boot the preview through visible `dev:status` phases, and a scripted `file:write` over the socket must appear in the running app via HMR.

**Acceptance Scenarios**:

1. **Given** an agent turn producing file changes, **When** `file:write`/`file:delete` events arrive, **Then** they are applied to the VFS in order per path and HMR reflects the change in the preview without a manual reload
2. **Given** a project open, **When** the VFS rehydrates from the authoritative store and the boot pipeline runs, **Then** each phase (mount, install, dev-server start) is surfaced via `dev:status` to both UI and agent, and failures are loud
3. **Given** `contract:deployed { address }`, **When** the client writes `VITE_CONTRACT_ADDRESS` to `.env.local` and restarts the dev server, **Then** the app reads the address only via the config.ts chokepoint, and before first deploy renders the deploy-your-contract-first guard (D10)
4. **Given** `artifacts:ready { urlPrefix }`, **When** the provider re-points, **Then** artifact fetches succeed under the R3 header configuration
5. **Given** runtime activity in the preview, **When** console output or dev-server state changes, **Then** `console:log`/`console:error`/`dev:status` reach the agent within the same turn via process streams (D12, R6)
6. **Given** a WebSocket drop mid-turn, **When** the client reconnects, **Then** it fetches the authoritative file manifest (paths + content hashes), diffs against the VFS, and applies the difference — converging with no silent divergence (D38)
7. **Given** a browser without cross-origin isolation support, **When** the app loads, **Then** an upfront hard gate names the requirement and supported browsers — no degraded mode (D39)
8. **Given** a container or dev-server crash, **When** the client performs its single automatic reboot and the container crashes again, **Then** `dev:status crashed` surfaces loudly with a manual retry affordance and the agent is informed mid-turn (D39)
9. **Given** the project is opened in a second tab, **When** the new session takes over, **Then** the previous tab is disconnected with a clear session-moved banner and take-back affordance — single live session per project (D40)

<details>
<summary>Supporting Decisions & Research</summary>

- **D4**: WebContainers-in-iframe execution environment, COEP/COOP, escape-hatch affordance
- **D10**: contract address via `.env.local` + config.ts chokepoint only
- **D12**: the bidirectional event protocol this story implements
- **D26**: Postgres-rows authoritative store (rehydration source; sync exclusions)
- **D35**: `artifacts:ready` at most once per green turn
- **D36**: expired-artifact fetches surface reopen guidance
- **D38**: reconnect = full resync via authoritative manifest diff
- **D39**: one auto-reboot crash policy; hard unsupported-browser gate
- **D40**: last-tab-wins single live session
- **R6**: WebContainer PoC — boot benchmarks, `/webcontainer/connect/*` COOP/COEP carve-out, service-worker localhost rewriting (feedback must use process streams), `window.opener` null by design

*Full context: `discovery/archive/DECISIONS.md`, `discovery/archive/RESEARCH.md`*
</details>

---

### User Story 4 - Behavioural verification loop (Priority: P4)

**Revision**: v1.0

As a Midnight DApp builder, I want every generated contract exercised by deterministic simulator tests on every iteration, so that "done" always means behaviourally verified — not just compiling.

Behavioural validity runs inside the WebContainer: the OpenZeppelin Compact simulator under Vitest (per MNE's compact-testing skill, PRD §7 — exact API verified at implementation via the skill, never memory). In-process, deterministic, no chain, no devnet (D5). The Implementation agent generates tests alongside contract and witnesses, steered by the compact-testing skill via Tome; test files are ordinary project source (synced, persisted, user-visible). Each verify cycle: check-mode compile (D35) → Vitest run spawned in the container by the host page → structured results parsed → `test:results { pass, failures[] }` via process streams (FR-020) within the turn. **Green = the current cycle's suite passes** — test quality is owned by steering and the Review agent, not a mechanical gate (D41), with per-circuit coverage measured as telemetry to keep that decision evidence-based. Green is the sole trigger for the full artifacts compile (D35) and for the turn presenting work as done. No retries; runs are killed at 120 seconds and count as failing cycles (D42). A failing run consumes one of the turn's 3 cycles (D21).

**Independent Test**: with a persisted project containing a contract and suite, spawning the verify cycle against known-good and known-broken contract variants must yield, respectively, a green `test:results` event and a failure event carrying per-test diagnostics — no agent swarm required.

**Acceptance Scenarios**:

1. **Given** a generated contract, witnesses, and test suite, **When** a verify cycle runs, **Then** the host spawns the Vitest/simulator run inside the container and `test:results { pass, failures[] }` reaches the agent within the same turn via process streams
2. **Given** failing tests, **When** results return, **Then** `failures[]` carries per-test name and assertion diagnostics sufficient for a retrieval-driven fix, and the cycle counts against the 3-cycle budget (D21)
3. **Given** all tests in the current cycle pass, **When** the cycle completes, **Then** green triggers the full compile (D35) and only then may the turn present the contract as done (D41)
4. **Given** a hung or overlong test run, **When** the 120-second budget expires (D42), **Then** the run is killed and treated as a failing cycle with timeout diagnostics — never a silent stall, never a retry
5. **Given** test files in the project, **When** the user inspects the project, **Then** tests are visible, synced, and persisted like any other source file (D12, D26)
6. **Given** the activity stream (D20), **When** verify cycles run, **Then** each run appears with pass/fail counts as sub-agent activity
7. **Given** identical source and suite, **When** the suite re-runs, **Then** results are identical — deterministic by construction (simulator, no network/chain access from tests; PRD §7)

<details>
<summary>Supporting Decisions & Research</summary>

- **D5**: simulator for determinism, pre-prod for realism, no devnet
- **D12 / FR-020**: `test:results` over process streams within the turn
- **D21**: 3-cycle budget; failing runs consume cycles
- **D35**: green triggers the full artifacts compile
- **D41**: steering-owned test quality, no mechanical adequacy gate; coverage telemetry keeps the decision revisable
- **D42**: no retries, 120s per-run budget
- **Watching**: hollow-test greens — if telemetry shows green turns with untested circuits becoming common, add a mechanical floor via story revision

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 5 - Wallet connect & session auth (Priority: P5)

**Revision**: v1.0

As a Midnight developer, I want to sign in to Nyx with my Lace wallet — no email, no password — so that my identity, balance, and projects all hang off the wallet I already use.

SIWE-style flow on pre-prod (D13): server issues a one-time, short-expiry nonce → client requests a wallet signature over a domain-bound message (domain, nonce, issued-at, statement) → server verifies and establishes a 7-day sliding session (D44). Connector reality from R5/R7: `window.midnight` is a UUID-keyed map of v4 wallets (Lace = rdns `io.lace.wallet`); authorization via `connect('preprod')`; exact API shapes are verified against installed SDK types at implementation, never memory (PRD §16). Accounts are keyed by the unshielded address, auto-created on first sign-in — one wallet, one account (D43). R8's hard lesson is encoded: **authorization can succeed while the wallet is unusable**, so the connect UX distinguishes four states — no extension / not authorized / authorized-but-unavailable (wallet-side guidance) / wrong network. Sessions live server-side (Postgres) behind HttpOnly/Secure/SameSite cookies.

**Independent Test**: with a Lace-equipped browser and no other Nyx feature, a fresh wallet must be able to connect, sign the nonce message, land in an authenticated session with a new account, and resume that session on reload without wallet interaction.

**Acceptance Scenarios**:

1. **Given** no `window.midnight`, **When** the user hits connect, **Then** an install-Lace guidance state names the supported wallet — no dead button
2. **Given** an injected v4 wallet, **When** the user connects, **Then** authorization runs via `connect('preprod')` and a wallet picker appears only when more than one v4 wallet is injected (Lace preferred by rdns otherwise)
3. **Given** authorization, **When** the server issues a one-time nonce and the wallet signs the domain-bound message, **Then** the server verifies the signature against the wallet identity, creates the account keyed by the unshielded address on first sign-in (D43), and establishes the session
4. **Given** a valid session, **When** the user returns within 7 days of last activity, **Then** they resume without wallet interaction (sliding renewal); 7 idle days trigger a fresh sign flow (D44)
5. **Given** an authorized wallet whose Midnight side is unavailable (R8), **When** any wallet call fails post-authorization, **Then** the UI shows the wallet-side-issue state with actionable guidance — never a generic error
6. **Given** a wallet on the wrong network, **When** connect or authorization fails on the network id, **Then** an explicit switch-to-pre-prod instruction state renders
7. **Given** a reused or expired nonce, **When** verification runs, **Then** it is rejected and the nonce burned — one signature per nonce, bound to our domain
8. **Given** an explicit disconnect, **When** the user logs out, **Then** the session is invalidated server-side immediately

<details>
<summary>Supporting Decisions & Research</summary>

- **D13**: SIWE-style nonce → Lace signature → session, on pre-prod
- **D26**: Postgres backs the session store and accounts
- **D37**: interim hosted proving posture (wallet signs; proving path per D37 until flip-back)
- **D43**: unshielded address keys the account; one wallet = one account; multi-wallet linking out of scope
- **D44**: 7-day sliding sessions; revisit before any real-value network
- **R5/R7**: connector v4 facts from the PoC and live Lace run
- **R8**: authorized-but-unavailable is a real persistent wallet state requiring first-class UX

*Full context: `discovery/archive/DECISIONS.md`, `discovery/archive/RESEARCH.md`*
</details>

---

### User Story 6 - NYXT token economy (Priority: P6)

**Revision**: v1.0

As a Midnight developer, I want to deposit tNIGHT once and spend NYXT credit per prompt, so that using Nyx never asks me to sign a transaction mid-conversation.

The chain is the top-up rail, Postgres the metering rail (D13). **Deposit side (Architecture C, D45):** a single **NyxtVault** Compact contract exposes one guaranteed-phase `deposit(depositRef, amount)` circuit that atomically receives tNIGHT (`receiveUnshielded`), mints **unshielded** NYXT to the contract's own vault (`mintUnshieldedToken` to `kernel.self()`), and records the orchestrator-issued `depositRef` in public ledger state — one signing ceremony per top-up, proving via the interim hosted prover (D37). Attribution (R4): Compact has no events and no trustworthy `msg.sender`, so the orchestrator preregisters each random ref bound to the account (D43) and credits **exactly once** on the **finalized SUCCESS** indexer observation. **Metering side (D34):** flat reserve after classification (declines place none, D25) → settlement at actual token consumption in all outcomes; no credit-backs; overage from a completed final cycle may drive balance negative; new prompts require available ≥ flat reserve. The ledger is account rows (available, reserved) plus an append-only entry log — the audit trail Story 12 renders. Rate, reserve, and minimum deposit are config tunables (D47). This contract is the platform's **dogfood moment** (D13): built with the MNE/mnm stack, S4-grade tests, production standard. Pre-implementation Watching gate: the R4 spike proving Lace can fund a contract-side `receiveUnshielded` end-to-end.

**Independent Test**: with wallet connect (Story 5) and a deployed NyxtVault on pre-prod, a top-up must credit the ledger exactly once after finality, and a scripted turn-settlement sequence against the ledger API must reserve, settle at actual, and enforce the available ≥ reserve gate — no agent swarm required.

**Acceptance Scenarios**:

1. **Given** a signed-in account, **When** the user initiates a top-up of X tNIGHT, **Then** the orchestrator preregisters a fresh random `depositRef` bound to the account and amount, and the client builds the `deposit(depositRef, X)` transaction for one wallet signing ceremony
2. **Given** a submitted deposit, **When** the indexer delivers the finalized SUCCESS contract call carrying the ref, **Then** the ledger credits the account exactly once with the minted NYXT amount and the UI moves the deposit from pending to credited
3. **Given** an accepted prompt, **When** classification passes, **Then** the flat reserve moves available→reserved before the turn runs; declined prompts move nothing (D25, D34)
4. **Given** a turn ending in any outcome, **When** settlement runs, **Then** the reserve releases and the actual token consumption is charged as one atomic ledger entry (D34)
5. **Given** consumption that exceeded the reserve in a completed final cycle, **When** settlement draws the overage, **Then** balance may go negative and new prompts are blocked until a top-up restores available ≥ flat reserve (D34)
6. **Given** a deposit transaction that fails on-chain, **When** the indexer reports FAILURE, **Then** nothing is credited and the pending deposit surfaces the failure with diagnostics
7. **Given** a reorg or duplicate observation of the same ref, **When** the credit path runs, **Then** idempotency by depositRef guarantees exactly-once credit
8. **Given** the NyxtVault contract itself, **When** it is built, **Then** it is written with the MNE/mnm retrieval stack, passes S4-grade simulator tests, and meets the same bar user contracts get (D13)

<details>
<summary>Supporting Decisions & Research</summary>

- **D13**: top-up rail vs metering rail; dogfood mandate
- **D25 / D34**: reserve-then-settle mechanics; no credit-backs; deposits one-way
- **D37**: interim hosted proving for the deposit signing ceremony
- **D43**: accounts keyed by unshielded address
- **D45**: NyxtVault Architecture C (resolves Q6/Q26)
- **D46**: orphaned deposits — no auto-credit, support table
- **D47**: rate/reserve/minimum as config tunables
- **R4**: the design brief (`archive/BRIEF-nyxt-deposit-design.md`) — attribution analysis, shielded-NYXT rejection, finality gating
- **Watching (pre-implementation gate)**: R4 vault-funding spike — Lace/`balanceUnsealedTransaction` funding a contract-side `receiveUnshielded` on pre-prod; a failed spike triggers a logged revision
- **Deferred to Story 10**: NYXT burn semantics at reconcile/settle

*Full context: `discovery/archive/DECISIONS.md`, `discovery/archive/RESEARCH.md`*
</details>

---

### User Story 7 - Project persistence & rehydration (Priority: P7)

**Revision**: v1.0

As a Midnight developer, I want my projects to survive closing the tab and reopen exactly where I left them, so that the ephemeral in-browser runtime never puts my work at risk.

Postgres rows are the authoritative copy (D26): files as `(project_id, path, content, version)` with **turn-scoped transactional commits** — rehydration can never observe half an agent edit. Turn-scoped version history is retained with a config retention window (D48) — undo/restore is future-enabled, not in scope. Chat history persists alongside and rehydrates on open (D23). Projects belong to the account's unshielded address (D43); one live session per project (D40). The **manifest endpoint** (paths + content hashes, D38) is the single convergence surface for both reconnect resync and reopen rehydration. Reopen pipeline: manifest → VFS rehydrate → full recompile repopulates R2 (D7/D35) → chat history restored → dev boot (S3). Write cadences differ by author: agent writes commit as turn-scoped batches; user edits (`file:changed`, Story 14) commit immediately per file, and the editor is read-only during an active turn. `node_modules` and artifacts are never persisted. Deletion is soft with 30-day recovery, while the ephemeral cascade (R2 cleanup, contract teardown via S8, session termination) runs immediately (D49). Size caps (1 MB/file, 50 MB/project defaults) and per-account quota are config tunables. Story 13 handoff materializes archives/git from these rows.

**Independent Test**: with no agent involved, scripted file commits followed by a reopen must reproduce the exact file tree (manifest hash equality), restored chat history, and a booted preview; a crash injected mid-commit must leave the previous consistent version.

**Acceptance Scenarios**:

1. **Given** an agent turn producing file changes, **When** the turn ends, **Then** all its writes commit as one transaction stamped with a version, and a crash mid-commit leaves the previous consistent state
2. **Given** a project reopen, **When** the pipeline runs, **Then** the VFS rehydrates from the manifest, artifacts recompile to a fresh R2 prefix, chat history restores, and the preview boots — the project resumes exactly where it left off
3. **Given** a user edit via the editor (S14), **When** `file:changed` arrives outside an active turn, **Then** it commits immediately as a single-file transaction; during an active turn the editor is read-only
4. **Given** any session, **When** it requests a project it does not own, **Then** access is denied — ownership is the unshielded address (D43)
5. **Given** the manifest endpoint, **When** reconnect or reopen queries it, **Then** it serves the current paths + content hashes consistently with the last committed transaction (D38)
6. **Given** a write exceeding the size caps, **When** persistence is attempted, **Then** it is rejected with a named error — never silently truncated
7. **Given** project lifecycle actions (create, rename, delete), **When** delete runs, **Then** the project soft-deletes with 30-day recovery while the cascade runs immediately: R2 prefix cleanup, deployed-contract teardown handoff (S8), open sessions terminated with notice (D49)

<details>
<summary>Supporting Decisions</summary>

- **D23**: chat history persisted and rehydrated
- **D26**: Postgres-rows authoritative store, turn-scoped transactions, exclusions
- **D38**: manifest endpoint as the convergence surface
- **D40**: single live session; deletion/session-termination machinery
- **D43**: ownership by unshielded address
- **D48**: turn-scoped version history, config retention; undo future-enabled, not in scope
- **D49**: soft-delete 30-day recovery; immediate ephemeral cascade; caps/quota as config

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 8 - Contract deploy loop (Priority: P8)

**Revision**: v1.0

As a Midnight developer, I want my generated contract deployed to pre-prod on request — with the address flowing straight into my running preview — so that "it works in the simulator" becomes "it runs on the real network" in one step.

Deploys are **explicit** — `deploy:request` from the user or a user-instructed agent (PRD §12), never automatic per green build — and **free on pre-prod** (D51). The orchestrator executes directly via the Midnight SDK with a server-held deploy key that never reaches the browser, WebContainer, or any generated file; the toolchain MCP stays compile-only and secret-free (D9, D50). A deploy requires a green build (D35 already produced its artifacts). Pipeline: build the deploy transaction from the latest green artifacts → prove server-side via the D37 prover (server-side deploys always needed non-wallet proving, independent of the Lace story) → sign → submit → **await finality** → only then emit `contract:deployed { address }`, exactly once (mirrors D45; no phantom addresses from reorgs). Story 3 handles the client side (`.env.local` → restart → config.ts chokepoint, D10). Redeploys register the new address and mark the prior one superseded in a deploy registry (project, address, version, status) — exactly one active address per project; the cleanup job and the D49 deletion cascade both drive teardown through the registry. Whether superseded contracts can be disabled on-chain is a **verify-via-mnm implementation item** (PRD §16), never assumed. One in-flight deploy per project; requests during an active turn queue until it ends. The server deploy wallet's tDUST balance is monitored with alerts.

**Independent Test**: with a green build persisted and no agent swarm, a scripted `deploy:request` must produce a finalized contract on pre-prod, exactly one `contract:deployed` event, a correct registry row, and — on redeploy — a superseded prior row and a new active address.

**Acceptance Scenarios**:

1. **Given** a project with a green build, **When** the user (or user-instructed agent) sends `deploy:request`, **Then** the orchestrator validates ownership and greenness and starts the pipeline, streaming phases (proving, submitting, awaiting finality) to the activity stream (D20)
2. **Given** a running pipeline, **When** the transaction finalizes, **Then** `contract:deployed { address }` is emitted exactly once, the client injects the address (S3/D10), and the preview reloads against the live contract
3. **Given** a project without a green build, **When** `deploy:request` arrives, **Then** it is rejected with a named reason — compile and tests must pass first (D35)
4. **Given** a redeploy, **When** the new address finalizes, **Then** the deploy registry marks the prior version superseded, exactly one active address exists per project, and the cleanup job processes superseded entries (D9)
5. **Given** a deploy failure (node rejection, proving failure, insufficient tDUST), **When** the pipeline aborts, **Then** the failure is loud with diagnostics, no `contract:deployed` is emitted, and the request is retriable
6. **Given** any client-bound payload (protocol events, generated files, VFS sync), **When** audited, **Then** the deploy key appears nowhere outside the orchestrator boundary (D9, D50)
7. **Given** a second `deploy:request` while one is in flight, **When** it arrives, **Then** it is rejected with an in-progress notice — one in-flight deploy per project
8. **Given** a project deletion (D49), **When** the cascade runs, **Then** active contracts are torn down through the same registry machinery

<details>
<summary>Supporting Decisions</summary>

- **D9**: server-key deploys; frontends never hosted; teardown on redeploy
- **D10**: address injection via `.env.local` + config.ts chokepoint (client side in Story 3)
- **D35**: green build precondition — artifacts already exist at deploy time
- **D37**: interim hosted prover serves server-side deploy proving
- **D45**: finality-gating pattern shared with deposit crediting
- **D49**: deletion cascade drives teardown through the deploy registry
- **D50**: orchestrator-direct execution; toolchain MCP stays compile-only
- **D51**: deploys free on pre-prod; revisit with the D37 real-value review
- **Verify at implementation (mnm)**: whether superseded contracts support any on-chain disable

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 9 - Escape-hatch tab + interim hosted proving (Priority: P9)

**Revision**: v1.0

> ⛔ **HARD PRE-IMPLEMENTATION GATE (D54)**: implementation of this story MUST NOT start until the R6 PoC live run confirms Lace injects `window.midnight` into the top-level preview origin (Q3). A negative result triggers a substantial logged revision of the escape-hatch mechanism.

As a Midnight developer, I want to open my generated DApp in a real tab where my wallet works, so that I can sign and submit genuine pre-prod transactions against my deployed contract.

Extension injection is blocked inside the preview iframe by design (D4), so "Open Preview in New Tab" (a user gesture) opens the preview top-level, where — per the Q3 assumption under test — Lace injects. The tab bootstraps through the connect-bridge popup against the `/webcontainer/connect/*` carve-out (S3/FR-021); the popup fires without a user gesture, so blocked popups get detect-and-guide UX, and a persistent host-page notice marks the lifetime coupling — the WebContainer lives in the host tab and the preview dies with it (D53, R6). No opener/postMessage channel exists between the tabs (R6); coordination flows through the VFS/env and server. Transactions in the generated app: v4 wallet connect (scaffold mirrors S5's four states), signing via Lace, proving via the scaffold's interim default — `httpClientProofProvider` against the Nyx prover with **session-bound short-lived tokens and per-session rate limits** (D37, D52) — flipping back to in-wallet proving by config when the upstream fix lands. On-chain confirmation reads through the indexer. Stale tabs after redeploys are harmless (EC-41).

**Independent Test**: with a deployed contract and a Lace-equipped browser, the full hatch flow — open top-level, bridge connect, wallet connect, circuit call proving through the token-gated prover, indexer confirmation — must complete; with a blocked popup, the guidance flow must surface instead of a hang.

**Acceptance Scenarios**:

1. **Given** a running preview, **When** the user clicks "Open Preview in New Tab", **Then** the preview opens top-level, the host page shows the persistent lifetime notice, and the bridge popup connects the tab
2. **Given** the top-level tab with Lace installed, **When** the generated app loads, **Then** `window.midnight` is present and the app's connect flow works (Q3 gate)
3. **Given** a connected wallet and a deployed contract, **When** the user triggers a circuit call, **Then** the transaction proves via the Nyx prover (D37), is signed by Lace, submits, and the app confirms the state change from the indexer
4. **Given** the prover endpoint, **When** any request arrives, **Then** only session-bound short-lived tokens are admitted and per-session rate limits apply — proving is never an open compute faucet (D52)
5. **Given** a blocked bridge popup, **When** no bridge is established within the timeout, **Then** detect-and-guide UX explains allowing popups for the origin and reloading (D53, R6)
6. **Given** the host tab closes, **When** the preview dies with it, **Then** the prior notice and the D20 recovery message on reopen make the coupling legible — never a mystery failure
7. **Given** a redeploy while an escape-hatch tab is open, **When** the stale tab keeps using the old address, **Then** interactions remain harmless on pre-prod and a reload picks up the new address
8. **Given** the upstream wallet-sdk fix lands, **When** the scaffold default flips to in-wallet proving (D37 Watching), **Then** the change is config-level — no story revision required beyond the flip

<details>
<summary>Supporting Decisions & Research</summary>

- **D4**: iframe injection blocked by design; escape hatch is the signing surface
- **D37**: interim hosted prover; flip-back Watching item
- **D52**: session-bound proving tokens, per-session rate limits
- **D53**: detect-and-guide popup UX; persistent lifetime notice
- **D54**: Q3 as HARD pre-implementation gate
- **R6**: bridge route, gesture-less popup, tab-lifetime coupling, no opener channel
- **R5/R7/R8**: connector v4 facts and the authorized-but-unavailable state the scaffold's connect UX mirrors

*Full context: `discovery/archive/DECISIONS.md`, `discovery/archive/RESEARCH.md`*
</details>

---

### User Story 10 - Ledger reconcile & settle (Priority: P10)

**Revision**: v1.0

As the platform operator, I want the off-chain NYXT ledger and the on-chain vault reconciled lazily and audibly, so that the credit system stays provably honest without ever touching the per-prompt path.

Per-turn settlement is already off-chain (D34, Story 6); this is the **lazy on-chain leg** (D13). A daily job (config cadence, D56) compares three sources: the append-only Postgres ledger, the finalized on-chain deposit log (the same indexer feed that credits deposits), and the vault's NYXT balance. Drift between chain and ledger is a **loud alarm** — it can only mean a bug or tampering, and is never auto-corrected. The job then **burns vault NYXT matching consumed credit since the last watermark, exactly once per watermark** (D55) — on-chain supply approximates outstanding credit, and the burn circuit is the platform's second dogfood circuit, orchestrator-only, designed at implementation via mnm/MNE (never memory). Idempotent runs, a persisted queryable report per run, zero presence in any user path. Deposits remain one-way (D34): reconcile never returns funds.

**Independent Test**: seed a ledger with known deposits and settlements, run reconcile against the pre-prod vault: a clean state must produce an equality report plus a correct burn; an injected ledger discrepancy must produce an alarm and no burn; an interrupted run must resume without double-burning.

**Acceptance Scenarios**:

1. **Given** the daily schedule fires (D56), **When** the job runs, **Then** it compares ledger credits against finalized on-chain deposits and the vault balance, and produces a signed, persisted reconcile report
2. **Given** a clean run, **When** totals match within the expected settlement lag, **Then** the report records equality and the batched burn executes exactly once per watermark (D55)
3. **Given** drift between on-chain deposits and ledger credits, **When** the comparison runs, **Then** a loud alarm fires with the discrepancy detail — drift is never auto-corrected silently
4. **Given** a reconcile run interrupted mid-flight, **When** it re-runs, **Then** idempotency guarantees no double-burn and no double-count (the D45 exactly-once pattern)
5. **Given** any user activity at any time, **When** reconcile runs, **Then** zero user-facing latency is added — the job never touches the per-prompt or per-deposit paths (D13)
6. **Given** the reconcile history, **When** the operator reviews it, **Then** every run's report (inputs, totals, actions, outcome) is retained and queryable

<details>
<summary>Supporting Decisions</summary>

- **D13**: chain as top-up rail only; dogfood mandate covers the burn circuit
- **D34**: off-chain settlement; deposits one-way
- **D45**: NyxtVault architecture; exactly-once watermark pattern
- **D55**: batched burn per watermark; burn circuit orchestrator-only, designed via mnm/MNE
- **D56**: daily schedule, config cadence, no threshold trigger

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 12 - Token ledger UI (Priority: P12)

**Revision**: v1.0

As a Midnight developer, I want to see exactly where my NYXT went, so that the reserve-and-settle metering never feels like a black box.

A rendering story over the S6/S10 machinery — no new ledger semantics. Balance card shows **available** and **reserved** distinctly (FR-043), including the negative-balance state with its top-up call-to-action (D34). The entry feed renders the append-only log: deposits (pending → credited with on-chain reference), reserves appearing at turn start, settlements linked to turns with actual token consumption. Updates ride the existing WebSocket session (D12); the top-up flow (S6) is entered from here; a low-balance nudge fires once per session below a config threshold (D47). Operator-facing reconcile reports (S10) are not user-visible. Every displayed figure derives from ledger rows — never client-side arithmetic.

**Independent Test**: with a seeded ledger and no agent activity, the page must render balances matching the rows exactly; scripted reserve/settlement events over the socket must update the display without reload.

**Acceptance Scenarios**:

1. **Given** the ledger page, **When** it renders, **Then** available and reserved balances match the ledger rows exactly, and a negative balance shows the blocked-prompts state with a top-up call-to-action (D34)
2. **Given** a turn starting or settling, **When** the ledger changes, **Then** the UI reflects the reserve/settlement over the existing WebSocket without a reload
3. **Given** the entry feed, **When** the user inspects any settlement, **Then** it links to its turn and shows actual token consumption; deposits show pending/credited with their on-chain reference
4. **Given** a balance below the config threshold, **When** the user is active, **Then** a low-balance nudge appears once per session — not a nag loop
5. **Given** any displayed number, **When** audited against Postgres, **Then** it derives from ledger rows — no client-side balance arithmetic

<details>
<summary>Supporting Decisions</summary>

- **D34**: reserve-then-settle states this UI renders, including negative balances
- **D47**: nudge threshold as config
- **FR-043**: the append-only log and dual balances
- **S10 boundary**: reconcile reports are operator-only

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 13 - Project handoff (Priority: P13)

**Revision**: v1.0

As a Midnight developer, I want to take my project home — as an archive or a git clone — so that Nyx never holds my code hostage.

Both mechanisms materialize on demand from the authoritative Postgres rows (D17, D26). **Archive**: a zip of the latest committed tree — source only — plus a generated README documenting local-run requirements (`VITE_CONTRACT_ADDRESS`, artifact/prover configuration). **Clone**: a bare repo with commits synthesized from D48 turn history, descriptive message per turn/user-edit commit (D59), served read-only over git HTTP behind an unguessable, revocable, regenerable token URL (D58). Revocation invalidates immediately; materialized repos cache per version watermark. Ownership (D43) gates downloads and token management; soft-deleted projects have handoff disabled (D49). No secrets exist in project files by design (PRD §16) — an enforced scan backs the rule.

**Independent Test**: for a project with several turns of history: the archive must hash-match the latest manifest; a token-URL clone must yield the synthesized history read-only; revocation must kill the URL immediately.

**Acceptance Scenarios**:

1. **Given** a project, **When** the owner downloads the archive, **Then** the zip matches the latest committed manifest exactly (hash equality), contains source only, and includes the generated README
2. **Given** clone sharing enabled, **When** anyone clones the token URL, **Then** they get a read-only repo whose commits reflect the turn/user-edit history with descriptive messages (D58, D59)
3. **Given** a token revocation, **When** the old URL is used, **Then** it is rejected immediately; regeneration mints a fresh token
4. **Given** a soft-deleted project, **When** any handoff endpoint is hit, **Then** it is disabled with an explanation (D49)
5. **Given** any archive or materialized repo, **When** scanned, **Then** it contains zero secrets — by design and by check
6. **Given** new commits after a materialization, **When** the next clone happens, **Then** the repo reflects the latest watermark (cache invalidated)

<details>
<summary>Supporting Decisions</summary>

- **D17**: handoff in scope — archive + read-only clone URL
- **D26/D48**: rows + turn history are the materialization source
- **D43/D49**: ownership gating; soft-delete disables handoff
- **D58**: unguessable revocable token URLs
- **D59**: commits synthesized from turn history

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

### User Story 14 - In-browser editor (Priority: P14)

**Revision**: v1.0

As a Midnight developer, I want to edit generated code directly in the browser — with Compact syntax highlighting — so that quick fixes don't need a round trip through the agent.

Monaco, with Compact highlighted via a Monarch tokenizer hand-ported from the LFDT-Minokawa TextMate grammar (D18); other languages use Monaco built-ins. Save flow (D60): ~1s idle debounce → auto-save → `file:changed` → immediate per-file commit (S7/FR-047) + VFS write → HMR (S3); dirty indicator while debouncing. Read-only during active turns with a visible lock (FR-047); an unsaved edit at turn start is surfaced, never dropped (EC-36). A `.compact` edit marks verification **stale/unverified** until the next green cycle — unverified is never presented as done (D35 semantics). The agent's next turn receives user-edit diffs as context. Oversized/binary files open read-only. Highlighting is best-effort; the compiler owns correctness.

**Independent Test**: with a persisted project and no agent, editing a file must produce (after the debounce) a commit, a VFS update, and an HMR refresh; editing a `.compact` file must flip the verification badge to stale; a simulated turn must lock the editor.

**Acceptance Scenarios**:

1. **Given** any project file, **When** opened in the editor, **Then** Monaco renders it, with Monarch-based Compact highlighting for `.compact` files (D18)
2. **Given** an edit followed by ~1s idle, **When** auto-save fires, **Then** `file:changed` commits the file immediately, the VFS updates, and HMR reflects the change in the preview (D60)
3. **Given** an active agent turn, **When** the user focuses the editor, **Then** it is read-only with a visible lock notice; an unsaved edit at turn start is surfaced, never dropped (FR-047, EC-36)
4. **Given** a `.compact` edit, **When** saved, **Then** the project's verification status shows stale/unverified until the next green cycle
5. **Given** the next agent turn after user edits, **When** it starts, **Then** the agent's context includes the user-edit diffs
6. **Given** an oversized or binary file, **When** opened, **Then** a read-only viewer explains the limitation

<details>
<summary>Supporting Decisions</summary>

- **D18**: editor in scope; Monarch tokenizer path
- **D60**: debounced auto-save
- **FR-047 / EC-36**: immediate user-edit commits; read-only during turns; unsaved-edit surfacing
- **D35 semantics**: `.compact` edits invalidate green until the next verified cycle

*Full context: `discovery/archive/DECISIONS.md`*
</details>

---

## Edge Cases

| ID | Scenario | Handling | Stories Affected |
|----|----------|----------|------------------|
| EC-01 | Available balance below the flat reserve, or consumption reaches the reserve mid-turn | Below-reserve balance: prompt rejected with top-up call-to-action. Mid-turn reserve exhaustion: current compile+test cycle completes, settlement draws overage from remaining balance (balance may go negative; new prompts blocked until topped up) (D34) | Story 1, Story 6 |
| EC-02 | Tome, mnm, or compiler MCP unreachable mid-turn | 3 retries with backoff; then loud failure naming the service; turn settles at actual token consumption up to the failure point — no refund (D34) | Story 1 |
| EC-03 | Verify loop exhausts 3-cycle budget without passing | Honest failure: diagnostics summary, WIP files kept in VFS, suggested next prompt; settles at actual consumption (D21, D34) | Story 1 |
| EC-04 | New prompt submitted while a turn is running | Chat input disabled until the turn ends; single active turn per project (D24) | Story 1 |
| EC-05 | Off-domain prompt (not a DApp request) | Cheap-tier intent classifier declines with an explanatory message; no reserve placed (D25, D34) | Story 1 |
| EC-06 | User closes the tab mid-turn | WebContainer dies with the tab; on reopen chat history rehydrates (D23) and a recovery message explains what completed (D20); agent state reconciles against persisted source | Story 1, Story 7 |
| EC-07 | Artifact upload partially fails mid-set | No artifacts:ready; tool reports failure; manifest-last or verify-before-announce guarantees no incomplete prefix ever exists | Story 2 |
| EC-08 | Artifacts expire while a preview session is open past the lifecycle window | Fetch failure maps to a clear reopen-the-project error; reopen triggers recompile (D36) | Story 2, Story 3 |
| EC-09 | Compiler version bump breaks an existing project at recompile-on-open | Surfaces as a normal compile failure into the agent verify loop (retrieval-driven fix) with a user-visible explanation; bump cadence is a Watching item | Story 2 |
| EC-10 | Artifact exceeds the 512 MB edge-cache limit | Serves from R2 uncached (R3); telemetry flag for visibility | Story 2 |
| EC-11 | Turn changes only frontend files (no .compact source) | No compile invoked, no artifacts:ready; preview runs without proving artifacts until a contract exists | Story 2, Story 3 |
| EC-12 | Pathological source hangs the compiler | Tool budget expires with an explicit failure that counts as one verify cycle; scale-to-zero reaps the machine | Story 2, Story 1 |
| EC-13 | npm install fails inside the container (registry flake) | One auto-reboot absorbs transients; second failure surfaces dev:status crashed with retry (D39) | Story 3 |
| EC-14 | file:write arrives while the container is still mounting/installing | Queued and applied post-mount in original order (D12) | Story 3 |
| EC-15 | Project opened in a second tab mid-turn | Last-tab-wins takeover; the old container dies like a tab close, so the D20 interrupted-turn recovery applies in the new session (D40) | Story 3 |
| EC-16 | Oversized or binary generated file in a sync event | Rejected against the D26 size caps with a loud, named error - never silently dropped | Story 3, Story 7 |
| EC-17 | Wallet extension cannot inject into the preview iframe | By design (D4): the preview UI always shows the escape-hatch affordance; real signing happens in the top-level tab (Story 9) | Story 3, Story 9 |
| EC-18 | Agent generates zero or trivial tests | No mechanical block (D41): steering + Review agent own quality; coverage telemetry (per-circuit) provides the evidence base for adding a floor via story revision | Story 4, Story 1 |
| EC-19 | Test run OOMs or crashes the container | D39 crash policy (one auto-reboot), then the run counts as a failing cycle | Story 4, Story 3 |
| EC-20 | Vitest collection error (syntax error in a test file) | Reported as failing results with collection diagnostics - not a stall, not a crash | Story 4 |
| EC-21 | Exported circuit has no test but suite passes | Green proceeds (D41); the gap is visible in per-circuit coverage telemetry | Story 4 |
| EC-22 | Simulator and compiler versions drift semantically | Versions pinned together in the scaffold; Watching item - drift forces a revision to compile/verify scenarios | Story 4, Story 2 |
| EC-23 | Legacy (pre-v4) connector wallet injected | Unsupported-wallet message naming the v4 requirement (R5) | Story 5 |
| EC-24 | User rejects authorization or the signature prompt | Clean cancel state; nonce burned; no session; no error tone | Story 5 |
| EC-25 | Wallet account switched in Lace mid-session | Session stays bound to the signed-in identity; acting as the new address requires a fresh sign-in (D43) | Story 5 |
| EC-26 | Multiple v4 wallets injected under window.midnight | Picker shown; Lace preferred by rdns when only one candidate; choice remembered per browser | Story 5 |
| EC-27 | Signature verification fails | Rejected, nonce burned, loud server log - no partial session state | Story 5 |
| EC-28 | On-chain deposit amount differs from the preregistered amount | Credit the on-chain truth; log the mismatch loudly for review | Story 6 |
| EC-29 | depositRef preregistered but never observed on-chain | Registration expires after TTL; abandoned top-up leaves no dangling pending state | Story 6 |
| EC-30 | Indexer outage while deposits are pending | Credits delayed with an explanatory pending state; scan resumes from cursor; ref idempotency makes catch-up safe | Story 6 |
| EC-31 | Raw NyxtVault.deposit call with an unregistered ref | Orphans table + manual support resolution; never auto-credited (D46) | Story 6 |
| EC-32 | Duplicate depositRef submitted on-chain | Contract rejects: ref already present in the public deposits map (D45) | Story 6 |
| EC-33 | Server crash mid-commit | Transactional atomicity: previous consistent version remains; the turn's partial writes never become visible (D26) | Story 7 |
| EC-34 | Rehydration encounters missing or corrupt rows | Loud failure state naming the project; support path; never a silently empty project | Story 7 |
| EC-35 | Project deleted while a session is open elsewhere | Open sessions terminated with an explicit project-deleted notice via the D40 machinery (D49) | Story 7, Story 3 |
| EC-36 | User has unsaved edit when an agent turn starts | Editor locks read-only at turn start; the pending edit is surfaced for explicit resolution, never silently dropped | Story 7, Story 14 |
| EC-37 | Restore of a soft-deleted project | Rows rehydrate within the window; artifacts recompile and contracts redeploy fresh (addresses change, consistent with D9 teardown semantics) (D49) | Story 7, Story 8 |
| EC-38 | Server deploy wallet exhausts tDUST | Deploy fails loudly as a platform-side issue; ops alert fires; refunding is a runbook item | Story 8 |
| EC-39 | Node outage or finality timeout during deploy | Explicit pending-then-timeout state with retry; never a hanging spinner or phantom address | Story 8 |
| EC-40 | deploy:request during an active agent turn | Queued until the turn ends; user informed via the activity stream | Story 8, Story 1 |
| EC-41 | Escape-hatch tab open against a superseded address | Old contract remains on-chain; stale sessions interact harmlessly on pre-prod until reload; the registry is authoritative | Story 8, Story 9 |
| EC-42 | Reorg between submission and finality | Finality gating means no address was emitted; the pipeline retries or surfaces failure | Story 8 |
| EC-43 | Prover endpoint down or unreachable | Generated app surfaces proving-unavailable naming the cause; wallet and signing state unaffected | Story 9 |
| EC-44 | Prover cold start or queue under load | Explicit progress state in the generated app with bounded wait and named timeout | Story 9 |
| EC-45 | Concurrent proving jobs from one session | Capped by config; excess queued with feedback (D52) | Story 9 |
| EC-46 | Wallet on wrong network in the escape-hatch tab | Generated scaffold's network guard explains, mirroring S5's wrong-network state | Story 9, Story 5 |
| EC-47 | Popup blocked and guidance ignored | Preview tab remains on the bootstrap page with persistent guidance; no silent hang (D53) | Story 9 |
| EC-48 | Indexer unavailable at reconcile time | Run skipped and rescheduled; alert after N consecutive skips (config); never a partial comparison | Story 10 |
| EC-49 | Burn transaction fails on-chain | Report records the failure; retry next run; consumed watermark unmoved, so no double-burn | Story 10 |
| EC-50 | Settlement lag races the comparison window | Comparisons use a finalized watermark, never wall-clock now | Story 10 |
| EC-51 | Drift alarm fires during active user sessions | Sessions unaffected; ledger keeps operating on Postgres truth; alarm is operator-facing | Story 10 |
| EC-52 | Settlement lands while the ledger page's socket is disconnected | D38 resync refreshes ledger state on reconnect; no stale balance | Story 12, Story 3 |
| EC-53 | Deposit stuck pending on indexer lag | Pending state shows elapsed time with the EC-30 explanation | Story 12, Story 6 |
| EC-54 | Long entry history | Paginated feed over the append-only log; totals never truncated | Story 12 |
| EC-55 | Token brute-force attempts against clone URLs | Token entropy plus rate limiting; attempts logged | Story 13 |
| EC-56 | Concurrent clones while a new commit lands | Watermark isolation: each clone gets a consistent snapshot | Story 13 |
| EC-57 | Clone of a near-empty project | Valid repo with its README; never an error | Story 13 |
| EC-58 | Rapid edit bursts in the editor | Debounce serializes per file; every burst lands in exactly one commit; zero lost edits | Story 14 |
| EC-59 | Editor commit rejected on size cap | EC-16 named error surfaces in the editor; buffer content preserved | Story 14, Story 7 |

---

## Requirements

### Functional Requirements

| ID | Requirement | Stories | Confidence |
|----|-------------|---------|------------|
| FR-001 | Each agent role's provider + model MUST be specified in a server-side config file; supported providers MUST include OpenAI, Anthropic, Gemini, OpenRouter, and OpenAI-compatible custom endpoints; changing an assignment requires only a config edit plus redeploy (D19) | Story 1 | High |
| FR-002 | The Implementation agent MUST NOT surface Compact code that has not been compiled via the compiler MCP within the current turn (D3, D5) | Story 1 | High |
| FR-003 | The Scaffolding agent MUST orient via Tome retrieval at project birth; no static template system exists (D3) | Story 1 | High |
| FR-004 | A turn MUST spend at most 3 compile+test cycles and MUST end with an honest-failure summary (diagnostics, WIP files kept, suggested next prompt) on exhaustion (D21) | Story 1 | High |
| FR-005 | Charging MUST be token-metered via reserve-then-settle: a flat NYXT reserve placed after intent classification; at turn end (success, honest failure, or infra failure) the ledger settles at actual token consumption; no credit-back/refund operation exists; mid-turn reserve exhaustion completes the current compile+test cycle with overage drawn from remaining balance (D34) | Story 1, Story 6 | High |
| FR-006 | The turn UI MUST stream supervisor narration and a per-sub-agent activity feed, and MUST persistently indicate that preview/tests run in the open tab (D20) | Story 1 | High |
| FR-007 | Compile diagnostics, test results, and console errors MUST round-trip to the agent within the same turn via the WebSocket event protocol (D12) | Story 1 | High |
| FR-008 | Chat history MUST persist with the project in the authoritative store and rehydrate on project open (D23) | Story 1, Story 7 | High |
| FR-009 | Exactly one turn MAY be active per project; chat input MUST be disabled while a turn is running (D24) | Story 1 | High |
| FR-010 | The flat NYXT reserve MUST be placed after intent classification; declined off-domain prompts place no reserve and cost nothing; a new prompt requires available balance at or above the flat reserve (D25, D34) | Story 1, Story 6 | High |
| FR-011 | The compile tool MUST expose check mode (static validity, no key generation) and full mode (artifacts to R2); verify-loop iterations use check mode and the full compile runs when behavioural tests pass, with fixed platform steering - artifacts:ready fires at most once per successful turn (D35) | Story 2, Story 1 | High |
| FR-012 | Every compile response MUST carry structured diagnostics (severity, file, line, message) and the pinned compiler version (D6, D31) | Story 2 | High |
| FR-013 | Artifacts MUST be uploaded as R2 object metadata with Cache-Control public/max-age=31536000/immutable and correct Content-Type, in the FetchZkConfigProvider layout (keys/<circuit>.prover|.verifier, zkir/<circuit>.bzkir, integrity manifest); the artifact domain MUST carry the R3 CORS policy, CORP Transform Rule, and Cache Rule (R3) | Story 2 | High |
| FR-014 | artifacts:ready MUST be emitted only for a complete, verified artifact prefix - a prefix with a partial artifact set must never be announced | Story 2 | High |
| FR-015 | Compile requests for source whose content hash matches an existing prefix MUST reuse those artifacts without re-running key generation | Story 2 | High |
| FR-016 | A compile call MUST either complete within the tool budget or return explicit queued/progress state - silent timeouts are prohibited (D31) | Story 2 | High |
| FR-017 | R2 write credentials MUST exist only in the toolchain MCP; the orchestrator and browser only ever read artifacts (D6) | Story 2 | High |
| FR-018 | Artifact fetch failures on an expired prefix MUST surface a clear reopen-the-project guidance error, never a silent failure (D36) | Story 2, Story 3 | High |
| FR-019 | Server-to-client sync events MUST be applied to the VFS in order per path; events arriving during mount/install MUST be queued and applied post-mount in order (D12) | Story 3 | High |
| FR-020 | All agent feedback (dev:status, console streams, test results) MUST travel via WebContainer process streams read by the host page - never network from inside the container (R6) | Story 3, Story 4 | High |
| FR-021 | COEP require-corp and COOP same-origin MUST be set on all app responses except /webcontainer/connect/*, which MUST be served with COOP/COEP unsafe-none (R6) | Story 3 | High |
| FR-022 | node_modules and compiled artifacts MUST never be synced over the protocol; the VFS mounts source only and reinstalls dependencies (D26) | Story 3 | High |
| FR-023 | On WebSocket reconnect the client MUST fetch the authoritative file manifest (paths + content hashes), diff against the VFS, and apply the difference (D38) | Story 3, Story 7 | High |
| FR-024 | On container/dev-server crash the client MUST perform exactly one automatic reboot before surfacing dev:status crashed with a manual retry, informing the agent mid-turn (D39) | Story 3 | High |
| FR-025 | Browsers without crossOriginIsolated support MUST receive an upfront hard gate naming the requirement and supported browsers - no degraded mode (D39) | Story 3 | High |
| FR-026 | Exactly one live session per project: a new tab takes over and the previous tab is disconnected with a session-moved banner and take-back affordance (D40) | Story 3 | High |
| FR-027 | Behavioural tests MUST run via the OpenZeppelin Compact simulator under Vitest inside the WebContainer - in-process, deterministic, no chain, no devnet (D5) | Story 4 | High |
| FR-028 | test:results MUST be parsed from structured runner output and emitted via process streams within the same turn, with failures[] carrying per-test name and assertion diagnostics (D12, FR-020) | Story 4 | High |
| FR-029 | Green MUST mean the current cycle's suite passes (no mechanical adequacy gate, D41) and MUST be the sole trigger for the full artifacts compile and done-presentation (D35) | Story 4, Story 1 | High |
| FR-030 | Test runs MUST NOT be retried; a run exceeding 120 seconds MUST be killed and counted as a failing cycle with timeout diagnostics (D42) | Story 4 | High |
| FR-031 | Test files MUST be treated as project source: synced over the protocol, persisted in the authoritative store, and user-visible (D12, D26) | Story 4, Story 7 | High |
| FR-032 | Per-circuit test coverage MUST be measured and reported as telemetry - never enforced as a gate - to keep D41 evidence-based | Story 4 | High |
| FR-033 | Test failure payloads MUST be capped at 32 KB per event (config tunable) with deterministic truncation that always preserves per-test name and the first assertion message (REV-002) | Story 4 | High |
| FR-034 | Authentication MUST be SIWE-style: one-time server nonce with short expiry, domain-bound signed message (domain, nonce, issued-at, statement), server-side signature verification; no passwords or email (D13) | Story 5 | High |
| FR-035 | Accounts MUST be keyed by the wallet's unshielded address and auto-created on first successful sign-in; one wallet = one account, no linking flow (D43) | Story 5, Story 6, Story 7 | High |
| FR-036 | Sessions MUST be server-side behind HttpOnly/Secure/SameSite cookies with a 7-day sliding lifetime; explicit logout MUST invalidate immediately (D44) | Story 5 | High |
| FR-037 | The connect UX MUST distinguish four states: no extension, not authorized, authorized-but-wallet-unavailable (with wallet-side guidance per R8), and wrong network - never a generic failure | Story 5 | High |
| FR-038 | Only connector-v4 wallets are supported; legacy connectors MUST be rejected with a named unsupported-wallet message (R5) | Story 5 | High |
| FR-039 | Nonces MUST be single-use and expiring; reuse or expiry MUST reject verification and burn the nonce | Story 5 | High |
| FR-040 | Top-ups MUST require exactly one wallet signing ceremony via the NyxtVault deposit(depositRef, amount) circuit; no on-chain write may ever sit in the per-prompt path (D13, D45) | Story 6 | High |
| FR-041 | Ledger credit MUST occur exactly once per depositRef and only on a finalized SUCCESS indexer observation of the deposit call (D45) | Story 6 | High |
| FR-042 | depositRefs MUST be random, orchestrator-issued, preregistered against the account, single-use on-chain (contract rejects duplicates) and off-chain, and expire after a TTL if unseen (D45) | Story 6 | High |
| FR-043 | Reserve and settlement MUST be atomic entries in an append-only ledger log keyed by the account's unshielded address, holding available and reserved balances distinctly (D34, D43) | Story 6, Story 12 | High |
| FR-044 | Finalized deposits with unregistered refs MUST land in an orphans table for manual support resolution and MUST NOT be auto-credited (D46) | Story 6 | High |
| FR-045 | The tNIGHT-to-NYXT rate, flat reserve size, and minimum deposit MUST be config values changeable without spec or code revision (D47) | Story 6, Story 12 | High |
| FR-046 | The NyxtVault contract MUST be built with the MNE/mnm retrieval stack and pass simulator test suites to the same standard required of user-generated contracts (D13) | Story 6 | High |
| FR-047 | Agent file writes MUST commit as turn-scoped transactions; user edits MUST commit immediately per file; the editor MUST be read-only while a turn is active (D26, D48) | Story 7, Story 14 | High |
| FR-048 | Turn-scoped version history MUST be retained per file with a config retention window; latest state MUST always be reconstructable without history (D48) | Story 7 | High |
| FR-049 | The manifest endpoint MUST serve paths plus content hashes consistent with the last committed transaction, serving both reconnect resync and reopen rehydration (D38) | Story 7, Story 3 | High |
| FR-050 | Reopen MUST rehydrate the VFS, trigger a full recompile to a fresh artifact prefix, and restore chat history before the preview boots (D7, D23, D35) | Story 7, Story 2 | High |
| FR-051 | Every project operation MUST be gated by an ownership check on the account's unshielded address (D43) | Story 7 | High |
| FR-052 | Project deletion MUST soft-delete with a 30-day recovery window while immediately cascading R2 prefix cleanup, contract teardown (S8), and open-session termination with notice (D49) | Story 7, Story 8 | High |
| FR-053 | File and project size caps and the per-account project quota MUST be config tunables (defaults: 1 MB/file, 50 MB/project, 20 projects/account) enforced with named errors (D26, D49, REV-002) | Story 7 | High |
| FR-054 | Deploys MUST be explicit (deploy:request from user or user-instructed agent), MUST require a green build, and MUST be free of NYXT charge on pre-prod (D35, D50, D51) | Story 8 | High |
| FR-055 | contract:deployed MUST be emitted exactly once per deploy and only after on-chain finality - no address may ever be injected from an unfinalized transaction (D45 pattern) | Story 8, Story 3 | High |
| FR-056 | The deploy key MUST exist only in the orchestrator; deploys execute orchestrator-direct via the SDK with server-side proving through the D37 prover; the toolchain MCP remains compile-only and secret-free (D9, D50) | Story 8 | High |
| FR-057 | A deploy registry MUST track (project, address, version, status) with exactly one active address per project; redeploys mark priors superseded; the cleanup job and D49 deletion cascade operate through the registry (D9, D49) | Story 8, Story 7 | High |
| FR-058 | At most one deploy may be in flight per project; requests during an active agent turn MUST queue until the turn ends | Story 8 | High |
| FR-059 | The server deploy wallet's tDUST balance MUST be monitored with alerting; exhaustion failures MUST present as a platform-side issue, never a user fault | Story 8 | High |
| FR-060 | The escape hatch MUST open the preview top-level via user gesture, with a persistent host-page lifetime notice while a hatch tab is open (D4, D53) | Story 9 | High |
| FR-061 | The generated scaffold's proving provider MUST default to the Nyx hosted prover behind session-bound short-lived tokens with per-session rate limits, and MUST be flippable to in-wallet proving by config (D37, D52) | Story 9, Story 1 | High |
| FR-062 | Unauthorized or rate-exceeded prover requests MUST be rejected; proving tokens MUST age out and be reissued through the authenticated session (D52) | Story 9 | High |
| FR-063 | Bridge-popup failure MUST trigger detect-and-guide UX within a bounded timeout - never a silent hang (D53, R6) | Story 9 | High |
| FR-064 | No escape-hatch design may depend on an opener/postMessage channel between preview and host tabs; coordination flows through VFS/env and server (R6) | Story 9, Story 3 | High |
| FR-065 | Implementation of this story MUST NOT begin until the Q3 injection run passes (D54 hard gate) | Story 9 | High |
| FR-066 | Reconcile MUST run as a daily scheduled job (config cadence), idempotently, and MUST never execute in any user-facing path (D13, D56) | Story 10 | High |
| FR-067 | Reconcile MUST compare the append-only ledger, the finalized on-chain deposit log, and the vault balance; drift MUST alarm loudly and MUST NOT be auto-corrected | Story 10 | High |
| FR-068 | The batched burn MUST match consumed credit since the last watermark, exactly once per watermark, with orchestrator-only authorization on the burn circuit (D55) | Story 10, Story 6 | High |
| FR-069 | Every reconcile run MUST produce a persisted, queryable report of inputs, totals, actions, and outcome | Story 10 | High |
| FR-070 | The ledger UI MUST render available and reserved balances distinctly, derive every figure from ledger rows, and never compute balances client-side | Story 12 | High |
| FR-071 | Ledger changes MUST propagate to the UI over the existing WebSocket session without reload; reconnects refresh via the D38 resync path | Story 12, Story 3 | High |
| FR-072 | Settlements MUST link to their turns with actual consumption; deposits MUST show pending/credited state with their on-chain reference | Story 12 | High |
| FR-073 | The low-balance nudge MUST use a config threshold and appear at most once per session | Story 12 | High |
| FR-074 | The archive MUST equal the latest committed tree (source only, D26 exclusions) plus a generated README documenting local-run requirements | Story 13 | High |
| FR-075 | Clone access MUST be read-only behind an unguessable, revocable, regenerable token URL; revocation MUST take effect immediately (D58) | Story 13 | High |
| FR-076 | Materialized repo history MUST be synthesized from D48 turn/user-edit versions with descriptive commit messages, cached per version watermark (D59) | Story 13 | High |
| FR-077 | Handoff endpoints MUST be disabled for soft-deleted projects; archives and repos MUST pass a secrets scan (D49, PRD section 16) | Story 13, Story 7 | High |
| FR-078 | Compact files MUST receive Monarch-based syntax highlighting ported from the LFDT-Minokawa TextMate grammar (D18) | Story 14 | High |
| FR-079 | Editor saves MUST follow the debounced auto-save flow into immediate per-file commits, VFS write, and HMR (D60, FR-047) | Story 14, Story 7 | High |
| FR-080 | A .compact edit MUST mark the project's verification status stale until the next green cycle; the next turn's agent context MUST include user-edit diffs | Story 14, Story 4, Story 1 | High |
| FR-081 | Generated apps MUST read the contract address exclusively through the config.ts chokepoint (getContractAddress / isContractDeployed); no other module may touch import.meta.env, and the VITE_ prefix is mandatory (D10, constitution VII, REV-002) | Story 3, Story 1 | High |

### Key Entities

[To be documented during discovery]

---

## Success Criteria

| ID | Criterion | Measurement | Stories |
|----|-----------|-------------|---------|
| SC-001 | A cold counter-DApp prompt yields a compiling, simulator-tested Compact contract plus running preview within a single turn (at most 3 verify cycles) in at least 80 percent of attempts | Phase 0 Q5 spike protocol, then production turn telemetry | Story 1 |
| SC-002 | 100 percent of Compact surfaced to users was compiled via the compiler MCP in the same turn - zero tolerance | Turn-trace audit: every surfaced contract hash matches a same-turn compile record | Story 1 |
| SC-003 | Turn settlement (reserve release + actual-consumption charge) posts to the NYXT ledger within 60 seconds of turn end, for all turn outcomes | Ledger timestamps: turn-end event to settlement row | Story 1, Story 6 |
| SC-004 | Swapping any agent role's provider or model requires a config edit plus redeploy only - no code change | Staging drill: reassign one role across OpenAI, Anthropic, Gemini, OpenRouter, and a custom OpenAI-compatible endpoint | Story 1 |
| SC-005 | 100 percent of announced artifacts:ready prefixes serve the complete artifact set - zero fresh-prefix 404s | Integration test on every release plus production fetch telemetry | Story 2 |
| SC-006 | Compile requests with an unchanged content hash trigger zero key-generation runs | Toolchain MCP call logs: content-hash hit-rate audit | Story 2 |
| SC-007 | At least 99.9 percent of artifact fetches from the cross-origin-isolated preview succeed, excluding expired-prefix guidance cases | Client telemetry on FetchZkConfigProvider failures | Story 2, Story 3 |
| SC-008 | At least 95 percent of check-mode compiles return diagnostics within the agent tool budget without queued-state fallback (provisionally 60 seconds; adjustable when the D31 MCP benchmark lands) | Turn traces: check-mode latency distribution | Story 2 |
| SC-009 | A file:write event is visible in the running preview via HMR within 2 seconds at p95 | Client telemetry: event receipt to HMR update timestamps | Story 3 |
| SC-010 | Reconnect resync converges to manifest equality (zero divergent paths) in 100 percent of integration runs | Automated disconnect/reconnect integration test comparing VFS hashes to the authoritative manifest | Story 3 |
| SC-011 | Cold project open reaches dev-ready within 60 seconds at p95 | dev:status telemetry: open to ready; R6 baseline was ~26s headless | Story 3 |
| SC-012 | 100 percent of crashes surface as recovered or dev:status crashed within 5 seconds - no silent stalls | Crash-injection tests plus production dev:status telemetry | Story 3 |
| SC-013 | test:results round trip (spawn to event) completes within 30 seconds at p95 for the reference counter suite | Turn traces: spawn timestamp to event receipt | Story 4 |
| SC-014 | Zero flaky verdicts: identical source and suite produce identical results across 100 consecutive runs | Determinism harness in CI re-running the reference suites | Story 4 |
| SC-015 | 100 percent of turns presenting work as done had a green suite within that same turn | Turn-trace audit pairing done-presentations with green test:results events | Story 4, Story 1 |
| SC-016 | Per-circuit coverage telemetry is present for 100 percent of green turns | Telemetry completeness audit: every green turn carries a coverage record | Story 4 |
| SC-017 | Server-side signature verification and session establishment completes within 500 milliseconds at p95 (excluding wallet interaction time) | Server traces: nonce-verify request to session-cookie response | Story 5 |
| SC-018 | Nonce single-use is absolute: replay attempts rejected in 100 percent of adversarial tests | Replay test suite in CI against the auth endpoint | Story 5 |
| SC-019 | Session resumption within the sliding window requires zero wallet interactions | Client telemetry: resume flows containing wallet API calls must be zero | Story 5 |
| SC-020 | The four connect states (no extension / unauthorized / unavailable / wrong network) are correctly classified in 100 percent of the test matrix | Integration matrix driving each wallet condition against the connect flow | Story 5 |
| SC-021 | Exactly-once crediting holds under reorg and duplicate-observation tests: zero double-credits in adversarial CI runs | Credit-path test harness replaying duplicate and reorged observations | Story 6 |
| SC-022 | Deposit credit lands within 60 seconds of on-chain finality at p95 | Timestamps: finalized block observation to ledger credit row | Story 6 |
| SC-023 | Ledger invariant holds continuously: available + reserved equals credits minus settlements per account | Invariant check job over the append-only log; zero violations | Story 6, Story 12 |
| SC-024 | The NyxtVault suite passes with per-circuit coverage and full ZK artifact compilation before any deploy | CI gate on the contract package | Story 6 |
| SC-025 | Reopen reproduces the exact committed tree: manifest hash equality in 100 percent of integration runs | Automated close/reopen tests diffing VFS hashes against the manifest | Story 7 |
| SC-026 | Zero partial-turn states ever observable: crash-injection during commits always leaves the prior consistent version | Crash-injection harness around the commit path | Story 7 |
| SC-027 | Ownership enforcement is absolute: cross-account project access attempts rejected in 100 percent of adversarial tests | Authz test matrix across project operations | Story 7 |
| SC-028 | Soft-deleted projects are recoverable for the full window and unrecoverable after purge, verified both ways | Lifecycle test: restore at window edge; confirm purge after expiry | Story 7 |
| SC-029 | Zero unfinalized or reorged addresses ever emitted: contract:deployed always refers to a finalized contract | Adversarial integration tests injecting reorgs before finality; production audit of emitted addresses vs chain state | Story 8 |
| SC-030 | Deploy pipeline completes (request to contract:deployed) within 3 minutes at p95 | Pipeline phase telemetry; baseline set by the proving benchmark (adjustable) | Story 8 |
| SC-031 | Deploy-key exposure is zero: no client-bound payload, generated file, or synced byte ever contains key material | Static analysis + payload audit in CI on every release | Story 8 |
| SC-032 | Registry invariant holds: exactly one active address per project at all times after any deploy/redeploy/delete sequence | Invariant check job over the deploy registry; zero violations | Story 8 |
| SC-033 | Zero unauthorized proving requests succeed across the adversarial test matrix (missing, expired, forged, and cross-session tokens) | Prover authz test suite in CI | Story 9 |
| SC-034 | The full hatch flow (open, bridge, connect, prove, confirm) succeeds in 100 percent of gated-environment integration runs once Q3 passes | E2E harness with a Lace-equipped browser profile | Story 9 |
| SC-035 | Blocked-popup sessions surface guidance within 10 seconds in 100 percent of cases | UX telemetry on bridge-timeout to guidance-render | Story 9 |
| SC-036 | Prover proving latency for the reference counter circuit stays within 60 seconds at p95 | Prover telemetry; baseline set at the D31-style benchmark (adjustable) | Story 9 |
| SC-037 | Zero double-burns across interruption and replay tests: consumed watermark advances exactly once per burned batch | Crash/replay harness around the reconcile job | Story 10 |
| SC-038 | Injected ledger discrepancies are detected and alarmed in 100 percent of drift-injection tests | Drift-injection suite in CI | Story 10 |
| SC-039 | Reconcile adds zero latency to user paths: no user-facing endpoint invokes any reconcile code path | Static dependency check plus production trace audit | Story 10 |
| SC-040 | Displayed balances equal ledger-row truth in 100 percent of audits | Automated UI-vs-DB comparison in integration tests and periodic production audit | Story 12 |
| SC-041 | Ledger changes appear in the UI within 5 seconds at p95 | Telemetry: settlement row timestamp to UI render | Story 12 |
| SC-042 | Archive contents hash-match the latest committed manifest in 100 percent of integration runs | Automated archive-vs-manifest comparison | Story 13 |
| SC-043 | Revoked clone tokens are rejected in 100 percent of attempts, immediately after revocation | Revocation test suite | Story 13 |
| SC-044 | Zero secrets found across adversarial scans of archives and materialized repos | Secrets scanner in CI over generated handoff artifacts | Story 13 |
| SC-045 | Edit-to-HMR latency stays within 3 seconds at p95 (debounce included) | Client telemetry: last keystroke to preview update | Story 14 |
| SC-046 | Zero lost edits across rapid-edit stress tests; every save lands in exactly one commit | Editor stress harness diffing buffer history against commits | Story 14 |
| SC-047 | Monarch highlighting renders the full compact-examples corpus without tokenizer errors | Corpus render test in CI | Story 14 |

---

## Appendix: Story Revision History

*Major revisions to graduated stories. Full details in `archive/REVISIONS.md`*

| Date | Story | Change | Reason |
|------|-------|--------|--------|
| 2026-07-10 | Story 1 (v1.0 → v1.1) | Charging model rewritten to token-metered reserve-then-settle; credit-backs removed (scenarios 4/5/9, FR-005, FR-010, EC-01/02/03/05, SC-003) | Q16 pricing decision D34 superseded D22 — see REV-001 |
| 2026-07-10 | Cross-cutting | FR-081 added (D10 chokepoint); FR-033 quantified; FR-053 quota default; SC-008 provisional budget; BYOK persona retired | /sdd:analyze fixes, owner-authorized — see REV-002, D62 |
