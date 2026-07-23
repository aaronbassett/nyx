> Provenance: SPIKE-1 brief (P1 plan Task 2, docs/superpowers/plans/2026-07-23-p1-spikes-foundation.md), executed 2026-07-23 by a Fable 5 background agent against the shared local devnet. Report reproduced verbatim.

# SPIKE-1 Report — wasm compiler chain alignment with the pinned Midnight devnet

## Verdict

**YES — wasm-compiled Compact contracts are accepted by the pinned devnet, with the wasm compiler pinned at the `compactc-v0.31.1` release (commit `0da5b0452eb0c1053d42418bf34b12cc29c7d63e`).** The full chain is proven end-to-end: wasm compile → zkir 2.1.0 keygen → midnight-js 4.1.1 deploy → local proof-server proof → finalized on node 0.22.5 → state change observed via the indexer.

Split verdict by compiler pin:

- **As-cloned HEAD pin (`c06961eb66`, self-reports compiler 0.33.109 / language 0.25.102 / runtime 0.18.101):** its **circuit artifacts are fully devnet-compatible** — the emitted ZKIR and the prover/verifier keys generated from it are **byte-identical** to native compactc 0.31.1 output for every circuit tested (counter `increment`, NyxtVault `deposit` + `burn`). Those exact wasm-produced keys deployed, proved, and finalized on the devnet. **But its generated JS contract module is NOT usable on the devnet's SDK stack:** it targets the compact-runtime 0.18 API and hard-fails against `compact-runtime@0.16.0` with a real signature incompatibility (not just the version-string check — the PoC's "strip `checkRuntimeVersion`" shortcut is insufficient at this pin).
- **Rebuilt at `compactc-v0.31.1` (done in this spike):** the wasm compiler's output is **byte-identical to the native 0.31.1 toolchain in every file** — generated JS (`checkRuntimeVersion('0.16.0')`), ZKIR, and (by IR identity) keys — for both contracts. This is a drop-in for the devnet SDK stack with **no version-check bypass at all**. NyxtVault (`pragma language_version >= 0.23`) compiles clean at both pins.
- The devnet's ledger version does constrain the pin — via the generated **runtime binding**, not the proof layer: compiler 0.31.1's flake pins midnight-ledger `ledger-8.0.2` (the devnet's ledger-8 line: proof-server 8.1.0, `ledger-v8@8.1.0`, `onchain-runtime-v3`); HEAD pins `ledger-9.1.0.0-rc.3` and emits for `compact-runtime@0.18.x` / `onchain-runtime-v4`. The zkir-v2 proof layer (IR v2.0, key format) is unchanged across that span for these circuits.

## Evidence

All work under `/tmp/claude-1001/-home-devbox-projects-nyx/de660570-a8e5-4780-ad7e-65470420eb16/scratchpad/spike1/` (`$SPIKE` below). Devnet containers (never restarted/reconfigured): `nyx-devnet-node` midnightntwrk/midnight-node:0.22.5 (`system_version` → `0.22.5-31b06338`, specVersion 22000), `nyx-devnet-indexer` indexer-standalone:4.2.1, `nyx-devnet-proof-server` proof-server:8.1.0 — all three health checks green before starting.

### 1. Wasm compile (HEAD pin, as cloned)

- `git clone https://github.com/aaronbassett/compactc-wasm` + `sfw npm install` — OK (webpack postinstall warns `keygen` is not exported by published `@midnightntwrk/zkir-v2@2.1.0`; `vendor/zkir-v2-keygen/` is not committed).
- `node node/compactc.mjs --skip-zk web/examples/counter.compact ../out/counter` → exit 0. `contract-info.json`: compiler-version **0.33.109**, language-version **0.25.102**, runtime-version **0.18.101**.
- `node node/compactc.mjs --skip-zk ../nyxt-vault.compact ../out/nyxt-vault` (copy of `packages/nyxt-vault/src/nyxt-vault.compact`, repo read-only) → exit 0, circuits `deposit` + `burn`.

### 2. Key generation

- `~/.compact/versions/0.31.1/x86_64-unknown-linux-musl/zkir` self-reports **midnight-zkir 2.1.0** — the same version as the npm `@midnightntwrk/zkir-v2` the PoC bundles. `zkir compile-many <zkir-dir> <keys-dir>` on the wasm HEAD IR → `increment.prover`/`.verifier`, `deposit.*`, `burn.*` + `.bzkir` binaries (SRS fetched from srs.midnight.network, cached `~/.cache/midnight/zk-params`).
- `zkir-v3` (midnight-zkir-v3 3.0.0-rc.1) **rejects** the same IR: `Error: Unhandled version: 2.0` — the wasm compiler emits zkir **v2.0** JSON IR at both pins.
- Circuit sizes (`Zkir.fromJson(...).getK()` via the zkir-v2 wasm): increment k=5, deposit k=13, burn k=14.

### 3. Byte-identity, wasm HEAD vs native 0.31.1

Native baseline: `~/.compact/versions/0.31.1/.../compactc counter-src.compact out/counter-native` and `... nyxt-vault.compact out/nyxt-vault-native` (toolchain generates keys itself).

- `diff` of pretty-printed ZKIR: **IDENTICAL** for `increment`, `deposit`, `burn`.
- `cmp` of keys: **all six key files byte-identical** (`increment.verifier` sha256 `62d768951a97c18af8cb385f8c0fe6488a4dbfbebce83ea08b21914a0ebe7789` in both trees; provers likewise).
- Generated JS differs **only** in the runtime binding (65 diff lines for counter): `checkRuntimeVersion('0.16.0')` vs `'0.18.101'`; sync vs `async` circuits; `context.currentQueryContext` vs `context.callContext.currentQueryContext`; `createCircuitContext(addr, …)` vs `createCircuitContext('name', addr, …)`; `copyCircuitContext`/`finalizeCallProofData` new in 0.18. Ledger-op transcripts identical.

### 4. Runtime compatibility probes

- Fresh npm project with `@midnight-ntwrk/compact-runtime@0.16.0` (deps: `@midnight-ntwrk/onchain-runtime-v3@^3.0.0`): the wasm-HEAD counter module (with `checkRuntimeVersion` patched out, the PoC's own regex) **fails in `initialState`**: `CompactError: 'contractState' parameter [object Object] has unexpected type` at `coerceToChargedState` — the 0.18-era leading-circuit-name argument shifts every parameter under the 0.16 signature. (`$SPIKE/probe-rt016/probe.mjs`.)
- The PoC's own `npm run test:node` (compact-runtime@0.18.0-rc.1 + onchain-runtime-v4@4.0.0-rc.3 + zkir-v2@2.1.0): **PASS execute+check** for counter, hello-world, bboard (2 circuits), lock — HEAD codegen is internally consistent with the 0.18-rc runtime; proving skipped (no keygen export, no committed keys).

### 5. Devnet deploy + circuit execution (midnight-verify sdk-tester subagent; result relayed via the orchestrator) — CONFIRMED

Artifacts under test: `$SPIKE/deploy-artifacts/{counter,nyxt-vault}/` = **wasm-produced `keys/` + `zkir/`** (byte-identical to native, hashes above) + the 0.16-API contract module; zkConfigProvider pointed at these directories.

- **Counter deploy**: contractAddress `1e28d6c2…`, txHash `bdab7f42…`, block 281, `SucceedEntirely`.
- **`increment()` call**: txHash `74bb8428…`, block 284, `SucceedEntirely`; proof generated by the local proof-server :6300 **from the wasm-produced `increment.prover`**; `round == 1n` independently confirmed by raw indexer GraphQL + the generated `ledger()` decode.
- **NyxtVault deploy-only**: contractAddress `464d0af0…`, txHash `51b3b781…`, block 318, `SucceedEntirely`; witness wired per `index.d.ts`. `deposit`/`burn` not called (needs tNIGHT funding — SPIKE-2 territory).
- SDK workspace pins (zero drift vs devnet): `midnight-js-*@4.1.1`, `compact-runtime@0.16.0`, `ledger-v8@8.1.0`, `onchain-runtime-v3@3.0.0`, `testkit-js@4.1.1`, `wallet-sdk@1.1.0`.

### 6. Rebuild of the wasm compiler at `compactc-v0.31.1`

`scripts/00-env.sh` `COMPACT_REV` → `0da5b0452eb0c1053d42418bf34b12cc29c7d63e`; then stages 01→04 (details and fixups below). Result: `build/out/compactc.{js,wasm,data}` (wasm 775 KB, boot file 4.18 MB); the Node CLI auto-prefers `build/out/`.

Recompile-diff, **rebuilt-wasm-0.31.1 vs native-0.31.1**, both contracts:

- generated `contract/index.js`: **IDENTICAL** (including `checkRuntimeVersion('0.16.0')`)
- ZKIR (`increment`, `deposit`, `burn`): **IDENTICAL**
- self-reported versions: compiler **0.31.1**, language **0.23.0**, runtime **0.16.0**

## Compiler pin decision

**Pin the wasm compiler to the `compactc-v0.31.1` release, commit `0da5b0452eb0c1053d42418bf34b12cc29c7d63e`.** It emits for `compact-runtime@0.16.0` / zkir v2.0 / ledger-8 — exactly the devnet + Nyx SDK stack — and its output is byte-identical to the native toolchain Nyx already trusts. Do not ship the HEAD pin: its runtime binding is unusable on this stack and its version-check bypass is a demo-only shortcut that doesn't even suffice.

Reproducing the build (from the PoC clone; Node ≥20, rustup not required for the compiler itself):

1. `scripts/00-env.sh`: set `COMPACT_REV=0da5b0452eb0c1053d42418bf34b12cc29c7d63e`.
2. Environment deltas needed on Debian/Ubuntu with emscripten 3.1.69+dfsg-4 (apt) — all applied in `$SPIKE/compactc-wasm`:
   - `scripts/03-build-compactc-boot.sh`: the pure-Scheme SHA-256 patch anchor `(define (sha256-file pathname)` does not exist at 0.31.1 (it predates manifest hashing — 0.31.1 emits no `contract-manifest.json`); guard the patch to skip when absent. The `(utils))` body-extraction anchor, `srcMaps`/`third_party` layout, and the `ledger-version.ss` flake grep all hold at 0.31.1.
   - `scripts/04-build-wasm.sh`: (a) `minify_html` no longer exists in emscripten 3.1.69's `emcc.py` — guard the patch block on its presence (otherwise it attempts a root-owned file rewrite and dies); (b) `~/.emscripten-compactc` must say `LLVM_ADD_VERSION/CLANG_ADD_VERSION = '19'` (the script writes '15'; Debian's emscripten depends on clang-19 — `clang-15` doesn't exist); (c) the hardcoded `clang-15` for `mainbridge.s` → `clang-19`; (d) zlib's old `./configure` fails under emcc/clang-19 until the config fix in (b) is applied (the failure is a misleading "too harsh" message; `configure.log` shows `clang executable not found at /usr/bin/clang-15`).
   - Chez's em-pb `make` fails at its final demo-html link (`html-minifier-terser` missing) — already tolerated by the script (`make || true`); only `main.o`/`libkernel.a`/`liblz4.a` are consumed.
3. `bash scripts/01-fetch-sources.sh && bash scripts/02-build-native-chez.sh && bash scripts/03-build-compactc-boot.sh && bash scripts/04-build-wasm.sh` (03's whole-program pb compile takes >10 min; it is incremental and safe to rerun). Verify with the recompile-diff in Evidence §6, then commit the prebuilt artifacts (as the PoC does for `web/`).

## Runtime-version strategy

- **Generated code loads against `@midnight-ntwrk/compact-runtime@0.16.0`** (which wraps `onchain-runtime-v3@3.0.0`) — the exact pins the confirmed deploy used, alongside `midnight-js-*@4.1.1`, `ledger-v8@8.1.0`, proof-server 8.1.0, node 0.22.5. This is one coherent ledger-8 stack; Nyx already pins compact-runtime 0.16.0.
- **The version-check bypass is NOT needed at the 0.31.1 pin** — generated code asserts `0.16.0` and that's what's installed. Remove the PoC's `checkRuntimeVersion`-stripping loader shim from any P2 plan; treat a version-check failure as a real stack-drift signal, never strip it.
- **Key generation must use zkir-v2 (2.1.0)** — `zkir compile-many` from the compact 0.31.1 toolchain, or the npm `@midnightntwrk/zkir-v2` wasm (same version; `check`/`prove` proven by the PoC suite, `keygen` only via the PoC's patched build). `zkir-v3` rejects v2.0 IR outright.
- **Move the whole row, or no row**: compiler pin, compact-runtime major, onchain-runtime major, midnight-js, ledger/proof-server/node versions are one lockstep unit. Bumping the compiler past 0.31.x flips generated code to the 0.18/onchain-runtime-v4 (ledger-9) API and requires the entire devnet + SDK row to move with it.

## Risks for P2

1. **In-browser keygen is unproven for this stack.** The published zkir-v2 wasm has no `keygen` export; the PoC's patched build (`scripts/07-build-zkir-wasm.sh`) pins `LEDGER_TAG=ledger-9.1.0.0-rc.3`. Before relying on browser keygen, rebuild the patched wasm at a ledger-8 tag (e.g. `ledger-8.0.2`, the compiler's own pin) and byte-compare its keys against `zkir compile-many` 2.1.0 output — the PoC README documents key-format drift between zkir builds ("v1 prover key" rejections), so same-crate-version is not proof of same-format. Server-side keygen with the toolchain zkir is the proven path today; also fine to pre-generate keys at compile time and serve them (Nyx's compile-service model).
2. **In-browser proving with these keys is SPIKE-2's territory, not proven here.** This spike proved proof-server proving (host-side) from wasm-produced keys. Burn is k=14, slightly above the PoC's bundled k=5–13 examples; proving time/memory grows with k.
3. **NyxtVault circuit calls not exercised on-chain** — deploy + witness wiring confirmed; `deposit`/`burn` execution needs funded tNIGHT (and the burn authority secret), coordinate with SPIKE-2's funding work.
4. **0.31.1 emits no `contract-manifest.json`** (no output hashing at all) — any P2 flow that consumed the HEAD compiler's manifest must compute its own hashes (Nyx's compile-service already does).
5. **`--skip-zk` output has no keys and no `.bzkir`** — `zkir compile-many` produces both; the SDK's `NodeZkConfigProvider`-style layout wants `keys/<c>.prover|.verifier` + `zkir/<c>.bzkir`. Budget the keygen step (deposit.prover 2.8 MB, burn.prover 5.2 MB; SRS download on first use).
6. **Build reproducibility quirks** (all environment, none alignment): the emscripten/clang-19 deltas listed under Compiler pin decision; stage 03 exceeds a 10-minute shell timeout; `sudo` needed only for apt installs. Commit the built `compactc.{js,wasm,data}` so consumers never run the pipeline.
7. **Deploy-path footguns** (from the confirmed sdk-tester run): the indexer GraphQL WebSocket is `/api/v4/graphql/ws` (405 on the http path); the tx-encoding network id must be **lowercase `undeployed`** — capitalized gets node rejection 1010/Custom 166 InvalidNetworkId (Lace merely _displays_ "Undeployed"); testkit-js wallet sync auto-registers NIGHT UTXOs for DUST — non-testkit paths must do that manually.
8. **Language drift headroom**: NyxtVault's `pragma language_version >= 0.23` also compiles at HEAD (0.25.102) with identical circuits today, but that identity is an observation about these contracts, not a guarantee — re-run the byte-diff harness (`$SPIKE/out/` layout) whenever either pin moves.
