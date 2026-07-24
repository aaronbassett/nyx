# P3 — Dev Wallet + Money Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lace with a demo-only dev wallet (browser-held BIP-340 key) that satisfies the existing SIWE auth unchanged, implement the real top-up ceremony (build/prove/sign/submit a NyxtVault `deposit`), add same-origin devnet forwarding routes, and fill the owner-gated indexer→deposit-observation seam so finalized deposits credit the real ledger.

**Architecture:** Everything slots into seams that already exist: the dev wallet is a connector-v4-shaped object under `window.midnight` (duck-typed detection at `apps/web/src/wallet/detect.ts:44-84` picks it up); the ceremony fills the `DepositCeremony` stub seam (`apps/web/src/wallet/topup.tsx:959` `createOwnerGatedCeremony`); the observation adapter feeds the existing `DepositStore.observeFinalized` (`apps/server/src/ledger/deposits.ts:153`); the forwarding routes clone the prover-proxy pattern (`apps/server/src/prover/proxy.ts`). No money invariant changes — reserve-then-settle, exactly-once credit, `numeric(40,0)`, bigint-in-code/string-on-wire all stay as-is.

**SPIKE-2 verdict folded in (Task 0, 2026-07-23 — SPIKE2_REPORT.md is the citation for every claim below):**

