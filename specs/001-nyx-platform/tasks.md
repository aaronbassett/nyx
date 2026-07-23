# Tasks: Nyx — prompt-to-DApp platform for Midnight Network

**Input**: Design documents from `/specs/001-nyx-platform/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓, quickstart.md ✓

**Tests**: INCLUDED — the spec's success criteria are test harnesses (SC-001..047), constitution IV mandates deterministic tests, and DS-001 makes them CI gates. Failing tests precede implementation within each story.

**Organization**: story phases are sequenced by the **dependency graph** (plan.md Phase Mapping), not by discovery P-number — discovery priorities were deep-dive order (D16), and US1 (the agent swarm) is the integrative core that *completes* the PRD Phase-1 slice rather than starting it. Story labels preserve spec identity.

**Standing rules for every task** (from constitution + owner policy):
1. Never hand-write Compact/Midnight-SDK shapes from memory — retrieve via Tome/MNE/mnm, verify via toolchain MCP + `/midnight-verify:verify` (constitution I)
2. Never `git add` `specs/`, `.sdd/`, `discovery/`, or `CLAUDE.md` — local-only by owner policy (overrides the git-workflow defaults below wherever they conflict)
3. All JS installs via `sfw pnpm`
4. Conventional commits (DS-002); hooks must pass — no `--no-verify`, ever
5. Phase 1 (Setup) deliberately carries no retro/map overhead — retros track implementation learnings (documented exemption)

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Repo baseline, workspace skeleton, CI + release flow (DS-001/DS-004)

- [x] T001 [GIT] Verify branch `001-nyx-platform` is checked out and review working tree (tooling baseline files present and untracked; planning artifacts correctly ignored)
- [x] T002 [GIT] Commit: tooling baseline (.gitignore, package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.mjs, .prettierrc.json, commitlint.config.mjs, .husky/, .editorconfig)
- [x] T003 Install dependencies with `sfw pnpm install`; verify husky pre-commit + commit-msg hooks fire on a test commit
- [x] T004 [P] Scaffold workspace packages — apps/server, apps/web, packages/protocol, packages/scaffold, packages/nyxt-vault, infra/ — each with package.json + tsconfig extending tsconfig.base.json (use devs:typescript-dev agent)
- [x] T005 [GIT] Commit: workspace scaffold
- [x] T006 Create CI pipeline in .github/workflows/ci.yml — lint, format:check, typecheck, test on PR (DS-001) (use devs:typescript-dev agent)
- [x] T007 Create release flow per DS-004 in .github/workflows/release.yml + release config — Release-PR front-end, git-cliff changelog groups, tag-fired back-end, publish gated behind green builds (mirror the release-plz process documented in research.md)
- [x] T008 [GIT] Commit: CI and release flow
- [x] T009 [GIT] Push branch to origin (ensure pre-push hooks pass)
- [x] T010 [GIT] Create PR to main with setup summary
- [x] T011 [GIT] Verify all CI checks pass
- [x] T012 [GIT] Report PR ready status
<!-- T008–T012 (Phase 1 completion) folded into PR #1, which bundles Setup + Foundational — the branch was never merged to main between phases. -->
<!-- Note: PR #1 = https://github.com/aaronbassett/nyx/pull/1 -->
<!-- Owner-review flags carried forward: server framework = Fastify (no D-number); config numeric tunables are D47 placeholders; wire-codec decoder + US5 session issuance + US7 authorizeProject seams open. -->
<!-- REMAINING GATES before their phases: T115 vault-funding spike (US6), T155 teardown semantics (US8), T172 burn-circuit design (US10), ⛔ T185 Q3 injection run (ALL of US9). -->
<!-- Next phase: Phase 3 (US5 — wallet connect & session auth). -->


---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Protocol package, server/web skeletons, DB schema, MCP clients, infra config — everything every story needs
**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T013 Create specs/001-nyx-platform/retro/P2.md for this phase (local-only)
- [x] T014 [P] Implement packages/protocol: zod schemas for all WS events + REST DTOs per contracts/websocket-protocol.md and contracts/http-api.md in packages/protocol/src/ (use devs:typescript-dev agent)
- [x] T015 [P] apps/server skeleton: HTTP + WS server with boot-time config schema validation failing fast with named errors (DS-003; tunables per data-model.md Config section) in apps/server/src/config/ (use devs:typescript-dev agent)
- [x] T016 Postgres wiring + migration framework + initial migration implementing all data-model.md tables in apps/server/src/db/ (use devs:typescript-dev agent)
- [x] T017 [GIT] Commit: protocol package, server skeleton, schema
- [x] T018 [P] apps/web skeleton: Vite + React 19 + shadcn + Tailwind v4 shell serving COOP require-corp / COEP same-origin on all responses EXCEPT the /webcontainer/connect/* unsafe-none carve-out (FR-021, R6) (use devs:react-dev agent)
- [x] T019 [P] MCP client layer: toolchain MCP (D31 contract: safe concurrency, no silent timeouts), Tome, mnm — connect + health checks in apps/server/src/mcp/ (use devs:typescript-dev agent)
- [x] T020 [P] infra/: fly.toml for orchestrator; **interim D37 proof server provisioned as foundational infra** (stock Midnight proof server on Fly, private-mesh orchestrator access — consumed by US6 deposits, US8 deploys, US9 hatch) in infra/prover/; R2 setup runbook implementing the R3 config exactly (bucket CORS JSON, CORP Transform Rule, mandatory Cache Rule for .prover/.verifier/.bzkir, Smart Tiered Cache, object-metadata Cache-Control/Content-Type) in infra/r2-setup.md
- [x] T021 [GIT] Commit: web shell, MCP clients, infra
- [x] T022 WS session layer: cookie-authenticated connect, single-live-session takeover signalling (D40), typed event router from packages/protocol in apps/server/src/protocol/ (use devs:typescript-dev agent)
- [x] T023 [GIT] Commit: WS session layer
- [x] T024 Foundational integration test: boot server with test config, authenticate, exchange typed events over WS in apps/server/tests/foundation.test.ts (use devs:typescript-dev agent)
- [x] T025 [GIT] Commit: foundation tests
- [x] T026 Run /sdd:map incremental for Phase 2 changes (updates local-only .sdd/codebase/ — no commit)
- [x] T027 Review retro/P2.md and extract critical learnings to CLAUDE.md (conservative; local-only — no commit)
- [x] T028 [GIT] Push branch to origin (ensure pre-push hooks pass)
- [x] T029 [GIT] Create/update PR with phase summary
- [x] T030 [GIT] Verify all CI checks pass
- [x] T031 [GIT] Report PR ready status

**Checkpoint**: Foundation ready — story phases can begin

---

## Phase 3: User Story 5 — Wallet connect & session auth (spec P5) [US5]

**Goal**: SIWE-style sign-in; accounts keyed by unshielded address; four-state connect UX
**Independent Test**: fresh wallet connects, signs the nonce, lands in a session with a new account, resumes on reload with zero wallet calls (spec S5 Independent Test)

- [x] T032 [US5] Create specs/001-nyx-platform/retro/P3.md
- [x] T033 [P] [US5] Failing tests first: nonce single-use/replay/expiry suite (SC-018) + session sliding-lifetime + logout invalidation + zero-wallet-calls-on-resume assertion (SC-019) in apps/server/tests/auth/ (use devs:typescript-dev agent)
- [x] T034 [P] [US5] Failing integration test: four-state connect matrix — no extension / unauthorized / authorized-but-unavailable / wrong network (SC-020) in apps/web/tests/wallet/ (use devs:react-dev agent)
- [x] T035 [US5] Auth endpoints POST /auth/nonce, /auth/verify (domain-bound SIWE message; signature verification against the unshielded address — verify SDK shapes against installed @midnight-ntwrk types, constitution I), POST /auth/logout in apps/server/src/auth/ (use devs:typescript-dev agent)
- [x] T036 [US5] Session middleware (7-day sliding, HttpOnly/Secure/SameSite) + account auto-create on first sign-in (D43/D44) in apps/server/src/auth/session.ts (use devs:typescript-dev agent)
- [ ] T037 [GIT] Commit: auth endpoints and sessions
- [x] T038 [US5] Wallet connect flow: v4 connector detection (UUID map), multi-wallet picker, four states with R8 wallet-side guidance in apps/web/src/wallet/ (use devs:react-dev agent; port detection patterns from pocs/lace-proving/src/midnight/connector.ts on branch worktree-agent-ab47e5ba8f8087738)
- [x] T039 [US5] Wire nonce→sign→verify flow, session resume, logout in apps/web/src/wallet/auth.ts (use devs:react-dev agent)
- [ ] T040 [GIT] Commit: wallet connect UI
- [x] T041 [US5] Make all US5 tests pass; measure SC-017 (verify ≤ 500ms p95) locally
- [x] T042 [GIT] Commit: US5 green  <!-- satisfied by T037 (7050d5d, c476e48) + T040 (c35cf58); code committed + green, no empty marker commit -->

- [x] T043 [US5] Run /sdd:map incremental for Phase 3 changes
- [x] T044 [US5] Review retro/P3.md → CLAUDE.md (conservative)
- [x] T045 [GIT] Push branch to origin
- [x] T046 [GIT] Create/update PR with phase summary
- [x] T047 [GIT] Verify all CI checks pass
- [x] T048 [GIT] Report PR ready status

**Checkpoint**: sign-in works end to end against a real Lace wallet

---

## Phase 4: User Story 7 — Project persistence & rehydration (spec P7) [US7]

**Goal**: Postgres-rows authoritative store, turn-scoped commits, manifest, lifecycle + cascade
**Independent Test**: scripted commits → reopen reproduces exact tree (manifest hash equality); crash mid-commit leaves prior consistent state

- [x] T049 [US7] Create specs/001-nyx-platform/retro/P4.md
- [x] T050 [P] [US7] Failing tests: crash-injection mid-commit (SC-026), reopen manifest equality (SC-025), cross-account ownership rejection matrix (SC-027), soft-delete window both-ways (SC-028) in apps/server/tests/projects/ (use devs:typescript-dev agent)
- [x] T051 [US7] File store: turn-scoped transactional batch commits, immediate user-edit commits, version history + retention config, size caps with named errors (D26/D48) in apps/server/src/projects/store.ts (use devs:typescript-dev agent)
- [x] T052 [US7] Manifest endpoint (paths + content hashes at last committed version, D38) + file/chat read routes per contracts/http-api.md in apps/server/src/projects/routes.ts (use devs:typescript-dev agent)
- [x] T053 [GIT] Commit: file store and manifest  <!-- folded with T056/T058 into one atomic US7-green commit; store.ts/routes.ts span both -->
- [x] T054 [US7] Project lifecycle: create/rename/soft-delete/restore, immediate cascade hooks (R2 prefix cleanup, contract-teardown handoff — STUBBED until T158 back-fills it, open-session termination), 30-day purge job, quota (D49); rehydration failures on missing/corrupt rows fail loudly naming the project (EC-34) in apps/server/src/projects/lifecycle.ts (use devs:typescript-dev agent)
- [x] T055 [US7] Chat persistence + rehydration (D23) in apps/server/src/projects/chat.ts (use devs:typescript-dev agent)
- [x] T056 [GIT] Commit: lifecycle and chat
- [x] T057 [US7] Make all US7 tests pass
- [x] T058 [GIT] Commit: US7 green
- [x] T059 [US7] Run /sdd:map incremental for Phase 4 changes
- [x] T060 [US7] Review retro/P4.md → CLAUDE.md (conservative)
- [x] T061 [GIT] Push branch to origin
- [x] T062 [GIT] Create/update PR with phase summary
- [x] T063 [GIT] Verify all CI checks pass
- [x] T064 [GIT] Report PR ready status

---

## Phase 5: User Story 2 — Compile pipeline (spec P2) [US2]

**Goal**: check/full compile via toolchain MCP, artifact discipline, R2 fetch verified under isolation
**Independent Test**: known-good source → complete fetchable artifact prefix; known-bad → structured diagnostics — no swarm needed

- [x] T065 [US2] Create specs/001-nyx-platform/retro/P5.md
- [x] T066 [P] [US2] Failing tests: artifacts:ready only-on-complete-verified-prefix (FR-014), content-hash reuse = zero key generation (SC-006), explicit queued/progress on long compiles (FR-016) in apps/server/tests/compile/ (use devs:typescript-dev agent)
- [x] T067 [US2] Toolchain MCP compile client: check mode per iteration / full on green with fixed platform steering (D35), structured diagnostics + pinned compiler version surfaced (FR-012) in apps/server/src/mcp/toolchain.ts (use devs:typescript-dev agent)
- [x] T068 [US2] Artifact flow: verify-before-announce, artifacts:ready emission (once per green turn), frontend-only skip (EC-11), expired-prefix reopen-guidance mapping (D36), and the reopen→full-recompile trigger repopulating a fresh prefix (FR-050) with a reopen-repopulation assertion in apps/server/src/compile/ (use devs:typescript-dev agent)
- [x] T069 [GIT] Commit: compile pipeline
- [x] T070 [US2] R2 fetch harness against infra/r2-setup.md config: artifact fetch matrix from a cross-origin-isolated context, fresh-prefix zero-404 check (SC-005, SC-007), oversized-artifact uncached-serve telemetry flag (EC-10) in apps/web/tests/artifacts.test.ts (use devs:react-dev agent)
- [x] T071 [GIT] Commit: artifact fetch harness
- [x] T072 [US2] Make all US2 tests pass; check-mode latency telemetry (SC-008)
- [x] T073 [GIT] Commit: US2 green
- [x] T074 [US2] Run /sdd:map incremental for Phase 5 changes
- [x] T075 [US2] Review retro/P5.md → CLAUDE.md (conservative)
- [x] T076 [GIT] Push branch to origin
- [x] T077 [GIT] Create/update PR with phase summary
- [x] T078 [GIT] Verify all CI checks pass
- [x] T079 [GIT] Report PR ready status

---

## Phase 5.5: Network profiles & local devnet (foundational — lands before US3) [NET]

**Goal**: a typed network-profile config (`local-devnet` default, `preprod` for public release) consumed by server + web, plus a local devnet stack on Lace-compatible ports (node 9944, proof 6300; everything else remapped) with a fail-fast port preflight that never reuses a devnet it did not start. Design: `specs/001-nyx-platform/design-network-profiles.md`.
**Amends D1/D5**: local devnet is the default target for all dev **and** validation (incl. owner-gated Independent Tests) until **public release = external promotion**; pre-prod stays the public-release target; the OZ-simulator verification loop is unchanged (D5 core / FR-027).
**Sequencing**: executes next, **before** Phase 6 (US3). Higher task numbers are an insertion artifact, not execution order.
**Independent Test**: (automated, CI) profile-resolver + port-preflight suites green — default resolves to `local-devnet`, unknown `NYX_NETWORK` fails fast, an occupied 9944/6300 aborts `devnet:up` with a named error. (owner-gated, manual) Lace on "Undeployed" completes a `signData` round-trip against the local devnet (re-points the US5 Independent Test to devnet).

- [x] T261 [NET] Create specs/001-nyx-platform/retro/P5.5.md for this phase (local-only)
- [x] T262 [P] [NET] Failing tests first: server network-profile resolver — default (no `NYX_NETWORK`) resolves to `local-devnet` (nodeUrl `http://localhost:9944`, proofServerUrl `http://localhost:6300`, remapped indexerUrl), `NYX_NETWORK=preprod` resolves the preprod profile, an unknown `NYX_NETWORK` fails fast with a named error (DS-003), optional per-field env overrides apply — in apps/server/tests/config/network.test.ts (use devs:typescript-dev agent)
- [x] T263 [P] [NET] Failing test first: web network-profile chokepoint — `VITE_NYX_NETWORK` selects the profile, the resolved profile exposes `{ networkId, nodeUrl, indexerUrl, proofServerUrl }`, `EXPECTED_NETWORK_ID` derives from it, default is `local-devnet` — in apps/web/tests/config.test.ts (use devs:react-dev agent)
- [x] T264 [P] [NET] Failing test first: port-preflight — `assertPortsFree(ports)` reports a bound host port as in-use with a named error naming the port, passes when free, and the aggregate check lists EVERY offending port and never attaches to a running service — in infra/tests/preflight.test.ts (add a minimal vitest include to infra if absent) (use devs:typescript-dev agent)
- [x] T265 [NET] Server network config: `NETWORK_PROFILES` + `resolveNetworkProfile(env)` returning `NetworkProfile { id, networkId, nodeUrl, indexerUrl, proofServerUrl }` in apps/server/src/config/network.ts; add `NYX_NETWORK` (enum of profile ids, default `local-devnet`) to `EnvSchema` and a `network: NetworkConfig` section to `Config`/`PublicConfig` (network URLs are public, non-secret) wired through apps/server/src/config/{schema.ts,load.ts,index.ts} (use devs:typescript-dev agent)
- [x] T266 [NET] Web network config chokepoint: apps/web/src/config.ts selecting the profile from `VITE_NYX_NETWORK` (default `local-devnet`) and exposing the resolved `NetworkProfile`; re-point apps/web/src/wallet/config.ts `EXPECTED_NETWORK_ID` to read `networkId` from it (resolves the existing TODO(verify) pointer) — type-only shape, no zod in the web bundle (use devs:react-dev agent)
- [x] T267 [GIT] Commit: network-profile config (server + web)
- [x] T268 [NET] Port-preflight module + runner: `assertPortsFree` in infra/devnet/preflight.ts (throws a named, multi-port error; never connects/attaches) + a `devnet:up`/`devnet:down` script pair (root package.json) that runs the preflight BEFORE `docker compose up` (use devs:typescript-dev agent)
- [x] T269 [NET] Local devnet stack: infra/devnet/docker-compose.yml running node@9944 + proof@6300 + indexer@remapped + a pre-funded genesis account whose key seeds the dev `DEPLOY_KEY` (server-only secret, constitution III) — image tag + real service ports VERIFIED via the midnight-tooling:iln skill, never memory (constitution I) — plus infra/devnet/README.md documenting the ports and the Lace "Undeployed" setup steps (use devs:typescript-dev agent; verify iln shapes via midnight-tooling:iln)
- [x] T270 [GIT] Commit: local devnet stack + port preflight
- [x] T271 [NET] Make all Phase 5.5 tests pass; verify (deterministic) that `devnet:up` aborts with the named error when 9944 or 6300 is already bound and never attaches to the running listener
- [x] T272 [GIT] Commit: Phase 5.5 green  <!-- satisfied by 21ebf4e (config) + 4b05a5e (devnet) — code committed + green; no empty marker commit -->

