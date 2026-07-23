<!--
==============================================================================
SYNC IMPACT REPORT
==============================================================================
Version change:        1.0.0 → 1.1.0   [MINOR — materially expanded guidance]
Bump rationale:        Align with discovery decisions D1–D60 (2026-07-10),
                       owner-approved. Principle VI gains an explicit,
                       owner-approved interim exception (hosted prover, D37/D52)
                       with a flip-back trigger; BYOK references removed (D57);
                       WebContainer licensing marked resolved (D29).

Changes:
  VI.  Zero-Idle, Cost-Aware Compute — "no proof servers" rule replaced with
       the D37 interim hosted-prover exception (session-bound tokens per D52,
       flip-back Watching item, privacy revisit before real-value networks).
  III. Secret & Trust Boundaries — BYOK encryption rule removed (BYOK descoped
       by owner, D57). Proving tokens (D52) added to the credential set.
  Security Requirements — Lace proving assumption marked RESOLVED (R5/R7/R8 →
       D37 interim posture); escape-hatch injection remains gated (Q3, D54).
  Architecture & Cost Constraints — proving layer updated to the interim
       default; licensing line resolved per D29.

Prior version: 1.0.0 (ratified 2026-07-10, same day — constitution was drafted
against the PRD before discovery concluded).
==============================================================================
-->

# Nyx Constitution

Nyx is a zero-trust, ultra-lean, multi-agent generative-UI platform for Midnight
Network developers: connect a Midnight wallet, buy NYXT credit, and prompt a
supervisor agent swarm that scaffolds, compiles, tests, and previews a full
data-protecting DApp (a Compact contract plus a React frontend), with contracts
deployed to Midnight **pre-prod**.

This constitution governs how Nyx itself is built. It is authoritative. The
source of product decisions is `.sdd/PRD.initial.md`; this document translates
that ground truth into enforceable engineering principles. Where the two ever
conflict, the conflict is surfaced to the project owner — never silently
resolved.

## Core Principles

### I. Verify, Never Trust Memory (NON-NEGOTIABLE)

Compact is not in any frontier model's training data, and no model's memory of
Midnight SDK, tooling, or protocol shapes is trustworthy. Every Compact snippet,
stdlib call, SDK signature, import path, CLI flag, disclosure rule, and protocol
claim — in Nyx's own code and in generated user code — MUST be confirmed by a
tool before it is presented or shipped. Assume your instinct is wrong until a
tool proves otherwise.

**Rules:**
- Never hand-write Compact from memory. Tool-confirm via mnm (semantics), MNE
  (writing/verifying), and the compiler MCP (static validity).
- Compilation alone does NOT prove correctness — code MUST be compiled AND
  executed. Compile-error feedback is not a substitute for retrieval; an agent
  with no reference material just loops, inventing new wrong syntax each round.
- Build every integration against LIVE docs (Midnight SDK, Compact CLI,
  WebContainer API, R2) — never training-data memory for API shapes.
- If a Midnight API misbehaves, ask mnm — do not invent a workaround.
- Pin the Compact compiler version and surface it to the agents; syntax drifts
  between versions and version skew is a real failure mode.

**Why:** Confident hallucination of Compact is *the* central technical risk of
this project. The external tooling stack (MNE / Tome / mnm) exists to counter it.

**Enforcement:** The verification loop (Principle IV), `/verify` and
`midnight-verify` agents, and the compiler MCP gate every iteration. No
Midnight-specific claim reaches the user unverified.

### II. Quality Is Not a Variable; Scope Is Owner-Governed (NON-NEGOTIABLE)

Pre-prod constrains exactly two things: which network we point at, and how large
the feature set is. It is not a licence to cut corners. Everything that ships —
agents, Compact generation, verification, deploys, the token economy, security
boundaries — MUST be genuinely real and built to production standard.

**Rules:**
- Real error handling, real key hygiene, no faked flows, no "good enough for a
  demo" code. Tokens carrying no real value (pre-prod) changes the network, not
  the standard.
- The feature set is set by the project owner and ONLY the project owner changes
  it. Building agents execute scope; they never trim, hollow out, or quietly
  drop a feature that is in scope.
- A phase is "done" only when its features are production-quality — tested,
  handling failure modes, secure — not when they happen to work on the happy
  path.
