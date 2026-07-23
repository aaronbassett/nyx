# Decision Log: nyx-platform

*Chronological record of all decisions made during discovery.*

---

[Decision entries will be added as decisions are made]

## D1: Target Midnight pre-prod with production-quality code — 2026-07-10

**Context**: Which network Nyx targets and what that implies

**Question**: [Question not provided]

**Options Considered**:
Pre-prod vs testnet vs mainnet

**Decision**: Target pre-prod, where tNIGHT/tDUST/NYXT carry no real-world value

**Rationale**: Constrains exactly two things: network pointed at and feature-set size. It is not a licence to cut corners; everything shipped must be production standard

**Implications**:
Real error handling, real key hygiene, no faked flows. Scope changes belong to the project owner alone; quality-vs-scope conflicts are raised to the owner, never resolved by lowering quality

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D2: All internal tool-calling standardized on MCP — 2026-07-10

**Context**: Agents need a uniform tool surface for compiler, docs, and skills

**Question**: [Question not provided]

**Options Considered**:
Mix of custom REST and AI plumbing vs uniform MCP

**Decision**: Compiler, docs layer (mnm), and skills layer (Tome/MNE) all present as MCP tools

**Rationale**: POLA: one uniform tool surface to the agents; fewer moving parts is a quality measure

**Implications**:
Compiler is an MCP server; Tome projects MNE skills via MCP; mnm consumed as MCP tool

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D3: Agent stack is a Vercel AI SDK supervisor swarm, not Claude Code headless — 2026-07-10

**Context**: Product selling point is model choice (BYOK or hosted mid-tier)

**Question**: [Question not provided]

**Options Considered**:
Claude Code headless vs custom Vercel AI SDK swarm

**Decision**: Custom AI SDK supervisor routing to Scaffolding, Planning, Implementation, Review sub-agents; cheap models for classification/scaffolding, high-reasoning models for Compact and verification

**Rationale**: Model-swappability is the requirement; Tome exists precisely to project MNE Claude-Code-format skills into a non-Claude-Code harness

**Implications**:
No template system: Scaffolding agent cold-starts via Tome and mnm, making Tome retrieval quality load-bearing (Phase 0). MNE verify/tooling called as discrete MCP tool calls; never reimplement MNE internal orchestration

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D4: Execution environment is StackBlitz WebContainers in an iframe — 2026-07-10

**Context**: Where generated apps run, install, and hot-reload

**Question**: [Question not provided]

**Options Considered**:
Cloud sandboxes/microVMs vs user-browser WebContainers

**Decision**: WebContainers execute the generated Vite + React 19 + shadcn + Tailwind v4 app entirely in the user browser

**Rationale**: Zero server-side runtime cost, no user-inspectable shell on our infra, natural tab-close lifecycle; stack matches MNE midnight-dapp-dev scaffold

**Implications**:
Requires COEP require-corp and COOP same-origin headers, so every third-party asset including R2 artifacts needs permissive CORS/CORP. Extension injection is blocked in the iframe, hence the Open Preview in New Tab escape hatch. Agent work requires an active session tab and the UI must communicate this state

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D5: Verification loop: simulator for determinism, pre-prod for realism, no devnet — 2026-07-10

**Context**: How generated contracts are verified each iteration

**Question**: [Question not provided]

**Options Considered**:
Local devnet (per-project or shared) vs simulator plus real pre-prod deploys

**Decision**: No devnet. Static validity via compiler MCP every iteration; behavioural validity via OpenZeppelin Compact simulator under Vitest inside the WebContainer every iteration; deployment validity via actual pre-prod deploy on redeploy

**Rationale**: Determinism comes from the simulator, realism from actual pre-prod deploys; devnet adds stateful infrastructure for no determinism gain

**Implications**:
Tests must be deterministic, flakiness unacceptable. Test results and runtime errors stream back to the agent over the WebSocket event protocol

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D6: Isolated compiler service: MCP wrapping native compactc on Fly.io — 2026-07-10

**Context**: Agents need server-side compilation independent of the browser

**Question**: [Question not provided]

**Options Considered**:
Public API with auth vs private-mesh service

**Decision**: Standalone MCP server exposing a compile tool; no public IP, reachable only over Fly 6PN at midnight-compiler-mcp.flycast; scale-to-zero; stateless source-in diagnostics-plus-artifact-URLs-out

**Rationale**: Private by construction means no auth tokens to leak; scale-to-zero means zero idle cost

**Implications**:
Compiler version is pinned and surfaced to agents (syntax drifts between versions). Holds the only R2 write credentials. Sizing and concurrency behaviour still open

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D7: Artifact storage on Cloudflare R2 with content-hashed immutable paths — 2026-07-10

**Context**: Prover/verifier keys and zkIR are large and fetched repeatedly by browsers

**Question**: [Question not provided]

**Options Considered**:
S3 vs R2; mutable vs content-hashed paths

**Decision**: R2 with 1-day lifecycle rules plus delete-on-project-close; paths content-hashed per compile and served with immutable long-lived Cache-Control; artifacts recompiled on project open

**Rationale**: Zero egress fees for repeatedly-fetched large keys; content-hashed URLs make stale-edge-cache problems impossible

**Implications**:
Bucket/custom domain must serve CORS/CORP headers compatible with the cross-origin-isolated preview or fetches fail silently. Time-weighted storage stays inside the 10GB free tier

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D8: Proving layer: Lace-delegated proving, R2 zk config, IndexedDB private state — 2026-07-10

**Context**: Generated apps need proving, zk config, and private state providers

**Question**: [Question not provided]

**Options Considered**:
Remote proof servers on our infra vs wallet-delegated proving

**Decision**: Scaffold with dappConnectorProofProvider on window.midnight, FetchZkConfigProvider pointed at the R2 prefix, and levelPrivateStateProvider on browser IndexedDB

**Rationale**: No proof servers on our infrastructure: remote proving would degrade under load and blow the budget; private state never leaves the user machine

**Implications**:
Contingent on Q2: whether current Lace proves in-wallet must be verified via mnm in Phase 0 before building on this

**Stories Affected**: [Stories not specified]

**Related Questions**: Q2

---

## D9: Contract deploys by orchestrator with server-held key; frontends never hosted — 2026-07-10

**Context**: Who executes pre-prod deploys and where keys live

**Question**: [Question not provided]

**Options Considered**:
Client-side deploys vs server-key deploys

**Decision**: Orchestrator deploys to pre-prod with a deploy key that lives only in the main app server; client/agent requests deploy over WebSocket and receives contract:deployed with the address; superseded contract versions torn down on redeploy

