# P2 Retro — Browser Compile

Plan: `docs/superpowers/plans/2026-07-23-p2-browser-compile.md` (as re-planned by Task 0) · Branch: `demo/p2-browser-compile` · Base: `dc9b3e4` (post-P1 main)

All eleven tasks completed; no deferrals. Commits: `7b89d18` (re-plan) → `84347fa` (protocol) → `bf30bb7` (compact-wasm) → `6f0bd9a` (worker) → `3e3c1b4` (upload handler) → `6a2875a` (artifact store) → `b5639c9` (routes) → `050a523` (browser client) → `5067a8b` (turn-loop wiring) → `a39c7bc` (retirement, `feat!`) → `63ce0fa` (web read path) → review fixes + this retro.

## Deviations from the plan

1. **Task 2 vendored via the SPIKE-1 build tree, not a fresh rebuild.** The orchestrator pointed the implementer at SPIKE-1's still-present `build/out` artifacts; the byte-identity gate was re-run twice (fresh recompiles vs the native 0.31.1 toolchain, counter + nyxt-vault) before vendoring. `REBUILD=1` from-scratch remains supported but needs SPIKE-1's emscripten/clang-19 environment fixups.
2. **Task 2 CJS/ESM boundary:** `compactc.js` is CommonJS inside a `type:module` package — fixed with a committed `vendor/package.json` (`{"type":"commonjs"}`), mirroring the PoC's own layout. Standalone Chez boot files are not vendored; they are embedded in `compactc.data` (verified via the emscripten packager manifest).
3. **Task 6 `registerArtifactRoutes` co-registers inside the projectStore block** (single-export signature honored); the public GET is session-less in the request sense. The durable-store/`index.ts` wiring was deferred to Task 9 (where it landed) rather than widening Task 6.
4. **Task 8 `publicOrigin` landed optional-with-derivation** (`PUBLIC_ORIGIN` env, else `http://localhost:<PORT>`) — a required var would have broken every server-building fixture (US1 lesson applied).
5. **Task 9 kept the `projects/secrets.ts` scanner's `R2_*`/`COMPILE_SERVICE_TOKEN` name-shapes** — those are credential patterns the US13 handoff scanner guards against in user artifacts, not config consumers. Everything that actually consumed the retired config is gone (grep-verified).
6. **Tasks 3/4 left two seams intentionally unwired:** the real worker boot is browser-only (mirrors the `real-handle.ts` gating pattern) and `getSources` has no production caller yet — P5/P6 must supply the resolve-current-sources fn + projectId to `createPreview` or compile handling stays unregistered. Recorded as explicit wiring obligations, not gaps discovered later.

## Discoveries

- **The vendored 0.31.1 wasm compiler is proven in-repo:** integration tests compile real contracts (accept-good/reject-bad, `checkRuntimeVersion('0.16.0')` in output, ZKIR + circuits emitted) on every test run — no version-check bypass anywhere in the tree.
- **Server test count moved 561 → 622 → 613:** the drop at Task 9 is the retired `HttpCompileClient` path's tests leaving with it (net +52 vs P1, incl. 24 artifact-store, 17 route/adapter, 16 inbox/client).
- **TS 5.7 `Uint8Array<ArrayBufferLike>` narrowing** breaks `crypto.subtle.digest`/`fetch` bodies — caught only by `tsc`, not vitest's esbuild (reaffirms the orchestrator-runs-full-gates rule).
- **`compile:results` validation is boundary-level** via `parseEvent("client-to-server", …)` incl. a superRefine (green full ⇒ `sourceHash` present), identical to `test:results`; the Defense-4 cross-tenant guard (deliveringProjectId binding) is live and tested at the WS handler.
- **`passedNames?` enrichment field** (P1 retro F1) landed additively on `TestResultsPayloadSchema` in Task 1; P6's Task 7b consumes it (emit + fold + cap interaction).

## Deferred items

None within plan scope. Owner-gated (consistent with the whole program): the real-browser E2E (real worker boot + WS upload + verify-before-announce over live HTTP) — deterministic equivalents are tested end-to-end in-process (orchestrator + in-memory store + fetch adapter announced-once test); the P5 demo smoke is the live proof point. The zkir **keygen** wasm is deliberately NOT vendored — SPIKE-1's ledger-8 rebuild + byte-compare gate stands; the proven path (proof-server proving with client-supplied keys from the artifact prefix) needs no browser keygen. P3 decides its proving adapter against that gate.

## Impact on remaining plans

- **P3 (dev wallet/money):** the compile/artifact surface it needs is real — key material (`keys/<c>.prover|.verifier`, `zkir/<c>.bzkir`) will be servable from the artifact prefix once keygen artifacts are produced (note: browser `--skip-zk` compiles do NOT produce keys — the keygen step is a P3/P4 concern per SPIKE-1; the `/srs/*` route from Task 9 serves SRS params). `publicOrigin` config exists.
- **P4 (deploy engine):** `getLatestGreenBuild` rows now come from real browser compiles; the deploy-side zkConfig reads the same artifact layout; the orchestrator's fetchArtifact is the in-process store adapter (no HTTP-to-self).
- **P5 (demo orchestrator):** MUST wire `getSources` + `projectId` into `createPreview`/`launchPreview` (compile handling is unregistered without them) and prove the real worker boot + Vite worker-chunk split at build time. `@nyx/compact-wasm` vendor (6.7 MB) rides into the Docker image via `COPY packages`.
- **P6 (UI/workspace):** Task 7b's enrichment consumers are unblocked (protocol field exists).