- **Ceremony proving path: in-browser wasm is PRIMARY** — a NyxtVault `deposit` whose contract-circuit proof was computed in-process by `@midnight-ntwrk/zkir-v2@2.1.0` wasm was accepted + finalized by the devnet node (block 218; proof-server negative control showed only the wallet's fee leg hit :6300). The injection point is the SUPPORTED SDK seam `Transaction.prove(provingProvider, CostModel.initialCostModel())`; `zkir.provingProvider(keyMaterialProvider)` produces exactly that `{check, prove}` shape. The **proof-server fallback is a one-line `proofProvider` swap** (`httpClientProofProvider(url, zkConfigProvider)`) over the SAME client-supplied key material — the modern proof server POSTs each circuit's serialized preimage + `{proverKey, verifierKey, ir}` to `/check` and `/prove` (`application/octet-stream`); it holds only built-in zswap/dust keys.
- **Verified tx recipe (executed, devnet-accepted):** unproven tx assembly via `midnight-js-contracts` (`ContractCallPrototype` → `Transaction.fromPartsRandomized(networkId, …)`); prove via the seam above; then wallet-sdk facade `balanceUnboundTransaction` → `signRecipe` (BIP-340 over unshielded intents via the unshielded keystore) → `finalizeRecipe` (proves wallet legs, binds) → `wallet.submitTransaction(finalizedTx)` over the node WS relay; finality observed via indexer `watchForTxData(txId)` / `contractAction(address)` GraphQL. There is NO lower-level "splice proof bytes into a tx" API — the callback IS the interface.
- **Wallet construction:** hand-built env `{walletNetworkId:'undeployed', networkId:'undeployed', indexer:'http://…:8088/api/v4/graphql', indexerWS:'ws://…:8088/api/v4/graphql/ws', node:'http://…:9944', nodeWS:'ws://…:9944', proofServer:'http://…:6300', faucet:undefined}` + `setNetworkId('undeployed')` + `MidnightWalletProvider.build(logger, env, seedHex)` (testkit-js@4.1.1 against the RUNNING devnet — never let `LocalTestEnvironment` start containers).
- **Tx-encoding network id is lowercase `undeployed`** (capitalized → node rejection 1010/Custom 166). The web connector gate `EXPECTED_NETWORK_ID` stays `"Undeployed"` (Lace DISPLAY value, `apps/web/src/config.ts:41`) — the two must never be conflated.
- **Proving budget is real:** ~23–26 s for the k=13 `deposit` proof (4.5 KB proof; prover key 2.8 MB + IR + SRS ~1.5 MB must reach the client, or keygen ~16 s). Plan UX accordingly: progress states in the ceremony/topup state machine, proving in a Web Worker, key-material prefetch from the artifact prefix.
- **The wallet FEE leg still needs a prover** (DUST spend): point the dev wallet's fee-leg proving at the proof server (via the same-origin proxy) or wire `wallet-sdk-prover-client`'s `WasmProver` (same zkir engine; exists upstream, unexercised). In-browser contract proof does NOT remove the wallet's proving dependency.
- **Fresh wallets need NIGHT + DUST registration** before the first fee-paying tx (transfer → `registerNightUtxosForDustGeneration` with zero dust held → ~12 s accrual); genesis seeds `0x…01`–`0x…04` are pre-registered. **Serialize per-wallet submissions** (UTXO races observed on concurrent submits from one seed).
- **wallet-sdk version discrepancy RESOLVED (P3 Task 0, from the executed spike workspace on disk):** SPIKE-2's `sdkwork/node_modules` holds a top-level `@midnight-ntwrk/wallet-sdk@1.0.0` (what its risk 2 reported) AND a nested `wallet-sdk@1.1.0` under `testkit-js@4.1.1` — whose package.json declares the EXACT dep `"@midnight-ntwrk/wallet-sdk": "1.1.0"`. The spike scripts imported the wallet stack exclusively via `@midnight-ntwrk/testkit-js` (`MidnightWalletProvider` etc.), so Node resolution means the wallet legs that actually executed ran **wallet-sdk@1.1.0** (matching SPIKE-1 §5). **Pin `wallet-sdk@1.1.0`** for any direct import; `testkit-js@4.1.1` brings it as an exact dep. The shadowed top-level 1.0.0 is the entire source of the discrepancy.
- **Ceremony key material provenance (P3 Task 0, resolving the P2 retro's keygen gate):** `@nyx/compact-wasm` as merged vendors ONLY the compiler (`vendor/compactc.{js,wasm,data}`; `COMPILE_FLAGS = ["--skip-zk"]` always; barrel exports compiler surfaces only — no zkir, no prover, no keygen). Browser keygen stays GATED (P2 retro: the keygen-patched zkir wasm is deliberately NOT vendored; SPIKE-1 risk 1's ledger-8 rebuild + byte-compare gate stands). The proven shipping path for the ceremony: **NyxtVault prover/verifier keys + `.bzkir` come from the native compact 0.31.1 toolchain compile at platform-setup time** (SPIKE-2 §B — `compact compile` emits `keys/{deposit,burn}.{prover,verifier}` + `zkir/*.bzkir`; P5's vault phase runs it) and are **served same-origin to the browser** (Task 4). The zkir PROVE engine for the browser is the published npm `@midnight-ntwrk/zkir-v2@2.1.0` (exports `provingProvider(keyMaterialProvider)` — `check`/`prove`; `keygen` is NOT exported from the published package, SPIKE-1 §1), added as a web dep in Task 4.

**Tech Stack:** TypeScript/Node ≥22, Fastify 5, React 19 + Vite, vitest, `@midnight-ntwrk/ledger-v8` (BIP-340 primitives — already proven in `apps/server/tests/auth/helpers.ts`), `@midnight-ntwrk/wallet-sdk-address-format`, `@nyx/compact-wasm` prover (SPIKE-2), devnet (node :9944 / indexer :8088 / proof server :6300).

## Global Constraints

- Host-side commands are ALWAYS `sfw pnpm …` — never bare `pnpm`, never `npm` (WebContainer-internal npm is the only exception; nothing in this plan runs there except generated-DApp guidance, which is P4).
- Warnings are errors: `eslint --max-warnings 0`, TS strict, prettier clean. A warning blocks the commit.
- Conventional commits, lowercase subject, no leading acronym/uppercase word, header ≤72 chars (commitlint enforces). Never `--no-verify`.
- Constitution I: NEVER hand-write Compact/`@midnight-ntwrk/*` shapes from memory. Every SDK-touching step below names its verification procedure; run it first, code only from verified shapes, and execution (not just compilation) is the proof bar.
- Money rules: `bigint` in code, decimal string on the wire via `@nyx/protocol` `encode*` helpers, `numeric(40,0)` in Postgres, exactly-once via DB structure. Never `Number()` on an amount.
- Ownership: bind everything to the ownership-checked session/`ctx.projectId`; ownership denials are 404, never 403.
- Seam pattern: interface + real impl + in-memory/fake double with injected clock; store/client failures are promise rejections; live-service tests env-gated (`DATABASE_URL` for Postgres, `DEVNET_URL` for the devnet — copy the gate idiom from `apps/server/tests/ledger/pg-deposits.test.ts:25-27`).
- The dev wallet and its seed handling are DEMO-ONLY concessions (design §1) — gate on `VITE_DEV_WALLET=1`, never install by default, and keep every dev-wallet file clearly named `dev-*`.

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p3-dev-wallet-money` off up-to-date `main` before the first task.

**Per task:**

1. TDD: write the failing test, see it fail, implement minimally, see it pass.
2. Run the gates for the touched package(s): `sfw pnpm lint && sfw pnpm typecheck && sfw pnpm test` (plus `sfw pnpm format:check` before commit). Warnings are errors — a warning from any tool blocks the commit.
3. Commit with a conventional-commit message (commitlint is enforced: lowercase subject, no leading acronym/uppercase word, header ≤72 chars). Never use `--no-verify`.
4. Self-review the task diff before moving on (does it match the task's interface block; is anything speculative or dead).

**Before opening the PR (after the last implementation task):**

1. Run the full repo gates from the root: `sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test`. All green, zero warnings.
2. Dispatch a code-reviewer subagent over the full branch diff (`git diff main...HEAD`). Fix every actionable finding, then re-review. Loop review → fix → re-review until a review pass returns no actionable findings. Findings you dispute must be argued in the retro, not silently dropped.
3. Write the retro (see Retro section) and commit it — it ships in this PR.

**PR / CI / merge:**

1. Push the branch; open a PR to `main` with `gh pr create` — body: link to this plan, summary of what shipped, test evidence (counts, gate output), any deviations.
2. Watch CI: `gh pr checks --watch`. If red: diagnose with systematic debugging, fix, push, re-watch. Never merge red; never weaken or skip a check to get green; a flaky test is a bug to fix, not to retry into submission.
3. When green: `gh pr merge --merge --delete-branch`.
4. Update the retro if the CI loop forced deviations (push to the PR before merging, or amend in the next plan's branch if already merged).
5. **Immediately** check out `main`, pull, open the next plan (`docs/superpowers/plans/2026-07-23-p4-deploy-engine.md`), and begin it — starting with its Task 0 re-planning preamble. Do not pause between plans.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- Server/web TypeScript tasks (dev-signer, dev-wallet, ceremony orchestration, devnet proxy, observation adapter): `devs:typescript-dev`.
- Every constitution-I verification step (deposit tx-building SDK shapes, indexer GraphQL shapes, bech32m network segment probe): the `midnight-verify:verify` skill / `midnight-verify:*` agents (`sdk-tester` for devnet E2E, `type-checker` for .d.ts claims).
- Anything touching the NyxtVault contract or Compact semantics: `compact-core:compact-dev`.
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches; money-path changes additionally get a `compact-core:security-reviewer` pass if contract interaction code changed.

**Model routing — which model runs what:**

- Implementation dispatches (`devs:typescript-dev`, `compact-core:compact-dev`) and `midnight-verify:*` verification dispatches run on **Opus**: pass `model: "opus"` in the Agent call.
- Review dispatches (`devs:code-reviewer`) run on **Opus** by default. **This plan is a money path**: the final pre-PR review of the ceremony + observation-adapter + crediting surfaces, and the `compact-core:security-reviewer` pass (if contract-interaction code changed), run on **Fable 5**. Also escalate any finding still disputed after one fix loop.
- **Fable 5 is reserved** for the orchestrating session itself, the Task 0 re-planning subagent, and the money-path reviews above. Never run routine implementation on Fable.

## No-Deferral Policy

Fully implement every task in this plan before moving on. Deferral is permitted only when 100% required — an external hard blocker outside the codebase. "This is hard/slow/complex" or "this could be a follow-up" are not justifications. Every deferral must appear in the retro with: what was deferred, the blocking condition, what unblocks it, and the impact on remaining plans.

## Code Quality Rules (binding for every task)

- **Host commands**: always `sfw pnpm …`, never bare `pnpm`, never `npm`, on anything that runs on our machine (installs, builds, scripts, Dockerfile build stages). Inside the user-facing WebContainer runtime only: plain `npm`.
- **Warnings are errors** everywhere: ESLint runs with `--max-warnings 0`, TypeScript strict, Prettier check must be clean. CI enforces the same; a warning that "seems harmless" blocks the commit.
- **Constitution I**: never hand-write Compact/`@midnight-ntwrk/*` shapes from memory. Where a step touches an SDK surface, the step names the verification procedure (installed-type reads, `midnight-verify` dispatch, live probing). Run it first; write code only from verified shapes. Compilation alone is not proof — execute.
- **Money rules** (iron rules 2–3): `bigint` in code, decimal string on the wire via `@nyx/protocol` `encode*` helpers, `numeric(40,0)` in Postgres, exactly-once via DB structure (partial unique indexes / CAS), never `Number()` on amounts.
- **Seam pattern** (iron rule 6): interface + `Pg*`/real impl + in-memory/fake double with injected clock; store failures are promise rejections; integration tests env-gated (`DATABASE_URL`, `DEVNET_URL`).
- Deterministic tests only in the default suite; anything touching a live service is env-gated.

## Retro (final task of this plan)

Write `docs/superpowers/plans/retros/P3_RETRO.md` before opening the PR. Contents, in detail:

- **Deviations** from this plan: what changed, why, and the evidence that forced it.
- **Discoveries**: verified facts (SDK shapes, tool behaviors, version constraints) that future plans must know — be specific, include exact names/versions.
- **Deferred items** (should be none): each with justification per the No-Deferral Policy.
- **Impact on remaining plans**: which upcoming tasks are now wrong/obsolete/missing, so the next plan's re-planning preamble can act on it.

---

### Task 0: Re-planning preamble

- [ ] **Step 1: Dispatch a Fable 5 re-planning subagent.** Use the Agent tool (the session model is Fable 5; do not downgrade the model for this dispatch). Give it: this plan file's path, all remaining plan files' paths (`2026-07-23-p4-deploy-engine.md`, `2026-07-23-p5-demo-orchestrator.md`, `2026-07-23-p6-ui-workspace.md`), the design doc (`docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md`), every `docs/superpowers/plans/retros/*_RETRO.md` **including `SPIKE1_REPORT.md` and `SPIKE2_REPORT.md`**, and instructions to inspect `git log --oneline` since the plans were authored plus the current state of the files each plan touches. Its job: reconcile this plan and all remaining plans with reality — completed/obsolete tasks removed, interface drift corrected (exact names/signatures from the code as it now exists), retro discoveries folded in, missing tasks added. **For THIS plan specifically it must resolve from `SPIKE2_REPORT.md`: (a) the ceremony proving path (in-browser wasm vs `/prover/prove` proxy fallback) and (b) the verified tx-build/submit recipe Task 5 codes against.** It edits the plan files directly.
- [ ] **Step 2: Review the subagent's plan edits** (`git diff` on `docs/superpowers/plans/`). You are accountable for the updated plan — sanity-check that edits are grounded in retros/code, not speculation.
- [ ] **Step 3: Commit** the updated plans: `git commit -m "docs: re-plan p3+ from retros and current state"`.
- [ ] **Step 4: Execute THIS plan as amended.**

---

### Task 1: Devnet forwarding proxy (server)

The isolated (COOP/COEP) browser cannot fetch `localhost:9944/8088` directly, so the browser talks same-origin to the server, which forwards opaquely. Clone the prover-proxy pattern exactly — encapsulated child scope, catch-all buffer parser, session gate, opaque relay (read `apps/server/src/prover/proxy.ts` end-to-end before starting; the code below mirrors it deliberately).

**Files:**

- Create: `apps/server/src/devnet/proxy.ts`
- Create: `apps/server/src/devnet/index.ts` (barrel: re-export the public surface)
- Test: `apps/server/tests/devnet/proxy.test.ts`
- Modify: `apps/server/src/app.ts` (there is no `server.ts` — `buildServer` lives in `app.ts`; register the routes where `registerProverRoutes` is registered, `app.ts:296`, inside the auth-gated block, and mirror how `requireSession` is built at `app.ts:221` — line anchors re-verified post-P2)

**Interfaces:**

- Consumes: `requireSession` preHandler (built in `buildServer`), `config.network.nodeUrl` / `config.network.indexerUrl` (`NetworkProfile`).
- Produces: `createDevnetForwarder(deps: DevnetForwarderDeps): DevnetForwarder` with `forward(request: ForwardRequest): Promise<ForwardResult>`; `registerDevnetRoutes(app, { nodeForwarder, indexerForwarder, requireSession })` exposing `POST|GET /devnet/node/*` and `POST|GET /devnet/indexer/*`. P3 Task 5 (ceremony submit) and P6 consume these routes from the browser.
- **⚠️ WS relay DECISION (P3 Task 0 — a plain HTTP forwarder is NOT enough; the relay is IN SCOPE as a first-class deliverable):** the verified SPIKE-2 stack REQUIRES WS legs — submission goes `wallet.submitTransaction(finalizedTx)` **over the node WS relay** (`ws://…:9944`, SPIKE-2 §What-a-tx-needs step 4), and wallet sync/`watchForTxData` use `indexerWS` at `ws://…:8088/api/v4/graphql/ws` (the http path 405s WS upgrades — SPIKE-1 risk 7). If the dev wallet is built on the testkit/wallet-sdk stack (the executed recipe), those endpoints must be reachable. The design's same-origin posture (§5: ALL devnet traffic rides the Nyx server; the forwarding routes are the keepable production shape) means this task implements a **session-gated WebSocket relay** on the two prefixes alongside the HTTP forwarders: `@fastify/websocket@11.3.0` is already a server dep (`app.ts:10`) — a thin socket-pair relay per prefix (browser WS ↔ server-side `ws` client to `nodeUrl`/`indexerUrl`-derived WS targets), bytes forwarded verbatim both ways, close/error propagated both ways. (Spec nuance, recorded honestly: COEP does not block cross-origin WebSockets, so a direct `ws://localhost:9944` from the isolated page MAY work — but that would bypass the designed same-origin server boundary; do not take that path silently. If at implementation the ceremony stack demonstrably runs with HTTP-only endpoints, record the executed evidence in the retro and drop the relay — decide from execution, never memory, constitution I.)

- [ ] **Step 1: Write the failing tests.** Cover: (a) unauthenticated request → 401, no forward (fake forwarder records zero calls); (b) authenticated POST body+content-type relayed verbatim to the target base URL + subpath, response status/body/content-type relayed back verbatim; (c) forwarder `fetch` throw → 502 `{"error":"devnet unreachable"}`, internals not leaked; (d) sibling JSON routes still parse JSON (register a probe route in the test app — proves the buffer parser stayed encapsulated); (e) subpath join: request to `/devnet/node/api/foo?x=1` forwards to `<nodeUrl>/api/foo?x=1` (query preserved). Build the test app the way `apps/server/tests/prover/` tests do (find them with `ls apps/server/tests/prover/`) — in-memory auth store, real session cookie via the in-memory store, `app.inject()`.

```typescript
// apps/server/tests/devnet/proxy.test.ts — representative core (write all five cases)
import { describe, expect, it } from "vitest";
import { createDevnetForwarder } from "../../src/devnet/proxy.js";

describe("createDevnetForwarder", () => {
  it("relays method, subpath, query, body and content-type verbatim", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(Buffer.from("ok-bytes"), {
        status: 201,
        headers: { "content-type": "application/scale" },
      });
    }) as typeof fetch;

    const forwarder = createDevnetForwarder({ baseUrl: "http://node:9944", fetch: fakeFetch });
    const result = await forwarder.forward({
      method: "POST",
      subpath: "/api/foo",
      query: "x=1",
      body: Buffer.from([1, 2, 3]),
      contentType: "application/json",
    });

    expect(calls[0]?.url).toBe("http://node:9944/api/foo?x=1");
    expect(result.status).toBe(201);
    expect(result.contentType).toBe("application/scale");
    expect(Buffer.compare(result.body, Buffer.from("ok-bytes"))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `sfw pnpm --filter @nyx/server test tests/devnet/proxy.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `apps/server/src/devnet/proxy.ts`.** Mirror `prover/proxy.ts` structure: `DevnetUnavailableError` (named, carries target, maps to 502), `createDevnetForwarder` (injectable `{baseUrl, fetch?}`, opaque byte relay, GET sends no body), `registerDevnetRoutes` (one encapsulated child scope per prefix with `removeAllContentTypeParsers()` + `addContentTypeParser("*", { parseAs: "buffer" }, …)`, `requireSession` preHandler, wildcard route `scope.route({ method: ["GET", "POST"], url: "/devnet/node/*", … })` extracting the subpath from `request.params["*"]` and the raw query from `request.raw.url`). Constitution I: the forwarder is a transparent byte relay — never parse node/indexer payloads as SDK shapes.
- [ ] **Step 4: Run the tests to verify they pass.** Run: `sfw pnpm --filter @nyx/server test tests/devnet/proxy.test.ts`. Expected: PASS (all five cases).
- [ ] **Step 5: Implement + test the WS relay** (per the decision block above): a session-gated upgrade handler per prefix that opens a server-side WS client to the target (`ws` package or the `@fastify/websocket` client side; derive `ws://` targets from `config.network.nodeUrl`/`indexerUrl`, with the indexer subpath `/api/v4/graphql/ws`), pipes frames verbatim both ways, and propagates close/error. Tests: unauthenticated upgrade rejected; frames relayed both directions against a local `ws` echo server; close propagation. Keep the relay transparent — never parse frames (constitution I).
- [ ] **Step 6: Register in `app.ts`** next to `registerProverRoutes` (`app.ts:296`), constructing two forwarders from `config.network.nodeUrl` / `config.network.indexerUrl`. Re-run the server test suite: `sfw pnpm --filter @nyx/server test`. Expected: PASS, no regressions.
- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/devnet apps/server/tests/devnet apps/server/src/app.ts
git commit -m "feat(server): same-origin devnet node/indexer forwarding routes"
```

---

### Task 2: Dev wallet signing core (web)

A pure, connector-independent module: seed → keypair → address, plus prefix-compatible signing. Uses the exact ledger-v8 recipe the server's own auth tests already proved by execution (`apps/server/tests/auth/helpers.ts:41-57`) — `sampleSigningKey()` / `signatureVerifyingKey()` / `addressFromKey()` / `signData(signingKey, bytes)` and the `midnight_signed_message:<byteLen>:` prefix from `apps/server/src/auth/verify.ts:46-53`.

**Files:**

- Create: `apps/web/src/wallet/dev-signer.ts`
- Test: `apps/web/tests/wallet/dev-signer.test.ts`
- Modify: `apps/web/package.json` (add `@midnight-ntwrk/ledger-v8`, `@midnight-ntwrk/wallet-sdk-address-format`)

**Interfaces:**

- Consumes: nothing from this repo (pure module).
- Produces: `generateDevSeed(): string` (a fresh ledger-v8 signing key — the "seed" IS the signing key hex; P5's keygen phase calls this), `createDevSigner(seed: string, network: string): DevSigner` where `DevSigner = { readonly verifyingKey: string; readonly address: string; sign(message: string): string }`. Task 3 (connector) and Task 5 (ceremony) consume `DevSigner`.
- **⚠️ Two derivations must be reconciled at implementation (SPIKE-2 §Funding + risk 6):** the ON-CHAIN wallet (P5 funding, Task 5 ceremony) is built by the wallet-sdk/testkit stack from a 32-byte hex seed (`MidnightWalletProvider.build(logger, env, seedHex)`), whose **unshielded keystore** provides `getBech32Address()`, `getPublicKey()`, and the `signData` used for `signRecipe`/dust registration. Verify by EXECUTION whether that keystore derivation from a seed equals ledger-v8 `signatureVerifyingKey(seed)`/`addressFromKey` (so one seed yields ONE identity for both SIWE and funds). If they diverge, prefer deriving the DevSigner from the wallet-sdk keystore (probing that its `signData` bytes verify under the server's `verifySignature` + `reconstructSignedBytes` recipe) so the SIWE session address IS the funded address; record the outcome in the retro. Never assume the two derivations agree.

- [ ] **Step 1: Verify package versions and browser/vitest loadability (constitution I).** Run `npm view @midnight-ntwrk/ledger-v8 version` and `npm view @midnight-ntwrk/wallet-sdk-address-format version` — pin what the server already uses (check `apps/server/package.json`; it has `ledger-v8@8.1.0` and `wallet-sdk-address-format@3.1.2` — use the SAME versions, do not bump). Add them with `sfw pnpm --filter @nyx/web add @midnight-ntwrk/ledger-v8@<pinned> @midnight-ntwrk/wallet-sdk-address-format@<pinned>`. Then READ the installed `.d.ts` for both packages under `apps/web/node_modules/` and record in a comment: the exact signatures of `sampleSigningKey`, `signatureVerifyingKey`, `signData`, `addressFromKey`, and whether `UnshieldedAddress`'s constructor accepts a `Uint8Array` (the server test passes a Node `Buffer`; the browser has none — if it demands `Buffer`, use a `Uint8Array` subclass shim ONLY if the `.d.ts` says `Buffer`, and verify by executing). ledger-v8 is ESM with sync WASM init and loads under vitest (proven in the server suite); the vite-bundle proof is Step 5.
- [ ] **Step 2: Write the failing test.** The test is the compatibility proof: it must verify with the SAME calls the server's `verify.ts` makes.

```typescript
// apps/web/tests/wallet/dev-signer.test.ts
import { addressFromKey, verifySignature } from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { describe, expect, it } from "vitest";
import {
  createDevSigner,
  generateDevSeed,
  reconstructSignedBytes,
} from "../../src/wallet/dev-signer";

describe("dev signer", () => {
  it("produces a signature the server-side verify recipe accepts", () => {
    const seed = generateDevSeed();
    const signer = createDevSigner(seed, "undeployed");
    const message = "nyx.example wants you to sign in.\n\nNonce: abc123";
    const signature = signer.sign(message);
    // EXACTLY what apps/server/src/auth/verify.ts:70-81 executes:
    expect(verifySignature(signer.verifyingKey, reconstructSignedBytes(message), signature)).toBe(
      true,
    );
  });

  it("binds address = SHA-256(verifyingKey) exactly as verifyKeyAddressBinding checks", () => {
    const signer = createDevSigner(generateDevSeed(), "undeployed");
    const fromKey = addressFromKey(signer.verifyingKey).toLowerCase();
    const parsed = MidnightBech32m.parse(signer.address);
    const decoded = parsed.decode(UnshieldedAddress, parsed.network);
    expect(decoded.hexString.toLowerCase()).toBe(fromKey);
  });

  it("is deterministic for a fixed seed", () => {
    const seed = generateDevSeed();
    const a = createDevSigner(seed, "undeployed");
    const b = createDevSigner(seed, "undeployed");
    expect(a.address).toBe(b.address);
    expect(a.verifyingKey).toBe(b.verifyingKey);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails.** Run: `sfw pnpm --filter @nyx/web test tests/wallet/dev-signer.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement `dev-signer.ts`.** Port `reconstructSignedBytes` from `apps/server/src/auth/verify.ts:46-53` verbatim (same prefix constant, same UTF-8 byte-length counting; a file-top comment records "mirrors apps/server/src/auth/verify.ts — the two must agree byte-for-byte, proven by tests/wallet/dev-signer.test.ts"). `generateDevSeed = () => sampleSigningKey()`. `createDevSigner(seed, network)`: `verifyingKey = signatureVerifyingKey(seed)`; `addressHex = addressFromKey(verifyingKey)`; encode with `MidnightBech32m.encode(network, new UnshieldedAddress(<hex→bytes>)).asString()` using a local `hexToBytes` (no `Buffer` in the browser — per the Step 1 `.d.ts` findings); `sign(message)` = `signData(seed, reconstructSignedBytes(message))`. The `network` segment for local-devnet addresses: start with the value the devnet/SDK uses — determine it by probing in Step 6, NOT from memory; the server's binding check decodes with the address's OWN network (`verify.ts:104-107`) so any self-consistent segment authenticates, but the tx path (Task 5) must match the chain's expectation.
- [ ] **Step 5: Run the test to verify it passes** (`sfw pnpm --filter @nyx/web test tests/wallet/dev-signer.test.ts`), then prove the web bundle builds with the wasm dep: `sfw pnpm --filter @nyx/web build`. Expected: PASS + a successful vite build (if vite chokes on the wasm, fix with vite config for the package — e.g. `optimizeDeps.exclude` — and record the exact config in the retro).
- [ ] **Step 6: Pin the address network segment (constitution I).** SPIKE-2 §C records the executed value: the funded devnet wallet's address is `mn_addr_undeployed1g9nr3mvjcey7ca8shcs5d4yjndcnmczf90rhv4nju7qqqlfg4ygs0t4ngm` — Bech32m network segment lowercase **`undeployed`** (Lace merely DISPLAYS "Undeployed"; the P1 retro confirms lowercase is the SDK/tx-path value). Confirm against the installed `wallet-sdk-address-format` enumeration, then record `export const DEV_WALLET_ADDRESS_NETWORK = "undeployed"` with a comment citing SPIKE2_REPORT.md §C. Do not re-derive from memory.
- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/wallet/dev-signer.ts apps/web/tests/wallet/dev-signer.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): dev wallet signing core with server-verified recipe"
```

---

### Task 3: Dev wallet connector (web)

Installs the connector-v4-shaped entry under `window.midnight.nyxDev` so the EXISTING detection/connect/SIWE stack runs unchanged. The shape must satisfy: `detect.ts` duck-typing (`connect` function → generation `v4`; `name`/`rdns` strings), `connect.ts:71-110` (`connect(networkId)` → api with `getConnectionStatus()` → `{status:"connected", networkId}`, `getUnshieldedAddress()` → `{unshieldedAddress}`), and `auth.ts:190` (`signData(message, {encoding:"text", keyType:"unshielded"})` → `{data, signature, verifyingKey}`).

**Files:**

- Create: `apps/web/src/wallet/dev-wallet.ts`
- Test: `apps/web/tests/wallet/dev-wallet.test.ts`
- Modify: the web entry point (find it: `grep -rn "createRoot\|render(" apps/web/src/main.tsx apps/web/src/*.tsx` — wire `maybeInstallDevWallet()` before the first render/detection)

**Interfaces:**

- Consumes: `DevSigner` / `createDevSigner` (Task 2); `EXPECTED_NETWORK_ID` from `apps/web/src/wallet/config.ts` (read it — the wrong-network gate compares EXACTLY, string `"Undeployed"`, case-sensitive).
- Produces: `installDevWallet(options: { seed: string; networkId: string })` (unconditional install, unit-testable), `maybeInstallDevWallet(): boolean` (env-gated: installs iff `VITE_DEV_WALLET === "1"` and `VITE_DEV_WALLET_SEED` is non-empty; returns whether it installed). The demo (P5) sets both vars in the generated `apps/web/.env.local`.

- [ ] **Step 1: Read the connector types.** Read the installed `@midnight-ntwrk/dapp-connector-api` `.d.ts` (under `apps/web/node_modules/`) and record in a comment the exact `InitialAPI`, `ConnectedAPI`, and `Signature` member signatures the mock must satisfy (the app imports these types today — `detect.ts:14`, `connect.ts:20`, `auth.ts:22` — so the mock must be assignable to them; list any members beyond `connect/getConnectionStatus/getUnshieldedAddress/signData` and implement them as honest rejections `Promise.reject(new Error("dev wallet: not implemented"))` rather than fake successes).
- [ ] **Step 2: Write the failing tests.** Cases: (a) `installDevWallet` → `discoverWallets()` (import from `../../src/wallet/detect`) reports one wallet, generation `"v4"`, name `"Nyx Dev Wallet"`; (b) `getConnectorEntry("nyxDev")` returns an entry whose `connect(networkId)` resolves to an api where `getConnectionStatus()` → `{status:"connected", networkId: "Undeployed"}` and `getUnshieldedAddress()` → the signer's address; (c) `signData(msg, {encoding:"text", keyType:"unshielded"})` resolves `{data: msg, signature, verifyingKey}` and the signature passes `verifySignature(verifyingKey, reconstructSignedBytes(msg), signature)`; (d) `maybeInstallDevWallet` returns `false` and installs nothing when the env flag is absent (stub `import.meta.env` the way existing web tests stub env — check `apps/web/tests/` for the established pattern, e.g. how `config.ts` consumers are tested); (e) full-stack proof: run `signIn` from `../../src/wallet/auth` against the installed dev wallet with a mocked `fetch` that captures the `/auth/verify` body, then assert `verifyMessageSignature`-equivalent checks pass on the captured `{message, signature, verifyingKey}` and the captured `address` equals the signer address (this is the end-to-end SIWE compatibility test — the dev wallet drives the REAL client flow and produces a body the REAL server predicate accepts).
- [ ] **Step 3: Run to verify failure.** Run: `sfw pnpm --filter @nyx/web test tests/wallet/dev-wallet.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `dev-wallet.ts`.** Install object: `{ name: "Nyx Dev Wallet", rdns: "network.nyx.devwallet", apiVersion: "4", connect: async (networkId) => connectedApi }` assigned to `(globalThis as { midnight?: Record<string, unknown> }).midnight ??= {}` under key `nyxDev`. The connected api holds the `DevSigner` in closure — the seed never leaves the module. `signData` REJECTS for `encoding !== "text"` or `keyType !== "unshielded"` (honest: the dev wallet only implements what Nyx uses). `maybeInstallDevWallet` reads env defensively (mirror `auth.ts:98-102` `readConfiguredBaseUrl` idiom) and pins `networkId` to `EXPECTED_NETWORK_ID`.
- [ ] **Step 5: Run to verify pass.** Run: `sfw pnpm --filter @nyx/web test tests/wallet/dev-wallet.test.ts`. Expected: PASS (all five).
- [ ] **Step 6: Wire the entry point** (`maybeInstallDevWallet()` before first render) and run the full web suite: `sfw pnpm --filter @nyx/web test`. Expected: PASS, no regressions (existing wallet tests must not see a phantom wallet — they construct their own fakes and never set the env flag).
- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/wallet/dev-wallet.ts apps/web/tests/wallet/dev-wallet.test.ts apps/web/src/main.tsx
git commit -m "feat(web): env-gated dev wallet connector for local demo"
```

---

### Task 4: Ceremony proving seam (web)

**SPIKE-2 resolved the shape (verdict block at the top of this plan):** the injection point is NOT "prove these opaque tx bytes" — it is the supported `Transaction.prove(provingProvider, CostModel.initialCostModel())` seam, where a `provingProvider` is the `{check, prove}` callback pair `@midnight-ntwrk/zkir-v2` exports as `provingProvider(keyMaterialProvider)`. Both routes share the same client-supplied key material (`{proverKey, verifierKey, ir}` per circuit, fetched same-origin from the new `/vault-artifacts/*` route — see the resolved key-material block below; SRS via the P2 `/srs/*` route). The two adapters:

- **Primary (wasm, in-browser):** `zkir.provingProvider(keyMaterialProvider)` — the exact wiring SPIKE-2 §D executed (23.6 s, finalized block 218). Run it in a Web Worker (proving budget ~23–26 s at k=13 must never block the UI).
- **Fallback (proof server):** `httpClientProofProvider(<same-origin prover proxy>, zkConfigProvider)` — SPIKE-2 §C (finalized block 201). ⚠️ **Discovered gap:** the existing proxy exposes ONLY `POST /prover/prove` (`apps/server/src/prover/proxy.ts:40` `PROVE_ROUTE`), but the modern proof-server protocol POSTs `/check` AND `/prove` per circuit. The fallback therefore needs the proxy extended to relay both subpaths (`POST /prover/*` → `<config.prover.url>/*`, same encapsulated child scope + `requireSession` + opaque byte relay + rate limiter) — a small server-side sub-task of this task; keep the relay transparent (constitution I).

**RESOLVED at P3 Task 0 (read from the merged code, not conditional any more):** `@nyx/compact-wasm` ships NO zkir/prover surface — `packages/compact-wasm/src/index.ts` exports only the compiler facade (`createCompiler`/`loadVendoredEngine`/`COMPACT_WASM_META`), and `vendor/` holds only `compactc.{js,wasm,data}`. So the zkir `provingProvider` wiring lands HERE, over the **published npm `@midnight-ntwrk/zkir-v2@2.1.0`** (the exact wasm SPIKE-2 §D executed; it exports `provingProvider(keyMaterialProvider)` → `{check, prove}`; NO `keygen` export — keygen stays gated, P2 retro). Add it to `apps/web` pinned at `2.1.0`.

**Key-material serving (resolved):** the NyxtVault `{proverKey, verifierKey, ir}` come from the native-toolchain compile at platform-setup time (verdict block; P5's vault phase produces `keys/` + `zkir/`). The vault is NOT a user project, so the `/artifacts/:projectId/:sourceHash/*` store prefix does not apply — clone the P2 `/srs/*` pattern instead (`apps/server/src/http/srs.ts`: session-less read-only static GET over a config dir with `isSafePath` + resolved-prefix containment, registered only when configured — `app.ts:208-211`): add `GET /vault-artifacts/*` over an optional `VAULT_ARTIFACTS_DIR` env (optional-with-no-default, same idiom as `SRS_CACHE_DIR`, `config/schema.ts:145`). P5's env generation points it at the vault build dir. SRS itself is already served at `GET /srs/*` when `SRS_CACHE_DIR` is set.

**Files:**

- Create: `apps/web/src/wallet/ceremony-prover.ts`
- Test: `apps/web/tests/wallet/ceremony-prover.test.ts`
- Modify: `apps/server/src/prover/proxy.ts` + `apps/server/tests/prover/` (the `/prover/*` subpath relay for the fallback — see above)
- Create: `apps/server/src/http/vault-artifacts.ts` + test (the `/vault-artifacts/*` serve route — clone `http/srs.ts` including its path-safety tests); modify `apps/server/src/config/schema.ts` (optional `VAULT_ARTIFACTS_DIR`) + `apps/server/src/app.ts` (conditional registration beside `registerSrsRoutes`)
- Modify: `apps/web/package.json` (add `@midnight-ntwrk/zkir-v2@2.1.0`)

**Interfaces:**

- Consumes: the published `@midnight-ntwrk/zkir-v2@2.1.0` `provingProvider` (verify its installed `.d.ts` before wiring — constitution I), the extended `/prover/*` proxy, the `/vault-artifacts/*` + `/srs/*` same-origin reads for key material + SRS.
- Produces: `interface CeremonyProverFactory { makeProvingProvider(keySource: CircuitKeySource): ProvingProviderLike }` where `ProvingProviderLike` is the `{check, prove}` pair `Transaction.prove` accepts (type it structurally from the installed `ledger-v8`/`zkir-v2` `.d.ts` — never from memory) and `CircuitKeySource` resolves `{proverKey, verifierKey, ir}` + SRS by circuit id; `createWasmCeremonyProver(deps)` (worker-hosted) and `createProxyCeremonyProver({fetch?, baseUrl?})`. Task 5 consumes the factory; a named `CeremonyProvingError` wraps failures.

- [ ] **Step 1: Write the failing tests.** For the proxy adapter (deterministic, always testable): relays check/prove payload bytes to the `/prover/*` routes with `credentials: "include"` and an opaque content-type, returns the response bytes, throws `CeremonyProvingError` on non-2xx or fetch throw (assert the error name + that the response body is not leaked into the message). For the wasm adapter: unit-test the orchestration (key-material resolution, worker round-trip, error surfacing) against a fake zkir module (the real wasm prove is covered by the `DEVNET_URL`-gated ceremony integration test in Task 5). Server side: the `/prover/*` relay tests mirror the existing prover route tests (401 gate, opaque relay, sibling-JSON-parser isolation).
- [ ] **Step 2: Run to verify failure**: `sfw pnpm --filter @nyx/web test tests/wallet/ceremony-prover.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement both adapters + the proxy subpath relay + the `/vault-artifacts/*` serve route.** Proxy adapter mirrors `auth.ts` transport idioms (injectable `fetch`/`baseUrl`). Wasm adapter wraps the published `@midnight-ntwrk/zkir-v2@2.1.0` `provingProvider` per its REAL installed exports (read the installed `.d.ts` first — constitution I). The serve route clones `http/srs.ts` byte-for-byte in structure (path safety, 400/404 mapping, conditional registration).
- [ ] **Step 4: Run to verify pass** (web + server suites). Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(web): ceremony proving seam with wasm and proxy adapters"`

---

### Task 5: Dev wallet top-up ceremony (web)

Fills `createOwnerGatedCeremony` (`topup.tsx:959`): build → prove → submit a NyxtVault `deposit(ref, amount)` transaction. The orchestration is deterministic and unit-tested over seams; the tx-build/submit recipe is SDK territory — constitution I gates it hard.

**Files:**

- Create: `apps/web/src/wallet/dev-ceremony.ts` (orchestration, seam-injected)
- Create: `apps/web/src/wallet/dev-ceremony-tx.ts` (the VERIFIED tx build/submit adapter)
- Test: `apps/web/tests/wallet/dev-ceremony.test.ts` (deterministic, fakes)
- Test: `apps/web/tests/wallet/dev-ceremony.devnet.test.ts` (`DEVNET_URL`-gated, `// @vitest-environment node`)
- Create: `apps/web/src/wallet/ceremony-select.ts` (env-gated ceremony selector — **verified at Task 0: `topup.tsx` has NO construction site to modify.** `TopUp(props)` receives its seams as props (`TopUpProps = UseTopUpOptions`, `topup.tsx:922`) and `createOwnerGatedCeremony` (`topup.tsx:959`) is a standalone export with no production caller — the ceremony is chosen wherever `TopUp` is MOUNTED, which is P6's TopUpModal. So P3 ships the selector; P6 consumes it. `topup.tsx` itself is NOT modified — the owner-gated stub remains for the non-dev path.)
- Modify: `apps/web/src/config.ts` (constitution-VII chokepoint: add the vault-address export read from `VITE_NYXT_VAULT_ADDRESS` — the ceremony takes it as an injected dep; P5's env generation writes the var. Currently NO vault var exists in `config.ts` — verified.)

**Interfaces:**

- Consumes: `CeremonyParams`/`CeremonyResult`/`DepositCeremony` (`topup.tsx:56-79` — resolve `{txRef}` on submitted; reject on decline/proving failure; never a false pending), `DevSigner` (Task 2), `CeremonyProver` (Task 4), `/devnet/node/*` (Task 1), the NyxtVault contract surface (`packages/nyxt-vault/src/nyxt-vault.compact`: `deposit(depositRef: Bytes<32>, amount: Uint<128>)`, guaranteed-phase; ref is 32 bytes hex from the store, `deposits.ts` `DEPOSIT_REF_BYTES = 32`).
- Produces: `createDevWalletCeremony(deps: DevCeremonyDeps): DepositCeremony` where `DevCeremonyDeps = { readonly signer: DevSigner; readonly prover: CeremonyProver; readonly buildTx: DepositTxBuilder; readonly submit: TxSubmitter }`, `DepositTxBuilder = (params: { depositRef: string; amount: bigint; contractAddress: string }) => Promise<{ unprovenTx: Uint8Array }>`, `TxSubmitter = (provenTx: Uint8Array) => Promise<{ txRef: string }>`. P6's top-up modal wiring consumes `createDevWalletCeremony`.

- [ ] **Step 1 (constitution I — GATE): assemble the verified tx recipe.** The executed, devnet-accepted recipe is in `SPIKE2_REPORT.md` and summarized in this plan's verdict block: pins `midnight-js-*@4.1.1` + `ledger-v8@8.1.0` + `testkit-js@4.1.1` + `zkir-v2@2.1.0` + `wallet-sdk@1.1.0` (discrepancy RESOLVED at Task 0 from the executed spike workspace — see the verdict block; testkit-js@4.1.1 declares it as an exact dep); `setNetworkId('undeployed')` (lowercase — capitalized is node rejection 1010/Custom 166); assembly via `midnight-js-contracts` `ContractCallPrototype`/`Transaction.fromPartsRandomized`; prove via `tx.prove(provingProvider, CostModel.initialCostModel())` (Task 4 factory); balance/sign/finalize via the wallet-sdk facade (`balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe`); submit via `wallet.submitTransaction` (node WS relay — through the Task 1 forwarding, never a direct devnet URL); observe via indexer `watchForTxData`. **The wallet's fee leg (DUST spend) is proven by the wallet's configured prover** — point it at the proof server via the Task 4 `/prover/*` proxy (or `wallet-sdk-prover-client` `WasmProver` if chosen; record which). The dev wallet must be NIGHT-funded + DUST-registered BEFORE the first ceremony (P5's funding phase / the spike fixture — §G). Then: (2) read the installed `.d.ts` of every package the recipe names; (3) if ANY step is still ambiguous, dispatch `midnight-verify` (`/midnight-verify:verify`) with the specific claim and wait for Confirmed before coding. Record the final recipe as a comment block at the top of `dev-ceremony-tx.ts` with citations (report section / verify transcript). DO NOT write `dev-ceremony-tx.ts` bodies before this step is complete.
- [ ] **Step 2: Write the failing deterministic tests** for `createDevWalletCeremony` orchestration with fake seams: (a) happy path — `buildTx` called with the exact `{depositRef, amount, contractAddress}`, its bytes go to `prover.prove`, proven bytes to `submit`, resolves `{txRef}`; (b) `prover` rejection → ceremony REJECTS with a named error (the topup state machine maps rejection to `ceremony-rejected`, `topup.tsx:121-125` — never resolve a false pending); (c) `submit` rejection → rejects; (d) amount is passed as `bigint` end-to-end and never stringified through `Number()` (assert `typeof amount === "bigint"` in the fake); (e) contract address comes from the injected config chokepoint value, not an env read inside the ceremony.
- [ ] **Step 3: Run to verify failure**: `sfw pnpm --filter @nyx/web test tests/wallet/dev-ceremony.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `dev-ceremony.ts`** (pure orchestration exactly as the interface block specifies — small, no SDK imports) and run to verify pass.
- [ ] **Step 5: Implement `dev-ceremony-tx.ts`** from the Step 1 verified recipe: `createDepositTxBuilder({contractAddress, signer, network})` and `createDevnetSubmitter({fetch?, baseUrl?})` (submits via `/devnet/node/*` forwarding route — never a direct devnet URL from the isolated page). Every SDK call must trace to the Step 1 recipe comment.
- [ ] **Step 6: Write + run the `DEVNET_URL`-gated integration test** (`dev-ceremony.devnet.test.ts`, node environment): against a running devnet (skip cleanly when `DEVNET_URL` unset, same idiom as `pg-deposits.test.ts:25-27`): fund/derive per the report's fixture guidance, run the REAL ceremony end-to-end against the deployed dev NyxtVault (address from env `NYXT_VAULT_ADDRESS`, provided by the P5 state or spike fixture), assert it resolves a `txRef` and the on-chain `deposits` map contains the ref (read back via the indexer, per the report's recipe). Run: `DEVNET_URL=… sfw pnpm --filter @nyx/web test tests/wallet/dev-ceremony.devnet.test.ts` with the devnet up (`sfw pnpm devnet:up` in another shell — or verify the P5 state exists). Expected: PASS live; SKIP without env.
- [ ] **Step 7: Implement + test the ceremony selector** (`ceremony-select.ts`, exported from the wallet barrel): `selectDepositCeremony(deps): DepositCeremony` — when the dev-wallet env gating is active (`VITE_DEV_WALLET === "1"`, read defensively per the `maybeInstallDevWallet` idiom), construct `createDevWalletCeremony` with the WASM prover as primary and the proxy prover as the designed fallback (SPIKE-2 verdict block) and the vault address from the `config.ts` chokepoint; otherwise return `createOwnerGatedCeremony()`. P6's TopUpModal mounts `TopUp` with this selector's result. **Proving-budget UX (SPIKE-2 risk 1):** the ~23–26 s prove must surface as an honest in-progress state in the topup state machine (read `topup.tsx`'s existing states — extend, don't bypass), run in the Task 4 Web Worker, and PREFETCH key material (prover key 2.8 MB + IR + SRS) when the modal opens rather than at prove time. **Serialize submissions per wallet** (SPIKE-2 risk 7): the ceremony must queue, never parallelize, submissions from the dev-wallet seed. Run the full web suite. Expected: PASS.
- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/wallet/dev-ceremony.ts apps/web/src/wallet/dev-ceremony-tx.ts apps/web/src/wallet/ceremony-select.ts apps/web/src/config.ts apps/web/tests/wallet
git commit -m "feat(web): dev wallet deposit ceremony with verified tx recipe"
```

---

### Task 6: `DepositStore.listOpenRefs` (server)

The observation adapter must know WHICH refs to watch. Add a narrow read to the existing store: refs in a watchable status (`preregistered`, `seen`) plus `expired` refs within a late-deposit grace window (D46/EC-30 — a deposit that lands after TTL still credits; `CREDITABLE_STATUSES` in `deposits.ts` already includes `expired`).

**Files:**

- Modify: `apps/server/src/ledger/deposits.ts` (interface + `PgDepositStore` + the in-memory double — find the double: `grep -n "class InMemoryDepositStore\|createInMemoryDepositStore" apps/server/src apps/server/tests -r`)
- Test: `apps/server/tests/ledger/deposits.test.ts` (extend), `apps/server/tests/ledger/pg-deposits.test.ts` (extend, `DATABASE_URL`-gated)

**Interfaces:**

- Consumes: existing `deposit_refs` table (no migration — statuses already exist).
- Produces: `listOpenRefs(graceMs: number): Promise<readonly OpenDepositRef[]>` on `DepositStore`, `OpenDepositRef = { readonly ref: string }`. Task 7 consumes it.

- [ ] **Step 1: Write the failing tests** (in-memory): preregistered ref listed; credited ref NOT listed; expired ref listed within `graceMs` of its `expiresAt`, not listed after; failed ref not listed. Mirror an existing `deposits.test.ts` describe block's setup style.
- [ ] **Step 2: Run to verify failure**: `sfw pnpm --filter @nyx/server test tests/ledger/deposits.test.ts`. Expected: FAIL (method missing).
- [ ] **Step 3: Implement** in both impls. Pg SQL shape: `SELECT ref FROM deposit_refs WHERE status IN ('preregistered','seen') OR (status = 'expired' AND expires_at > now() - ($1::bigint * interval '1 millisecond'))` — adapt to the real schema/columns (READ migration 0001/0002 for exact names first). DB clock decides, never the process clock (auth-store precedent).
- [ ] **Step 4: Run to verify pass**, then extend + run the pg-gated test if `DATABASE_URL` is available locally: `DATABASE_URL=… sfw pnpm --filter @nyx/server test tests/ledger/pg-deposits.test.ts`.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): list open deposit refs for observation polling"`

---

### Task 7: Indexer observation adapter + poller (server)

The keepable production piece: poll the devnet indexer for the open refs, map finalized on-chain deposits to `DepositObservation`, feed `observeFinalized`, and surface `credited`/`failed` outcomes to a sink (index.ts wires the sink to the WS `ledger:update` push in Task 8).

**Files:**

- Create: `apps/server/src/ledger/indexer-observation.ts`
- Test: `apps/server/tests/ledger/indexer-observation.test.ts` (deterministic, fake indexer)
- Test: `apps/server/tests/ledger/indexer-observation.devnet.test.ts` (`DEVNET_URL`-gated)

**Interfaces:**

- Consumes: `DepositStore.observeFinalized` + `listOpenRefs` (`deposits.ts`; `CreditOutcome` union), `DepositObservation` (`deposits.ts:83` — narrow Nyx-internal shape, NOT an indexer type), the scheduler idiom from `ledger/reconcile-scheduler.ts` (generation guard, injected `schedule`, serial ticks, a tick error never kills the loop).
- Produces: `interface DepositIndexerQuery { findDeposits(refs: readonly string[]): Promise<readonly DepositObservation[]> }` (the narrow seam; real impl `createDevnetDepositIndexerQuery({indexerUrl, fetch?})`); `createObservationPoller(deps: ObservationPollerDeps): ObservationPoller` (`start()`/`stop()`), `ObservationPollerDeps = { store: Pick<DepositStore, "observeFinalized" | "listOpenRefs">; query: DepositIndexerQuery; intervalMs: number; graceMs: number; onOutcome?: (outcome: CreditOutcome) => void; onError?: (error: unknown) => void; schedule?: (fn: () => void, ms: number) => () => void }`. Task 8 wires it; P6's ledger UI depends on the `onOutcome`→`ledger:update` push.

- [ ] **Step 1: Write the failing poller tests** (fake `query`, fake store, injected `schedule` driven manually): (a) each tick lists open refs and queries only those; zero open refs → no query call; (b) a finalized success observation is passed to `observeFinalized` verbatim and the `credited` outcome reaches `onOutcome`; (c) an unfinalized observation still goes to the store (the store ignores it — that classification is the store's job, don't duplicate it); (d) a query rejection → `onError`, poller keeps ticking (next scheduled tick still fires); (e) `stop()` cancels the pending tick and an in-flight tick cannot re-arm after `stop()` (generation guard — copy the `reconcile-scheduler.ts:99+` pattern); (f) ticks are serial: the next tick is armed only after the current tick's store calls settle.
- [ ] **Step 2: Run to verify failure**: `sfw pnpm --filter @nyx/server test tests/ledger/indexer-observation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `createObservationPoller`** per the interface block (small; mirror the reconcile-scheduler's `running`/`generation`/`clearPending` internals — read it before writing).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5 (constitution I — GATE): verify the indexer query recipe.** The devnet indexer is `indexer-standalone:4.2.1`, GraphQL at `/api/v4/graphql` on :8088 (**WS subscriptions at `/api/v4/graphql/ws` — the http path 405s**; SPIKE-1 risk 7). Recorded prior art (start here): SPIKE-1 §5 confirmed on-chain state via raw indexer GraphQL + the generated `ledger()` decode; SPIKE-2 §C/§D used `contractAction(address)` (returns the `ContractCall` with tx hash/height) plus `watchForTxData(txId)`, and decoded the on-chain `deposits.lookup(ref)` from contract state. The exact query for "deposits for these refs, with finality" must still come from evidence, not memory: (1) reread those report sections; (2) read the reconcile watermark adapter if P1/P2 built one; (3) probe the live devnet indexer's GraphQL schema via introspection (`DEVNET_URL` running) and/or dispatch `midnight-verify` for the claim. Record the verified query + response mapping as the comment header of `createDevnetDepositIndexerQuery`. The mapping produces `DepositObservation` fields: `ref` (from the contract's `deposits` map key / call args), `amount` (ON-CHAIN amount as `bigint` — parse from string, never `Number()`), `txRef`, `outcome`, `finalized` (at/after the indexer's finality signal — pin what "finalized" means from the verified schema).
- [ ] **Step 6: Implement `createDevnetDepositIndexerQuery`** with an injectable `fetch`; deterministic tests use a fake `fetch` returning canned GraphQL responses copied VERBATIM from the Step 5 probe (fixtures cite their capture in a comment). Failure = rejection (`IndexerUnavailableError`), a well-formed "no results" = empty array.
- [ ] **Step 7: Write + run the `DEVNET_URL`-gated integration test**: with the devnet up and a deposit landed (reuse the Task 5 devnet test's deposit, or drive one via the report's fixture), assert `findDeposits([ref])` returns a finalized success observation with the on-chain amount. Run: `DEVNET_URL=… sfw pnpm --filter @nyx/server test tests/ledger/indexer-observation.devnet.test.ts`. Expected: PASS live; SKIP without env.
- [ ] **Step 8: Commit.** `git commit -m "feat(server): indexer deposit observation adapter and poller"`

---

### Task 8: Boot wiring + `ledger:update` push + deposit logger (server)

**Files:**

- Modify: `apps/server/src/index.ts` (construct + start the poller; wire the outcome sink to the WS ledger push; inject the real `DepositLogger`)
- Test: extend an existing boot/wiring test if one covers `index.ts` construction (check `apps/server/tests/foundation.test.ts` + `tests/turn/`); otherwise cover the sink-mapping helper with a unit test in `apps/server/tests/ledger/indexer-observation.test.ts`

**Interfaces:**

- Consumes: `createObservationPoller` (Task 7), `encodeLedgerUpdateEvent` from `@nyx/protocol` (`packages/protocol/src/events.ts:264`; bigint→string on the wire — NEVER a raw payload), the WS layer's existing emit surface — verified pointers: `apps/server/src/protocol/registry.ts` (`createSessionRegistry`/`sessionKey(accountAddress, projectId)` — connections are keyed by account+project, so routing a `credited` outcome's `address` to that account's connections means iterating the registry by address) and `apps/server/src/protocol/router.ts:151` (`sendEvent(socket, event)`); READ how `apps/server/src/ws/index.ts` + the coordinator's emit closures use them before wiring.
- Produces: a running poller at boot (interval from a new `config.tunables` entry `depositPollIntervalMs`, default 5000 — add to `config/schema.ts` as an OPTIONAL var with default so no test fixture breaks; grace from `depositRefTtlMs`).

- [ ] **Step 1: Add `DEPOSIT_POLL_INTERVAL_MS` (optional, default 5000)** to `config/schema.ts` following an existing optional tunable's exact idiom; extend the config test that enumerates tunables (find it in `apps/server/tests/config/`). Run config tests: expected PASS.
- [ ] **Step 2: Write the sink-mapping test**: a `credited` outcome maps to exactly one encoded `ledger:update` frame for the outcome's `address` (assert the encode helper was used — amounts are STRINGS on the frame), `failed` maps to the deposit-scoped failure signal the topup subscription expects (`DepositUpdate` in `topup.tsx:93-95`; if the server side lacks that event today, route it per the WS layer's existing deposit/failure convention — READ first, and if genuinely absent, add the minimal event to `@nyx/protocol` mirroring an existing S→C event's schema + encode-helper pattern), and `orphaned`/`already-credited`/`ignored-unfinalized` map to NO frame (logged only).
- [ ] **Step 3: Implement the wiring in `index.ts`**: construct `createDevnetDepositIndexerQuery({indexerUrl: config.network.indexerUrl})`, `createObservationPoller({store: depositStore, query, intervalMs: config.tunables.depositPollIntervalMs, graceMs: config.tunables.depositRefTtlMs, onOutcome, onError: log})`, `poller.start()` after listen, `poller.stop()` on shutdown (mirror how the reconcile scheduler is started/stopped in `index.ts` — read that region and copy its lifecycle handling). Also: pass `logger: app.log`-backed `DepositLogger` into `createDepositStore` (closes the known silent-no-op gap — EC-28 warnings become loud).
- [ ] **Step 4: Run the full server suite**: `sfw pnpm --filter @nyx/server test`. Expected: PASS, no regressions.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): wire deposit observation poller and ledger update push"`

---

### Task 9: Full gates + review loop

- [ ] **Step 1:** `sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test` from the repo root. Fix everything; zero warnings.
- [ ] **Step 2:** Dispatch the code-reviewer subagent over `git diff main...HEAD`. Money-path scrutiny is the review brief: cross-tenant delivery (the `ledger:update` push must go ONLY to the outcome's address), false-pending in the ceremony, `Number()` on any amount, secrets (the seed) in logs. Fix → re-review until clean.

### Task 10: Retro + PR + merge + next plan

- [ ] **Step 1:** Write `docs/superpowers/plans/retros/P3_RETRO.md` per the Retro section (deviations, verified discoveries — especially the pinned address network, the tx recipe citations, the indexer query schema — deferred items, impact on P4–P6). Commit: `git commit -m "docs: p3 retro"`.
- [ ] **Step 2:** Push, open the PR (`gh pr create`), watch CI (`gh pr checks --watch`), fix until green, `gh pr merge --merge --delete-branch`.
- [ ] **Step 3:** `git checkout main && git pull`, open `docs/superpowers/plans/2026-07-23-p4-deploy-engine.md`, and begin at its Task 0. Do not pause.