**Rationale**: Deploy key never reaches browser or WebContainer (zero-trust boundary); WebContainer preview plus escape-hatch tab is the only frontend runtime so there is no frontend deploy pipeline

**Implications**:
The R2 write credentials and deploy key are the two secrets that never cross the server boundary

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D10: Contract address is runtime config through a single chokepoint module — 2026-07-10

**Context**: Generated apps need the deployed address without hardcoding

**Question**: [Question not provided]

**Options Considered**:
Hardcode in source vs env-var runtime config

**Decision**: On contract:deployed the client writes VITE_CONTRACT_ADDRESS into .env.local in the WebContainer VFS; the app reads it only via client/src/lib/config.ts (getContractAddress / isContractDeployed)

**Rationale**: VITE_ prefix is mandatory (Vite guardrail against secret leakage; unprefixed vars are silently undefined); a single chokepoint keeps the Implementation agent steerable

**Implications**:
Pre-deploy state renders a graceful deploy-your-contract-first guard instead of white-screening; nothing else touches import.meta.env directly

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D11: Project source persisted server-side as authoritative copy — 2026-07-10

**Context**: Projects must survive tab close despite ephemeral WebContainer VFS

**Question**: [Question not provided]

**Options Considered**:
Browser-only vs server-side authoritative store

**Decision**: Server-side store is authoritative and mirrored into the WebContainer VFS; on project open the VFS is rehydrated and artifacts recompiled to repopulate R2

**Rationale**: The VFS is in-memory and dies with the tab; R2 artifacts are ephemeral by design so source must be the durable root

**Implications**:
Store choice (Postgres rows vs non-expiring R2 prefix vs other) is Q1 and blocks Phase 1 file-event handler design

**Stories Affected**: [Stories not specified]

**Related Questions**: Q1

---

## D12: Bidirectional WebSocket sync protocol between chat interface and WebContainer — 2026-07-10

**Context**: Agent verification loop and error visibility need a return path

**Question**: [Question not provided]

**Options Considered**:
One-way push vs bidirectional event protocol

**Decision**: Bidirectional events: server-to-client file:write, file:delete, contract:deployed, artifacts:ready; client-to-server test:results, console:log/error, dev:status, deploy:request, file:changed

**Rationale**: The agent must see test results and runtime errors, not just compile errors, for the verification loop to close

**Implications**:
file:changed is contingent on the in-browser editor scope decision (Q11)

**Stories Affected**: [Stories not specified]

**Related Questions**: Q11

---

## D13: Token economy: chain is the top-up rail, Postgres is the metering rail — 2026-07-10

**Context**: Per-prompt on-chain writes would be UX death

**Question**: [Question not provided]

**Options Considered**:
On-chain metering vs off-chain ledger with on-chain top-up

**Decision**: Deposit tNIGHT into the Nyx deposit contract (one on-chain tx) to mint an off-chain NYXT balance in Postgres; prompts decrement the Postgres ledger; lazy on-chain reconcile/settle; SIWE-style nonce-Lace-signature-session auth

**Rationale**: No on-chain write ever sits in the per-prompt path; metering must be instant

**Implications**:
Deposit contract and real NYXT minting are Phase 1 scope and the platform dogfood moment, built with the same MNE/mnm stack to the same standard. Token design must fit Midnight shielded/UTXO model (Q6), not ERC20 account-model instincts

**Stories Affected**: [Stories not specified]

**Related Questions**: Q6

---

## D14: BYOK is settings-page CRUD, scheduled last — 2026-07-10

**Context**: Bring-your-own-key model management scope and timing

**Question**: [Question not provided]

**Options Considered**:
Build early as AI infrastructure vs late as CRUD

**Decision**: Settings-page CRUD with keys encrypted at rest, using createOpenAICompatible for the OpenAI-compatible long tail; lands in Phase 3

**Rationale**: It is the easiest item in the plan, dressed up as AI infrastructure; nothing else depends on it

**Implications**:
Anthropic, OpenAI, Gemini, or any OpenAI-compatible endpoint, plus our hosted mid-tier default

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D15: Four-phase delivery, each phase ends shippable — 2026-07-10

**Context**: Sequencing bounds feature set, never quality

**Question**: [Question not provided]

**Options Considered**:
Big-bang vs phased shippable increments

**Decision**: Phase 0 de-risks five load-bearing assumptions before app code; Phase 1 vertical slice (wallet, token economy, chat plus swarm, preview plus sync, compile, verify loop); Phase 2 deploy loop; Phase 3 extended features (BYOK, ledger UI polish, conditional handoff/editor)

**Rationale**: Phase 1 alone is a legitimate product and proves the genuinely novel part: prompt to compiling tested Compact contract plus running preview

**Implications**:
A phase is done when its features are production-quality, not when the happy path works. Phase contents are owner scope decisions; building agents execute, they do not trim

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D16: Story backlog approved: 12 core stories in proposed deep-dive order — 2026-07-10

**Context**: Phase 2 exit criteria require user agreement on story set and priorities

**Question**: [Question not provided]

**Options Considered**:
Approve as proposed; approve with reorder; change the set

**Decision**: Owner approved the 12-story backlog with deep-dive order S1 agent swarm, S2 compile pipeline, S3 preview/sync, S4 verify loop, S5 wallet connect, S6 token economy, S7 persistence, S8 deploy loop, S9 escape hatch, S10 reconcile/settle, S11 BYOK, S12 ledger UI

**Rationale**: Specify the novel, risky agent/compile/verify core first; PRD phase order preserved otherwise

**Implications**:
Story 1 moves to In Progress; stories 13 and 14 appended from resolved scope questions Q10 and Q11

**Stories Affected**: [Stories not specified]

**Related Questions**: [Questions not specified]

---

## D17: Project handoff in scope: archive download plus read-only clone URL — 2026-07-10

**Context**: PRD section 14.10 left handoff as an owner scope decision

**Question**: [Question not provided]

**Options Considered**:
Archive only; archive plus clone URL; out of scope; defer

**Decision**: Both mechanisms: archive download and read-only clone URL, landing in Phase 3

**Rationale**: Owner decision via discovery questionnaire 2026-07-10

**Implications**:
Becomes Story 13. Clone URL adds a small hosted read-only git surface to design; source of truth is the authoritative server-side store (D11)

**Stories Affected**: [Stories not specified]

**Related Questions**: Q10

---

## D18: In-browser editor in scope: Monaco with Monarch tokenizer port — 2026-07-10

**Context**: PRD section 14.11 left the editor as an owner scope decision

**Question**: [Question not provided]

**Options Considered**:
Monarch hand-port (pragmatic); monaco-textmate plus vscode-oniguruma WASM (high fidelity); out of scope; defer

