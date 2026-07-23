# P0 Retro — Quality Gates & Supply-Chain Hardening

Plan: `docs/superpowers/plans/2026-07-23-p0-quality-gates.md` · Branch: `demo/p0-quality-gates` · Base: `dd405a2`

All seven tasks completed; no deferrals. Commits: `44d8fca` (lint gate) → `c1f9d5a` (check-sfw) → `3dd2b11` (pre-push) → `0a9440f` (pnpm hardening) → `567ad73` (CI) → `caf292c` (docs) → this retro.

## Deviations from the plan

1. **Task 1 — `eslint.config.mjs` untouched.** The plan's conditional fallback (`linterOptions.reportUnusedDisableDirectives`) was unnecessary: ESLint 9 reports unused disable directives at `warn` severity by default, so `--max-warnings 0` alone makes the gate bite. Proven with the scratch-file test (exit 1 on one warning), then removed.
2. **Task 2 — one file beyond the brief.** `scripts/check-sfw.mjs` belongs to no tsconfig, so the `strictTypeChecked`/`projectService` ESLint setup failed it with a parse error. The existing untyped-config override in `eslint.config.mjs` was extended to `scripts/**/*.mjs` (plus `console`/`process` Node globals). Required to keep the zero-warnings gate green; follows the pre-existing pattern for `*.config.mjs`.
3. **Task 3 — explicit `set -e` added to `.husky/pre-push`.** Husky 9 already executes hooks under `sh -e`, so this is explicit-not-behavioral, but it makes exit-on-first-failure visible in the file rather than an inherited runtime property.
4. **Task 4 — `packageManager` bumped `pnpm@10.0.0` → `pnpm@10.34.5`.** Forced, not optional: `minimumReleaseAge` requires pnpm ≥ 10.16.0, and 10.0.0 **also silently ignored the existing `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml`** — esbuild's build script was being skipped on every install (the long-observed "ignored build scripts: esbuild" warning). On 10.34.5 the warning is gone and esbuild's postinstall demonstrably runs. Lockfile unchanged.
5. **Task 5 — two additions beyond the brief's literal text.** (a) sfw pinned in CI (`npm i -g sfw@2.0.6`) instead of unpinned `npm install -g sfw` — the supply-chain guard should not itself be an unpinned head-version install; bump deliberately. (b) Workflow-level `permissions: contents: read` (least privilege). Checkout/pnpm/node steps untouched per the brief.

## Discoveries (doc-verified, never memory)

- `minimumReleaseAge`: units are **minutes**, read from `pnpm-workspace.yaml`, introduced in pnpm **10.16.0** (verified 2026-07-23 at pnpm.io/settings). Configured 10080 = 7 days. Escape hatch for an urgently-needed fresh release: `minimumReleaseAgeExclude` (deliberately unpopulated).
- `onlyBuiltDependencies` is the pnpm **v10** key; pnpm **v11 renames it to `allowBuilds`** — any future pnpm 11 bump must migrate the key or the allowlist silently stops applying (the exact failure mode 10.0.0 had).
- sfw install command per docs.socket.dev: `npm i -g sfw`; current version 2.0.6.
- CI's `pnpm/action-setup@v4` (no version input) resolves pnpm from `packageManager`, so 10.34.5 flows to CI automatically — no workflow change needed for the bump.
- ESLint 9 flat config reports unused disable directives at `warn` by default (no `linterOptions` needed).

## Deferred items

None.

## Impact on remaining plans

- **P1–P6 installs:** any dependency version published < 7 days ago is now refused. If a plan needs a brand-new release, add a scoped `minimumReleaseAgeExclude` entry with a justification comment — never lower the global age.
- **Any new dependency needing a build script** must be added to `onlyBuiltDependencies` with a justification comment via reviewed PR (P2's WASM tooling is the likely candidate).
- **P5 demo orchestrator:** the Dockerfile/preflight must use pnpm ≥ 10.34.5 (corepack from `packageManager`) and install sfw pinned (`npm i -g sfw@2.0.6`, same as CI); the preflight already plans to call `scripts/check-sfw.mjs` — it exists now at that path.
- **Push latency:** pre-push runs the full gates including the whole test suite (~4–6 min today, growing as plans add tests). Autonomous agents must let it finish — never `--no-verify`.
- **Pre-existing zizmor findings** (unpinned `@v4` action tags, artipacked) in `ci.yml`/`release.yml` are repo-wide convention, left as-is; a repo-wide action-pinning pass is a candidate polish task, not P0 scope.