- [ ] T273 [NET] ⚠️ OWNER-GATED VALIDATION — bring up the devnet (`devnet:up`), point Lace at "Undeployed", and complete a real-Lace `signData` round-trip against it (re-points the US5 Independent Test to devnet); confirm the exact `networkId` string Lace reports for "Undeployed" and whether Undeployed pins an indexer endpoint, then set the `local-devnet` profile `networkId` accordingly. On failure: STOP, raise to owner
- [ ] T274 [NET] Run /sdd:map incremental for Phase 5.5 changes (updates local-only .sdd/codebase/ — no commit)  <!-- DEFERRED (orchestrator call): low drift for a 15-file config+infra phase; knowledge captured in CLAUDE.md carried-decisions + design-network-profiles.md + retro/P5.5.md; batch with US3 map (T093). Surfaced to owner. -->
- [x] T275 [NET] Review retro/P5.5.md → CLAUDE.md; record the D1/D5 amendment + devnet gotchas (conservative; local-only — no commit)
- [x] T276 [GIT] Push branch to origin (ensure pre-push hooks pass)
- [x] T277 [GIT] Create/update PR with phase summary
- [x] T278 [GIT] Verify all CI checks pass
- [x] T279 [GIT] Report PR ready status (merge per standing when-green cadence)
<!-- Phase 5.5 MERGED: PR #5 (https://github.com/aaronbassett/nyx/pull/5), merge commit 48d3409; branch synced to main. ⚠️ T273 (real-Lace round-trip) owner-gated; T274 (/sdd:map) deferred → batch with US3 (T093). -->