**Decision**: Monaco editor with a Monarch tokenizer hand-ported from the LFDT-Minokawa TextMate grammar (editor-support/vsc/compact/syntaxes/compact.tmLanguage.json), landing in Phase 3

**Rationale**: Owner chose the PRD-designated pragmatic path

**Implications**:
Becomes Story 14. Activates the file:changed client-to-server event in the sync protocol (D12); user edits flow back to the authoritative store

**Stories Affected**: [Stories not specified]

**Related Questions**: Q11

---

## D19: Per-agent model routing via static config file, redeploy to change — 2026-07-10

**Context**: Owner wants each agent's provider and model easily swappable without live edits or an admin UI; BYOK remains deferred to Phase 3 (D14 unchanged)

**Question**: [Question not provided]

**Options Considered**:
Live admin UI; env vars per agent; static server-side config with redeploy

**Decision**: A server-side config file maps each agent role (supervisor, Scaffolding, Planning, Implementation, Review) to a provider-plus-model pair. Required providers: OpenAI, Anthropic, and Gemini via first-party AI SDK providers; OpenRouter; and owner-hosted models via createOpenAICompatible (OpenAI-compatible endpoints). Changing an assignment is a config edit plus server redeploy

**Rationale**: Config-plus-redeploy is the simplest mechanism satisfying swap-ability; the AI SDK provider abstraction makes provider and model a data concern rather than code

**Implications**:
The routing table is runtime data, not code. Owner-hosted inference servers (vLLM, Ollama, TGI and similar) expose OpenAI-compatible APIs, and OpenRouter also speaks the OpenAI API, so createOpenAICompatible covers both. BYOK in Phase 3 layers user keys onto the same provider abstraction

**Stories Affected**: Story 1

**Related Questions**: Q12

---

## D20: Turn UX is a full activity stream with persistent session indicator — 2026-07-10

**Context**: PRD section 6 requires the UI to communicate the active-session constraint explicitly rather than fail mysteriously

**Question**: [Question not provided]

**Options Considered**:
Full activity stream; single status line; plain chat narration

**Decision**: Chat streams supervisor narration plus a collapsible per-sub-agent activity feed (compile attempts, test runs, verify iterations); a persistent session indicator states that preview and tests run in this tab and it must stay open; reopening after an interrupted turn shows an explicit recovery message

**Rationale**: Richest signal for a chat-driven product whose execution environment is the user's own tab; failure states become legible instead of mysterious

**Implications**:
Activity events already exist in the WebSocket protocol (dev:status, test:results, console streams per D12); the feed is a rendering of them

**Stories Affected**: Story 1

**Related Questions**: Q13

---

## D21: Verify-loop budget: 3 compile-test cycles per turn, honest failure on exhaustion — 2026-07-10

**Context**: A turn needs a bounded worst case and a defined behaviour when the agent cannot reach a passing state

**Question**: [Question not provided]

**Options Considered**:
3 cycles; 5 cycles; adaptive budget

**Decision**: Maximum 3 compile-plus-test cycles per turn. On exhaustion the turn ends honestly: failing state summarized with diagnostics, work-in-progress files kept in the VFS, and a suggested next prompt offered. Unverified code is never presented as done

**Rationale**: Owner chose the tighter budget: cheaper worst-case turns, with hard requests becoming multi-turn conversations

**Implications**:
Interacts with D22 charging policy: an exhausted budget is real work and is charged

**Stories Affected**: Story 1

**Related Questions**: Q14

---

## D22: Infra failures refund the prompt; exhausted budgets do not — 2026-07-10

**Context**: A prompt decrements NYXT before the turn runs (D13), so infrastructure failure mid-turn needs a charging policy

**Question**: [Question not provided]

**Options Considered**:
Refund on infra failure only; refund all failed turns; no refunds

**Decision**: Bounded retries (3, with backoff) on a failing Tome, mnm, or compiler MCP call; if still unavailable the turn fails loudly naming the unavailable service and the NYXT decrement is credited back. Turns that exhaust their verify budget are charged - the work ran

**Rationale**: Users should never pay for our outage, but honest-failure turns consumed real model and compute time; refunding them would be gameable and muddy the metering model

**Implications**:
Ledger needs a credit-back operation distinct from deposit-minted credit (affects Story 6 ledger design and Story 12 display)

**Stories Affected**: Story 1, Story 6

**Related Questions**: Q14

---

## D23: Chat history is persisted with the project and rehydrated on open — 2026-07-10

**Context**: D11 settled project-source persistence but left conversation history unstated

**Question**: [Question not provided]

**Options Considered**:
Persist and rehydrate; session-only; bounded last-N turns

**Decision**: Conversation history lives in the same authoritative store as project source and reloads on project open

**Rationale**: Continuity: the interrupted-turn recovery message (D20) can point at exactly where the conversation stopped

**Implications**:
Store schema for S7 must cover chat history alongside source files; ties into Q1 store choice

**Stories Affected**: Story 1, Story 7

**Related Questions**: Q15

---

## D24: Single active turn per project: input rejected while busy — 2026-07-10

**Context**: A policy was needed for prompts submitted while a turn is running

**Question**: [Question not provided]

**Options Considered**:
Queue one prompt; reject while busy; cancel and replace

**Decision**: Chat input is disabled during a running turn; the user waits for the turn to end

**Rationale**: Owner chose the simplest possible semantics; no queued-state or mid-compile cancellation complexity

**Implications**:
Simplifies ledger too: exactly one decrement in flight per project at any time

**Stories Affected**: Story 1

**Related Questions**: [Questions not specified]

---

## D25: Declined off-domain prompts are not charged — 2026-07-10

**Context**: Intent classifier can decline non-DApp requests; charging policy was undefined

**Question**: [Question not provided]

**Options Considered**:
Not charged; charged; free quota then charged

**Decision**: A prompt the classifier declines as off-domain does not decrement NYXT; the decline message explains what Nyx is for

**Rationale**: Classification runs on the cheap tier so a decline costs near-nothing, and charging for a refusal is hostile

**Implications**:
Decrement must happen after intent classification, not on submission - ordering constraint for the S6 metering flow

**Stories Affected**: Story 1, Story 6

**Related Questions**: [Questions not specified]

---

## D26: Authoritative project source and chat history live in Postgres rows — 2026-07-10

**Context**: Q1: the persistence store shapes the Phase 1 file-event handlers and gates Stories 7 and 13; the WebContainer VFS is ephemeral and R2 artifacts are deliberately short-lived

**Question**: [Question not provided]

**Options Considered**:
Postgres rows; non-expiring R2 prefix; git-native store (volume or hosted Gitea)

