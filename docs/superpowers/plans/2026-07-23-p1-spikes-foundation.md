# P1 — Spikes + Foundation Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the two novel bets (SPIKE-1: wasm-compiled contracts run on the pinned devnet; SPIKE-2: in-browser-proven transactions are accepted by the devnet node) while closing the three foundation gaps every later plan builds on (turn-end file persistence, green-build persistence, coverage telemetry).

**Architecture:** The two spikes run **concurrently as background subagents** against a shared local devnet while the foundation tasks proceed inline on the branch. Foundation work follows the existing seam/store patterns exactly: a new `commitFiles` supervisor seam wired to `ProjectStore.commit`, new `recordGreenBuild`/`getLatestGreenBuild` store methods behind migration 0005, and a telemetry-only coverage log at the coordinator's full-compile site. Spike deliverables are evidence-backed reports that P2/P3's re-planning preambles consume.

**Tech Stack:** TypeScript/Node ≥22, Fastify 5 server, Postgres (migrations), vitest, compactc-wasm PoC (Chez-wasm compiler + zkir-v2 wasm), Midnight local devnet (pinned images: node 0.22.5, indexer 4.2.1, proof-server 8.1.0), midnight-verify agents.

## Global Constraints

- Host-side installs/builds/scripts: **always `sfw pnpm …`** (PoC clone: `sfw npm …` since its lockfile is npm) — never bare package managers.
- **Warnings are errors**; full gates before push (P0's pre-push hook enforces).
- **Conventional commits** (commitlint: lowercase subject, header ≤72 chars).
- **Constitution I**: every Compact/`@midnight-ntwrk/*` claim in the spikes is verified by execution + `midnight-verify`, never memory. Compilation alone is not proof.
- **Money rules**: `bigint` in code, decimal string on wire, `numeric(40,0)` in Postgres; no `Number()` on amounts. (Foundation tasks touch stores — the green-build table carries no amounts, but the rule stands.)
- **Store pattern**: interface + `Pg*` impl + in-memory double, promise-rejection failures, `DATABASE_URL`-gated pg tests.
- A settled turn's money path must never be broken by file persistence: `turn:settled` emission takes priority over a failed commit (log loudly, never swallow silently, never block settle).
- Devnet is the only chain target; Lace networkId is exactly `Undeployed`.

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p1-spikes-foundation` off up-to-date `main` before the first task.

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
5. **Immediately** check out `main`, pull, open the next plan (`docs/superpowers/plans/2026-07-23-p2-browser-compile.md`), and begin it — starting with its Task 0 re-planning preamble. Do not pause between plans.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- SPIKE-1 / SPIKE-2: dispatch as background subagents per their briefs; inside them, Compact/SDK evidence work goes to `compact-core:compact-dev` and the `midnight-verify:*` agents (`sdk-tester` for devnet E2E, `contract-writer`/`zkir-checker` for toolchain claims) via the `midnight-verify:verify` skill.
- Foundation TypeScript tasks (commit wiring, green-build store, coverage telemetry): `devs:typescript-dev`.
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches.

## No-Deferral Policy

Fully implement every task in this plan before moving on. Deferral is permitted only when 100% required — an external hard blocker outside the codebase. "This is hard/slow/complex" or "this could be a follow-up" are not justifications. Every deferral must appear in the retro with: what was deferred, the blocking condition, what unblocks it, and the impact on remaining plans. **Exception baked into this plan:** a spike that honestly concludes "NO, with evidence" has SUCCEEDED — the fallback decision is the deliverable, not a deferral.

## Code Quality Rules (binding for every task)

- **Host commands**: always `sfw pnpm …`, never bare `pnpm`, never `npm`, on anything that runs on our machine. Inside the user-facing WebContainer runtime only: plain `npm`.
- **Warnings are errors** everywhere: ESLint `--max-warnings 0`, TypeScript strict, Prettier clean. CI enforces the same.
- **Constitution I**: never hand-write Compact/`@midnight-ntwrk/*` shapes from memory — installed-type reads, `midnight-verify` dispatch, live probing first; code only from verified shapes; execute, don't just compile.
- **Money rules** (iron rules 2–3) and **seam pattern** (iron rule 6) as in Global Constraints.
- Deterministic tests only in the default suite; anything touching a live service is env-gated (`DATABASE_URL`, `DEVNET_URL`).

---

### Task 1: Start the shared devnet

**Files:** none (infrastructure only)

**Interfaces:**

- Produces: a healthy devnet on node :9944 / indexer :8088 / proof-server :6300 that BOTH spikes use concurrently. Foundation tasks do not need it.

- [ ] **Step 1: Preflight.** Run: `sfw pnpm exec tsx infra/devnet/preflight-cli.ts`. Expected: exit 0. If it reports ports in use, something this script does not own is running — stop **only** processes you can identify as a stale devnet from an earlier session of yours (`docker compose -f infra/devnet/docker-compose.yml down`), re-run preflight; if still blocked by a foreign process, that is a genuine environment blocker: record it and halt this task only (spikes blocked, foundation proceeds — revisit before Task 7).

- [ ] **Step 2: Bring it up detached.** Run: `docker compose -f infra/devnet/docker-compose.yml up -d`. Expected: three containers running.

- [ ] **Step 3: Health-wait.** Use the midnight-tooling devnet skill (`Skill: midnight-tooling:devnet` — status/health) or poll manually until: node RPC on :9944 answers, indexer GraphQL on :8088 answers, proof server on :6300 answers. Expected: all three healthy; record container image digests in your notes for the spike reports.

### Task 2: Dispatch SPIKE-1 (compiler↔chain alignment) — CONCURRENT

**Files (written later, by Task 7):**

- Create: `docs/superpowers/plans/retros/SPIKE1_REPORT.md`

**Interfaces:**

- Produces: the compiler pin + runtime-version strategy for `@nyx/compact-wasm` (P2's Task 0 re-planning MUST read this report).

- [ ] **Step 1: Dispatch a background subagent** (worktree/scratch isolation; it works in a scratch dir, NOT in this branch's tree) with this brief, verbatim:

> **SPIKE-1: prove wasm-compiled Compact contracts are accepted by the pinned Midnight local devnet.**
> The devnet is already running (node :9944, indexer :8088, proof server :6300; images node 0.22.5 / indexer 4.2.1 / proof-server 8.1.0). Work in a scratch directory.
>
> 1. Clone `https://github.com/aaronbassett/compactc-wasm` and build it (`sfw npm install`, then its documented build; Node ≥20). If in-browser keygen wasm (`vendor/zkir-v2-keygen/`) is not committed, run `scripts/07-build-zkir-wasm.sh` per its README.
> 2. Compile a known-good contract with the **wasm** compiler via the Node CLI: `node node/compactc.mjs --skip-zk <contract>.compact out/` — use the bundled `web/examples/counter.compact` first, then `packages/nyxt-vault/src/nyxt-vault.compact` from the Nyx repo (read-only). Record the wasm compiler's language/compiler version output.
> 3. **Deploy the wasm-compiled output to the devnet and execute a circuit.** Generate keys (wasm keygen or the PoC's genkeys fallback — host-side, so run it as `sfw npm run genkeys`), then deploy + call using the Midnight SDK against `http://localhost:9944` — follow the midnight-verify sdk-tester approach (verify every SDK shape from installed types, never memory; the `midnight-verify:verify` skill and its agents are available — use them). Success = deploy tx finalized on the devnet AND one circuit call executed and observable via the indexer.
> 4. **Version matrix.** The PoC pins compiler HEAD `c06961eb66` emitting for runtime `0.18.101` (strict-version check stripped — demo-only shortcut). Nyx's native toolchain is compiler 0.31.1 / language ≥0.23. Determine: does HEAD-pinned wasm output deploy+run on this devnet? Does the devnet's ledger version constrain the compiler pin? Would rebuilding the wasm at a pinned compiler **release** (e.g. 0.31.1) be needed for NyxtVault (`pragma language_version >= 0.23`) — and if so, attempt that rebuild (`scripts/` pipeline with the pin changed) and report the outcome.
> 5. **Deliverable — a report (markdown, returned as your final message)** with sections: `## Verdict` (which compiler pin works against the pinned devnet, or NO-with-evidence), `## Evidence` (exact commands, tx identifiers, indexer query results, midnight-verify transcript summaries), `## Compiler pin decision` (the pin + how to reproduce the wasm build at it), `## Runtime-version strategy` (which `@midnight-ntwrk/compact-runtime` / onchain-runtime versions the generated code must load against, and whether the version-check bypass is still needed), `## Risks for P2` (anything the browser-compile plan must change).
>    A definitive NO with evidence is a valid outcome. Never fabricate: every claim in the report must be backed by a command you ran.

- [ ] **Step 2: Note the dispatch** (agent id, start time) and continue immediately to Task 3 — do NOT wait.

### Task 3: Dispatch SPIKE-2 (in-browser tx proving) — CONCURRENT

**Files (written later, by Task 7):**

- Create: `docs/superpowers/plans/retros/SPIKE2_REPORT.md`

**Interfaces:**

- Produces: the in-browser-proving verdict + fallback decision (P3's Task 0 re-planning MUST read this report; the top-up ceremony and preview-DApp proving paths depend on it).

- [ ] **Step 1: Dispatch a second background subagent** (own scratch dir, independent clone — do not share state with SPIKE-1 beyond the devnet) with this brief, verbatim:

> **SPIKE-2: prove a real transaction proven by the zkir wasm is ACCEPTED by the Midnight devnet node.**
> The devnet is running (node :9944, indexer :8088, proof server :6300). Work in a scratch directory; clone and build `https://github.com/aaronbassett/compactc-wasm` (`sfw npm install`; enable the keygen-patched zkir wasm per its README) — its pipeline already does compile → execute → keygen → prove → self-verify for circuit calls, all client-side.
>
> 1. **Gap to close:** the PoC self-verifies proofs; nobody has shown the devnet node accepting one inside a real submitted transaction. Determine what a submittable Midnight transaction needs beyond the zkir `prove` output (tx structure, balancing, fees/DUST, serialization) — from installed SDK types, the ledger source, and `midnight-verify` (verify-by-source / sdk-tester), never memory.
> 2. Target transaction: NyxtVault `deposit(ref, amount)` (contract at `packages/nyxt-vault/` in the Nyx repo, read-only) — deploy the vault first however is expedient (native toolchain deploy is fine; SPIKE-1 owns wasm-deploy questions). Fund/register the sender as needed from the genesis dev account (seed `0x00…01`; NIGHT pre-minted; DUST registration required before fees — discover the exact recipe by probing, document it: P5 needs it too).
> 3. Build the deposit call's proof with the **wasm** zkir `prove` (keys from wasm keygen), assemble the transaction, submit to `http://localhost:9944`, and check acceptance + finalization via the indexer.
> 4. If wasm-proof-in-real-tx is NOT achievable (missing serialization surface, version mismatch, wallet-SDK-only tx assembly), demonstrate the **fallback**: the same deposit proven via the devnet proof server on :6300, submitted and finalized — so the ceremony's fallback seam is proven viable either way.
> 5. **Deliverable — a report (markdown, returned as your final message)** with sections: `## Verdict` (in-browser proving viable for real txs: YES/NO + confidence), `## Evidence` (commands, tx identifiers, node/indexer responses, error transcripts for failed routes), `## Fallback decision` (proof-server route proven? exact recipe), `## Funding/DUST recipe` (exact steps discovered — P5's setup script will encode these), `## Risks for P3` (what the dev-wallet/ceremony plan must change).
>    A definitive NO with evidence is a valid outcome. Never fabricate: every claim must be backed by a command you ran.

- [ ] **Step 2: Note the dispatch and continue immediately to Task 4** — foundation work proceeds while both spikes run.

### Task 4: Turn-end file persistence (`commitFiles` seam → `ProjectStore.commit`)

**Files:**

- Modify: `apps/server/src/agents/supervisor.ts` (SupervisorDeps + runVerifyLoop + a new private helper)
- Modify: `apps/server/src/turn/coordinator.ts` (TurnCoordinatorDeps + wiring)
- Modify: `apps/server/src/index.ts` (pass the project store through)
- Modify: supervisor/coordinator test fixtures (locate via `grep -rn "commitFiles\|SupervisorDeps" apps/server/tests`)
- Test: `apps/server/tests/turn/turn-file-persistence.test.ts` (new)

**Interfaces:**

- Consumes: `ProjectStore.commit(projectId, {author: "agent", files}): Promise<CommitResult>` (`apps/server/src/projects/store.ts:101`), `FileWrite {path, content}` (store.ts:47).
- Produces: `SupervisorDeps.commitFiles: (projectId: string, files: readonly FileWrite[]) => Promise<CommitResult>` — REQUIRED (not optional; every fixture updates). Later plans (P6 editor reads, US13 exports) rely on settled turns having `project_file_versions` rows.

- [ ] **Step 1: Read before writing.** Read `apps/server/src/agents/supervisor.ts` around lines 140–170 (the `SourceFile` type — confirm it is structurally `{path, content}` compatible with `FileWrite`; if it carries extra fields, map explicitly) and lines 600–700 (the verify loop; note the TWO `exhaustedEnding` call sites and the `InfraFailureError` catch). Read `apps/server/tests/` for the supervisor deps fixture factory.

- [ ] **Step 2: Write the failing integration test** `apps/server/tests/turn/turn-file-persistence.test.ts`, following the existing coordinator test harness style (find it via `ls apps/server/tests/turn/`). Core assertions:

```ts
// Drive a full green turn through the coordinator with the in-memory project store
// (fake sub-agents produce 2 files; fake test results = pass).
const store = createInMemoryProjectStore(/* per existing double's factory */);
// ... run the turn to `turn:settled` ...
const versions = await store.getVersionHistory(projectId);
expect(versions).toHaveLength(1);
expect(versions[0]?.author).toBe("agent");
expect(versions[0]?.files.map((f) => f.path).sort()).toEqual(["contract.compact", "src/App.tsx"]);
// US13 no-longer-hollow proof:
const files = await store.getFiles(projectId);
expect(files.length).toBeGreaterThan(0);
```

Also add: an **exhausted** turn commits its WIP files; a commit-throwing store still yields the terminal `turn:settled` (loud persistence failure never blocks settle).

- [ ] **Step 3: Run the test, watch it fail** (no `commitFiles` seam exists): `sfw pnpm --filter @nyx/server test -- tests/turn/turn-file-persistence.test.ts`. Expected: FAIL (type error or missing versions).

- [ ] **Step 4: Add the seam to the supervisor.** In `supervisor.ts`:
  - Import: `import type { CommitResult, FileWrite } from "../projects/store.js";`
  - Add to `SupervisorDeps` (after `chat`): `/** Persist a turn's accumulated files as ONE agent-authored commit (SC-026). */ readonly commitFiles: (projectId: string, files: readonly FileWrite[]) => Promise<CommitResult>;`
  - In `runVerifyLoop`, accumulate across cycles (after `runCycleAgents`): maintain `const turnFiles = new Map<string, FileWrite>();` at loop top-level; after `const work = await this.runCycleAgents(...)` add `for (const file of work.files) turnFiles.set(file.path, { path: file.path, content: file.content });`
  - Add the private helper:

```ts
/**
 * Persist the turn's accumulated files as one agent commit. Persistence must
 * NEVER break the money path: a failed commit is logged onto the activity feed
 * and swallowed — the turn still settles, the files still live in the client VFS.
 */
