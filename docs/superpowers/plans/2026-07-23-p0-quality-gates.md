# P0 — Quality Gates & Supply-Chain Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every quality gate bite (warnings = errors, full-repo gates on push, CI mirrors local) and harden the supply chain (sfw-wrapped pnpm, minimum release age, no lifecycle scripts) so the fully-autonomous P1–P6 agents can safely merge their own PRs.

**Architecture:** No product code changes. Tighten existing tooling (ESLint 9 flat config, husky 9, commitlint, GitHub Actions CI) and pnpm workspace config; add one small check script. Everything is repo-level so it binds every later plan, every contributor, and CI identically.

**Tech Stack:** pnpm 10 workspace, ESLint 9 (typescript-eslint strictTypeChecked), Prettier 3, husky 9 + lint-staged, commitlint (`@commitlint/config-conventional`), GitHub Actions, Socket Firewall (`sfw`).

## Global Constraints

- Host-side installs/builds/scripts: **always `sfw pnpm …`**, never bare `pnpm`, never `npm` (WebContainer-internal `npm` is out of scope for this plan).
- **Warnings are errors**: ESLint `--max-warnings 0`; Prettier check clean; TS strict. CI enforces identically.
- **Conventional commits**, enforced by commitlint: lowercase subject (no leading acronym/uppercase word), header ≤ 72 chars.
- Never `--no-verify`. Never weaken a check to get green.
- pnpm supply-chain settings are verified against the **official pnpm docs at implementation time** (Rover fetch on pnpm.io), never written from memory.
- Repo baseline (audited 2026-07-23, verify before relying on it): root `lint` script is `eslint .` (no max-warnings); husky has `pre-commit` (lint-staged + typecheck) and `commit-msg` (commitlint) but **no pre-push**; CI (`.github/workflows/ci.yml`) runs bare `pnpm install --frozen-lockfile` + the four gates; `pnpm-workspace.yaml` already has `onlyBuiltDependencies: [esbuild]`; `packageManager` is `pnpm@10.0.0`.

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p0-quality-gates` off up-to-date `main` before the first task.

**Per task:**

1. TDD: write the failing test, see it fail, implement minimally, see it pass. (For tooling tasks the "test" is the exact command whose exit code must flip — run it before and after.)
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
5. **Immediately** check out `main`, pull, open the next plan (`docs/superpowers/plans/2026-07-23-p1-spikes-foundation.md`), and begin it — starting with its Task 0 re-planning preamble if present. Do not pause between plans.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- Scripts/config/hook tasks (`check-sfw.mjs`, husky, pnpm config, lint scripts): `devs:typescript-dev`.
- CI workflow changes (`.github/workflows/ci.yml`): `gha:gha-creator` (and `gha:review` before the PR if workflows changed).
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches.
- Doc lookups (pnpm settings, socket.dev install): Rover fetch inline; no subagent needed.

**Model routing — which model runs what:**

- Implementation dispatches (`devs:typescript-dev`, `gha:*`) run on **Opus**: pass `model: "opus"` in the Agent call.
- Review dispatches (`devs:code-reviewer`) run on **Opus** by default. Escalate a review to **Fable 5** only when a finding is still disputed after one fix loop (P0's surface — hooks, lint config, CI — is low-risk; escalation should be rare).
- **Fable 5 is reserved** for the orchestrating session itself (task sequencing, integration judgment, the retro) and, in later plans, the spikes and Task 0 re-planning subagents. Never run implementation on Fable; never downgrade the reserved dispatches to Opus.

## No-Deferral Policy

Fully implement every task in this plan before moving on. Deferral is permitted only when 100% required — an external hard blocker outside the codebase. "This is hard/slow/complex" or "this could be a follow-up" are not justifications. Every deferral must appear in the retro with: what was deferred, the blocking condition, what unblocks it, and the impact on remaining plans.

## Code Quality Rules (binding for every task)

- **Host commands**: always `sfw pnpm …`, never bare `pnpm`, never `npm`, on anything that runs on our machine (installs, builds, scripts, Dockerfile build stages). Inside the user-facing WebContainer runtime only: plain `npm`.
- **Warnings are errors** everywhere: ESLint runs with `--max-warnings 0`, TypeScript strict, Prettier check must be clean. CI enforces the same; a warning that "seems harmless" blocks the commit.
- **Constitution I**: never hand-write Compact/`@midnight-ntwrk/*` shapes from memory. Where a step touches an SDK surface, the step names the verification procedure (installed-type reads, `midnight-verify` dispatch, live probing). Run it first; write code only from verified shapes. Compilation alone is not proof — execute.
- **Money rules** (iron rules 2–3): `bigint` in code, decimal string on the wire via `@nyx/protocol` `encode*` helpers, `numeric(40,0)` in Postgres, exactly-once via DB structure (partial unique indexes / CAS), never `Number()` on amounts.
- **Seam pattern** (iron rule 6): interface + `Pg*`/real impl + in-memory/fake double with injected clock; store failures are promise rejections; integration tests env-gated (`DATABASE_URL`, `DEVNET_URL`).
- Deterministic tests only in the default suite; anything touching a live service is env-gated.

---

### Task 1: Zero-warnings lint gate

**Files:**

- Modify: `package.json` (root — `scripts.lint`)

**Interfaces:**

- Produces: root `sfw pnpm lint` exits non-zero on ANY warning. Every later plan's per-task gate relies on this.

- [ ] **Step 1: Confirm the current behavior is the bug.** Run: `sfw pnpm lint`; expected: exit 0. Note that `eslint .` without `--max-warnings 0` exits 0 even when warnings are reported.

- [ ] **Step 2: Tighten the script.** In root `package.json`, change:

```json
"lint": "eslint . --max-warnings 0",
```

- [ ] **Step 3: Verify the repo is currently warning-free.** Run: `sfw pnpm lint`. Expected: exit 0 (the tree is clean today). If it exits non-zero, fix every reported warning in this task — do not relax the flag.

- [ ] **Step 4: Prove the gate bites.** Create `apps/server/src/scratch-gate-proof.ts` containing exactly:

```ts
/* eslint-disable no-console */
export const gateProof = 1;
```

(There is no `console` usage, so ESLint 9 reports an **unused disable directive** warning.) Run: `sfw pnpm lint`. Expected: **non-zero exit** citing the unused directive. If ESLint reports nothing (directive reporting configured off), instead add `linterOptions: { reportUnusedDisableDirectives: "warn" }` to the root `eslint.config.mjs` first block and re-run until the gate demonstrably fails on a warning.

- [ ] **Step 5: Remove the scratch file.** Delete `apps/server/src/scratch-gate-proof.ts`. Run: `sfw pnpm lint`. Expected: exit 0.

- [ ] **Step 6: Commit.**

```bash
git add package.json eslint.config.mjs
git commit -m "build: fail lint on any warning"
```

### Task 2: sfw presence check script

**Files:**

- Create: `scripts/check-sfw.mjs`
- Modify: `package.json` (root — add `check:sfw` script)

**Interfaces:**

- Produces: `node scripts/check-sfw.mjs` — exit 0 iff `sfw` is on PATH; the pre-push hook (Task 3) and the P5 demo preflight both call it. No arguments, no dependencies beyond Node built-ins.

- [ ] **Step 1: Fetch the authoritative install instructions.** Use Rover (`mcp__rover__fetch_tool`) on `https://docs.socket.dev/docs/socket-firewall-free` and copy the current install command into the script's error message in Step 2 (replace the placeholder there if the docs differ).