**Decision**: Files as rows (project_id, path, content, version) in the same Postgres already running the NYXT ledger; chat history (D23) stored alongside; handoff zip and read-only clone URL materialized on demand from rows in Story 13

**Rationale**: Atomic multi-file commits per turn mean rehydration can never observe half an agent edit; one ops and backup surface; R2 stays purely ephemeral with the compiler MCP as its sole writer, preserving the D6 credential boundary that an R2 source prefix would break; a git-native store adds stateful infrastructure against KISS and zero-idle

**Implications**:
File-event handlers commit turn-scoped batches transactionally. node_modules and zk artifacts are never persisted (reinstalled and recompiled respectively). Practical size caps to set during Story 7 design (proposal: 1 MB per file, 50 MB per project). Story 13 clone URL becomes materialize-git-on-demand

**Stories Affected**: Story 7, Story 13

**Related Questions**: Q1

---

## D27: Assume Tome retrieval works; failures are fixed upstream in Tome — 2026-07-10

**Context**: Q5 asked whether search_skills reliably surfaces the right MNE skills for a cold scaffold prompt

**Question**: [Question not provided]

**Options Considered**:
Run a retrieval spike; assume and fix upstream if wrong

**Decision**: The owner develops Tome. Retrieval is assumed reliable for spec purposes; any cold-start retrieval failure is a Tome bug fixed in Tome, never worked around inside Nyx

**Rationale**: Owner controls the tool; a Nyx-side fallback mechanism would duplicate effort and mask upstream issues

**Implications**:
Story 1's Watching item for Q5 is retired - no fallback-retrieval scenario will be added. The Q5 spike remains useful as a Tome QA exercise but no longer gates or threatens the Nyx spec

**Stories Affected**: Story 1

**Related Questions**: Q5

---

## D28: Assume mnm hosted MCP is reachable from the orchestrator — 2026-07-10

**Context**: Q17 asked whether the hosted mnm MCP is usable server-side (auth, latency, availability) given it is in preview

**Question**: [Question not provided]

**Options Considered**:
Reachability spike; assume and fix upstream if wrong

**Decision**: The owner develops mnm, and it is hosted on Fly.io - the same platform as the Nyx orchestrator. Reachability is assumed; any gap is fixed in mnm. The stdio self-host fallback remains available but unplanned

**Rationale**: Owner controls the tool and both ends share a platform

**Implications**:
Phase 0 item (b) closed without a spike

**Stories Affected**: Story 1

**Related Questions**: Q17

---

## D29: WebContainer commercial license not required at present — 2026-07-10

**Context**: Q4 flagged licensing as a precondition for building the execution environment on WebContainers

**Question**: [Question not provided]

**Options Considered**:
Confirm terms before building; defer

**Decision**: Owner reviewed StackBlitz's current terms: a commercial license is not needed for Nyx at the moment

**Rationale**: Owner read the terms directly

**Implications**:
Watching item: recheck the terms at commercial launch or if StackBlitz revises them - license posture can change

**Stories Affected**: Story 3

**Related Questions**: Q4

---

## D30: Toolchain specifics are abstracted behind the owner's in-development MCP server — 2026-07-10

**Context**: Q7 asked for exact compactc invocation, artifact layout, contract deploy API, and pre-prod node/indexer URLs

**Question**: [Question not provided]

**Options Considered**:
Research via mnm and MNE now; absorb into the compiler MCP contract

**Decision**: An MCP server currently in development by the owner will expose the toolchain; the spec assumes agents can access it when needed. Story 2's deep-dive specifies the tool contract Nyx consumes (compile tool inputs/outputs, artifact URL semantics, diagnostics shape), not compactc internals

**Rationale**: The owner is building the MCP; duplicating its internals in the spec would re-decide his implementation

**Implications**:
Story 2 blocker reduces to Q8; Story 8 loses its Q7 blocker. Deploy API and pre-prod URL details surface during Story 2/8 deep-dives as contract requirements on that MCP

**Stories Affected**: Story 2, Story 8

**Related Questions**: Q7

---

## D31: Compiler MCP concurrency and sizing are implementation details; Nyx specs the consumed contract only — 2026-07-10

**Context**: Q8 asked how the compiler service handles concurrent compiles and how machines/timeouts are sized for proving-key generation

**Question**: [Question not provided]

**Options Considered**:
Pin FIFO single-machine; pin Fly autoscale; spec the observable contract only

**Decision**: The toolchain MCP is the owner's project (D30), so its concurrency model and machine sizing are its own implementation decisions. Story 2 pins only the contract Nyx consumes: concurrent compile calls must be safe; long compiles must never silently time out - a call either completes within the agent tool budget or returns explicit queued/progress state; sizing and timeout numbers are set by benchmarking real contracts during MCP development

**Rationale**: Pinning infrastructure internals in the Nyx spec would re-decide the owner's implementation; the observable contract is what Story 2's scenarios actually depend on

**Implications**:
Story 2 acceptance scenarios will be written against the contract (safe concurrency, no silent timeout, explicit long-compile state); benchmark task lives with the MCP project, not Nyx

**Stories Affected**: Story 2

**Related Questions**: Q8

---

## D32: NYXT deposit design intent: mint on-chain NYXT for tNIGHT, deposit to Nyx, credit off-chain — 2026-07-10

**Context**: Q6 needed a design direction; owner supplied intent during discovery questionnaire

**Question**: [Question not provided]

**Options Considered**:
PRD section 13 literal (lock tNIGHT, off-chain-only NYXT); owner shape (on-chain NYXT fungible token + deposit step); combined single contract

**Decision**: Owner intent: users pay tNIGHT to mint on-chain NYXT tokens, transfer them to Nyx (likely via a deposit/vault contract), and the orchestrator credits the off-chain Postgres balance - preserving the one-signing-per-top-up rule (D13). Owner phrased it as ERC-20; per PRD section 13 this is translated to Midnight-native fungible-token design, not ported literally. A background design brief (subagent, writing discovery/archive/BRIEF-nyxt-deposit-design.md) is evaluating architectures A/B/C against the shielded/UTXO model, with deposit attribution as the first-class problem

**Rationale**: One signing ceremony per top-up keeps per-prompt interaction off-chain; an on-chain NYXT token gives users a real asset and makes the deposit step composable

**Implications**:
Q6 stays open until the brief lands and Story 6's deep-dive settles the final architecture; the attribution mechanism (which user to credit for a shielded deposit) is the dominant open sub-problem

**Stories Affected**: Story 6, Story 10

**Related Questions**: Q6

---

## D33: Crate naming convention: nyx-midnight-* — 2026-07-10

**Context**: Q9 asked for a naming sweep (domain, npm scope, GitHub org, trademark, NYXT ticker). Owner narrowed it: only crates.io names matter, and the bare nyx crate is taken