**Checkpoint**: network profiles + local devnet ready — US3 and later stories consume the profile; on-chain integration (US6/US8/US10) develops against the devnet

---

## Phase 6: User Story 3 — WebContainer preview + file-sync (spec P3) [US3]

**Goal**: live preview in lockstep with file events; process-stream feedback; resilience policies
**Independent Test**: persisted project boots through visible dev:status phases; scripted file:write appears via HMR

- [x] T080 [US3] Create specs/001-nyx-platform/retro/P6.md
- [x] T081 [P] [US3] Failing tests: per-path ordering + queue-during-mount (FR-019/EC-14), reconnect resync manifest equality (SC-010) in apps/web/tests/container/ (use devs:react-dev agent)
- [x] T082 [US3] WebContainer host: boot pipeline (rehydrate → mount → install → vite dev) with dev:status phases in apps/web/src/container/boot.ts (use devs:react-dev agent; port boot/log patterns from pocs/webcontainer-lace/host/)
- [x] T083 [US3] VFS sync handlers: file:write/file:delete ordering, node_modules/artifact exclusions in apps/web/src/container/sync.ts (use devs:react-dev agent)
- [x] T084 [GIT] Commit: boot pipeline and VFS sync
- [x] T085 [US3] Process-stream feedback: console + dev:status parsed from container streams → WS (never in-container network, FR-020/R6) in apps/web/src/container/streams.ts (use devs:react-dev agent)
- [x] T086 [US3] contract:deployed handler: VITE_CONTRACT_ADDRESS → .env.local → dev-server restart; verify deploy-first guard renders pre-deploy (D10) in apps/web/src/container/env.ts (use devs:react-dev agent)
- [x] T087 [US3] artifacts:ready handler → FetchZkConfigProvider re-point in apps/web/src/container/artifacts.ts (use devs:react-dev agent)
- [x] T088 [GIT] Commit: streams and event handlers
- [x] T089 [US3] Resilience: manifest-diff full resync on reconnect (D38), one-auto-reboot crash policy + loud crashed state (D39), last-tab-wins takeover banner (D40), crossOriginIsolated hard gate in apps/web/src/container/resilience.ts (use devs:react-dev agent)
- [x] T090 [GIT] Commit: resilience policies
- [x] T091 [US3] Make all US3 tests pass; HMR + cold-open telemetry (SC-009, SC-011), crash-surfacing check (SC-012)  <!-- deterministic suite green (54 container unit tests); the SC-009/011/012 timing telemetry is owner-gated (needs a live cross-origin-isolated WebContainer boot) -->
- [x] T092 [GIT] Commit: US3 green  <!-- satisfied by 111f723 + efacc2c + a0861c9 + 80d8548; no empty marker commit -->
- [ ] T093 [US3] Run /sdd:map incremental for Phase 6 changes  <!-- DEFERRED (as P5.5): knowledge captured in CLAUDE.md + retro/P6.md; batch a later incremental map -->
- [x] T094 [US3] Review retro/P6.md → CLAUDE.md (conservative)
- [x] T095 [GIT] Push branch to origin
- [x] T096 [GIT] Create/update PR with phase summary
- [x] T097 [GIT] Verify all CI checks pass
- [x] T098 [GIT] Report PR ready status
<!-- Phase 6 (US3) MERGED: PR #7 (https://github.com/aaronbassett/nyx/pull/7), merge commit 57e7685; branch synced to main. 54 container unit tests. ⚠️ Independent Test (live boot + HMR + SC-009/011/012 telemetry), connect-bridge, Shell Preview-panel UI wiring owner-gated. T093 (/sdd:map) deferred. -->