- [ ] **Step 2: Write the script.** Create `scripts/check-sfw.mjs`:

```js
#!/usr/bin/env node
// Supply-chain gate: every host-side pnpm invocation must run through Socket
// Firewall (`sfw pnpm …`). This check fails fast when sfw is not installed so
// hooks and the demo preflight surface the gap before any install runs.
import { spawnSync } from "node:child_process";

const result = spawnSync("sfw", ["--version"], { stdio: "ignore", shell: false });

if (result.error || result.status !== 0) {
  console.error(
    [
      "sfw (Socket Firewall) is required but was not found on PATH.",
      "Install it per https://docs.socket.dev/docs/socket-firewall-free :",
      "  npm install -g sfw",
      "Then re-run. All host-side installs/builds MUST use `sfw pnpm …`.",
    ].join("\n"),
  );
  process.exit(1);
}
process.exit(0);
```

- [ ] **Step 3: Wire the script.** In root `package.json` scripts add:

```json
"check:sfw": "node scripts/check-sfw.mjs",
```

- [ ] **Step 4: Verify both directions.** Run: `sfw pnpm check:sfw` → expected exit 0. Then simulate absence: `PATH=/usr/bin node scripts/check-sfw.mjs` → expected: exit 1 with the install message (adjust the stripped PATH if sfw lives in /usr/bin on this machine — the point is to see the failure text once).

