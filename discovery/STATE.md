# Discovery State: nyx-platform

**Updated**: 2026-07-10 11:30 UTC
**Iteration**: 6
**Phase**: Completion — all in-scope stories graduated; pending owner sign-off
**Source PRD**: `.sdd/PRD.initial.md` (ground truth for settled decisions — see D1–D15; backlog approved in D16)

---

## Problem Understanding

### Problem Statement
Midnight Network developers have no prompt-to-DApp platform. Generic generative-UI tools (Bolt, Lovable, V0) are useless for Midnight because Compact — the language for data-protecting smart contracts — is not in any frontier model's training data: models hallucinate its syntax with total confidence and produce code that fails at compile time. Building a Midnight DApp today means hand-assembling a toolchain (Compact compiler, proving keys, simulator, Lace wallet integration, pre-prod deployment) with no AI assistance that can be trusted. Nyx closes this gap: a user connects their Lace wallet, deposits tNIGHT to buy NYXT credit, and prompts a multi-agent system that scaffolds, compiles, tests, and previews a full DApp — a Compact contract plus a React frontend — with contracts deployed to Midnight pre-prod. The central technical risk (Compact hallucination) is countered by a retrieval-first external tooling spine: MNE skills (doing), mnm cited docs Q&A (knowing), and Tome semantic skill routing (finding), all consumed over MCP (R1, R2).

### Personas
| Persona | Description | Primary Goals |
|---------|-------------|---------------|
| Midnight DApp builder | Developer targeting Midnight who knows what they want to build | Go from prompt to a compiling, tested, deployed Compact contract + React preview without fighting hallucinated syntax |
| Midnight explorer | Developer evaluating Midnight / prototyping an idea | Try a real DApp on pre-prod in minutes with zero local toolchain setup |
| ~~BYOK power user~~ | *(persona retired — BYOK descoped, D57)* | Model choice remains an owner-level config concern (D19) |
| Platform operator (project owner) | Runs Nyx as a lean, for-profit product | Zero idle compute cost, zero-trust security boundaries, production quality throughout, owner-controlled scope |

### Current State vs. Desired State
**Today (without Nyx)**: No Bolt/Lovable/V0 equivalent exists for Midnight. AI assistants hallucinate Compact; developers loop on compile errors with invented syntax. Trying Midnight requires installing the Compact toolchain, wiring proving infrastructure, and learning ledger/witness/disclose semantics before seeing anything run.

**Tomorrow (with Nyx)**: Connect Lace → deposit tNIGHT → prompt. A supervisor swarm (retrieval-grounded via Tome/MNE/mnm) generates the contract and frontend; the compiler MCP validates statically every iteration; the OZ simulator under Vitest validates behaviour every iteration; the preview runs live in a WebContainer in the user's own browser; contracts deploy to pre-prod via the orchestrator's server-held key; the escape-hatch tab lets the user sign real pre-prod transactions with Lace.

### Constraints
- **Quality bar is fixed; scope belongs to the owner alone.** Pre-prod targeting constrains network and feature-set size only — never quality (D1). Scope/quality tension is raised to the owner, never resolved silently.
- **Compact hallucination is the central risk.** Every agent must treat its instinct about Compact syntax as wrong until a tool confirms it; retrieval (MNE/Tome/mnm) is mandatory, compile-error feedback alone is not a substitute.
- **Zero-trust, zero-idle.** Expensive compute (dev server, ZK proving) runs on the user's machine; backend is orchestrator + stateless scale-to-zero compile service. Deploy key and R2 write credentials never reach the browser or WebContainer.
- **KISS/YAGNI/POLA.** No microVMs, no job queues, no persistent container clusters; all internal tool-calling is MCP (D2).
- **No on-chain write in the per-prompt path** — chain is the top-up rail, Postgres is the metering rail (D13).
- **Cross-origin isolation** (COEP/COOP) required for WebContainers; every asset in the preview, including R2 artifacts, needs compatible CORS/CORP headers (D4, D7).
- **WebContainer license**: none required at present per StackBlitz terms (D29); recheck at commercial launch.
- **Tests must be deterministic** — simulator, not chain; no devnet (D5).

---

## Story Landscape

### Story Status Overview
*Backlog and deep-dive order approved by owner (D16). Stories 13–14 added from resolved scope decisions (D17, D18).*