---

## Phase 7: User Story 4 — Behavioural verification loop (spec P4) [US4]

**Goal**: simulator/Vitest runs in-container, structured results to the agent, deterministic
**Independent Test**: known-good and known-broken contract variants yield green and diagnostic-rich failure events respectively

- [x] T099 [US4] Create specs/001-nyx-platform/retro/P7.md
- [x] T100 [P] [US4] Failing tests: structured Vitest output parsing → test:results shape (FR-028), 120s kill = failing cycle with timeout diagnostics (D42), determinism harness scaffold (SC-014) in apps/web/tests/verify/ (devs:react-dev agent) and apps/server/tests/verify/ (devs:typescript-dev agent)
- [x] T101 [US4] Test-runner spawn + structured result parsing + test:results emission via process streams in apps/web/src/container/testrunner.ts (use devs:react-dev agent)
- [x] T102 [US4] Server-side verify-cycle accounting (D21 budget), green → full-compile trigger (D35, FR-029) in apps/server/src/agents/verify.ts (use devs:typescript-dev agent)
- [x] T103 [GIT] Commit: verify loop
- [x] T104 [US4] Per-circuit coverage telemetry — measurement only, never a gate (FR-032/D41) + failure payload caps (FR-033) in apps/server/src/agents/coverage.ts (use devs:typescript-dev agent)
- [x] T105 [GIT] Commit: coverage telemetry
- [x] T106 [US4] Make all US4 tests pass; round-trip latency check (SC-013)
- [x] T107 [GIT] Commit: US4 green
- [ ] T108 [US4] Run /sdd:map incremental for Phase 7 changes  <!-- DEFERRED (as P5.5/P6): knowledge lives in CLAUDE.md + retro/P7.md -->
- [x] T109 [US4] Review retro/P7.md → CLAUDE.md (conservative)
- [x] T110 [GIT] Push branch to origin
- [x] T111 [GIT] Create/update PR with phase summary
- [x] T112 [GIT] Verify all CI checks pass
- [x] T113 [GIT] Report PR ready status

---