private async persistTurnFiles(
  ctx: SupervisorContext,
  turnId: string,
  projectId: string,
  turnFiles: ReadonlyMap<string, FileWrite>,
): Promise<void> {
  if (turnFiles.size === 0) return;
  try {
    await this.deps.commitFiles(projectId, [...turnFiles.values()]);
  } catch (error) {
    await this.emitActivity(ctx, turnId, {
      agent: "supervisor",
      phase: "persist",
      detail: `file persistence failed (${error instanceof Error ? error.message : String(error)}); files remain in the container only`,
    });
  }
}
```

- Call `await this.persistTurnFiles(ctx, turnId, projectId, turnFiles);` immediately BEFORE: the `greenEnding` return, BOTH `exhaustedEnding` returns, and the `infraEnding` return inside the `InfraFailureError` catch. (Declined/rejected paths never reach the loop — no call.)

- [ ] **Step 5: Wire the coordinator.** In `coordinator.ts`: add to `TurnCoordinatorDeps` — `/** Turn-end file persistence (US7 store; the US13/US14 read path depends on it). */ readonly projectStore: Pick<ProjectStore, "commit">;` (import the type from `../projects/store.js`). Where the coordinator constructs `createSupervisor` deps, add: `commitFiles: (projectId, files) => deps.projectStore.commit(projectId, { author: "agent", files }),`

- [ ] **Step 6: Wire `index.ts`.** Find the existing project-store construction (`grep -n "ProjectStore\|projectStore" apps/server/src/index.ts`) and pass it into `createTurnCoordinator({ ..., projectStore })`. Update `buildServer` plumbing only if the coordinator is built there — follow the existing dependency path.

- [ ] **Step 7: Fix the fixtures.** Every `SupervisorDeps`/coordinator-deps fixture now fails typecheck (missing `commitFiles`/`projectStore`). Update the shared factory (preferred) with a recording fake: `commitFiles: vi.fn(() => Promise.resolve({ version: 1 }))`. Run: `sfw pnpm --filter @nyx/server typecheck`. Expected: clean.

- [ ] **Step 8: Run the new test — pass.** `sfw pnpm --filter @nyx/server test -- tests/turn/turn-file-persistence.test.ts`. Expected: PASS (all three scenarios).

- [ ] **Step 9: Full server suite.** `sfw pnpm --filter @nyx/server test`. Expected: all green (546+ tests, plus new).

- [ ] **Step 10: Commit.**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): persist turn files via commitFiles seam at turn end"
```

