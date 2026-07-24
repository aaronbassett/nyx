# P4 — Deploy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the already-built, already-tested deploy pipeline a real engine: a devnet `DeployExecutor` (prove via the :6300 proof server, sign with the server deploy key, submit to node :9944, await finality via the indexer), a real deploy-wallet tDUST `BalanceQuery`, and the scaffold guidance so generated preview DApps sign/submit their own transactions with the dev wallet seed.

**Architecture:** Body-only swaps of designed seams. `createDevnetDeployExecutor` implements the existing `DeployExecutor` interface (`apps/server/src/deploy/pipeline.ts` — `prove → signAndSubmit → awaitFinality`, all outcomes-as-data); the pipeline's exactly-once/never-reject machinery is untouched. Internally the executor splits SDK calls behind three private seams so classification logic (EC-38 tDUST shortfall, EC-39 bounded finality, SC-029 reorg) is deterministically unit-tested with fakes, while the verified SDK adapter is exercised by a `DEVNET_URL`-gated real deploy round-trip. Artifacts come from the P2 `ArtifactStore` (the `urlPrefix` now resolves locally).

**Tech Stack:** TypeScript/Node ≥22, Fastify 5, vitest, Midnight SDK at the SPIKE-proven version matrix (**`midnight-js-*@4.1.1`, `ledger-v8@8.1.0`, `compact-runtime@0.16.0`, `onchain-runtime-v3@3.0.0`, `testkit-js@4.1.1` patterns; **wallet-sdk 1.1.0 — the 1.0.0-vs-1.1.0 report discrepancy was resolved at P3 Task 0 from the executed SPIKE-2 workspace on disk: testkit-js@4.1.1 declares the EXACT dep `wallet-sdk@1.1.0` and Node resolution means the executed wallet legs ran 1.1.0 (the top-level 1.0.0 was shadowed)** — zero drift vs the devnet; every shape still verification-gated at use**), devnet (node `0.22.5` :9944, indexer `4.2.1` :8088, proof-server `8.1.0` :6300), `@nyx/scaffold` steering.