**Question**: [Question not provided]

**Options Considered**:
Bare nyx (taken); nyx-midnight-* prefix; midnight-nyx-*

**Decision**: All Nyx Rust crates use the nyx-midnight-* prefix (e.g. nyx-midnight-server, nyx-midnight-mcp). Verified 2026-07-10 via crates.io API: nyx returns HTTP 200 (taken), nyx-midnight, nyx-midnight-server, nyx-midnight-compiler, nyx-midnight-mcp all 404 (available)

**Rationale**: Owner decision; prefix is descriptive, available, and collision-resistant

**Implications**:
crates.io has no namespace ownership - anyone can publish nyx-midnight-anything. Standard defence: publish placeholder crates for the core names early. Domain/npm/GitHub/trademark/ticker aspects of Q9: explicitly not a concern per owner; nyx.example placeholders in the PRD resolve whenever a domain is chosen

**Stories Affected**: Story 2

**Related Questions**: Q9

---

## D34: NYXT pricing is token-metered via reserve-then-settle; no credit-backs; deposits one-way — 2026-07-10

**Context**: Q16 asked how a prompt's cost is determined. Owner decision supersedes the D22 refund model

**Question**: [Question not provided]

**Options Considered**:
Flat per prompt; tiered flat; token-metered reserve-then-settle

**Decision**: Token-metered: after intent classification a FLAT NYXT reserve is placed (declined prompts place none, per D25); the turn consumes tokens against it; at turn end - success, honest failure, or infra failure alike - the ledger settles at ACTUAL token consumption. If consumption reaches the reserve mid-turn, the current compile+test cycle completes and settlement draws the overage from remaining balance. No credit-back/refund operation exists: settlement IS the reconciliation, and NYXT transferred to the DApp is gone (deposits are one-way, no on-chain withdrawal)

**Rationale**: Fairest pricing; infra failures naturally settle near zero so a special-case refund path (old D22) is redundant; flat reserve keeps a predictable pre-turn gate

**Implications**:
SUPERSEDES D22's credit-back clause (D21's exhaustion-is-charged note becomes settles-at-actual). Derived policy: a new prompt requires available balance >= flat reserve; overage can drive balance negative, blocking prompts until topped up (flagged as adjustable). Ledger (S6) needs reserved-vs-available states; ledger UI (S12) displays both; reconcile/settle (S10) aligns. Triggers Story 1 revision REV-001. Flat reserve amount and tNIGHT-to-NYXT rate are Story 6 tunables

**Stories Affected**: Story 1, Story 6, Story 10, Story 12

**Related Questions**: Q16

---

## D35: Compile modes: fast check per iteration, full artifacts on green — 2026-07-10

**Context**: Q18: proving-key generation is the heavy part of compilation but simulator tests consume no artifacts

**Question**: [Question not provided]

**Options Considered**:
Check/full split with fixed steering; full every iteration; agent-chosen per call

**Decision**: Verify-loop iterations use fast static-validity compiles with no key generation; the full compile (proving keys, zkir, manifest to R2) runs when behavioural tests pass. artifacts:ready fires at most once per successful turn

**Rationale**: Fastest turns and cheapest compute; proving artifacts are needed exactly when a green build exists, and they always correspond to the latest green build

**Implications**:
The compile tool contract exposes both modes with fixed platform steering (not agent discretion); recompile-on-open uses full mode

**Stories Affected**: Story 1, Story 2

**Related Questions**: Q18

---

## D36: Mid-session artifact expiry: accept breakage with reopen guidance — 2026-07-10

**Context**: Q19: R2's 1-day lifecycle can expire artifacts inside a >24h-open preview session, which recompile-on-open does not cover

**Question**: [Question not provided]

**Options Considered**:
New artifacts:refresh protocol event; accept breakage with guidance; lengthen lifecycle

**Decision**: No new protocol event. When an expired-artifact fetch fails, the client surfaces a clear error instructing the user to reopen the project (reopen triggers recompile per D7/D11)

**Rationale**: Rare case; keeps the D12 protocol surface unchanged

**Implications**:
The client MUST map artifact-fetch failures on stale prefixes to the reopen-guidance message rather than failing silently - lands in S3's error surface

**Stories Affected**: Story 2, Story 3

**Related Questions**: Q19

---

## D37: Interim Nyx-hosted proof server; in-wallet proving deferred until the wallet-sdk fix lands — 2026-07-10

**Context**: Q2's end-to-end confirmation is blocked: live Lace advertises in-wallet proving (R5, R7) but a wallet-sdk tx-history migration bug (R8) leaves the owner's Lace Midnight side unavailable to DApps, and recovery attempts failed. Owner decision to move on

**Question**: [Question not provided]

**Options Considered**:
Keep betting on in-wallet proving; require users to run a local proof server; Nyx hosts an interim proof server

**Decision**: Nyx assumes it hosts a proof server as the interim proving path. Generated apps scaffold proving as a configurable provider: httpClientProofProvider (@midnight-ntwrk/midnight-js-http-client-proof-provider, confirmed present in the SDK workspace) pointed at the Nyx-hosted prover, with dappConnectorProofProvider remaining the preferred path to flip back to once in-wallet proving is confirmed end-to-end

**Rationale**: Unblocks every user-signed flow (S6 deposits, S9 escape-hatch transactions) without betting the critical path on an upstream bug fix; capability evidence says in-wallet proving is coming, so the fallback is explicitly interim

**Implications**:
AMENDS D8's no-proof-servers-on-our-infra clause (owner decision, on the record). Stated tensions: (1) witness/private inputs transit Nyx infrastructure during proving - deviates from private-state-never-leaves-the-user-machine; acceptable on valueless pre-prod, MUST be revisited before any real-value story; (2) proving is heavy compute on our budget - the PRD's original rationale for refusing it; scale-to-zero and sizing to be specified; (3) a browser-reachable proving endpoint is new abuse surface needing session-bound auth and rate limiting. Details spec'd in the S9 deep-dive, touching S1 scaffold defaults, S5, S6. Watching: flip the default back to in-wallet proving when the Lace/wallet-sdk fix lands

**Stories Affected**: Story 1, Story 5, Story 6, Story 9

**Related Questions**: Q2

---

## D38: Reconnect semantics: full resync from the authoritative manifest — 2026-07-10

**Context**: A WS drop mid-turn must not leave the preview silently divergent from the authoritative store (D26)

**Question**: [Question not provided]

**Options Considered**:
Full resync via manifest diff; sequence-numbered replay; full project reload

**Decision**: On reconnect the client fetches the authoritative file manifest (paths plus content hashes), diffs it against the VFS, and applies the difference. No sequence numbers, no replay buffers