- When scope and the quality bar conflict, the resolution is never lower quality
  and never a silently dropped feature: STOP and raise the conflict to the
  owner, who decides what (if anything) is cut.

**Why:** A lean feature set is a quality strategy (fewer moving parts to get
right), not a discount on rigor.

**Enforcement:** Owner sign-off gates scope changes. Any PR/plan that weakens,
skips tests on, or hollows out an in-scope feature is rejected until the conflict
is raised.

### III. Secret & Trust Boundaries — Zero-Trust (NON-NEGOTIABLE)

No service trusts another by default, and privileged credentials never cross into
untrusted execution contexts. The client requests privileged actions; the
orchestrator executes them.

**Rules:**
- The server contract-deploy key and the R2 **write** credentials NEVER reach the
  browser or the WebContainer. The client emits `deploy:request`; the
  orchestrator performs the deploy and emits `contract:deployed { address }`.
- No secrets in generated project files, or in anything synced to the client.
  Browsers only ever hold R2 **read** access.
- The compiler MCP has no public IP — reachable only over Fly's private 6PN mesh
  (`.flycast`). There are no auth tokens to leak because there is no public
  surface.
- The interim hosted prover (D37) is browser-reachable by necessity and is
  gated by session-bound short-lived proving tokens with per-session rate
  limits (D52); unauthorized or rate-exceeded requests are rejected.
- Backend prompts and configuration never enter the WebContainer execution
  environment.

**Why:** This is a wallet-connected product handling deploy authority and
per-user model keys. A single boundary leak is a compromise, pre-prod or not.

**Enforcement:** Code review and CI checks assert no privileged secret is
reachable from client/WebContainer bundles; `VITE_`-scoping (Principle VII) is
the browser guardrail against secret leakage.

### IV. Deterministic Verification (No Devnet, No Flake)

Determinism comes from the simulator; realism comes from actual pre-prod deploys.
There is no local devnet — not per-project, not shared.

**Rules:**
- **Static validity** (every agent iteration): compile via the compiler MCP —
  server-side, agent-driven, independent of the browser.
- **Behavioural validity** (every agent iteration): the OpenZeppelin Compact
  simulator under Vitest inside the WebContainer — in-process, deterministic, no
  chain. Results stream back to the agent over the WebSocket protocol.
- **Deployment validity** (on redeploy): an actual pre-prod deploy — real proofs,
  real indexer — to catch "passes tests but won't deploy".
- Tests MUST be deterministic. Flakiness is unacceptable; a flaky test is a bug
  to fix, never a retry to tolerate.

**Why:** The agent's self-correction loop and the user's trust both depend on
verification signals that mean the same thing every run.

**Enforcement:** CI and the agent loop treat any non-deterministic test as a
failure. The simulator — never a live chain — is the behavioural oracle.

### V. Lean by Design (KISS / YAGNI / POLA)

Fewer moving parts means fewer failure modes to get production-right. Lean
architecture here is a quality measure, not a shortcut.

**Rules:**
- No heavy stateful microVM infrastructure, no job queues, no distributed state
  machines, no persistent remote container clusters. Standard web protocols,
  ephemeral tasks, browser-driven compute; the client browser and isolated MCP
  endpoints handle lifecycles naturally.
- All internal tool-calling is standardized on MCP (POLA): the compiler, the
  docs layer, and the skills layer present one uniform tool surface to the
  agents — not a mix of custom REST and AI plumbing.
- Call MNE verify/tooling capabilities as discrete MCP tool calls. Do NOT
  reimplement MNE's internal multi-agent orchestration inside the Nyx
  supervisor.
- Build the smallest thing that satisfies in-scope requirements; do not add
  speculative infrastructure "just in case."

**Why:** The novel, hard part of this product is Compact generation and
verification. Every unit of avoidable infrastructure is attention taken from
getting that part right.

**Enforcement:** New infrastructure or a new custom protocol requires
justification in the plan's Complexity Tracking; the default answer is "use MCP
and the existing lean topology."

### VI. Zero-Idle, Cost-Aware Compute

The expensive compute runs on the user's machine; the backend is an orchestrator
plus a stateless compile service. Nothing idles for money.