## Phase 8: User Story 6 — NYXT token economy (spec P6) [US6]

**Goal**: NyxtVault dogfood contract, exactly-once deposit crediting, reserve-then-settle ledger
**Independent Test**: top-up credits exactly once after finality; scripted turn sequence reserves, settles at actual, enforces available ≥ reserve
**⚠️ GATE**: T115 must pass before contract work freezes

- [x] T114 [US6] Create specs/001-nyx-platform/retro/P8.md
- [ ] T115 [US6] ⚠️ GATE — vault-funding spike (R4): prove Lace/balanceUnsealedTransaction funds a contract-side receiveUnshielded end-to-end on pre-prod (~1 day; extend pocs/lace-proving; requires a healthy Lace wallet). On failure: STOP, raise to owner, logged Story 6 revision  <!-- OWNER-GATED: R4 Lace vault-funding spike is owner-run (needs healthy Lace + pre-prod); flagged, not run this session. Contract/ledger built against simulator + local-devnet only. -->
- [x] T116 [US6] NyxtVault Compact contract — deposit(depositRef, amount) guaranteed-phase circuit (receive tNIGHT + mintUnshieldedToken to kernel.self() + record ref; duplicate refs rejected) in packages/nyxt-vault/src/ (use compact-core:compact-dev agent; MNE/mnm retrieval only, constitution I)
- [x] T117 [US6] NyxtVault simulator suite: per-circuit coverage, duplicate-ref rejection, amount edge cases in packages/nyxt-vault/tests/ (use compact-core:compact-dev agent with compact-testing patterns)
- [x] T118 [US6] Full-ZK compile (no --skip-zk) + run /midnight-verify:verify over the contract + witnesses (SC-024 gate), then **scripted bootstrap deployment of NyxtVault to pre-prod** (deploy key + foundational T020 prover; record vault address in config) in packages/nyxt-vault/scripts/deploy.ts — the US8 pipeline does not exist yet and is not needed for this one-off  <!-- full-ZK compile + /midnight-verify:verify = Confirmed (SC-024 artifact gate DONE); scripted bootstrap DEPLOY redirected to local-devnet + owner-gated (no preprod/fly this run). -->
- [x] T119 [GIT] Commit: NyxtVault contract and suite
- [x] T120 [P] [US6] Failing tests: exactly-once credit under reorg/duplicate replay (SC-021), ledger invariant available+reserved=credits−settlements (SC-023), reserve/settle semantics incl. overage/negative-balance gating (D34), settlement-latency assertion (SC-003: settlement posts ≤ 60s of turn end) in apps/server/tests/ledger/ (use devs:typescript-dev agent)
- [x] T121 [US6] Ledger service: append-only entries, reserve/release/settle at actual, derived balances, decrement-after-classification hook for US1 (D25/D34) in apps/server/src/ledger/ledger.ts (use devs:typescript-dev agent)
- [x] T122 [US6] Deposit flow: preregistration endpoint + TTL expiry, indexer watcher with finality gating, exactly-once credit by ref (credit the on-chain amount on mismatch, logging loudly — EC-28), orphans table (D45/D46), plus the session-authenticated prover proxy route for Nyx-app transaction proving (D62) in apps/server/src/ledger/deposits.ts and apps/server/src/prover/proxy.ts (use devs:typescript-dev agent)
- [x] T123 [GIT] Commit: ledger and deposits
- [x] T124 [US6] Top-up UI: amount → depositRef → single wallet ceremony (transaction proving via the session-authenticated prover proxy, D37/D62) → pending/credited states in apps/web/src/wallet/topup.tsx (use devs:react-dev agent)
- [x] T125 [GIT] Commit: top-up flow
- [x] T126 [US6] Make all US6 tests pass; credit-latency telemetry (SC-022)  <!-- all US6 tests green (233 server / 185 web / 18 nyxt-vault); SC-022 credit-latency has deterministic hooks, real p95 owner-gated. -->
- [x] T127 [GIT] Commit: US6 green
- [ ] T128 [US6] Run /sdd:map incremental for Phase 8 changes  <!-- DEFERRED (as P5.5/P6/P7): knowledge in CLAUDE.md + retro/P8.md -->
- [x] T129 [US6] Review retro/P8.md → CLAUDE.md (conservative)
- [x] T130 [GIT] Push branch to origin
- [x] T131 [GIT] Create/update PR with phase summary
- [x] T132 [GIT] Verify all CI checks pass
- [x] T133 [GIT] Report PR ready status

---

## Phase 9: User Story 1 — Prompt-to-DApp agent swarm (spec P1) [US1] 🎯 MVP

**Goal**: the integrative core — supervisor swarm, turn lifecycle, scaffold package, chat UI. Completing this phase completes the PRD Phase-1 vertical slice.
**Independent Test**: funded session + compiler MCP reachable → one cold "counter DApp" prompt yields a compiling, simulator-tested contract + running preview (SC-001/SC-002)

- [x] T134 [US1] Create specs/001-nyx-platform/retro/P9.md
- [x] T135 [P] [US1] Failing E2E harness: cold counter-DApp prompt → green contract + preview, with turn-trace audit pairing done-presentations to same-turn green (SC-015) in apps/server/tests/e2e/turn.test.ts (use devs:typescript-dev agent)
- [x] T136 [US1] Model routing config loader: per-role provider+model, OpenAI/Anthropic/Gemini/OpenRouter/createOpenAICompatible (D19) in apps/server/src/agents/routing.ts (use devs:typescript-dev agent)
- [x] T137 [US1] Supervisor: intent classifier (declines cost nothing, D25), turn state machine (classify → reserve → ≤3 cycles → settle at actual; single active turn D24; honest failure D21; infra-failure bounded retries + loud service naming D34-era semantics) in apps/server/src/agents/supervisor.ts (use devs:typescript-dev agent)
- [x] T138 [GIT] Commit: routing and supervisor
- [x] T139 [P] [US1] Scaffolding agent: Tome cold-start retrieval (search_skills → get_skill), no templates (D3/FR-003) in apps/server/src/agents/scaffolding.ts (use devs:typescript-dev agent)
- [x] T140 [P] [US1] Planning, Implementation, Review agents with MNE/mnm/toolchain tools; compile-before-surface invariant (FR-002) in apps/server/src/agents/planning.ts, implementation.ts, review.ts (explicit files — keeps [P] safe alongside T139) (use devs:typescript-dev agent)
- [x] T141 [US1] packages/scaffold: generated-app template assets + steering content — config.ts chokepoint (D10), provider wiring with D37 interim prover default + config flip-back, network guards, compact-testing patterns (use devs:react-dev agent for template, devs:typescript-dev for steering)
- [x] T142 [GIT] Commit: sub-agents and scaffold package
- [x] T143 [US1] Chat UI + activity stream: supervisor narration, collapsible per-sub-agent feed with cycle counts, persistent tab-alive indicator (D20) in apps/web/src/chat/ (use devs:react-dev agent)
- [x] T144 [US1] Input lock during turns (D24), interrupted-turn recovery message (D20/D23), decline UX in apps/web/src/chat/turn-state.tsx (use devs:react-dev agent)
- [x] T145 [GIT] Commit: chat UI
- [x] T146 [US1] E2E green: cold prompt → compiling, tested contract + running preview; ledger audit passes (SC-001 protocol baseline, SC-002, SC-015)
- [x] T147 [GIT] Commit: US1 green — 🎯 PRD Phase-1 vertical slice complete (MVP)
- [ ] T148 [US1] Run /sdd:map incremental for Phase 9 changes  <!-- DEFERRED: knowledge in CLAUDE.md + retro/P9.md -->
- [x] T149 [US1] Review retro/P9.md → CLAUDE.md (conservative)
- [x] T150 [GIT] Push branch to origin
- [x] T151 [GIT] Create/update PR with phase summary
- [x] T152 [GIT] Verify all CI checks pass
- [x] T153 [GIT] Report PR ready status