- [ ] **Step 5: Commit.**

```bash
git add scripts/check-sfw.mjs package.json
git commit -m "build: add sfw presence check script"
```

### Task 3: Pre-push hook running the full repo gates

**Files:**

- Create: `.husky/pre-push`

**Interfaces:**

- Consumes: Task 1's zero-warnings lint, Task 2's `check:sfw`.
- Produces: `git push` runs the full gates; a red gate blocks the push. Pre-commit stays staged-only (unchanged).

- [ ] **Step 1: Write the hook.** Create `.husky/pre-push` (husky 9 style — plain shell, no sourcing boilerplate):

```sh
node scripts/check-sfw.mjs
sfw pnpm lint
sfw pnpm format:check
sfw pnpm typecheck
sfw pnpm test
```

Make it executable: `chmod +x .husky/pre-push`.

- [ ] **Step 2: Verify the hook fires and passes.** Run: `git push --dry-run origin HEAD` — expected: the four gates run (watch the output), then the dry-run completes. (`--dry-run` still triggers pre-push.)

- [ ] **Step 3: Verify the hook blocks.** Re-create the Task 1 Step 4 scratch warning file, run `git push --dry-run origin HEAD` → expected: push aborted at `sfw pnpm lint`. Delete the scratch file.

- [ ] **Step 4: Commit.**

```bash
git add .husky/pre-push
git commit -m "build: run full repo gates on pre-push"
```

### Task 4: pnpm supply-chain hardening (minimum release age + lifecycle-script lockdown)

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root — `packageManager` field, only if the docs check requires a newer pnpm)

**Interfaces:**

- Produces: repo-wide pnpm settings — a minimum release age for every new dependency version, and lifecycle scripts blocked except the audited allowlist. Binds every later plan's installs and CI.

- [ ] **Step 1: Verify the exact setting names and units from the official docs — never memory.** Rover-fetch `https://pnpm.io/settings` (and `https://pnpm.io/npmrc` if settings are split there). Record: (a) the exact key for minimum release age (e.g. `minimumReleaseAge`), its **units**, and the pnpm version that introduced it; (b) where pnpm 10 reads it (`pnpm-workspace.yaml` vs `.npmrc`); (c) the current semantics of `onlyBuiltDependencies` / whether an explicit "block all lifecycle scripts" key exists.

- [ ] **Step 2: Ensure the installed pnpm supports the setting.** Run: `sfw pnpm --version`. If the docs say the minimum-release-age key needs a newer pnpm than `packageManager` pins (`pnpm@10.0.0`), bump the root `package.json` `packageManager` field to the latest pnpm 10.x from the docs, run `corepack enable && sfw pnpm --version` to confirm, and note the bump for the retro.

- [ ] **Step 3: Apply the settings.** Edit `pnpm-workspace.yaml` — keep the existing `packages:` block, extend the rest to (adapt key names/units to what Step 1 verified):

```yaml
# Supply-chain hardening (P0): new dependency versions must be at least this old
# before pnpm will install them — freshly-published (potentially poisoned)
# releases are quarantined. Units per pnpm docs (verified 2026-07-23).
minimumReleaseAge: 10080 # 7 days, in minutes — CORRECT THE UNITS to match the docs

# Dependency lifecycle scripts are blocked by default (pnpm 10). This allowlist
# is the ONLY set of packages permitted to run build scripts. Every entry needs
# a justification comment; additions require a code-reviewed PR.
onlyBuiltDependencies:
  - esbuild # native binary bootstrap; vitest/vite are unusable without it
```

- [ ] **Step 4: Prove installs still work.** Run: `sfw pnpm install`. Expected: exit 0, lockfile unchanged (`git diff --exit-code pnpm-lock.yaml`). Then prove the age gate is live: `sfw pnpm add left-pad@latest --dir /tmp/pnpm-age-probe --ignore-workspace 2>&1 | head -20` is NOT a valid probe inside the repo — instead check `sfw pnpm config get minimumReleaseAge` (or the docs' equivalent) prints the configured value. If the key is unrecognized (typo'd or unsupported), treat as failure and fix.

- [ ] **Step 5: Run the full gates** (`sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test`). Expected: all green — proving the script lockdown broke nothing (if a package now fails from a blocked lifecycle script, add it to the allowlist WITH a justification comment and note it in the retro).