### Task 5: Green-build persistence (migration 0005 + store methods + wiring)

**Files:**

- Create: `apps/server/src/db/migrations/0005_green_builds.up.sql`, `apps/server/src/db/migrations/0005_green_builds.down.sql`
- Modify: `apps/server/src/projects/store.ts` (interface + `PgProjectStore` + in-memory double location per existing pattern)
- Modify: `apps/server/src/turn/coordinator.ts` (record at the `ready` outcome)
- Modify: `apps/server/src/index.ts` (replace the `getLatestGreenBuild` stub at line ~201)
- Test: `apps/server/tests/projects/green-builds.test.ts` (new), extend `apps/server/tests/projects/pg-*.test.ts` (DATABASE_URL-gated), extend coordinator tests

**Interfaces:**

- Consumes: `CompileOutcome` `kind:"ready"` (`apps/server/src/compile/orchestrator.ts:137` — `{urlPrefix, compilerVersion, ...}`); `DeployArtifacts {urlPrefix, compilerVersion}` (`apps/server/src/deploy/pipeline.ts:71`).
- Produces: `ProjectStore.recordGreenBuild(projectId: string, build: DeployArtifacts): Promise<void>` (upsert — latest wins) and `ProjectStore.getLatestGreenBuild(projectId: string): Promise<DeployArtifacts | null>`. P4's deploy engine consumes `getLatestGreenBuild` via the existing `DeployHandlerDeps.getLatestGreenBuild` seam.

