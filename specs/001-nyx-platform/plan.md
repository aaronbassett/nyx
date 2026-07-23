# Implementation Plan: Nyx — prompt-to-DApp platform for Midnight Network

**Branch**: `001-nyx-platform` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-nyx-platform/spec.md` (faithful port of owner-approved `discovery/SPEC.md`; decisions D1–D62, research R1–R8, PRD `.sdd/PRD.initial.md`, constitution v1.1.0)

## Summary

Nyx lets a Midnight developer connect a Lace wallet, deposit tNIGHT for NYXT credit, and prompt a Vercel-AI-SDK supervisor swarm that scaffolds, compiles (via the owner's toolchain MCP), simulator-tests, and previews a full DApp (Compact contract + React frontend) inside a WebContainer in their own browser — with orchestrator-executed deploys to pre-prod. Technical approach: lean topology — Fly.io orchestrator + owner's private compile MCP + the interim prover (owner-approved exception, constitution v1.1.0) + R2 artifact CDN, Postgres as the single authoritative store (ledger, projects, sessions), a bidirectional WebSocket event protocol as the client spine, and retrieval-first agents (Tome/MNE/mnm) countering the central risk that no frontier model knows Compact.

## Technical Context

**Language/Version**: TypeScript (Node.js ≥ 22 LTS) for platform server + web client; Compact (compiler pinned, surfaced to agents, D6) for the NyxtVault dogfood contract; Rust reserved for adjacent tooling (owner's separate `nyx-midnight-*` crates, D33)
**Primary Dependencies**: Vercel AI SDK (supervisor swarm, D3); `@webcontainer/api` (R6-verified); `@midnight-ntwrk/*` SDK — public npm, versions via `npm view`, never memory (constitution I); Monaco + hand-ported Monarch Compact grammar (D18); shadcn + Tailwind v4 + Vite + React 19 (D4); MCP clients for toolchain/Tome/mnm (D2, D30)
**Storage**: Postgres — append-only NYXT ledger (D34), project files + turn-scoped version history (D26/D48), sessions (D44), deposit refs/orphans (D45/D46), deploy registry (FR-057), reconcile reports (D55). Cloudflare R2 for ephemeral zk artifacts (D7, R3 header config)
**Testing**: Vitest everywhere; OpenZeppelin Compact simulator in-container for generated contracts and the NyxtVault suite (D5, D41/D42); Playwright for client E2E; crash/replay/drift-injection harnesses per SC-021/026/037/038
**Target Platform**: Fly.io (orchestrator + interim prover, both scale-to-zero); user's browser (WebContainer execution); Midnight pre-prod only (D1)
**Project Type**: web (monorepo: server + web client + shared packages)
**Performance Goals**: per success criteria — SC-009 HMR ≤ 2s p95, SC-011 cold open ≤ 60s p95, SC-013 test round trip ≤ 30s p95, SC-017 auth verify ≤ 500ms p95, SC-022 deposit credit ≤ 60s of finality, SC-030 deploy ≤ 3min p95, SC-041 ledger UI ≤ 5s p95, SC-003 settlement ≤ 60s, SC-036 proving ≤ 60s p95, SC-045 edit-to-HMR ≤ 3s p95
**Constraints**: COOP/COEP with the `/webcontainer/connect/*` carve-out (R6); no on-chain writes in per-prompt path (D13); secrets never cross the server boundary (constitution III); deterministic tests only (constitution IV); all Compact/SDK facts tool-verified (constitution I)
**Scale/Scope**: single-owner pre-prod product; 13 user stories, FR-001..081, DS-001..004; scale posture is zero-idle rather than high-throughput (constitution VI)

## Constitution Check

*Constitution v1.1.0 (amended 2026-07-10, owner-approved, to absorb discovery decisions D37/D52/D57/D29).*

| Principle | Status | Evidence |
|---|---|---|
| I. Verify, Never Trust Memory | ✅ PASS | FR-002/003 (retrieval-grounded generation, compile-before-surface); gates route burn-circuit and teardown research through mnm/MNE; STACK.md mandates `npm view` for versions |
| II. Quality / Owner-Governed Scope | ✅ PASS | Spec carries owner sign-off provenance for every requirement; S11 descope was owner-decided (D57); no feature hollowed |
| III. Zero-Trust Boundaries | ✅ PASS | FR-056 (deploy key orchestrator-only), FR-017 (R2 write creds in toolchain MCP only), D52 prover tokens, SC-031 zero-exposure audit |
| IV. Deterministic Verification | ✅ PASS | FR-027/030 (simulator, no retries, 120s kill), SC-014 (100-run determinism harness), no devnet anywhere |
| V. Lean by Design | ✅ PASS | Three app services + interim prover (owner-approved exception) + CDN; MCP-only tool surface (D2); no queues/microVMs; reconcile is a cron, not a state machine |
| VI. Zero-Idle, Cost-Aware | ✅ PASS | Scale-to-zero orchestration; interim hosted prover is the constitution's own owner-approved exception (v1.1.0) with flip-back trigger; no per-prompt chain writes (FR-040) |
| VII. Runtime Config Discipline | ✅ PASS | FR-081 (config.ts chokepoint, added REV-002) + Story 3 scenario 3 / D10; VITE_ guardrail; deploy-your-contract-first state |
| VIII. Don't Silently Re-Decide | ✅ PASS | Every plan element cites its D/R number; deviations in this SDD flow (skipped tech-review agent, local-only planning artifacts) documented in checklists/requirements.md |

**Post-design re-check (after Phase 1 artifacts)**: no new violations introduced — data model and contracts are direct projections of decided requirements. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-nyx-platform/
├── plan.md              # This file
├── research.md          # Phase 0 output — consolidates discovery R1–R8 + deferred gate research
├── data-model.md        # Phase 1 output — entities, fields, state machines
├── quickstart.md        # Phase 1 output — dev setup + commands
├── contracts/
│   ├── websocket-protocol.md   # D12 event contract (the client spine)
│   └── http-api.md             # auth/manifest/deposit/handoff/prover surfaces
├── checklists/requirements.md  # spec quality gate (complete)
└── tasks.md             # /sdd:tasks output — NOT created by /sdd:plan
```

### Source Code (repository root)

```text
apps/
├── server/                    # Orchestrator (Fly.io app #1)
│   ├── src/
│   │   ├── agents/            # AI SDK supervisor + Scaffolding/Planning/Implementation/Review; model-routing config loader (D19); turn lifecycle (D21/D24/D34)
│   │   ├── protocol/          # WS server, event schemas + handlers (D12), activity-stream fanout (D20)
│   │   ├── auth/              # SIWE nonce/verify/session (D13/D43/D44); proving-token issuance (D52)
│   │   ├── ledger/            # reserve/settle (D34), deposit watcher + refs/orphans (D45/D46), reconcile job + burn (D55/D56)
│   │   ├── projects/          # file store + versions (D26/D48), manifest (D38), lifecycle + cascade (D49), handoff materializer (D58/D59)
│   │   ├── deploy/            # deploy pipeline + registry (D50, FR-054..059)
│   │   ├── mcp/               # toolchain MCP client (D30/D31), Tome client, mnm client
│   │   ├── compile/           # artifact flow: verify-before-announce, artifacts:ready, reopen recompile (D35/D36, FR-050)
│   │   ├── prover/            # session-authenticated prover proxy for Nyx-app flows (D37/D62)
│   │   ├── db/                # Postgres wiring, migrations (data-model.md)
│   │   ├── telemetry/         # SC telemetry wiring (SC-003/016/… per tasks T248)
│   │   └── config/            # boot-time env/config schema validation (DS-003); tunables (D47)
│   └── tests/
├── web/                       # Nyx client (served by server or static)
│   ├── src/
│   │   ├── chat/              # chat UI + activity stream (D20)
│   │   ├── container/         # WebContainer boot, VFS sync, process-stream feedback, resync (S3, D38/D39/D40, R6)
│   │   ├── editor/            # Monaco + Monarch Compact tokenizer (D18/D60)
│   │   ├── wallet/            # connect flow, four states (S5, R8)
│   │   ├── ledger/            # balance card + entry feed (S12)
│   │   ├── hatch/             # escape-hatch open/lifetime/popup-guide UX (S9, D53) — ⛔ gated by Q3 (D54)
│   │   ├── projects/          # project list/create/rename/delete UI (S7) + handoff UI (S13)
│   │   └── lib/
│   └── tests/
packages/
├── protocol/                  # shared zod schemas: WS events, REST DTOs — single source for both apps
├── scaffold/                  # generated-app template assets + agent steering content (S1); provider wiring (D37 interim default)
└── nyxt-vault/                # NyxtVault Compact contract + witnesses + simulator suite (S6/S10 dogfood) — ⛔ gated by vault-funding spike
infra/                         # Fly configs (orchestrator, interim prover D37/D52); R2 setup runbook (R3: CORS policy, CORP Transform Rule, Cache Rule, Smart Tiered Cache)
```

**Structure Decision**: pnpm monorepo, two apps + three shared packages + infra. `packages/protocol` is the type-safe spine both sides import (POLA: one schema, no drift). `packages/nyxt-vault` isolates the dogfood contract with its own simulator suite so it ships to the same standard as user output (D13). The prover is deployment config in `infra/`, not app code — it's the stock Midnight proof server behind token auth (D37/D52).

## Phase Mapping (PRD §15 → stories → gates)

| Build phase | Stories | Pre-implementation gates |
|---|---|---|
| Phase 1 vertical slice | S1–S7 | Vault-funding spike before S6 freeze (R4) |
| Phase 2 deploy loop | S8–S10 | Teardown semantics via mnm (S8); burn-circuit design via mnm/MNE (S10) |
| Phase 3 | S12–S14 | — |
| Cross-cutting | S9 (Phase 2) | ⛔ HARD: Q3 injection run (D54) — implementation MUST NOT start until it passes |

## Complexity Tracking

*No constitution violations to justify — the one historical exception (hosted prover) was ratified into constitution v1.1.0 by the owner before this plan, with an explicit flip-back trigger.*

## Tech Debt / Environment Notes

- **NEEDS: CI pipeline setup** — no `.github/workflows/` exists yet; DS-001/DS-004 require CI lint/typecheck/test plus the release-plz-style release flow (front-end Release PR + tag-fired back-end, per Tome/mnm `release-plz.toml`, verified 2026-07-10)
- Local tooling baseline scaffolded greenfield (root pnpm workspace, strict tsconfig, ESLint+Prettier, Vitest, husky+commitlint configs); dependencies not yet installed — first `sfw pnpm install` activates hooks (see quickstart.md)
- `dev-specialisms:init-local-tooling` skill referenced by the /sdd:plan flow is not installed in this environment — tooling scaffolded directly instead (documented deviation)
- Planning artifacts (`specs/`, `.sdd/`, `discovery/`, `CLAUDE.md`) are deliberately git-ignored in this repo (local-only by owner policy) — do not `git add` them