**Rationale**: Converges from any state with one manifest round trip; replay buffers add protocol state and an age-out divergence failure mode

**Implications**:
Manifest endpoint becomes part of the S7 persistence surface; resync also covers the reopen path

**Stories Affected**: Story 3, Story 7

**Related Questions**: Q20

---

## D39: Crash policy: one auto-reboot then loud failure; hard unsupported-browser gate — 2026-07-10

**Context**: Container/dev-server crashes and non-isolated browsers were undefined behaviour

**Question**: [Question not provided]

**Options Considered**:
One auto-reboot; none; retry loop with backoff

**Decision**: On crash the client performs exactly one automatic container reboot remounting from VFS state; a second crash surfaces dev:status crashed loudly with a manual retry affordance and informs the agent mid-turn. Browsers without crossOriginIsolated get an upfront hard gate naming the requirement and supported browsers - no degraded mode

**Rationale**: One retry absorbs transient OOM-style crashes without hiding real crash loops; a degraded no-preview mode would hollow out the product

**Implications**:
Crash recovery interacts with the turn: the agent is informed via dev:status rather than the turn silently stalling

**Stories Affected**: Story 3

**Related Questions**: Q21

---

## D40: Multi-tab policy: last tab wins with takeover banner — 2026-07-10

**Context**: Two tabs on one project means two WebContainers and two sockets against one authoritative store, and D24 allows one active turn

**Question**: [Question not provided]

**Options Considered**:
Last tab wins; block second tab; read-only mirror

**Decision**: Opening a project in a new tab takes over the live session; the previous tab is disconnected and shows a clear session-moved banner with a take-back affordance. Single live session invariant per project

**Rationale**: One invariant, no extra read-only mode to build and maintain

**Implications**:
A takeover mid-turn behaves like a tab close for the old container: the D20 interrupted-turn recovery message applies in the new session

**Stories Affected**: Story 3

**Related Questions**: [Questions not specified]

---

## D41: Test adequacy is owned by steering and the Review agent - no mechanical gate — 2026-07-10

**Context**: Q22 asked what stops a trivial or empty suite from going green, since green gates the full compile (D35) and done-presentation

**Question**: [Question not provided]

**Options Considered**:
Per-circuit mechanical floor; non-empty-suite floor; steering only

**Decision**: Green requires only that the current cycle's suite passes. Test quality is owned by the compact-testing skill steering and the Review agent - no mechanical adequacy validation

**Rationale**: Owner decision: keep the pipeline clean and trust the swarm's quality layer

**Implications**:
Accepted risk, on the record: a hollow suite can go green. Mitigation without a gate: per-circuit test coverage is measured and reported as TELEMETRY (FR-033), giving the evidence base to add a mechanical floor via story revision if hollow-test greens appear in practice. Watching item added

**Stories Affected**: Story 1, Story 4

**Related Questions**: Q22

---

## D42: No test retries; 120-second per-run budget — 2026-07-10

**Context**: PRD section 7 demands deterministic tests; hung runs need a defined budget

**Question**: [Question not provided]

**Options Considered**:
No retries with 120s; flake-detection rerun; no retries with 60s

**Decision**: A failure is a failure - the simulator is deterministic by construction, so an apparent flake is a real bug the agent must fix. Runs exceeding 120 seconds are killed and count as a failing cycle with timeout diagnostics

**Rationale**: Retries would mask nondeterminism the PRD forbids; 120s gives cold-cache headroom (reference suites should run in seconds) and is adjustable at benchmark

**Implications**:
Timeout kills must produce diagnostics, never silent stalls

**Stories Affected**: Story 4

**Related Questions**: Q23

---

## D43: Account identity is the wallet's unshielded address — 2026-07-10

**Context**: Q24: everything downstream (ledger, projects, deposits) hangs off the account key

**Question**: [Question not provided]

**Options Considered**:
Unshielded address; platform user id with linked addresses; shielded address

**Decision**: A Nyx account is keyed by the wallet's unshielded address, auto-created on first successful sign-in. One wallet = one account; a different wallet is a different account

**Rationale**: Public, stable, human-checkable, and matches the unshielded deposit rail (NIGHT is unshielded); no linking flow to build

**Implications**:
Multi-wallet linking and non-wallet auth are explicitly out of scope; if ever wanted, a platform-id migration is a revision. S6 ledger rows and S7 project ownership key on this address

**Stories Affected**: Story 5, Story 6, Story 7

**Related Questions**: Q24

---

## D44: Sessions: 7-day sliding renewal — 2026-07-10

**Context**: Q25: D13 settled the auth shape but not session mechanics

**Question**: [Question not provided]

**Options Considered**:
7-day sliding; 24h fixed; 30-day sliding

**Decision**: Sessions live 7 days with sliding renewal on activity; wallet re-sign only after 7 idle days; explicit logout invalidates server-side immediately

**Rationale**: Comfortable for a dev tool on valueless pre-prod without being indefinite