| # | Story | Priority | Status | Confidence | Blocked By |
|---|-------|----------|--------|------------|------------|
| 1 | Prompt-to-DApp agent swarm (chat UI + supervisor + sub-agents via Tome/MNE/mnm) | P1 | ✅ In SPEC | 100% | - |
| 2 | Compile pipeline (owner's toolchain MCP → R2 artifacts → `artifacts:ready`, D30/D31) | P2 | ✅ In SPEC | 100% | - |
| 3 | WebContainer preview + file-sync protocol | P3 | ✅ In SPEC | 100% | - |
| 4 | Behavioural verification loop (OZ simulator + Vitest, results streamed to agent) | P4 | ✅ In SPEC | 100% | - |
| 5 | Wallet connect & session auth (nonce → Lace signature → session) | P5 | ✅ In SPEC | 100% | - |
| 6 | NYXT token economy (NyxtVault deposit per R4 brief, reserve-then-settle metering per D34) | P6 | ✅ In SPEC | 100% | - |
| 7 | Project persistence & rehydration (Postgres-rows authoritative source, D26) | P7 | ✅ In SPEC | 100% | - |
| 8 | Contract deploy loop (server-key deploy, address injection, teardown) | P8 | ✅ In SPEC | 100% | - |
| 9 | Escape-hatch tab: real signing + interim hosted proving (D37) | P9 | ✅ In SPEC | 100% | Q3 (impl gate) |
| 10 | Ledger reconcile & settle | P10 | ✅ In SPEC | 100% | - |
| 11 | ~~BYOK model management~~ — **descoped by owner (D57, supersedes D14)** | P11 | ❌ Descoped | - | - |
| 12 | Token ledger UI | P12 | ✅ In SPEC | 100% | - |
| 13 | Project handoff (archive + clone URL, materialized on demand from Postgres, D26) | P13 | ✅ In SPEC | 100% | - |
| 14 | In-browser editor (Monaco + Monarch Compact tokenizer, `file:changed` sync) | P14 | ✅ In SPEC | 100% | - |

### Story Dependencies
```
S5 wallet connect ──→ S6 token economy ──→ S10 reconcile/settle
                                  │
S1 agent swarm ──→ S2 compile ────┤
      │                │          │
      │                ▼          ▼
      ├──→ S3 preview/sync ──→ S8 deploy loop ──→ S9 escape hatch
      │            │   │              ▲
      │            │   ▼              │
      └────────→ S4 verify loop ──────┘
S7 persistence underpins S2/S3 (rehydrate + recompile on open) and S13 handoff
S14 editor depends on S3 (file:changed return path) and S7 (durable writes)
S12 ledger UI is a leaf node (Phase 3); S11 BYOK descoped (D57)
```
*Mapping to PRD phases: S1–S7 = Phase 1 vertical slice, S8–S10 = Phase 2 deploy loop, S11–S14 = Phase 3. Phase 0 de-risk items are research actions, not stories (see Next Actions).*

### Proto-Stories / Emerging Themes
*None — both former proto-stories were promoted (Story 13 via D17, Story 14 via D18).*

---

## Completed Stories Summary

| # | Story | Priority | Completed | Key Decisions | Revision Risk |
|---|-------|----------|-----------|---------------|---------------|
| 1 | Prompt-to-DApp agent swarm | P1 | 2026-07-10 | D3, D12, D19, D20, D21, D22, D23, D24, D25, D34 (REV-001) | None — Q5 retired via D27 |
| 2 | Compile pipeline | P2 | 2026-07-10 | D6, D7, D30, D31, D35, D36 + R3 | Compiler version-bump cadence (Watching) |
| 3 | WebContainer preview + file-sync | P3 | 2026-07-10 | D4, D10, D12, D38, D39, D40 + R6 | None |
| 4 | Behavioural verification loop | P4 | 2026-07-10 | D5, D21, D35, D41, D42 | Hollow-test greens (Watching, D41) |
| 5 | Wallet connect & session auth | P5 | 2026-07-10 | D13, D43, D44 + R5/R7/R8 | Session lifetime revisit before real-value network (D44) |
| 6 | NYXT token economy | P6 | 2026-07-10 | D34, D45, D46, D47 + R4 | Vault-funding spike (pre-implementation gate) |
| 7 | Project persistence & rehydration | P7 | 2026-07-10 | D23, D26, D38, D48, D49 | None |
| 8 | Contract deploy loop | P8 | 2026-07-10 | D9, D45-pattern, D50, D51 | On-chain teardown semantics (verify via mnm at implementation) |
| 9 | Escape hatch + hosted proving | P9 | 2026-07-10 | D37, D52, D53, D54 + R6 | Q3 HARD implementation gate; proving flip-back |
| 10 | Ledger reconcile & settle | P10 | 2026-07-10 | D55, D56 | Burn circuit design at implementation (via mnm/MNE) |
| 12 | Token ledger UI | P12 | 2026-07-10 | D34, D47 renderings | None |
| 13 | Project handoff | P13 | 2026-07-10 | D17, D58, D59 | None |
| 14 | In-browser editor | P14 | 2026-07-10 | D18, D60 | None |

*Full stories in SPEC.md*

---

## In-Progress Story Detail

*None — all in-scope stories graduated (S11 descoped via D57).*

---

## Watching List

*Items that might affect graduated stories:*
- **Vault-funding spike (D45, pre-implementation gate for Story 6)** — prove Lace/balanceUnsealedTransaction funds a contract-side receiveUnshielded end-to-end on pre-prod before implementation freeze; failure triggers a logged Story 6 revision
- **Hollow-test greens (D41)** — steering-only adequacy accepted; if coverage telemetry shows green turns with untested circuits becoming common, add a mechanical floor to Story 4 via the revision protocol
- **In-wallet proving flip-back (D37)** — interim hosted proof server amends D8; when the wallet-sdk tx-history migration fix (R8) lands upstream, retest the lace-proving PoC and flip the default proving path back to in-wallet (touches S1 scaffold defaults, S5, S6, S9). Privacy deviation (witness data transits Nyx infra) must be revisited before any real-value network
- **Q3 (Lace injection) — HARD implementation gate for graduated Story 9 (D54)**: PoC built (R6), stack-boot half confirmed; the live run gates Story 9 implementation start; negative result = substantial logged revision
- WebContainer license terms (D29) — none needed today; recheck at commercial launch or if StackBlitz revises terms
- Compact compiler version drift — pinned version (D6) can still force revisions to compile-pipeline scenarios

---

## Glossary

- **Compact**: Midnight's language for data-protecting (ZK) smart contracts; not present in any frontier model's training data
- **Midnight pre-prod**: shared pre-production Midnight network; all tokens on it are valueless
- **tNIGHT / tDUST**: pre-prod network tokens (deposit currency / transaction fuel)
- **NYXT**: Nyx's off-chain credit balance, minted on tNIGHT deposit, decremented per prompt (placeholder ticker, Q9)
- **MNE (Midnight Expert)**: owner-built marketplace of Claude Code plugins — the agents' capability surface for writing/verifying Compact and DApp code
- **Tome**: owner-built Rust CLI + MCP server; semantic search-then-load over MNE skills, projecting them into the non-Claude-Code AI SDK harness
- **mnm (Midnight Manual)**: owner-built cited docs Q&A over live Midnight docs/source; hosted MCP; the "knowing" layer
- **WebContainer**: StackBlitz in-browser Node runtime (VFS, npm, Vite dev server) — the execution environment for generated apps
- **Escape hatch**: "Open Preview in New Tab" button opening the preview top-level so the Lace extension can inject `window.midnight`
- **Lace**: Midnight's browser-extension wallet; signs transactions and (assumption Q2) generates ZK proofs
- **Supervisor swarm**: Vercel AI SDK supervisor routing to Scaffolding / Planning / Implementation / Review sub-agents
- **Compiler MCP**: private, scale-to-zero Fly.io MCP service wrapping native `compactc`; sole holder of R2 write credentials
- **zk artifacts**: prover keys, verifier keys, zkIR produced per compile; content-hashed on R2, 1-day lifecycle
- **BYOK**: bring-your-own-key frontier-model credentials (Phase 3 settings CRUD)
- **SIWE-style auth**: sign-in-with-wallet — nonce → Lace signature → session
- **Reserve-then-settle**: D34 charging — flat NYXT reserve placed after intent classification, ledger settles at actual token consumption at turn end; no credit-backs
- **Turn**: one prompt→response agent cycle, including any internal compile/test iterations

---

## Next Actions

- [ ] **Owner (clears the last gate)**: run the Q3 injection test — `pocs/webcontainer-lace/`, `./run.sh` in a Lace-equipped Chrome profile; a pass unlocks Story 9 implementation (D54)
- [ ] **Owner**: final spec review and sign-off ("this spec captures everything") — flips SPEC.md status to Approved
- [ ] **Pre-implementation gates on record**: Q3 (S9, HARD), vault-funding spike (S6), burn-circuit design via mnm/MNE (S10), on-chain teardown semantics via mnm (S8)
- [ ] **Standing Watching items**: proving flip-back (D37), hollow-test greens (D41), session lifetime + privacy revisits before any real-value network (D37/D44), WebContainer license recheck (D29), compiler version-bump cadence