**Rules:**
- The Node dev-server preview runs in the user's browser (WebContainer).
  **Interim, owner-approved exception (D37/D52)**: because a wallet-sdk bug
  currently blocks in-wallet proving end-to-end (R8), Nyx hosts a scale-to-zero
  proof server behind session-bound short-lived tokens with per-session rate
  limits. This is explicitly temporary: when the upstream fix lands, the
  scaffold default flips back to wallet-delegated proving (Watching item), and
  the witness-data-transit privacy posture MUST be revisited before any
  real-value network.
- The compiler MCP is scale-to-zero (Fly stops it when idle, wakes it on the next
  compile call).
- Artifacts live in Cloudflare R2: $0 egress, content-hashed immutable paths,
  1-day lifecycle plus deletion on project close, recompiled on project open.
- **No on-chain write ever sits in the per-prompt path.** The chain is the top-up
  rail, not the metering rail: deposits mint an off-chain NYXT balance, and
  per-prompt metering is a Postgres ledger decrement with lazy on-chain
  reconcile/settle.

**Why:** A zero-idle design is what makes an ultra-lean, bring-your-own-proving
product economically viable — and keeps per-prompt interaction instant.

**Enforcement:** Any design that adds always-on backend compute, per-message
on-chain writes, or non-user-side proving is rejected pending owner review.

### VII. Runtime Config Discipline

The deployed contract address is runtime configuration, never source. Generated
apps read it through exactly one module.

**Rules:**
- The contract address is NEVER hardcoded in generated source.
- Single chokepoint: the client reads the address in exactly one module —
  `client/src/lib/config.ts` (`getContractAddress()` / `isContractDeployed()`).
  Nothing else touches `import.meta.env` directly, and the Implementation agent
  routes all address access through this module.
- On `contract:deployed`, the client writes `VITE_CONTRACT_ADDRESS` into the
  WebContainer VFS `.env.local`. The `VITE_` prefix is MANDATORY — a var without
  it is silently `undefined` in the browser (and is Vite's guardrail against
  leaking secrets into the bundle).
- Before the first deploy, the app renders a graceful "deploy your contract
  first" state instead of white-screening.

**Why:** A single, disciplined config chokepoint is what makes the deploy →
address-injection → preview-reload flow correct and debuggable, and keeps
secrets out of the client bundle.

**Enforcement:** Review rejects any generated module that reads
`import.meta.env` outside `config.ts` or hardcodes an address.

### VIII. Don't Silently Re-Decide — Disagree Out Loud

The PRD is ground truth for decisions already made. Settled questions are not
re-opened quietly.

**Rules:**
- Never silently re-decide a settled question or build something different from
  what the PRD specifies. If a decision looks wrong, surface it explicitly with
  reasoning and raise it to the owner.
- Open questions (PRD §14) are resolved via mnm / MNE before the code that
  depends on them — never by guessing. Load-bearing assumptions are de-risked
  (Phase 0) before app code is written.
- Descoping and re-scoping decisions belong to the owner alone (see Principle II).

**Why:** An agent that quietly substitutes its own judgment for a settled
decision produces drift that is expensive to detect and unwind.

**Enforcement:** Plans and PRs cite the PRD section they implement; deviations are
called out in the open, not buried in a diff.

## Security Requirements

- **Wallet auth:** SIWE-style flow — nonce → Lace signature → session, on
  pre-prod. Sessions are the trust anchor for the off-chain NYXT ledger.
- **Credential isolation:** deploy key and R2 write creds are server-only
  (Principle III); BYOK keys encrypted at rest; browsers hold R2 read-only.
- **Cross-origin isolation:** the main app MUST send
  `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Opener-Policy: same-origin` (WebContainers need
  `SharedArrayBuffer`). Consequently, every third-party asset loaded in the
  preview — including R2 artifacts — MUST respond with compatible CORS/CORP
  headers, or the fetch dies silently.
- **Token design:** design the NYXT/deposit token for Midnight's shielded/UTXO
  model — not the EVM account model. Confirm mechanics with mnm; do not port
  "ERC20" instincts.
- **Verify before building on API assumptions:** RESOLVED for the Lace proving
  story (R5/R7/R8: connector v4 advertises in-wallet proving; blocked upstream;
  interim posture D37). The escape-hatch injection assumption remains a HARD
  pre-implementation gate on Story 9 (Q3, D54).