**Checkpoint**: 🎯 MVP — demo-able product; STOP and validate before Phase 2 stories

---

## Phase 10: User Story 8 — Contract deploy loop (spec P8) [US8]

**Goal**: orchestrator-direct deploys, finality-gated address emission, registry + teardown
**Independent Test**: scripted deploy:request on a green build → finalized contract, exactly one contract:deployed, correct registry; redeploy supersedes
**⚠️ GATE**: T155 before implementation

- [x] T154 [US8] Create specs/001-nyx-platform/retro/P10.md
- [x] T155 [US8] ⚠️ GATE — research on-chain teardown semantics for superseded contracts via mnm (never memory); record findings + decision addendum in specs/001-nyx-platform/research.md  <!-- RESOLVED: deployed contracts are PERMANENT (no on-chain teardown); teardown = off-chain registry supersede + config-chokepoint + indexer-watch stop + artifact GC; the on-chain cascade seam is a documented no-op by design. Owner-confirmable (protocol-forced). -->
- [x] T156 [P] [US8] Failing tests: finality-gated exactly-once emission incl. reorg injection (SC-029), one-active-address registry invariant (SC-032), deploy-key exposure static check (SC-031) in apps/server/tests/deploy/ (use devs:typescript-dev agent)
- [x] T157 [US8] Deploy pipeline: green-build precondition, server-side proving via the foundational D37 prover over the private mesh (provisioned in T020), orchestrator-direct sign/submit (D50), finality await in apps/server/src/deploy/pipeline.ts (use devs:typescript-dev agent)
- [x] T158 [US8] Deploy registry: supersede on redeploy, cleanup job, D49 cascade integration — back-fills the T054 teardown-handoff stub in apps/server/src/deploy/registry.ts (use devs:typescript-dev agent)
- [x] T159 [GIT] Commit: deploy pipeline and registry
- [x] T160 [US8] deploy:request handling: ownership + greenness validation, one-in-flight rejection, queue-during-turn, activity-stream phases in apps/server/src/deploy/handler.ts (use devs:typescript-dev agent)
- [x] T161 [US8] Deploy wallet ops: tDUST balance monitor + alerting + platform-fault user messaging (EC-38) in apps/server/src/deploy/wallet.ts (use devs:typescript-dev agent)
- [x] T162 [GIT] Commit: deploy handling and wallet ops
- [x] T163 [US8] Make all US8 tests pass; pipeline latency telemetry (SC-030)  <!-- all green (server 409); SC-030 real p95 owner-gated (needs the live deploy) -->
- [x] T164 [GIT] Commit: US8 green
- [ ] T165 [US8] Run /sdd:map incremental for Phase 10 changes  <!-- DEFERRED: knowledge in CLAUDE.md + retro/P10.md -->
- [x] T166 [US8] Review retro/P10.md → CLAUDE.md (conservative)
- [x] T167 [GIT] Push branch to origin
- [x] T168 [GIT] Create/update PR with phase summary
- [x] T169 [GIT] Verify all CI checks pass
- [x] T170 [GIT] Report PR ready status

---

## Phase 11: User Story 10 — Ledger reconcile & settle (spec P10) [US10]

**Goal**: daily three-source comparison, loud drift alarms, watermark-idempotent batched burn
**Independent Test**: seeded ledger vs pre-prod vault: clean → equality report + burn; injected discrepancy → alarm, no burn; interruption → no double-burn
**⚠️ GATE**: burn-circuit design inside T172

- [x] T171 [US10] Create specs/001-nyx-platform/retro/P11.md
- [ ] T172 [US10] ⚠️ GATE then implement — design the orchestrator-only burn circuit via mnm/MNE (record design addendum in specs/001-nyx-platform/research.md), implement + simulator suite in packages/nyxt-vault/ (use compact-core:compact-dev agent; /midnight-verify:verify before merge)
- [ ] T173 [GIT] Commit: burn circuit and suite
- [ ] T174 [P] [US10] Failing tests: watermark idempotency / zero double-burn under crash-replay (SC-037), drift-injection alarms with no auto-correct (SC-038) in apps/server/tests/reconcile/ (use devs:typescript-dev agent)
- [ ] T175 [US10] Reconcile job: daily schedule (config cadence D56), three-source comparison on finalized watermark, loud drift alarms, batched burn per watermark, persisted queryable reports (D55); indexer-unavailable runs skip + reschedule with alert after N consecutive skips (EC-48) in apps/server/src/ledger/reconcile.ts (use devs:typescript-dev agent)
- [ ] T176 [GIT] Commit: reconcile job
- [ ] T177 [US10] Make all US10 tests pass; zero-user-path static dependency audit (SC-039)
- [ ] T178 [GIT] Commit: US10 green
- [ ] T179 [US10] Run /sdd:map incremental for Phase 11 changes
- [ ] T180 [US10] Review retro/P11.md → CLAUDE.md (conservative)
- [ ] T181 [GIT] Push branch to origin
- [ ] T182 [GIT] Create/update PR with phase summary
- [ ] T183 [GIT] Verify all CI checks pass
- [ ] T184 [GIT] Report PR ready status

---