**Implications**:
Revisit lifetime before any real-value network (same trigger class as D37's privacy revisit)

**Stories Affected**: Story 5

**Related Questions**: Q25

---

## D45: NyxtVault Architecture C adopted: single contract, one deposit circuit, one signature — 2026-07-10

**Context**: Q26/Q6: the deposit mechanism needed a Midnight-native architecture; R4 evaluated three shapes

**Question**: [Question not provided]

**Options Considered**:
A: lock tNIGHT with off-chain-only NYXT; B: token contract + vault transfer (two signatures); C: single NyxtVault with atomic deposit circuit

**Decision**: A single NyxtVault Compact contract exposes a guaranteed-phase deposit(depositRef, amount) circuit that atomically receives tNIGHT (receiveUnshielded), mints unshielded NYXT to the contract's own vault (mintUnshieldedToken to kernel.self()), and records the orchestrator-issued depositRef in public ledger state. One signing ceremony per top-up. Attribution: orchestrator preregisters the random ref bound to the account (D43) and credits exactly once on finalized SUCCESS indexer observation

**Rationale**: On Midnight the mint recipient is a circuit parameter, so the two-step collapses into mint-to-vault: half the signatures, no user custody of a token with no external use, less contract surface. Shielded NYXT rejected per R4 (attribution needs a public record; upstream shielded token modules archived)

**Implications**:
Resolves Q6 and D32's open shape. Pre-implementation gate (Watching): the R4 spike proving Lace can fund a contract-side receiveUnshielded end-to-end. NYXT burn semantics at settle belong to Story 10

**Stories Affected**: Story 6, Story 10

**Related Questions**: Q6, Q26

---

## D46: Orphaned deposits: no auto-credit, support log — 2026-07-10

**Context**: Q27: the contract cannot check server state, so unregistered refs are possible by construction

**Question**: [Question not provided]

**Options Considered**:
No auto-credit with support table; sender-heuristic auto-credit; ignore

**Decision**: Finalized deposits with unregistered refs are recorded in an orphans table and surfaced for manual resolution; never auto-credited

**Rationale**: R4 grades sender identification as a soft signal only; auto-crediting on it invites ref-guessing edge cases. On pre-prod the honest path (use the UI) is trivial

**Implications**:
Orphans table is part of the S6 ledger schema; support resolution is manual by design

**Stories Affected**: Story 6

**Related Questions**: Q27

---

## D47: Economic tunables are config values with implementation defaults — 2026-07-10

**Context**: Rate, flat reserve, and minimum deposit needed a home

**Question**: [Question not provided]

**Options Considered**:
Fix numbers in the spec; config-driven with defaults at implementation

**Decision**: The tNIGHT-to-NYXT exchange rate, flat reserve size, and minimum deposit are config values; the spec pins the mechanism only, and concrete numbers are set and tuned at implementation against real model costs

**Rationale**: Pricing changes must not require spec revisions

**Implications**:
Config surface documented alongside the D19 model-routing config

**Stories Affected**: Story 6, Story 12

**Related Questions**: [Questions not specified]

---

## D48: Turn-scoped version history with config retention — 2026-07-10

**Context**: Q28: the schema decision determines whether undo/restore is ever possible without migration

**Question**: [Question not provided]

**Options Considered**:
Turn-scoped history with retention; latest-only

**Decision**: Every turn commit and each user-edit commit retains prior file versions, with a config retention window (defaults at implementation, e.g. last 50 versions or 30 days)

**Rationale**: Enables future undo/restore and a full audit trail of agent changes; files are small text so storage is modest

**Implications**:
Undo/restore itself is NOT in scope - the data model simply supports it; retention is a config tunable per the D47 pattern

**Stories Affected**: Story 7

**Related Questions**: Q28

---

## D49: Soft-delete with 30-day recovery; caps and quota are config tunables — 2026-07-10

**Context**: Q29: deletion cascades across R2 artifacts, deployed contracts, and open sessions

**Question**: [Question not provided]

**Options Considered**:
Soft-delete 30 days; hard delete; other window

**Decision**: Delete marks the project recoverable for 30 days; the cascade runs immediately for ephemeral surfaces (R2 prefix cleanup, contract teardown via S8, open-session termination with notice) while rows purge at window end. Size caps (defaults 1 MB/file, 50 MB/project) and per-account project quota confirmed as config tunables

**Rationale**: Recoverable from misclicks at near-zero cost; ephemeral surfaces need no recovery since reopen recompiles and redeploys

**Implications**:
Restore within the window rehydrates from rows and recompiles; a restored project's contracts redeploy fresh (addresses change - consistent with D9 teardown semantics)

**Stories Affected**: Story 7, Story 8

**Related Questions**: Q29

---

## D50: Deploys execute orchestrator-direct; the toolchain MCP stays compile-only — 2026-07-10

**Context**: Q30: D9's key-location wording needed reconciling with the D30 toolchain MCP

**Question**: [Question not provided]

**Options Considered**:
Orchestrator-direct with SDK; MCP custodies key with deploy tool; split sign/submit

**Decision**: The orchestrator holds the deploy key and executes deploys itself via the Midnight SDK against pre-prod, proving through the D37 interim prover. The toolchain MCP remains compile-only and secret-free

**Rationale**: One secret, one holder, no key material crossing service boundaries; D9 stands literally

**Implications**:
Deploy pipeline code lives in the orchestrator; the MCP contract (D31) is unchanged

**Stories Affected**: Story 8

**Related Questions**: Q30

---

## D51: Deploys are free on pre-prod — 2026-07-10

**Context**: Q31: deploys consume proving compute and tDUST but no model tokens

**Question**: [Question not provided]

**Options Considered**:
Free; flat NYXT fee

**Decision**: Deploys cost no NYXT; the ledger remains purely model-cost; tDUST is valueless on pre-prod

**Rationale**: Keeps one pricing concept; deploy spam is bounded by the one-in-flight rule and explicit requests

**Implications**:
Revisit alongside D37's real-value-network review if economics change

**Stories Affected**: Story 8, Story 6

**Related Questions**: Q31

---

## D52: Prover access: session-bound short-lived tokens with per-session rate limits — 2026-07-10

**Context**: Q32: the D37 hosted prover is browser-reachable compute needing an abuse-surface shape

**Question**: [Question not provided]

**Options Considered**:
Session tokens; open with rate limits; per-account API keys

**Decision**: The orchestrator issues short-lived proving tokens to authenticated Nyx sessions; the scaffold injects the token into the generated app's prover configuration alongside the contract address; per-session rate limits apply and unauthorized requests are rejected

**Rationale**: Abuse requires a live authenticated session and tokens age out; long-lived keys in browser-visible env would violate the VITE_ hygiene the PRD itself mandates

**Implications**:
Token issuance/refresh rides the existing session (D44); limits are config tunables

**Stories Affected**: Story 9

**Related Questions**: Q32

---

## D53: Escape-hatch UX: detect-and-guide for popups; persistent lifetime notice — 2026-07-10

**Context**: Q33: R6 proved the bridge popup is blockable and the preview dies with the host tab

**Question**: [Question not provided]

**Options Considered**:
Detect-and-guide; pre-flight popup check

**Decision**: The host page detects an unconnected preview tab (no bridge within a timeout) and shows targeted guidance (allow popups for the origin, reload); a persistent host-page notice marks the lifetime coupling while a hatch tab is open; the D20 recovery message covers losses

**Rationale**: Guidance only when needed beats upfront friction for users whose blockers were fine

**Implications**:
UX copy and timeout are implementation details within the decided shape

**Stories Affected**: Story 9

**Related Questions**: Q33

---

## D54: Story 9 graduates with Q3 as a HARD pre-implementation gate — 2026-07-10

**Context**: The injection assumption is empirical (Chrome/Lace behaviour) and a negative result means substantial rework, not a tweak

**Question**: [Question not provided]

**Options Considered**:
Graduate with hard gate; hold In Progress until the PoC run

**Decision**: Story 9 enters SPEC at v1.0, but implementation MUST NOT start until the R6 PoC live run confirms Lace injects window.midnight into the top-level preview origin; a negative result triggers a substantial logged revision of the escape-hatch mechanism

**Rationale**: Owner decision: keep discovery moving; the ten-minute run closes the gate either way

**Implications**:
Q3 remains open; Watching entry marked HARD GATE

**Stories Affected**: Story 9

**Related Questions**: [Questions not specified]

---

## D55: Reconcile performs a batched burn of consumed NYXT — 2026-07-10

**Context**: Q34: D45 deferred what the lazy on-chain leg writes

**Question**: [Question not provided]

**Options Considered**:
Batched burn; bookkeeping only; descope

**Decision**: The reconcile job burns vault NYXT matching consumed credit since the last watermark, exactly once per watermark - on-chain supply approximates outstanding credit

**Rationale**: Real auditability for the token and a second dogfood circuit built to production standard (D13); strictly lazy, never in a user path

**Implications**:
The NyxtVault gains a burn circuit (orchestrator-only authorization - design at implementation via mnm/MNE); watermark idempotency mirrors the D45 exactly-once pattern

**Stories Affected**: Story 10, Story 6

**Related Questions**: Q34

---

## D56: Reconcile cadence: daily schedule only — 2026-07-10

**Context**: Q35: the lazy job needed a trigger definition

**Question**: [Question not provided]

**Options Considered**:
Daily plus threshold; weekly; threshold only; daily only

**Decision**: The reconcile job runs on a daily schedule, no consumption-threshold trigger; the cadence itself is a config tunable

**Rationale**: Owner chose the simplest predictable cadence; drift detection latency is bounded at one day

**Implications**:
Cadence config per the D47 pattern

**Stories Affected**: Story 10

**Related Questions**: Q35

---

## D57: BYOK is descoped — 2026-07-10

**Context**: Q36 surfaced the charging question and the owner cut the feature instead

**Question**: [Question not provided]

**Options Considered**:
Free; flat fee; same as hosted; descope BYOK

**Decision**: Story 11 (BYOK model management) is removed from scope entirely. All users run on the hosted models; the D19 per-agent routing config remains the platform-side model-choice mechanism

**Rationale**: Owner scope decision (PRD section 15: the feature set is the owner's alone). The charging ambiguity plus encryption/key-custody surface bought little on pre-prod where hosted models are the product anyway

**Implications**:
SUPERSEDES D14. The BYOK power-user persona becomes a future consideration; model choice remains an owner-level config concern (D19). BYOK can return as a new story via the normal backlog process - the draft detail is preserved in this iteration's history

**Stories Affected**: Story 11

**Related Questions**: Q36

---

## D58: Clone URLs are unguessable, revocable, read-only token URLs — 2026-07-10

**Context**: Q37: the clone URL access model determines shareability

**Question**: [Question not provided]

**Options Considered**:
Token URL; session-authenticated only

**Decision**: A long random token in the URL grants read-only git access; the owner can revoke and regenerate from project settings; revocation invalidates old links immediately

**Rationale**: Shareability is the point of a clone URL; token entropy plus rate limiting bounds abuse on valueless pre-prod code

**Implications**:
Token management gated by ownership (D43); handoff disabled for soft-deleted projects (D49)

**Stories Affected**: Story 13

**Related Questions**: Q37

---

## D59: Materialized repos carry commits synthesized from turn history — 2026-07-10

**Context**: Q38: D48 retained turn-scoped versions so real history exists

**Question**: [Question not provided]

**Options Considered**:
Synthesized commits; single squashed commit

**Decision**: Each turn commit and user-edit commit becomes a git commit with a descriptive message; the taken-home repo carries the project's real evolution

**Rationale**: D48 already stores the versions, so materialization is cheap and the history has real value

**Implications**:
Materialized repos cache per version watermark and invalidate on new commits

**Stories Affected**: Story 13

**Related Questions**: Q38

---

## D60: Editor uses debounced auto-save — 2026-07-10

**Context**: Q39: only the save trigger remained open after S7 fixed commit semantics

**Question**: [Question not provided]

**Options Considered**:
Debounced auto-save; explicit save

**Decision**: Roughly one second of idle triggers auto-save: file:changed then immediate per-file commit, VFS write, HMR; a dirty indicator shows while debouncing

**Rationale**: Lowest-friction editing consistent with S7's immediate-commit rule

**Implications**:
Rapid-edit bursts serialize per file through the debounce

**Stories Affected**: Story 14

**Related Questions**: Q39

---

## D61: Development standards adopted; release process emulates release-plz flow from Tome/mnm — 2026-07-10

**Context**: SDD specify common-elements round; greenfield repo needs dev standards

**Question**: [Question not provided]

**Options Considered**:
Ask per item; adopt all with owner's release-process directive

**Decision**: Owner adopted all four: (1) ESLint + Prettier + TypeScript strict mode, CI-enforced; (2) pre-commit hooks running lint/typecheck/test plus conventional commits; (3) environment/config schema validation at boot with fail-fast named errors; (4) automated versioning and changelog emulating the release-plz process used in Tome and Midnight Manual (research those repos and mirror the PR-based release flow)

**Rationale**: Owner selection 2026-07-10 during /sdd:specify

**Implications**:
Constitution v1.1.0 amended same day to absorb D37/D52/D57/D29 (owner-approved MINOR bump). Release tooling choice at implementation: release-plz itself for Rust components (D33 crates), its process mirrored (e.g. release-please) for the TS platform

**Stories Affected**: Story 1

**Related Questions**: [Questions not specified]

---

## D62: Protocol completion and infra re-sequencing from the /sdd:analyze pass — 2026-07-10

**Context**: Cross-artifact analysis (3 independent reviewers) found the D12 event set incomplete and the D37 prover scheduled after its consumers

**Question**: [Question not provided]

**Options Considered**:
Leave gaps; fix per owner authorization

**Decision**: Four protocol events added: prompt:submit (client-to-server chat input, rejected while a turn is active per D24, classified pre-reserve per D25), turn:message (server-to-client assistant reply/narration stream), deploy:status (deploy pipeline phases - deploys are not turns so turn:activity cannot carry them), ledger:update (live deposit-credited and balance propagation). Infra re-sequenced: the interim prover (D37) is provisioned as FOUNDATIONAL infrastructure with private orchestrator access; D52 session-bound tokens remain the gate for the later public exposure serving escape-hatch tabs; the Nyx app's own flows (deposits, deploys) reach the prover via a session-authenticated same-origin proxy. NyxtVault gains an explicit scripted pre-prod bootstrap deployment (it predates the US8 pipeline)

**Rationale**: The chat channel was presupposed by every turn flow but never defined; deploys and deposits both need proving phases before Story 9's hard gate clears

**Implications**:
Contracts, plan tree, and tasks updated accordingly. Owner pre-authorized medium-plus fixes 2026-07-10

**Stories Affected**: Story 1, Story 3, Story 6, Story 8, Story 9, Story 12

**Related Questions**: [Questions not specified]

---