## Architecture & Cost Constraints

- **Topology (lean, per PRD §4):** Fly.io main app (AI SDK supervisor swarm +
  WebSocket + Postgres NYXT ledger + server deploy key) · private scale-to-zero
  compiler MCP (`.flycast`, pinned `compactc`) · Cloudflare R2 (ephemeral,
  content-hashed, $0 egress) · StackBlitz WebContainers in the user's browser.
- **Execution environment:** the generated app (Vite + React 19 + shadcn +
  Tailwind v4) runs entirely in the WebContainer; the agent's execution and test
  environment is the user's browser tab, so the UI MUST communicate session /
  tab-alive state explicitly rather than fail mysteriously.
- **Proving layer:** interim default is `httpClientProofProvider` → the Nyx
  hosted prover behind session tokens (D37/D52); `FetchZkConfigProvider` (R2
  content-hashed prefix, R3 header config) + `levelPrivateStateProvider`
  (IndexedDB). Flip-back target: `dappConnectorProofProvider` (wallet-delegated
  proving) once the upstream wallet-sdk fix lands.
- **Model-swappability:** the AI SDK choice supports per-agent provider+model
  assignment via a server-side config file (D19: Anthropic / OpenAI / Gemini /
  OpenRouter / OpenAI-compatible via `createOpenAICompatible`). BYOK is
  descoped (D57). Tome projects MNE's Claude-Code-format skills into the
  non-Claude-Code harness — this is what makes the AI SDK choice viable.
- **External tooling division of labour:** mnm answers "how does X work"; MNE
  writes and verifies the Compact/DApp code; Tome routes the agent to the right
  MNE skill without drowning its context. These are the owner's tools — do not
  confuse them with similarly-named third-party projects.
- **Licensing:** RESOLVED (D29): no WebContainer commercial license is required
  at present per StackBlitz terms; recheck at commercial launch or if terms
  change (Watching item).

## Development Workflow & Quality Gates

Nyx is built by the project owner directing an AI-agent workflow. "Review" is not
a human peer-PR gate; it is the combination of:

1. **The verification loop** (Principle IV) — static + behavioural + deployment
   validity — as the primary correctness gate on all Compact/DApp output.
2. **Automated CI gates** — deterministic tests, type checks, linting, and
   Compact compilation must pass; no flaky or skipped checks.
3. **Owner sign-off** — the project owner is the ratifying authority for scope,
   quality trade-offs, and merges to the mainline.

Additional gates:
- **Phasing:** each phase (0 de-risk → 1 vertical slice → 2 deploy loop → 3
  extended features) ends shippable at production quality; phases bound the
  feature set, never the quality bar.
- **Dogfood standard:** the Phase 1 deposit contract + NYXT mint is built with
  the same MNE/mnm stack the product gives users, to the same standard expected of
  user-facing output.
- **SDD integration:** `/sdd:plan` runs a Constitution Check gate against this
  file before implementation; violations are justified in Complexity Tracking or
  the plan is revised.

## Governance

This constitution supersedes agent default behavior and any convenience-driven
shortcut. When an instinct, a habit, or a training-data memory conflicts with a
principle here, the principle wins.

- **Authority:** the project owner is the sole ratifying authority. Amendments,
  scope changes, and descoping decisions belong to the owner alone.
- **Amendment process:** propose the change with rationale and alternatives
  considered → owner approval → bump the version → update the Last Amended date →
  record the change in a Sync Impact Report at the top of this file → propagate
  to any dependent artifacts.
- **Versioning policy (semantic):**
  - **MAJOR** — backward-incompatible governance changes or removal/redefinition
    of a principle.
  - **MINOR** — a new principle or materially expanded guidance.
  - **PATCH** — clarifications, wording, or typo fixes with no semantic change.
- **Compliance review:** plans and PRs verify compliance with the relevant
  principles; complexity and any principle exception must be justified in the
  open (Principle VIII), never buried. Persistent, repeated violation of a
  principle is a signal to amend it deliberately — not to ignore it.
- **NON-NEGOTIABLE principles** (I, II, III) admit no silent exception: a genuine
  conflict is raised to the owner before proceeding.

**Version**: 1.1.0 | **Ratified**: 2026-07-10 | **Last Amended**: 2026-07-10