## Phase 12: User Story 9 — Escape hatch + interim hosted proving (spec P9) [US9]

**Goal**: real pre-prod signing in a top-level tab; token-gated hosted prover
**Independent Test**: full hatch flow (open → bridge → connect → prove → confirm) with Lace; blocked popup → guidance, not hang
**⛔ HARD GATE (D54/FR-065)**: T185 MUST pass before ANY other task in this phase

- [ ] T185 [US9] ⛔ HARD GATE — owner runs the Q3 injection test: pocs/webcontainer-lace ./run.sh in a Lace-equipped Chrome profile; window.midnight must appear in the top-level preview-origin banner. On failure: STOP, substantial logged Story 9 revision (D54). Do not proceed past this task until it passes
- [ ] T186 [US9] Create specs/001-nyx-platform/retro/P12.md
- [ ] T187 [P] [US9] Failing tests: prover authz matrix — missing/expired/forged/cross-session tokens all rejected (SC-033), popup-guidance within 10s (SC-035) in apps/server/tests/prover/ (devs:typescript-dev agent) and apps/web/tests/hatch/ (devs:react-dev agent)
- [ ] T188 [US9] Public exposure of the foundational prover (T020): token-validating proxy with per-session rate limits for generated apps in escape-hatch tabs (D37/D52/D62) in infra/prover/ (use devs:typescript-dev agent for the proxy)
- [ ] T189 [US9] Proving-token issuance: POST /prover/token bound to session, short expiry, refresh-through-session (D52) in apps/server/src/auth/proving-tokens.ts (use devs:typescript-dev agent)
- [ ] T190 [GIT] Commit: prover deployment and tokens
- [ ] T191 [US9] Hatch UX: open-in-new-tab (user gesture), persistent lifetime notice, bridge-timeout detect-and-guide (D53/R6) in apps/web/src/hatch/ (use devs:react-dev agent)
- [ ] T192 [US9] Scaffold prover wiring verification: generated app proves via token-gated prover end-to-end; flip-back config path exercised in packages/scaffold/ (use devs:typescript-dev agent)
- [ ] T193 [GIT] Commit: hatch UX and scaffold wiring
- [ ] T194 [US9] Gated-environment E2E: open → bridge → connect → prove → indexer confirm (SC-034); prover latency telemetry (SC-036)
- [ ] T195 [GIT] Commit: US9 green
- [ ] T196 [US9] Run /sdd:map incremental for Phase 12 changes
- [ ] T197 [US9] Review retro/P12.md → CLAUDE.md (conservative)
- [ ] T198 [GIT] Push branch to origin
- [ ] T199 [GIT] Create/update PR with phase summary
- [ ] T200 [GIT] Verify all CI checks pass
- [ ] T201 [GIT] Report PR ready status

**Checkpoint**: PRD Phase-2 deploy loop complete (US8 + US9 + US10)

---

## Phase 13: User Story 12 — Token ledger UI (spec P12) [US12]

**Goal**: render the S6/S10 machinery — balances, entry feed, top-up entry, nudge
**Independent Test**: seeded ledger renders row-exact balances; scripted settle events update live without reload

- [ ] T202 [US12] Create specs/001-nyx-platform/retro/P13.md
- [ ] T203 [P] [US12] Failing tests: UI-vs-DB balance equality audit (SC-040), live-update path, one-per-session nudge in apps/web/tests/ledger/ (use devs:react-dev agent)
- [ ] T204 [US12] Balance card (available/reserved, negative-state top-up CTA) + paginated entry feed (deposits with on-chain refs, reserves, settlements linked to turns) in apps/web/src/ledger/ (use devs:react-dev agent)
- [ ] T205 [US12] Live updates via turn:settled + D38 resync refresh + low-balance nudge (config threshold) in apps/web/src/ledger/live.ts (use devs:react-dev agent)
- [ ] T206 [GIT] Commit: ledger UI
- [ ] T207 [US12] Make all US12 tests pass; update-latency telemetry (SC-041)
- [ ] T208 [GIT] Commit: US12 green
- [ ] T209 [US12] Run /sdd:map incremental for Phase 13 changes
- [ ] T210 [US12] Review retro/P13.md → CLAUDE.md (conservative)
- [ ] T211 [GIT] Push branch to origin
- [ ] T212 [GIT] Create/update PR with phase summary
- [ ] T213 [GIT] Verify all CI checks pass
- [ ] T214 [GIT] Report PR ready status

---

## Phase 14: User Story 13 — Project handoff (spec P13) [US13]

**Goal**: exact-tree archives; token-URL git clones with synthesized history
**Independent Test**: archive hash-matches the manifest; token clone yields read-only synthesized history; revocation kills the URL immediately

- [ ] T215 [US13] Create specs/001-nyx-platform/retro/P14.md
- [ ] T216 [P] [US13] Failing tests: archive/manifest hash equality (SC-042), revocation immediacy (SC-043), secrets scan of artifacts (SC-044) in apps/server/tests/handoff/ (use devs:typescript-dev agent)
- [ ] T217 [US13] Archive endpoint: latest committed tree zip + generated README (env requirements) in apps/server/src/projects/archive.ts (use devs:typescript-dev agent)
- [ ] T218 [US13] Git materializer: commits synthesized from turn/user-edit versions (D48/D59), watermark caching in apps/server/src/projects/git.ts (use devs:typescript-dev agent)
- [ ] T219 [US13] Clone tokens: mint/revoke/regenerate + read-only git HTTP endpoint + rate limits (D58) in apps/server/src/projects/clone.ts (use devs:typescript-dev agent)
- [ ] T220 [GIT] Commit: handoff services
- [ ] T221 [US13] Handoff UI: archive download + clone-URL management; disabled state for soft-deleted projects (D49) in apps/web/src/projects/handoff.tsx (use devs:react-dev agent)
- [ ] T222 [GIT] Commit: handoff UI
- [ ] T223 [US13] Make all US13 tests pass
- [ ] T224 [GIT] Commit: US13 green
- [ ] T225 [US13] Run /sdd:map incremental for Phase 14 changes
- [ ] T226 [US13] Review retro/P14.md → CLAUDE.md (conservative)
- [ ] T227 [GIT] Push branch to origin
- [ ] T228 [GIT] Create/update PR with phase summary
- [ ] T229 [GIT] Verify all CI checks pass
- [ ] T230 [GIT] Report PR ready status

---

## Phase 15: User Story 14 — In-browser editor (spec P14) [US14]