**SPIKE facts folded in (Task 0, 2026-07-23, re-verified post-P3 at P4 Task 0 2026-07-24):** the tx-encoding network id is lowercase **`undeployed`** (`setNetworkId('undeployed')`; capitalized → node rejection 1010/Custom 166 — SPIKE-1 risk 7/P1 retro; P3 additionally pins that the Bech32m address segment is lowercase `undeployed` while the connector-reported `networkId` display string is `Undeployed` — never compare the tx path against the display string). **Verifier keys ship INSIDE the deploy**: a deploy wraps `new ContractDeploy(contractState)` (verifier keys inside `ContractState`, sourced from the client-supplied zkConfig — `NodeZkConfigProvider`-style over `keys/<c>.prover|.verifier` + `zkir/<c>.bzkir`, exactly the ArtifactStore prefix layout) in an `Intent` (SPIKE-2 §What-a-tx-needs + §C: deploy with 0.31.1-compiled verifier keys finalized in 17.8 s). Executed deploy prior art: SPIKE-1 §5 (counter deploy + `increment()` call, both `SucceedEntirely`, proof via the local proof server from wasm-produced keys) and SPIKE-2 §C/§F. `getLatestGreenBuild` is now REAL (P1: store method + migration 0005; wired at `index.ts:303` as of post-P3 main — the anchor moves with each phase's boot wiring) — the greenness gate reads real rows, the stub is gone; the recorded `urlPrefix` is the ABSOLUTE `${publicOrigin}/artifacts/<projectId>/<sourceHash>` (no trailing slash, built at `compile/browser-client.ts:157`). Serialize submissions from the ONE deploy wallet (per-wallet UTXO races observed — SPIKE-2 risk 7; P3 shipped the WEB-side `serializeSubmissions` for the user wallet — the server needs its OWN mutex, Task 2 Step 3); fees are DUST accrued from registered NIGHT, and the deploy wallet must be funded + dust-registered by P5's setup (SPIKE-2 §Funding). **P3-merged carry-ins:** the verified indexer GraphQL pattern is IN-REPO at `apps/server/src/ledger/indexer-observation.ts` (bound-variable `contractAction(address: $addr)` POST to `INDEXER_GRAPHQL_PATH = "/api/v4/graphql"`, `IndexerUnavailableError` on transport/GraphQL faults — reuse this pattern for the deploy finality query, do not reinvent); the prover seam method is `ProverClient.relay(request)`, NOT `prove` (Task 2 Consumes); the on-chain deposits-map decode is still owner-gated behind the injectable `DepositsStateReader` (`readDepositsState` deliberately omitted at `index.ts:402-405` → `DepositIndexerNotWiredError` each poll tick) and shares THIS plan's SDK-install boundary (P3 retro: "the same boundary as the deploy executor") — un-gated here in Task 3b so the demo's deposit crediting works.

## Global Constraints

- Host-side commands are ALWAYS `sfw pnpm …` — never bare `pnpm`, never `npm`. The ONLY npm in this plan is the text of the scaffold steering rule telling agents that generated DApps inside the WebContainer use plain `npm`.
- Warnings are errors: `eslint --max-warnings 0`, TS strict, prettier clean. A warning blocks the commit.
- Conventional commits, lowercase subject, header ≤72 chars (commitlint enforces). Never `--no-verify`.
- Constitution I: NEVER hand-write Compact/`@midnight-ntwrk/*` shapes from memory — deploy building, tx submission, finality queries, and balance reads are ALL verification-gated below. Compilation is not proof; execution is.
- Constitution III / D50: the deploy key (`config.secrets.deployKey`) flows ONLY into the executor deps (`signingKey`), never into logs, errors, frames, or any client-bound surface. The SC-031 audit greps for the key field name at the construction site (`index.ts`) and under `src/deploy/` — keep it that way.
- Deploys are money: EC-38 shortfall is a PLATFORM fault surfaced as such; `contract:deployed` is emitted exactly once, only on finality; `recordDeploy` idempotency by `tx_ref` is load-bearing — never bypass the pipeline.
- Deployed contracts are permanent (T155): no on-chain teardown anywhere in this plan.
- Seam pattern: interface + real impl + fake double, injected clock, promise-rejection failures, env-gated live tests (`DATABASE_URL` — gate idiom `apps/server/tests/ledger/pg-deposits.test.ts:25-27`; `DEVNET_URL` — the P3-established idiom is IN-REPO at `apps/server/tests/ledger/indexer-observation.devnet.test.ts:26-29`, `describe.skipIf(!runLive)`).

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p4-deploy-engine` off up-to-date `main` before the first task.

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
5. **Immediately** check out `main`, pull, open the next plan (`docs/superpowers/plans/2026-07-23-p5-demo-orchestrator.md`), and begin it — starting with its Task 0 re-planning preamble. Do not pause between plans.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- Executor/adapter/wiring TypeScript tasks: `devs:typescript-dev`.
- The `deploy/sdk-recipe.md` evidence gate and every constitution-I step (deploy SDK shapes, finality semantics, tDUST balance query, EC-38 error-shape probe): the `midnight-verify:verify` skill / `midnight-verify:*` agents (`sdk-tester` against the live devnet).
- Scaffold steering-rule tasks: `devs:typescript-dev`; any Compact snippet inside steering text must be `compact-core:compact-dev`-authored + verified.
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches.

**Model routing — which model runs what:**

- Implementation dispatches (`devs:typescript-dev`, `compact-core:compact-dev`) and `midnight-verify:*` verification dispatches run on **Opus**: pass `model: "opus"` in the Agent call.
- Review dispatches (`devs:code-reviewer`) run on **Opus** by default. **Deploys spend real funds and hold the deploy key**: the final pre-PR review of the executor/signing/SC-031 surfaces runs on **Fable 5**. Also escalate any finding still disputed after one fix loop.
- **Fable 5 is reserved** for the orchestrating session itself, the Task 0 re-planning subagent, and the deploy-key/signing review above. Never run routine implementation on Fable.

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

Write `docs/superpowers/plans/retros/P4_RETRO.md` before opening the PR. Contents, in detail:

- **Deviations** from this plan: what changed, why, and the evidence that forced it.
- **Discoveries**: verified facts (SDK shapes, tool behaviors, version constraints) that future plans must know — be specific, include exact names/versions.
- **Deferred items** (should be none): each with justification per the No-Deferral Policy.
- **Impact on remaining plans**: which upcoming tasks are now wrong/obsolete/missing, so the next plan's re-planning preamble can act on it.

---

### Task 0: Re-planning preamble

- [ ] **Step 1: Dispatch a Fable 5 re-planning subagent.** Use the Agent tool (the session model is Fable 5; do not downgrade the model for this dispatch). Give it: this plan file's path, all remaining plan files' paths (`2026-07-23-p5-demo-orchestrator.md`, `2026-07-23-p6-ui-workspace.md`), the design doc (`docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md`), every `docs/superpowers/plans/retros/*_RETRO.md` **including `SPIKE1_REPORT.md`, `SPIKE2_REPORT.md`, and `P3_RETRO.md`**, and instructions to inspect `git log --oneline` since the plans were authored plus the current state of the files each plan touches. Its job: reconcile this plan and all remaining plans with reality — completed/obsolete tasks removed, interface drift corrected (exact names/signatures from the code as it now exists — especially the P2 `ArtifactStore` surface and P3's devnet forwarding + verified SDK recipes), retro discoveries folded in, missing tasks added. **For THIS plan specifically it must fold in: (a) SPIKE-1's pinned SDK package set + deploy recipe, (b) P3's verified tx-submit + indexer query recipes (the executor reuses them), (c) whether P1 wired `getLatestGreenBuild` into `index.ts` or only added the store method.** It edits the plan files directly.
- [ ] **Step 2: Review the subagent's plan edits** (`git diff` on `docs/superpowers/plans/`). You are accountable for the updated plan — sanity-check that edits are grounded in retros/code, not speculation.
- [ ] **Step 3: Commit** the updated plans: `git commit -m "docs: re-plan p4+ from retros and current state"`.
- [ ] **Step 4: Execute THIS plan as amended.**

---

### Task 1: Verified deploy recipe (constitution I — GATE for Tasks 2–3)

No executor code is written until the deploy recipe is evidence-backed end to end.

**Files:**

- Create: `apps/server/src/deploy/sdk-recipe.md` (the recipe record — committed, cited by code comments)

**Interfaces:**

- Produces: the pinned recipe document Tasks 2–3 code against: exact `@midnight-ntwrk/*` packages + versions, the deploy-build call sequence from compiled artifacts, the proving payload/response contract against proof-server `8.1.0`, the signed-submit call against node `0.22.5`, the finality query against indexer `4.2.1` including the finality/reorg-depth signal (SC-029), and the tDUST balance read for an unshielded account.

- [ ] **Step 1: Collect existing evidence.** Read, in order: `docs/superpowers/plans/retros/SPIKE1_REPORT.md` §5 (counter + NyxtVault deployed on this devnet via `midnight-js@4.1.1` + `NodeZkConfigProvider` — the closest prior art; pins build + prove + submit), `SPIKE2_REPORT.md` §C/§F + §What-a-tx-needs (deploy = `new ContractDeploy(contractState)` in an `Intent`, verifier keys from zkConfig; wallet facade `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe` → `submitTransaction`; indexer `watchForTxData`/`contractAction`; DUST/NIGHT balance reads: `state.dust.balance(new Date())` — time-dependent — and `state.unshielded.balances[unshieldedToken().raw]`) + `P3_RETRO.md` (verified submit + indexer recipes as MERGED), and the MERGED P3 indexer adapter `apps/server/src/ledger/indexer-observation.ts` (the executed-and-shipped `contractAction` GraphQL query with source-verified variable types, plus the `queryContractState` + `mod.ledger(state.data)` decode recipe in its `DepositsStateReader` docblock, `indexer-observation.ts:212-240`). There is NO vault bootstrap / `infra/demo/` yet (P5 territory — grep-verified at Task 0). List which of the five recipe elements (build, prove, sign+submit, finality, balance) each source pins. Elements the spikes did NOT pin and Step 2 must: the SC-029 "finalized strictly past reorg depth" signal (the spikes observed `SucceedEntirely` + block inclusion only) and the EC-38 out-of-funds error shape.
- [ ] **Step 2: Fill the gaps with verification, not memory.** For each unpinned element: read the installed `.d.ts` of the candidate SDK packages (install what SPIKE-1 pinned: `sfw pnpm --filter @nyx/server add <pkg>@<spike-pinned>` — versions from the report or `npm view <pkg> version`, never memory), and dispatch `midnight-verify` (`/midnight-verify:verify`) with the concrete claim (e.g. "this sequence deploys a compiled contract to devnet node 0.22.5 and returns a contract address"; "this indexer query reports a tx finalized strictly past reorg depth"). An element is pinned only when Confirmed by execution.
- [ ] **Step 3: Write `sdk-recipe.md`**: the five elements, each with its call sequence, package@version, and evidence citation (report section / verify transcript id). Include the EC-38 discriminator: the exact node error shape that means "fee wallet out of tDUST" (probe it live if no source pins it — submit from an unfunded key on the devnet and record the error verbatim).
- [ ] **Step 4: Commit.** `git commit -m "docs(server): verified devnet deploy recipe"`

---

### Task 2: `createDevnetDeployExecutor` (server)

**Files:**

- Create: `apps/server/src/deploy/devnet-executor.ts` (classification/orchestration over three private seams)
- Create: `apps/server/src/deploy/sdk-adapter.ts` (the verified SDK calls — every line traces to `sdk-recipe.md`)
- Test: `apps/server/tests/deploy/devnet-executor.test.ts` (deterministic, fake seams)
- Test: `apps/server/tests/deploy/devnet-executor.devnet.test.ts` (`DEVNET_URL`-gated real round-trip)

There is NO `apps/server/src/deploy/index.ts` barrel (verified at P4 Task 0 — boot imports each deploy module directly, `index.ts:23-28`). Export the new factory from its own module; Task 4 imports it directly. Keep `createOwnerGatedDeployExecutor` exported from `executor.ts` — tests (incl. `tests/deploy/exposure.test.ts`) use it.

**Interfaces:**

- Consumes: `DeployExecutor` / `DeployArtifacts` / `DeployProof` / `ProveOutcome` / `SubmitOutcome` / `DeployFinality` / `FinalityRequest` (`pipeline.ts:71-143` — READ them; outcomes are DATA, `insufficient-tdust` vs `rejected` per `SubmitRejectionCause`), `ProverClient` (`prover/proxy.ts:78-86` — the seam method is **`relay(request: ProxyRequest): Promise<ProxyResult>`**, NOT `prove`; `ProxyRequest = { subpath ("check"|"prove"), body: Buffer, contentType }` at `:54-66`, `ProxyResult = { status, body: Buffer, contentType }` at `:68-75`; a transport fault REJECTS `ProverUnavailableError`, any prover HTTP status RESOLVES as data), `NetworkProfile` (`config/network.ts:18`), the P2 `ArtifactStore` (re-verified at P4 Task 0: `apps/server/src/artifacts/store.ts:52-80` — `putFile`/`commit`/`getManifest`/`getFile`/`sweepStaged`, manifest-last commit semantics; the executor is a pure READER and uses only `getManifest(projectId, sourceHash)` + `getFile(projectId, sourceHash, path)`; the public GET route shape it inverts is `/artifacts/:projectId/:sourceHash/*`, `artifacts/routes.ts:193-194`).
- Produces: `createDevnetDeployExecutor(deps: DevnetDeployExecutorDeps): DeployExecutor` where `DevnetDeployExecutorDeps = { readonly signingKey: string; readonly network: NetworkProfile; readonly proverClient: ProverClient; readonly artifacts: ArtifactStore; readonly sdk?: DeploySdk }` and `DeploySdk = { buildDeploy(input: { files: DeployFileSet; signingKey: string; network: NetworkProfile }): Promise<{ unprovenDeploy: Uint8Array }>; submit(input: { provenDeploy: Uint8Array; nodeUrl: string }): Promise<{ txRef: string }>; queryFinality(input: { txRef: string; indexerUrl: string }): Promise<"finalized-with-address" | …>; }` — pin `DeploySdk`'s EXACT member signatures to what `sdk-recipe.md` needs (the sketch here fixes the seam idea, not the final field list; the finality member must return the address on success). `sdk?` defaults to the real `sdk-adapter.ts` implementation; tests inject fakes. Also `parseArtifactUrlPrefix(urlPrefix: string): { projectId: string; sourceHash: string }` (exported; the recorded green-build `urlPrefix` is the ABSOLUTE `${publicOrigin}/artifacts/<projectId>/<sourceHash>` with NO trailing slash — built at `compile/browser-client.ts:157` — so parse the URL path, not a bare prefix string). Task 4 wires the factory in `index.ts`.

- [ ] **Step 1: Write the failing deterministic tests** with a fake `DeploySdk` + in-memory `ArtifactStore`: (a) `prove` loads the manifest + every artifact file for the `urlPrefix`, hands them to `sdk.buildDeploy`, relays the proving payload via `proverClient.relay({ subpath: "prove", body, contentType })` (the seam's real method — `check`/`prove` are subpaths, `proxy.ts:54-66`), and resolves `{outcome:"proved", proof}` with the prover's bytes; a prover non-2xx `ProxyResult` → `{outcome:"failed", reason}` (reason mentions the status, never dumps the body); a `ProverUnavailableError` rejection → `{outcome:"failed"}` (data, not a throw — the pipeline depends on it); a missing manifest → `{outcome:"failed", reason:"artifacts missing"}`; (b) `signAndSubmit` → `{outcome:"submitted", txRef}` on success; the EC-38 discriminator error (fake throws the recipe-recorded shape) → `{outcome:"rejected", cause:"insufficient-tdust"}`; any other node rejection → `cause:"rejected"`; (c) `awaitFinality` polls `sdk.queryFinality` with an injected `delay` + `now` until finalized (→ `{outcome:"finalized", address}`), maps rolled-back → `failed`, reorg → `reorged`, and STOPS at `timeoutMs` → `{outcome:"timeout"}` (assert no further polls after the deadline — EC-39 bounded, never unbounded); (d) the signing key NEVER appears in any outcome, reason string, or thrown error (assert with a canary key value searched across all outputs — the SC-031 discipline); (e) `parseArtifactUrlPrefix` round-trips the P2 prefix shape and rejects malformed prefixes.
- [ ] **Step 2: Run to verify failure**: `sfw pnpm --filter @nyx/server test tests/deploy/devnet-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `devnet-executor.ts`** (orchestration + classification only — zero `@midnight-ntwrk` imports in this file; injected `delay`/`now` defaulting like `pipeline.ts` does — read its `DeployPipelineDeps` defaults and mirror). **Serialize `signAndSubmit` process-wide** (a simple promise-chain mutex over the one deploy wallet): the pipeline's one-in-flight invariant is PER PROJECT, but concurrent projects share the deploy wallet and per-wallet concurrent submissions race UTXO state (SPIKE-2 risk 7). Add a deterministic test: two concurrent deploys' submits are observed strictly sequentially.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Implement `sdk-adapter.ts`** from `sdk-recipe.md` (this is the only file that imports the SDK; every call cites its recipe element in a comment). Include the EC-38 error-shape discriminator function with its probed evidence.
- [ ] **Step 6: Write + run the `DEVNET_URL`-gated round-trip test** (`devnet-executor.devnet.test.ts`): skip cleanly without env; with the devnet up: seed a real compiled contract's artifacts into a local `ArtifactStore` fixture (use the SPIKE-1 artifact bundle recorded in its report, or compile `packages/nyxt-vault` with the compact CLI when `command -v compact` — mirror the nyxt-vault package's own guard idiom), run `prove → signAndSubmit → awaitFinality` with a funded key — P5 has NOT run yet, so use a genesis seed per SPIKE-2 §Funding (seeds `0x…01`–`0x…04` each hold 250e12 NIGHT pre-dust-registered; the spikes used `…01`/`…03` — pick `…02` or `…04` to respect seed partitioning), and assert `{outcome:"finalized", address}` with a nonempty address. Run: `DEVNET_URL=… sfw pnpm --filter @nyx/server test tests/deploy/devnet-executor.devnet.test.ts`. Expected: PASS live; SKIP without env. This deploy spends devnet-only tDUST — it is the Independent Test for this task.
- [ ] **Step 7: Commit.**

```bash
git add apps/server/src/deploy apps/server/tests/deploy
git commit -m "feat(server): real devnet deploy executor behind verified sdk adapter"
```

---

### Task 3: Real deploy-wallet `BalanceQuery` (server)

**Files:**

- Create: `apps/server/src/deploy/balance.ts`
- Test: `apps/server/tests/deploy/balance.test.ts` (fake fetch/sdk) + a `DEVNET_URL`-gated case in `devnet-executor.devnet.test.ts` (funded key → positive balance)

**Interfaces:**

- Consumes: `BalanceQuery = () => Promise<bigint>` (`deploy/wallet.ts:43` — base units; a rejection is the loud "unavailable" that makes `assertCanDeploy` fail closed), the `sdk-recipe.md` balance element. SPIKE-2 §Funding pins the executed read shapes: fee-paying balance is DUST — `state.dust.balance(new Date())` (TIME-DEPENDENT: DUST accrues from registered NIGHT, so inject the clock) — and NIGHT is `state.unshielded.balances[unshieldedToken().raw]`; verify which one `assertCanDeploy`'s floor should gate on in the recipe (fees are spent in DUST).
- Produces: `createDevnetBalanceQuery(deps: { readonly network: NetworkProfile; readonly signingKey: string; readonly sdk?: BalanceSdk }): BalanceQuery` (derives the deploy wallet's address from the key per the recipe; `BalanceSdk` seam pinned to the recipe's balance call). Task 4 wires it.

- [ ] **Step 1: Write the failing tests**: resolves the fake sdk's balance as `bigint` (feed a value > 2^63 to prove no `Number()` truncation — assert exact `bigint` equality); an sdk rejection propagates as a rejection (fail-closed — NEVER resolve 0 on error: a zero balance means "exhausted", an error means "unknown", and `classifyBalance` (`wallet.ts:159`) must not conflate them); the signing key never appears in the rejection.
- [ ] **Step 2: Run to verify failure**, implement per the recipe (adapter split as in Task 2), run to verify pass.
- [ ] **Step 3: Extend the devnet-gated test**: funded demo key → balance > 0n.
- [ ] **Step 4: Commit.** `git commit -m "feat(server): real deploy wallet tdust balance query"`

---

### Task 3b: Real `DepositsStateReader` — un-gate the P3 deposit-observation decode (server)

**Added at P4 Task 0 (2026-07-24), grounded in the P3 retro + merged code:** the P3 deposit-observation poller is armed but gated — `createDevnetDepositIndexerQuery` takes an optional `readDepositsState?: DepositsStateReader` and, when omitted (as boot omits it today, `index.ts:402-405`), `findDeposits` rejects `DepositIndexerNotWiredError` on every tick with on-chain state present, crediting nothing. The P3 retro assigns un-gating to "the same owner-gated SDK-install boundary as the deploy executor" — which is THIS plan (Tasks 1–2 install the SPIKE-pinned SDK into `apps/server`). Without this task the demo's deposit → credit leg (design §5, golden-path beat 4) stays dead.

**Files:**

- Create: `apps/server/src/ledger/vault-state-reader.ts`
- Test: `apps/server/tests/ledger/vault-state-reader.test.ts` (deterministic, fake provider + fake compiled module) + a `DEVNET_URL`-gated case (extend `tests/ledger/indexer-observation.devnet.test.ts` or a sibling `.devnet` file; requires a deployed vault — deploy one in-test via the Task 2 executor path or skip with an explicit reason when `NYXT_VAULT_ADDRESS` is unset, mirroring that file's existing gating)

**Interfaces:**

- Consumes: `DepositsStateReader` + `DepositStateEntry` (`ledger/indexer-observation.ts:205-240` — READ the seam contract: `amount` native `bigint` never `Number()`, `finalized` reflects ONLY finalized state (I1 — the store credits on it directly), map keys lowercase 64-char hex, no `0x`). The verified recipe is ALREADY documented in that seam's docblock (`indexer-observation.ts:212-227`, SPIKE-2 §C/§D executed evidence): `publicDataProvider.queryContractState(vaultAddress)` (`@midnight-ntwrk/midnight-js-indexer-public-data-provider@4.1.1`, SPIKE-pinned) → `mod.ledger(state.data)` (the compiled NyxtVault module's generated decode) → `decoded.deposits` map. The compiled module comes from the native vault build (`packages/nyxt-vault` `compact:build` → `build/nyxt-vault/contract/index.js`, gitignored) — resolve its path from config (`config.artifacts.vaultArtifactsDir`, `schema.ts:149`; P5 copies `contract/` there alongside `keys/`+`zkir/`).
- Produces: `createNyxtVaultStateReader(deps: { readonly indexerUrl: string; readonly vaultModuleDir: string; readonly provider?: <injectable seam over queryContractState>; readonly loadModule?: <injectable dynamic-import seam> }): DepositsStateReader` — pin the exact dep list to the recipe evidence; the FINALITY flag per entry derives from the Task 1 recipe's SC-029 finality element (the same finalized-head signal the deploy `awaitFinality` uses — one finality definition, two consumers), NEVER hardcoded `true` (the P3 I1 lesson: a `finalized:true` shortcut makes the store's SC-021 gate vacuous and risks off-chain mint).

- [ ] **Step 1: Write the failing deterministic tests** with a fake provider/module: decoded entries come back keyed lowercase-hex with native `bigint` amounts (feed > 2^63 to prove no `Number()`); a not-yet-final state yields `finalized: false` (and drive the REAL `createDevnetDepositIndexerQuery` + in-memory deposit store with the reader injected to prove `finalized:false` credits NOTHING — extend the existing I1 negative test pattern in `tests/ledger/indexer-observation.test.ts`); provider/module load faults are promise rejections, never fake-empty maps (a stubbed reader must never look successful — the `DepositIndexerNotWiredError` discipline).
- [ ] **Step 2: Run to verify failure, implement, run to verify pass.** The SDK import lives behind the injectable seams (only the real adapter file imports `@midnight-ntwrk/*`; every call cites its recipe/docblock evidence).
- [ ] **Step 3: Gates + commit.** `git commit -m "feat(server): real nyxt-vault deposits-state reader for the observation poller"`

---

### Task 4: Boot wiring (server)

**Files:**

- Modify: `apps/server/src/index.ts` (executor + balance query + green-build source)
- Test: extend `apps/server/tests/foundation.test.ts` or the deploy handler tests if they cover construction (read them first; if none covers `index.ts` construction, the full-suite run is the gate)

**Interfaces:**

- Consumes: the current wiring at `index.ts:265-308` (line anchors re-verified post-P3 at P4 Task 0) — `createOwnerGatedDeployExecutor({signingKey: config.secrets.deployKey, network: config.network, proverClient})` (`index.ts:271-275`), the rejecting `queryBalance` stub inside `createDeployWalletMonitor` (`index.ts:280-285`; keep its sibling deps `lowThreshold: DEPLOY_WALLET_LOW_THRESHOLD_TDUST` + `alert: logWalletAlert`), and `getLatestGreenBuild` — **already REAL: P1 wired `(projectId) => projectStore.getLatestGreenBuild(projectId)` at `index.ts:303`** (store interface `projects/store.ts:118`, `recordGreenBuild` impl at `store.ts:497`, migration 0005). The `artifactStore` instance is constructed at `index.ts:201-208`; `proverClient` at `index.ts:230`. The deposit-observation query is constructed at `index.ts:402-405` with `readDepositsState` omitted (Task 3b's wiring site).
- Produces: real `createDevnetDeployExecutor` + `createDevnetBalanceQuery` wired; `readDepositsState` injected when configured; `getLatestGreenBuild` untouched (verify it still reads the store at deploy time — nothing to wire).

- [ ] **Step 1: Swap the executor construction** to `createDevnetDeployExecutor({signingKey: config.secrets.deployKey, network: config.network, proverClient, artifacts: artifactStore})` (the `artifactStore` instance exists from P2's wiring, `index.ts:201-208`). Keep the owner-gated stub factory exported but unused at boot; delete the "OWNER-GATED" wiring comments that are now false (`index.ts:265-266`, `:268-270`).
- [ ] **Step 2: Swap the balance stub** for `createDevnetBalanceQuery({network: config.network, signingKey: config.secrets.deployKey})`, preserving `lowThreshold` + `alert`. Delete the stale stub comment (`index.ts:276-279`) — including the now-FALSE parenthetical "(Unreached today: `getLatestGreenBuild` rejects first.)" (P1 made `getLatestGreenBuild` real; it resolves `null`, it does not reject).
- [ ] **Step 3: Verify `getLatestGreenBuild`** is still the P1 wiring (`getLatestGreenBuild: (projectId) => projectStore.getLatestGreenBuild(projectId)`, `index.ts:303`, returning `DeployArtifacts | null` — `{urlPrefix, compilerVersion}`, `deploy/pipeline.ts:71-76`). Nothing to add; a regression here is a red flag, stop and investigate.
- [ ] **Step 3b: Wire the Task 3b reader**: pass `readDepositsState: createNyxtVaultStateReader({...})` into `createDevnetDepositIndexerQuery` (`index.ts:402-405`) ONLY when `config.artifacts.vaultArtifactsDir` and `config.nyxtVaultAddress` are both set (the P5 demo env sets both) — otherwise keep the honest loud-fault omission; update the boot comment accordingly.
- [ ] **Step 4: Run the SC-031 deploy-key audit greps** (the US8 lesson — construction site + real field name): `grep -rn "deployKey\|signingKey" apps/server/src/deploy/ apps/server/src/index.ts` and confirm the key value flows only executor/balance-deps-inward; no log line, error message, or emitted payload interpolates it. **Then update `apps/server/tests/deploy/exposure.test.ts`** — its angle 4 pins the construction site to `createOwnerGatedDeployExecutor({ signingKey: ... })` and its angle 3 scans `src/deploy/*.ts` + `index.ts`; extend BOTH to the new `createDevnetDeployExecutor`/`createDevnetBalanceQuery` construction sites and the new `devnet-executor.ts`/`sdk-adapter.ts`/`balance.ts` files (the audit widening, never a weakening). Then the full server suite: `sfw pnpm --filter @nyx/server test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): wire real deploy executor, balance query, and vault state reader"`

---

### Task 5: Scaffold steering — preview-DApp dev wallet + npm-only (packages/scaffold)

Generated DApps in the WebContainer must (a) use plain `npm` (never pnpm/sfw — those are host-side rules), and (b) in dev-wallet mode, read `VITE_DEV_WALLET_SEED` from the container `.env.local` and sign/submit their own transactions in-page (no `window.midnight` injection into the iframe — the T185/US9 problem stays side-stepped).

**Files:**

- Modify: `packages/scaffold/src/steering.ts` (two new rules; extend `ScaffoldSteering` + `SCAFFOLD_STEERING_RULES`)
- Test: `packages/scaffold/src/steering.test.ts` (extend, following its existing per-rule assertions — read it first)

**Interfaces:**

- Consumes: `SteeringRule` / `ScaffoldSteering` (`steering.ts:31-53`).
- Produces: `SCAFFOLD_STEERING.packageManagerRule` (id `"package-manager"`) and `SCAFFOLD_STEERING.devWalletRule` (id `"dev-wallet"`), appended to `SCAFFOLD_STEERING_RULES` (`steering.ts:117-122` — order-stable list, append, don't reorder). **Verified split in `instructions.ts` (re-checked post-P3 — unchanged):** `buildImplementationInstructions()` composes `SCAFFOLD_STEERING_RULES` (`instructions.ts:94-96`) so appending reaches it automatically; `buildScaffoldingInstructions()` enumerates THREE rules BY NAME (`instructions.ts:76-85` — configChokepoint/proverProvider/networkGuard), so add `packageManagerRule` (and `devWalletRule` if the skeleton wires wallet code) to its explicit list too.

- [ ] **Step 1: Write the failing tests**: both rules present in `SCAFFOLD_STEERING_RULES` (length + ids); `packageManagerRule.guidance` contains `"npm"` and forbids `"pnpm"` inside the container; `devWalletRule.guidance` names `VITE_DEV_WALLET_SEED`, `.env.local`, and carries the constitution-I retrieval marker for SDK call shapes; the composed instructions (via the real builder functions) include both rules' titles.
- [ ] **Step 2: Run to verify failure**: `sfw pnpm --filter @nyx/scaffold test`. Expected: FAIL.
- [ ] **Step 3: Implement the two rules** following the existing rules' voice exactly (policy fixed here; SDK shapes marked RETRIEVAL-SOURCED):

```typescript
packageManagerRule: {
  id: "package-manager",
  title: "Container package manager",
  decisions: ["design §7 supply-chain split"],
  guidance:
    "Generated projects run inside the user's browser WebContainer and use PLAIN npm for " +
    "every install/script (npm install, npm run dev, npm test) — exactly what the " +
    "in-browser runtime ships. NEVER generate pnpm, pnpm-lock.yaml, sfw, corepack, or " +
    "any custom registry configuration into a user project: pnpm+sfw hardening is a " +
    "HOST-side rule for the Nyx repo itself and must not leak into user code. Keep " +
    "generated package.json scripts boringly standard npm.",
},
devWalletRule: {
  id: "dev-wallet",
  title: "Dev-wallet transaction signing (local mode)",
  decisions: ["design §6 preview interaction", "D37"],
  guidance:
    "In local/dev-wallet mode the generated app signs and submits its own transactions " +
    "in-page: it reads the signing seed from import.meta.env.VITE_DEV_WALLET_SEED " +
    "(merged into the container .env.local by the platform — never hardcode a key, " +
    "never prompt for one) and derives the wallet identity from it. There is NO " +
    "window.midnight connector inside the preview iframe — do not generate connector " +
    "detection for local mode; gate any connector path behind the absence of " +
    "VITE_DEV_WALLET_SEED. The exact SDK call shapes for deriving the identity and " +
    "building/submitting transactions are RETRIEVAL-SOURCED (constitution I): retrieve " +
    "the platform's verified dev-wallet recipe (mirrored from the Nyx dev wallet and " +
    "ceremony modules) rather than writing SDK calls from memory.",
},
```

- [ ] **Step 4: Run to verify pass** (`sfw pnpm --filter @nyx/scaffold test`), then the server agent suites that snapshot instruction composition (`sfw pnpm --filter @nyx/server test tests/agents`) — update snapshots ONLY by reading the diff and confirming the two new rule titles are the only change.
- [ ] **Step 5: Commit.** `git commit -m "feat(scaffold): npm-only and dev-wallet steering rules"`

---

### Task 6: Full gates + review loop

- [ ] **Step 1:** `sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test` from the repo root. Zero warnings.
- [ ] **Step 2:** Dispatch the code-reviewer subagent over `git diff main...HEAD`. Review brief: deploy-key leakage (grep the canary discipline), outcomes-as-data (no throw path from the executor into the pipeline), bounded finality (no unbounded poll), EC-38 misclassification, `bigint` discipline in the balance path. Fix → re-review until clean.

### Task 7: Retro + PR + merge + next plan

- [ ] **Step 1:** Write `docs/superpowers/plans/retros/P4_RETRO.md` per the Retro section — especially the final `DeploySdk` member signatures, the EC-38 discriminator evidence, the SC-029 finality signal shared by `awaitFinality` and the Task 3b `DepositsStateReader`, and anything P5's vault-bootstrap deploy should reuse from `sdk-adapter.ts` (P5 Task 8 plans to). Commit: `git commit -m "docs: p4 retro"`.
- [ ] **Step 2:** Push, open the PR (`gh pr create`), watch CI (`gh pr checks --watch`), fix until green, `gh pr merge --merge --delete-branch`.
- [ ] **Step 3:** `git checkout main && git pull`, open `docs/superpowers/plans/2026-07-23-p5-demo-orchestrator.md`, and begin at its Task 0. Do not pause.