- [ ] **Step 1: Read `0001_initial_schema.up.sql`** for the `projects` table's exact id type and the file-header comment style; read the migration-runner note in `0003` ("runner wraps in a single transaction; no BEGIN/COMMIT").

- [ ] **Step 2: Write the failing store test** `apps/server/tests/projects/green-builds.test.ts` against the in-memory double (mirror an existing projects test file's setup):

```ts
it("records and returns the latest green build per project", async () => {
  await store.recordGreenBuild(projectId, { urlPrefix: "p1/hashA/", compilerVersion: "0.31.1" });
  await store.recordGreenBuild(projectId, { urlPrefix: "p1/hashB/", compilerVersion: "0.31.1" });
  await expect(store.getLatestGreenBuild(projectId)).resolves.toEqual({
    urlPrefix: "p1/hashB/",
    compilerVersion: "0.31.1",
  });
});
it("returns null when no green build exists", async () => {
  await expect(store.getLatestGreenBuild(projectId)).resolves.toBeNull();
});
```

Run it; expected: FAIL (methods missing).

- [ ] **Step 3: Migration.** `0005_green_builds.up.sql` (adapt the FK type to what Step 1 found):

```sql
-- 0005_green_builds.up.sql
-- Latest green build per project (FR-054 greenness gate). One row per project,
-- upserted at every `ready` CompileOutcome; the deploy handler reads it AT DEPLOY
-- TIME (US8 stale-build lesson). No amounts here; plain text provenance columns.
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT.

CREATE TABLE project_green_builds (
  project_id uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  url_prefix text NOT NULL,
  compiler_version text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
```

`0005_green_builds.down.sql`:

```sql
-- 0005_green_builds.down.sql
DROP TABLE project_green_builds;
```

- [ ] **Step 4: Store methods.** Add to the `ProjectStore` interface (store.ts, after `getVersionHistory`): the two signatures from the Interfaces block, with doc comments. Implement in `PgProjectStore`:

```ts
async recordGreenBuild(projectId: string, build: DeployArtifacts): Promise<void> {
  await this.db.query(
    `INSERT INTO project_green_builds (project_id, url_prefix, compiler_version)
       VALUES ($1, $2, $3)
     ON CONFLICT (project_id)
       DO UPDATE SET url_prefix = EXCLUDED.url_prefix,
                     compiler_version = EXCLUDED.compiler_version,
                     recorded_at = now()`,
    [projectId, build.urlPrefix, build.compilerVersion],
  );
}

async getLatestGreenBuild(projectId: string): Promise<DeployArtifacts | null> {
  const rows = await this.db.query<{ url_prefix: string; compiler_version: string }>(
    `SELECT url_prefix, compiler_version FROM project_green_builds WHERE project_id = $1`,
    [projectId],
  );
  const row = rows.rows[0];
  return row ? { urlPrefix: row.url_prefix, compilerVersion: row.compiler_version } : null;
}
```

(Adapt the query-call shape to `PgProjectStore`'s actual `Queryable` usage — read a neighboring method first. Import `DeployArtifacts` as a type from `../deploy/pipeline.js`; if that import direction creates a cycle, define a structurally-identical `GreenBuild` type in store.ts instead and note it in the retro.) Mirror both methods in the in-memory double (a `Map<string, DeployArtifacts>` keyed by projectId).

- [ ] **Step 5: In-memory tests pass; add the pg-gated test.** Run Step 2's test → PASS. Add the same two scenarios to the `DATABASE_URL`-gated pg test file for projects (existing pattern), including migration 0005 in its setup path. Run with `DATABASE_URL` set if a local Postgres is available: `DATABASE_URL=... sfw pnpm --filter @nyx/server test -- tests/projects` (skips cleanly otherwise).

- [ ] **Step 6: Record at the coordinator's ready site.** In `coordinator.ts`, the supervisor's `runFullCompile` seam is bound around line 603 (`runFullCompile: (input) => orchestratorFor(...).runTurn(input)`). Wrap it:

```ts
runFullCompile: async (input) => {
  const outcome = await orchestratorFor(/* existing args */).runTurn(input);
  if (outcome.kind === "ready") {
    try {
      await deps.projectStore.recordGreenBuild(input.projectId, {
        urlPrefix: outcome.urlPrefix,
        compilerVersion: outcome.compilerVersion,
      });
    } catch (error) {
      deps.logError?.("green-build record failed", error); // use the coordinator's existing loud-log seam; grep for how the backstop logs and match it
    }
  }
  return outcome;
},
```

Widen `TurnCoordinatorDeps.projectStore` to `Pick<ProjectStore, "commit" | "recordGreenBuild">`. A record failure must never fail the turn (the artifacts are announced; deploy simply won't see them — loud log, retro if observed).

- [ ] **Step 7: Replace the index.ts stub.** At `apps/server/src/index.ts:201`, replace `getLatestGreenBuild: () => Promise.resolve(null)` (and its OPEN-WIRING-GAP comment) with `getLatestGreenBuild: (projectId) => projectStore.getLatestGreenBuild(projectId)` — the shapes already match `DeployHandlerDeps.getLatestGreenBuild` structurally.

- [ ] **Step 8: Coordinator behavior test.** Extend the coordinator green-turn test: after a green turn, `expect(store.getLatestGreenBuild(projectId)).resolves.toEqual({...})` with the fake orchestrator's urlPrefix. Run the server suite: `sfw pnpm --filter @nyx/server test` → all green.

- [ ] **Step 9: Commit.**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): persist latest green build and wire deploy greenness gate"
```

### Task 6: Coverage telemetry wiring (FR-032) — capTestResults verification + coverage log

**Files:**

- Modify: `apps/server/src/turn/coordinator.ts`
- Test: extend the coordinator tests

**Interfaces:**

- Consumes: `computeCircuitCoverage` + `testNamesFromResults` (`apps/server/src/agents/coverage.ts:118` and the fallback helper below it); the `ready` outcome's `circuits` (read `apps/server/src/compile/schemas.ts` for the `CompileCircuit` field names before coding — do not assume `.name`).
- Produces: a telemetry-only coverage log line per green full compile. Never a gate (D41).

- [ ] **Step 1: Verify the already-wired cap (no code).** Confirm and note in the retro: `capTestResults` IS enforced server-side at `coordinator.ts:533` (`capResults`) applied at the `test:results` delivery site (`inbox.deliver(capResults(event.payload), ctx.projectId)`, ~line 793) and again defensively in `supervisor.ts:688`. The Phase 7 "US1 must wire" flag is SATISFIED for the cap; only coverage telemetry is unwired (grep confirms `computeCircuitCoverage` has zero production callers).

- [ ] **Step 2: Failing test.** In the coordinator test file, drive a green turn and assert an injected telemetry sink received a coverage report:

```ts
const coverageReports: CircuitCoverageReport[] = [];
// deps: logCoverage: (report) => { coverageReports.push(report); }
// fake orchestrator ready outcome: circuits: [{ name: "deposit", ... }]  ← field names per schemas.ts
// fake test:results: failures: [{ name: "deposit rejects duplicate ref", message: "..." }]
expect(coverageReports).toHaveLength(1);
expect(coverageReports[0]?.perCircuit[0]).toMatchObject({ circuit: "deposit", covered: true });
```

Run → FAIL (no `logCoverage` dep).

- [ ] **Step 3: Implement.** In `coordinator.ts`: (a) add optional dep `readonly logCoverage?: (report: CircuitCoverageReport) => void;` defaulting to a `logger.info`-style line via the coordinator's existing logging pattern; (b) at the `test:results` handler, after `capResults`, stash the capped payload per project: `lastResultsByProject.set(ctx.projectId, capped);` (a plain `Map`, cleared when the project's supervisor state is dropped); (c) in the Task 5 `runFullCompile` wrapper's `ready` branch, compute and emit:

```ts
const lastResults = lastResultsByProject.get(input.projectId);
deps.logCoverage?.(
  computeCircuitCoverage({
    circuits: outcome.circuits.map((c) => c.name), // field name per schemas.ts — verify first
    testNames: lastResults ? testNamesFromResults(lastResults) : [],
  }),
);
```

Telemetry only: no branch of turn control flow may read the report.

- [ ] **Step 4: Tests pass + full suite.** Run the coordinator tests, then `sfw pnpm --filter @nyx/server test`. Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): emit circuit coverage telemetry on green full compile"
```

### Task 7: Collect the spike reports

**Files:**

- Create: `docs/superpowers/plans/retros/SPIKE1_REPORT.md`
- Create: `docs/superpowers/plans/retros/SPIKE2_REPORT.md`

**Interfaces:**

- Produces: the two committed reports P2/P3 re-planning reads. BLOCKING: this plan's PR does not open until both exist.

- [ ] **Step 1: Await both spike subagents.** If either is still running, continue polishing foundation tests/docs meanwhile; do not open the PR early.

- [ ] **Step 2: Validate each report** against its required sections (Verdict / Evidence / pin- or fallback-decision / Risks; SPIKE-2 additionally Funding-DUST recipe). A report missing evidence for a claim goes back: re-dispatch the spike agent with the gap named. A NO-verdict with evidence is accepted as-is.

- [ ] **Step 3: Save + commit** the reports verbatim (plus a one-line provenance header naming the spike brief and date):

```bash
git add docs/superpowers/plans/retros/SPIKE1_REPORT.md docs/superpowers/plans/retros/SPIKE2_REPORT.md
git commit -m "docs: spike reports for wasm compiler pin and in-browser proving"
```

- [ ] **Step 4: Tear down the devnet** unless a spike report says otherwise: `docker compose -f infra/devnet/docker-compose.yml down`.

### Task 8: Retro

**Files:**

- Create: `docs/superpowers/plans/retros/P1_RETRO.md`

- [ ] **Step 1: Write `docs/superpowers/plans/retros/P1_RETRO.md`**: **Deviations** (exact seam/type adjustments vs this plan — e.g. `SourceFile` mapping, import-cycle fallback, fixture-factory realities); **Discoveries** (spike headline verdicts one paragraph each — the reports carry detail; the funding/DUST recipe pointer; anything learned about the coordinator/supervisor internals later plans assume); **Deferred items** (none expected); **Impact on remaining plans** (concretely: what P2 must change given SPIKE-1, what P3 must change given SPIKE-2, whether P4's executor assumptions still hold).

- [ ] **Step 2: Commit.**

```bash
git add docs/superpowers/plans/retros/P1_RETRO.md
git commit -m "docs: p1 retro"
```

Then execute the **PR / CI / merge** steps of the Autonomous Execution Protocol and proceed to `docs/superpowers/plans/2026-07-23-p2-browser-compile.md`.
