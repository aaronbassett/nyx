# Nyx demo-ready local mode — design

**Date:** 2026-07-23 · **Status:** Approved pending final owner review · **Approach:** first-class local mode (Approach A)

## 1. Purpose

Bring Nyx to a fully demoable state: a viewer watches a real prompt → agent swarm → compile → verify → deploy → interact loop against a locally hosted Midnight devnet, with a polished full client UI, working re-prompt/edit/re-verify/re-deploy conversation, and the NYXT token meter visible throughout. The audience includes non-technical stakeholders and decision makers; the UI quality and the "compiled and proven in your browser" architecture story are what sell it.

**Timeline:** quality-driven, no fixed date.

### Demo-only vs. product architecture

Only two things in this design are demo concessions:

1. **Local devnet as the sole target** (stand-in for pre-prod; pre-prod requirements dropped for now).
2. **The dev wallet** — no Lace integration; the frontend holds the user's signing key and submits transactions on their behalf.

Everything else — browser-side compilation and proof generation, the server-side artifact store, the real deploy executor, the real deposit-observation adapter, the full workspace UI — **is the product architecture being pitched** and is built to keep.

## 2. Trust model

**Our code builds and runs on our machine. User code builds and runs on theirs.**

- **Platform contracts** (NyxtVault, anything Nyx itself needs): compiled with the local `compact` CLI by the demo setup script, deployed by the setup script. The wasm toolchain never touches platform contracts.
- **User-generated DApps**: compiled, executed, tested, and proven in the user's browser — wasm compiler + WebContainer + zkir wasm. This extends US3's existing rationale (the user's browser is the sandbox; no per-user server-side VMs) to cover compile and prove, not just test.
- **The one crossing**: compiled user artifacts are uploaded to the server solely because deploys are server-side — the server signs with its deploy key, pays fees, and proves the deploy transaction against a proof server it controls. The interface is deliberately narrow: an ownership-gated, size-capped artifact upload.

A user compiling their own contract on their own machine violates no trust boundary. The residual concerns are resource-shaped and covered by existing product mechanics: deploys spend **server** tDUST (greenness gate + one-in-flight + wallet monitor), artifact uploads get size caps + ownership gating (same discipline as `capTestResults`), and server-side deploy proving is bounded per deploy. A user falsifying their own compile results only breaks their own project; the meter charges them either way.

## 3. Topology — `pnpm demo`

One command orchestrates setup and run. Home: `infra/demo/` (a `tsx` CLI + one compose file), phases idempotent with visible progress, state in gitignored `infra/demo/.state/`.

**Setup phases** (each skips when already satisfied):

1. Port preflight — reuses `infra/devnet/preflight.ts` bind-based checks, extended to Postgres/server/web/MCP ports. Never attach to services the script did not start.
2. Devnet up (existing pinned images, unchanged: node `0.22.5`, indexer `4.2.1`, proof-server `8.1.0`) + health-wait (block height advancing, indexer synced, prover responding).
3. **Keygen + funding**: generate the server deploy key and the user dev-wallet key; from the genesis `dev` account (seed `0x00…01`) transfer NIGHT to both; DUST-register both. The exact derivation/registration recipe is **verified against the live devnet at implementation, never written from memory** (constitution I).
4. **Platform contracts**: compile NyxtVault with the local compact CLI (existing `packages/nyxt-vault` build), bootstrap-deploy to devnet, record the vault address.
5. Postgres container up + `migrateUp`.
6. **SRS pre-fetch** into a local cache served by the demo stack — the first in-browser prove never downloads mid-demo.
7. **Env generation**: `.env.demo` for the server (DB URL, `PROVER_URL` → :6300, deploy key, Tome/mnm MCP URLs, `MODEL_ROUTING` + LLM keys read from a user-maintained, gitignored `.env.demo.local`; a committed `.env.demo.example` documents every var) and `apps/web/.env.local` (`VITE_DEV_WALLET=1`, dev-wallet seed, network, vault address via the constitution-VII config chokepoint).

**Run phases**: build + start the server container → launch Tome + mnm MCP servers from a services manifest in `infra/demo/` (launch commands as data, not hardcoded) → health-check each → start Vite on the host (existing COOP/COEP isolation headers; host-run keeps HMR and the browser is on the host anyway) → print/open the URL.

**Lifecycle**: `pnpm demo:down` stops everything; `pnpm demo --reset` additionally wipes Postgres + devnet volumes + `.state/`; `pnpm demo --check` is a headless smoke pass (server health, devnet liveness, vault deployed) — the executable definition of demo-ready.

**Dockerfile**: `apps/server/Dockerfile` does not exist today (fly.toml references it) and is authored in this work — multi-stage pnpm workspace build (`--filter @nyx/server...`), non-root, port 8080. Fly.io is not used for the demo.

**MCP note**: compact-mcp is removed entirely (its compile role moves to the browser wasm; the per-cycle check already routes through the `CompileClient` seam). Tome + mnm remain for agent retrieval. `MCP_TOOLCHAIN_URL` leaves the required-env set.

## 4. Browser compile (the pitch centerpiece)

### Package

**`@nyx/compact-wasm`**: vendors the compactc-wasm build outputs (`compactc.{js,wasm,data}`, the keygen-patched `zkir-v2` wasm, the zk-bridge bundle) behind a thin typed API. Hosted in a **Web Worker** in `apps/web` so multi-second compiles/keygen never block the UI. The compiler pin is decided by SPIKE-1 (§10), not inherited blindly from the PoC's HEAD pin.

### Server seam

A new **`BrowserCompileClient`** implements the existing `CompileClient` interface (`check`/`compile`/`pollCompile`/`version`) but delegates execution to the connected client over WS, mirroring the `verify:run` → `test:results` round-trip:

- **Per-cycle check**: server emits `compile:run {turnId, kind:"check"}` → worker compiles from the project VFS → client replies `compile:results {ok, diagnostics}`. Bounded timeout = failed check (D42 discipline). A closed tab mid-turn becomes a failed cycle, never a hang.
- **Full compile on green**: server emits `compile:run {kind:"full"}` → worker compiles + generates keys/zkir → client uploads the artifact bundle to the server's **`ArtifactStore`** (`POST /projects/:id/artifacts` — session + ownership gated, content-hash addressed, size-capped) → client signals completion with `compile:results {turnId, kind:"full", sourceHash}` → server runs the existing `verifyPrefix` against its own store → emits `artifacts:ready {urlPrefix}` pointing at `GET /artifacts/<projectId>/<sourceHash>/…`. The same bounded timeout covers the whole compile-upload-signal window.

Artifacts land on the server because the deploy executor proves server-side and needs keys/zkir. The R2 `urlPrefix` contract (`manifest.json` + files, manifest-last completeness marker) stays byte-compatible, so `verifyPrefix`, the WebContainer `.env.local` repointer, and `FetchZkConfigProvider` work unchanged.

The editor's **Build** button hits the same worker directly for instant feedback — no server round-trip.

### ArtifactStore

A server-side storage seam (interface + local-disk impl for the demo; an R2-backed impl remains possible later as a pure storage choice with server-held creds — storage is no longer coupled to who compiles).

### Retirements (superseded decisions — recorded, not silent)

Owner decision 2026-07-23, superseding the US2 Compile Service resolution:

- The **Compile Service** (`infra/compile-service/API.md` contract), `HttpCompileClient`, `COMPILE_SERVICE_URL`/`COMPILE_SERVICE_TOKEN`, and the R2-artifact-write architecture (Compile Service as sole R2 write-cred holder) are **retired**. Browser compile is not a profile beside the service — it replaces it.
- **Lace integration is deferred** in favor of the dev wallet for local mode (T273/T115 remain owner-gated for whenever real-wallet work resumes). US9 (escape hatch) remains hard-blocked on T185 and is untouched by this design.
- The `CompileClient` seam interface survives; only its implementation changes.

## 5. Dev wallet + money path

### Dev wallet

`apps/web/src/wallet/dev-wallet.ts`, gated by `VITE_DEV_WALLET=1`. Installs an entry under `window.midnight.nyxDev` implementing the connector-v4 shape the existing detection duck-types (`connect(networkId)` → `getConnectionStatus`/`getUnshieldedAddress`/`signData`). It holds a **real BIP-340 keypair** whose verifying key SHA-256-hashes to its Bech32m address, so the server's `verify.ts` (signature verify + key↔address binding) passes unmodified. Keypair generated by the setup script, delivered via `VITE_DEV_WALLET_SEED` in the generated `apps/web/.env.local`. SIWE, nonce burn, and session issuance are untouched — real crypto, real sessions. The `midnight_signed_message:` prefix round-trip becomes self-consistent because we control both ends; Lace byte-compat stays an open (out-of-scope) question.

### Top-up ceremony

Implements the `DepositCeremony` seam (currently a throwing stub): build a NyxtVault `deposit(ref, amount)` transaction in the browser via the Midnight SDK, **prove in-browser** (zkir wasm — SPIKE-2), sign with the dev-wallet key, submit to the devnet node, return `txRef`. The seam keeps a **proof-server fallback** through the existing same-origin prover proxy so a SPIKE-2 surprise cannot block the demo. All SDK shapes midnight-verify-gated at implementation (iron rule 1).

### Deposit crediting — real indexer adapter (keepable)

A server-side watcher polls the devnet indexer for registered `depositRef`s (NyxtVault's public `deposits` map is the attribution channel by design) and on finality calls the existing `observeFinalized({ref, amount, txRef, outcome, finalized:true})`. Everything downstream is already built and stays real: exactly-once credit via partial unique index, EC-28 on-chain-amount crediting, `ledger:update` push, US12 ledger UI. **No money invariant changes**: reserve-then-settle, fold invariants, `numeric(40,0)`, bigint-in-code/string-on-wire.

### Browser ↔ devnet networking

The web app is cross-origin isolated (COOP/COEP for WebContainer), so direct fetches to `localhost:9944/8088` would need CORS/CORP headers the devnet services likely don't send. The browser therefore talks **same-origin to the Nyx server**, which gains thin forwarding routes for node-submit and indexer-query (the `/prover/prove` proxy already established the pattern).

## 6. Deploy loop

- **Real `DeployExecutor`** (body-only swap of the owner-gated stub; deps already wired): read green artifacts from the `ArtifactStore`, build the deploy via the Midnight SDK, prove through `PROVER_URL` → devnet proof server :6300, sign with `DEPLOY_KEY`, submit to node :9944, `awaitFinality` against the indexer honoring SC-029 (finalized strictly past reorg depth). The pipeline's exactly-once/never-reject machinery is already built and tested.
- **`BalanceQuery`** wired to a real deploy-wallet tDUST query (shape verified at implementation), feeding the existing monitor + `InsufficientDeployFundsError` path.
- **Green-build persistence** (P1 prerequisite): persist the green `CompileOutcome` per project (migration 0005), written when `verifyPrefix` succeeds after a full compile; deploy re-fetches **at deploy time** (US8 stale-build lesson). Until this lands every deploy honestly fails its greenness gate.
- **Preview interaction**: contract address already flows via `contract:deployed` → container `.env.local` merge; ZK config via the artifact routes. For signing the user's own DApp transactions inside the preview iframe, the **scaffold gains a dev-wallet module** reading `VITE_DEV_WALLET_SEED` from the container `.env.local`, signing/submitting in-page (proving via SPIKE-2 wasm, else the proxy). No `window.midnight` injection into the iframe — the T185/US9 problem is side-stepped entirely, and US9 stays blocked and untouched.

## 7. Supply-chain requirements (cross-cutting)

The hardening boundary follows the architecture: **our machine hardened, the user's browser sandbox stock**.

**Host side** — everything that installs/builds/deploys on our machine (repo workspaces, demo orchestrator, Dockerfile build, compactc-wasm vendoring/rebuild, devnet tooling):

- **pnpm only, always through Socket Firewall**: every install/build invocation in scripts, docs, the Dockerfile, and the demo CLI is written `sfw pnpm …`; bare `pnpm` never appears. The demo preflight checks `sfw` is installed and fails fast with install instructions (docs.socket.dev) if missing.
- **Hardened pnpm config committed to the repo** (exact config keys verified against current pnpm docs at implementation, not from memory): a **minimum package release age** before any new version is installable, and **dependency lifecycle scripts disabled** (no pre/post-install execution), with an explicit audited allowlist only where a dependency genuinely cannot function without its build step — each entry justified in a comment. Repo-level, so it binds CI and every contributor.
- **The server Dockerfile build counts as host-side**: the build stage installs `sfw` first and uses `sfw pnpm` for fetch/install.
- The compactc-wasm PoC's build scripts use npm today; the vendoring/rebuild for `@nyx/compact-wasm` (SPIKE-1) adapts those host-side steps to the same regime.

**Browser side** — the user's generated DApp inside the WebContainer uses plain **`npm`**, exactly as shipped in the in-browser runtime. No pnpm, no sfw. The `@nyx/scaffold` house rules get an explicit line stating this split so agents never generate pnpm/sfw usage into user projects.

## 8. Config changes

- Required-env set shrinks: `MCP_TOOLCHAIN_URL`, `COMPILE_SERVICE_URL`, `COMPILE_SERVICE_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` are removed as requirements (R2 vars may return later as optional storage-backend config for the `ArtifactStore`).
- New config: artifact-store settings (local root dir, size caps), dev-wallet flag (web), demo tunables as needed.
- Adding/removing required env vars breaks every server-building test fixture (US1 lesson) — fixtures updated in the same change, full repo gates run.

## 9. UI

**Shell + routing**: a minimal two-route app replacing the placeholder `Shell.tsx` — **Landing** and **Workspace** — behind the existing isolation gate + session bootstrap. Dev wallet auto-connects; SIWE happens silently on first visit; a wallet chip shows the address.

**Landing**: branding hero; project cards (name, last-active, deploy status) from `GET /projects`; "New project" creates + navigates.

**Workspace**:

- **Left sidebar**: conversation (existing chat modules; per-turn progress strip: classify → reserve → cycle n/3 → settle — the agent loop made visible); token meter below (compact `BalanceCard`: available/reserved, negative → blocked + CTA), entry feed behind a click-through, `LowBalanceNudge`; **Top-up** as a modal over the existing `topup.tsx` state machine.
- **Main pane**: resizable **Code | Preview** split, both visible at once (agent writes streaming into the editor while the preview HMRs is the money shot); either side collapsible.
  - **Code side**: file tree + Monaco with the Compact Monarch grammar (ported from the LFDT-Minokawa TextMate grammar, T232). **Read-only + live-updating during a turn** (agent `file:changed` events stream in); **editable when idle**. Toolbar + shortcuts: **Save** (⌘S), **Build** (⌘B → browser wasm check, inline diagnostics), **Deploy** (⌘⇧D → `deploy:request`; status chip from `deploy:status`; deployed address with copy affordance).
  - **Preview side**: WebContainer iframe with `dev:status` boot phases as a staged loader; console drawer below.
- **Unsaved-edit semantics**: explicit save (no auto-save); dirty-file badges; prompt-send with unsaved changes → modal **Save all / Discard all / Cancel** (save/discard then sends; cancel leaves the prompt unsent). User edits since the agent last ran are diffed into the next turn's agent context (FR-080) with instructions to review, re-verify, and re-deploy as needed.
- **Pitch moments in the UI**: a compile chip ("⚡ compiled in your browser — 1.2s") on every check/build; an equivalent proof chip on in-browser proves.
- **Polish**: a dedicated final sub-project (frontend-design-driven): typography, motion, empty/loading/error states, dark theme — after the workspace is functionally complete.

## 10. Spikes (run first — they carry the novel risk)

- **SPIKE-1 — compiler↔chain alignment.** The PoC pins compiler HEAD `c06961eb66` emitting for runtime `0.18.101` with a version-check bypass; the devnet pins node `0.22.5` and Nyx's toolchain is compiler `0.31.1`. Prove wasm-compiled output is accepted by the pinned devnet: compile a known contract in the wasm toolchain, deploy, execute, midnight-verify the claims. Outcome: the compiler pin + runtime-version strategy for `@nyx/compact-wasm` (possibly a rebuild at a pinned release).
- **SPIKE-2 — in-browser transaction proving.** The PoC proves + self-verifies circuit calls; a demo top-up needs a proof the devnet node accepts inside a real transaction. Prove a vault `deposit` end-to-end with the zkir wasm. Outcome: in-browser proving for ceremony + preview transactions, or the :6300 proxy fallback (demo works either way; the pitch prefers in-browser).

## 11. Sub-projects & build order

Each row becomes its own implementation plan. P-numbers are dependency order, not strict serialization.

| # | Sub-project | Contents | Depends on |
|---|---|---|---|
| P1 | Foundation gaps | turn-loop → `ProjectStore.commit` + integration test; green-build persistence (migration 0005); `capTestResults`/`computeCircuitCoverage` wiring check | — |
| P2 | `@nyx/compact-wasm` + browser compile | vendored wasm package, compile worker, `compile:run`/`compile:results` WS events, `BrowserCompileClient`, `ArtifactStore` + upload/serve routes, Compile Service/R2 retirement | SPIKE-1 |
| P3 | Dev wallet + money path | dev-wallet module, top-up ceremony, indexer→deposit-observation adapter, node/indexer forwarding routes | SPIKE-2 (proving path) |
| P4 | Deploy engine | real `DeployExecutor`, `BalanceQuery`, scaffold dev-wallet module for preview txs | P1, P2, SPIKE-1 |
| P5 | Demo orchestrator | `infra/demo/` CLI, compose, `apps/server/Dockerfile`, keygen/funding/DUST, vault bootstrap, env generation, sfw/pnpm preflight, smoke check | P2–P4 seams defined (stubs OK early) |
| P6 | UI: shell, workspace, polish | routing + landing, workspace split, Monaco + Monarch grammar, save/build/deploy + guards, turn-progress strip, pitch chips, final polish pass | P1; integrates P2–P4 as they land |

P1 + both spikes start immediately in parallel; P6's skeleton can also start early against existing mocked seams.

## 12. Testing

1. **Deterministic unit/behavioral tests** (existing seam pattern) for all new logic: compile round-trip over a fake WS, artifact-store caps/ownership, ceremony state machine, editor lock/guard semantics. CI, no environment.
2. **Devnet-gated integration tests**: new env-gate (à la `DATABASE_URL`), e.g. `DEVNET_URL`, for tests needing the live devnet — executor deploy round-trip, deposit→credit E2E, funding scripts. Local only, skipped in CI.
3. **`pnpm demo --check`** as the executable demo-ready definition, plus a scripted golden-path rehearsal doc (the exact prompt sequence to demo) run before any showing.

## 13. Risks & open items

- **SPIKE-1/2 outcomes** may force a compactc-wasm rebuild at a different pin or the proof-server fallback — both have designed landing zones.
- **DUST registration + genesis funding recipe** unknown until executed against the live devnet — the setup script's riskiest step; verified live, never from memory.
- **First-ever real E2Es** land at once: real WebContainer boot, real LLM turn loop, real deploys. The rehearsal doc + `--check` exist to absorb this.
- **Devnet-service CORS/CORP behavior** assumed hostile (hence server forwarding routes); if the services turn out permissive, the routes are still the keepable production shape.
- **`ledger:update`/WS bridge wiring** for the US12 ledger UI (noted owner-gated in Phase 13) is part of P6 integration.
- Compact Monarch grammar (T232) is ported, not hand-written — grammar source is the LFDT-Minokawa TextMate grammar.