- [ ] **Step 6: Commit.**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "build: enforce minimum release age and lifecycle-script allowlist"
```

### Task 5: CI mirrors the hardened local gates

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: Task 1's zero-warnings lint (CI runs the same root scripts).
- Produces: CI = sfw-wrapped install + the exact four local gates. Every P1–P6 PR merges only through this.

- [ ] **Step 1: Wrap the CI install in sfw.** Edit `.github/workflows/ci.yml` — after the `actions/setup-node` step and before install, add sfw installation, and wrap the install (use the install command Task 2 Step 1 verified from docs.socket.dev):

```yaml
- run: npm install -g sfw
- run: sfw pnpm install --frozen-lockfile
- run: sfw pnpm lint
- run: sfw pnpm format:check
- run: sfw pnpm typecheck
- run: sfw pnpm test
```

(Replace the existing four bare `pnpm` gate lines and the bare install line; keep checkout/pnpm/node steps as-is.)

- [ ] **Step 2: Lint the workflow.** Run: `npx --yes actionlint@latest .github/workflows/ci.yml` via `sfw` if wrapping npx is supported, otherwise read the diff carefully against YAML syntax. Expected: no findings.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: wrap installs in socket firewall and mirror local gates"
```

(CI proof happens at this plan's own PR — the protocol's `gh pr checks --watch` step is the test.)

### Task 6: Conventions documented (commitlint verified + CONTRIBUTING)

**Files:**

- Create: `CONTRIBUTING.md`
- Modify: `CLAUDE.md` (Commands section — one line)

**Interfaces:**

- Produces: the written convention every autonomous agent and human follows; commitlint config confirmed enforcing it.

- [ ] **Step 1: Verify commitlint enforces conventional commits.** Run: `echo "Bad Subject Line" | sfw pnpm commitlint` → expected: non-zero with `subject-case`/`type-empty` errors. Then: `echo "docs: verify commitlint" | sfw pnpm commitlint` → expected: exit 0.

- [ ] **Step 2: Write CONTRIBUTING.md** at the repo root:

```markdown
# Contributing

## Commits

Conventional Commits, enforced by commitlint (`@commitlint/config-conventional`):

- `type(scope): subject` — subject **lowercase** (no leading acronym/uppercase word), header ≤ 72 chars.
- Types in use: `feat`, `fix`, `build`, `ci`, `docs`, `test`, `refactor`, `chore`.
- Never `--no-verify`.

## Toolchain (supply-chain rules)

- Host-side: **always `sfw pnpm …`** (Socket Firewall), never bare `pnpm`, never `npm`.
  `node scripts/check-sfw.mjs` verifies sfw is installed.
- New dependency versions are quarantined by a minimum release age (see
  `pnpm-workspace.yaml`); dependency lifecycle scripts are blocked except the
  audited `onlyBuiltDependencies` allowlist — additions need a justified, reviewed PR.
- Inside the user-facing WebContainer runtime only: plain `npm`.

## Gates

`sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test`
must pass with **zero warnings** before any push (pre-push hook enforces; CI mirrors).
```

- [ ] **Step 3: Add the CLAUDE.md pointer.** In `CLAUDE.md`'s `## Commands` line, append: `· pre-push runs full gates + sfw check (see CONTRIBUTING.md)`.

- [ ] **Step 4: Commit.**

```bash
git add CONTRIBUTING.md CLAUDE.md
git commit -m "docs: contributing conventions and supply-chain rules"
```

### Task 7: Retro

**Files:**

- Create: `docs/superpowers/plans/retros/P0_RETRO.md`

- [ ] **Step 1: Write `docs/superpowers/plans/retros/P0_RETRO.md`** with, in detail: **Deviations** from this plan (what changed, why, evidence); **Discoveries** (exact pnpm version + setting keys/units verified from docs, sfw install command verified from docs.socket.dev, any allowlist additions); **Deferred items** (should be none — justify per the No-Deferral Policy if any); **Impact on remaining plans** (e.g. if the pnpm bump or CI sfw wrapping changes what P5's Dockerfile/preflight must do).

- [ ] **Step 2: Commit.**

```bash
git add docs/superpowers/plans/retros/P0_RETRO.md
git commit -m "docs: p0 retro"
```

Then execute the **PR / CI / merge** steps of the Autonomous Execution Protocol and proceed to `docs/superpowers/plans/2026-07-23-p1-spikes-foundation.md`.