**Goal**: Monaco + Monarch Compact highlighting, auto-save into the S7 commit flow, turn lock
**Independent Test**: edit → (debounce) → commit + VFS + HMR; .compact edit flips verification badge; simulated turn locks editor

- [ ] T231 [US14] Create specs/001-nyx-platform/retro/P15.md
- [ ] T232 [US14] Port the Monarch tokenizer from the LFDT-Minokawa TextMate grammar (github.com/LFDT-Minokawa/compact → editor-support/vsc/compact/syntaxes/compact.tmLanguage.json) in apps/web/src/editor/compact-monarch.ts (use devs:react-dev agent; D18)
- [ ] T233 [P] [US14] Failing tests: zero-lost-edits stress (SC-046), Monarch corpus render over compact-examples (SC-047) in apps/web/tests/editor/ (use devs:react-dev agent)
- [ ] T234 [US14] Monaco integration: file tree, read-only turn lock with visible state, unsaved-edit surfacing at turn start (FR-047/EC-36) in apps/web/src/editor/ (use devs:react-dev agent)
- [ ] T235 [US14] Debounced auto-save (~1s) → file:changed → immediate commit + VFS write + HMR; dirty indicator (D60) in apps/web/src/editor/save.ts (use devs:react-dev agent)
- [ ] T236 [US14] Stale-verification badge on .compact edits + user-edit diffs into next-turn agent context (FR-080) in apps/server/src/agents/user-edits.ts (use devs:typescript-dev agent)
- [ ] T237 [GIT] Commit: editor
- [ ] T238 [US14] Make all US14 tests pass; edit-to-HMR telemetry (SC-045)
- [ ] T239 [GIT] Commit: US14 green
- [ ] T240 [US14] Run /sdd:map incremental for Phase 15 changes
- [ ] T241 [US14] Review retro/P15.md → CLAUDE.md (conservative)
- [ ] T242 [GIT] Push branch to origin
- [ ] T243 [GIT] Create/update PR with phase summary
- [ ] T244 [GIT] Verify all CI checks pass
- [ ] T245 [GIT] Report PR ready status

---

## Phase 16: Polish & Cross-Cutting Concerns

- [ ] T246 Create specs/001-nyx-platform/retro/P16.md
- [ ] T247 [P] Draft and file the upstream wallet-sdk bug report (R8: InMemoryTransactionHistoryStorage legacy-format migration gap; Lace swallows account-watch failures) — unblocks the D37 flip-back Watching item
- [ ] T248 [P] Success-criteria telemetry wiring: production dashboards/reports for every SC that specifies telemetry (SC-001, 003, 007, 008, 009, 011, 012, 013, 016, 022, 030, 036, 041, 045) in apps/server/src/telemetry/
- [ ] T249 CI security gates: deploy-key/secret exposure static checks (SC-031) + handoff secrets scan (SC-044) as required CI jobs in .github/workflows/ci.yml (use devs:typescript-dev agent)
- [ ] T250 [GIT] Commit: CI security gates
- [ ] T251 Operational runbooks: deploy-wallet tDUST refunding (EC-38), R2 lifecycle/purge, prover ops, reconcile drift response in infra/runbooks/
- [ ] T252 [GIT] Commit: runbooks
- [ ] T253 Run full quickstart.md validation on a clean checkout, plus the SC-004 model-swap drill: reassign one agent role across OpenAI, Anthropic, Gemini, OpenRouter, and a custom OpenAI-compatible endpoint via config edit + redeploy only
- [ ] T254 Watching-items sweep: proving flip-back retest plan, hollow-test-green telemetry review (D41), WebContainer license recheck (D29), session/privacy real-value revisits (D37/D44) — record status in specs/001-nyx-platform/watching.md (local-only)
- [ ] T255 Run /sdd:map incremental (final)
- [ ] T256 Review retro/P16.md → CLAUDE.md (conservative)
- [ ] T257 [GIT] Push branch to origin
- [ ] T258 [GIT] Create/update PR with final summary
- [ ] T259 [GIT] Verify all CI checks pass
- [ ] T260 [GIT] Report PR ready status

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (1)** → **Foundational (2)** → story phases. Foundational BLOCKS all stories.
- **Story order is dependency-driven** (deviation from spec P-numbers, documented above): US5 → US7 → US2 → US3 → US4 → US6 → **US1 (🎯 MVP)** → US8 → US10 → US9 (⛔ gated) → US12 → US13 → US14 → Polish.
- US9 may run any time after US8 **once T185 passes**; US12 needs US6 (and US10's reports stay operator-only); US13 needs US7; US14 needs US3 + US7.

### Gates (never skip)

| Task | Gate | Blocks |
|---|---|---|
| T115 | Vault-funding spike (R4) | US6 contract freeze |
| T155 | Teardown semantics via mnm | US8 implementation detail |
| T172 | Burn-circuit design via mnm/MNE | US10 |
| T185 | ⛔ Q3 injection run (D54/FR-065) | ALL of US9 |

### Parallel opportunities

- Within phases: all [P] tasks (different files). E.g. Phase 2: T014/T015 then T018/T019/T20; Phase 9: T139/T140.
- Across stories (if parallel capacity exists): after Phase 2, US5 and US7 are independent; after US7, {US2} and {US3} can proceed in parallel; US12/US13/US14 are mutually independent after their prerequisites.

## Parallel Example: Phase 2 (Foundational)

```bash
Task: "Implement packages/protocol zod schemas per contracts/ (T014)"
Task: "apps/server skeleton with boot config validation (T015)"
# then, after T017:
Task: "apps/web shell with COOP/COEP + carve-out (T018)"
Task: "MCP client layer (T019)"
Task: "infra fly.toml + R2 runbook (T020)"
```

## Implementation Strategy

- **MVP = through Phase 9 (US1)**: that is the PRD Phase-1 vertical slice — a funded, signed-in user prompts and receives a compiling, simulator-tested contract in a live preview. STOP, validate, demo.
- **Incremental delivery**: each phase ends with its own PR + CI green + LGTM stop (per-phase completion blocks). PRD Phase-2 = US8/US10/US9; Phase-3 = US12/US13/US14.
- **Agents**: TypeScript tasks → devs:typescript-dev; React/web → devs:react-dev; Compact (.compact) → compact-core:compact-dev with /midnight-verify:verify before merge; never from memory.

## Notes

- Retro files, map outputs, watching.md, and CLAUDE.md updates are **local-only** (owner .gitignore policy) — the [GIT] tasks never stage them.
- Numbers flagged adjustable in the spec (SC thresholds, 120s test budget, caps) are config tunables — changing them is not a spec revision (D47).
