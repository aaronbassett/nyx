# P2 — Browser Compile (`@nyx/compact-wasm` + ArtifactStore + Compile Service retirement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-generated Compact contracts compile (and generate keys/ZKIR) in the user's browser via the vendored compactc/zkir wasm toolchain; compiled artifacts upload to a server-side `ArtifactStore` that serves the same `urlPrefix` contract R2 did; the Compile Service, its config, and the R2 write architecture are retired.

**Architecture:** A new `@nyx/compact-wasm` package vendors the wasm toolchain behind a typed API. A Web Worker in `apps/web` hosts it; a WS `compile:run`/`compile:results` round-trip (mirroring `verify:run`/`test:results`) lets the server's turn loop delegate compiles to the connected client via a new `BrowserCompileClient` that implements the _existing_ `CompileClient` interface, so `ArtifactOrchestrator` (incl. `verifyPrefix`) runs unchanged. Artifacts land server-side through staged `PUT file` + `commit manifest-last` routes backed by a `LocalArtifactStore`, preserving the manifest-last completeness marker `verifyPrefix` depends on.

**Tech Stack:** TypeScript/Node ≥22, Fastify 5, zod (`@nyx/protocol` is the single event-shape source of truth), vitest, Web Worker, vendored Emscripten/wasm-pack outputs (compactc pb-bytecode Chez build + patched `zkir-v2`).

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md` (§4 is this plan's spec). SPIKE reports `docs/superpowers/plans/retros/SPIKE1_REPORT.md` / `SPIKE2_REPORT.md` are AUTHORITATIVE for the compiler pin, vendor source commit, and toolchain version metadata. **Folded in (Task 0, 2026-07-23):** the wasm compiler is pinned at the **`compactc-v0.31.1` release, commit `0da5b0452eb0c1053d42418bf34b12cc29c7d63e`** (SPIKE-1 §Compiler pin decision) — rebuilt at that pin its generated JS, ZKIR, and keys are **byte-identical to the native 0.31.1 toolchain** (SPIKE-1 §6); toolchain versions: compiler `0.31.1`, language `0.23.0`, runtime `0.16.0` (`checkRuntimeVersion('0.16.0')` — matches the repo's pinned `@midnight-ntwrk/compact-runtime@0.16.0`), zkir `2.1.0` (v2.0 JSON IR; zkir-v3 REJECTS it). Never bump any of these alone — compiler pin, compact-runtime, onchain-runtime, midnight-js, ledger/proof-server/node move as ONE lockstep row (SPIKE-1 §Runtime-version strategy).
- **NO `checkRuntimeVersion` bypass/stripping ANYWHERE** (SPIKE-1): at the 0.31.1 pin generated code asserts `0.16.0` and that is what is installed — the bypass is not needed, and at other pins it does not even suffice (real signature incompatibility). Treat a version-check failure as a stack-drift signal, never strip it. Any shim/loader that patches `checkRuntimeVersion` out is a defect.
- Supply-chain (P0 retro): pnpm is `10.34.5` (`packageManager`), `minimumReleaseAge` 10080 min (7 days) — any dependency published < 7 days ago is refused (scoped `minimumReleaseAgeExclude` with justification, never a global lowering). Any NEW dependency needing a lifecycle/build script must be added to `onlyBuiltDependencies` in `pnpm-workspace.yaml` with a justification comment. The vendored wasm artifacts are prebuilt + committed precisely so no install-time build script is needed.
- Trust model: user code compiles on the user's machine; artifacts cross to the server ONLY for deploys, via an ownership-gated, size-capped upload. Ownership denials are **404, never 403** (SC-027).
- `@nyx/protocol` is imported `workspace:*`, JIT source-pointing exports, no build step. New package `@nyx/compact-wasm` follows the same pattern; its tsconfig must NOT set `rootDir: "src"` and must set `noEmit`.
- Compile failure is DATA (`ok:false` / `status:"failed"`), never a throw. D35: green tests are the sole full-compile trigger — this plan changes WHO compiles, never WHEN.
- Bounded everything: every WS wait has an injectable timeout; a silent/closed tab is a failed cycle, never a hang (D42 discipline).
- Constitution I: never hand-write Compact/`@midnight-ntwrk/*`/wasm-module shapes from memory — steps below name the verification procedure (read the vendored driver, read installed types, execute).
- Money untouched: this plan must not modify ledger/deposit/settle code paths.
- Commit subjects lowercase, conventional commits, header ≤72 chars; never `--no-verify`; `sfw pnpm` for every host-side command; plain `npm` only inside the WebContainer runtime.
- Warnings are errors: `--max-warnings 0`, TS strict, prettier clean (P0 gates are live).
- Vendored wasm assets (`packages/compact-wasm/vendor/**`) are COMMITTED, but excluded from eslint/prettier/typecheck globs (same treatment as `**/build/**`).

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p2-browser-compile` off up-to-date `main` before the first task.

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
5. **Immediately** check out `main`, pull, open the next plan (`docs/superpowers/plans/2026-07-23-p3-dev-wallet-money.md`), and begin it — starting with its Task 0 re-planning preamble. Do not pause between plans.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- Server/web TypeScript tasks (protocol events, worker, client, ArtifactStore, routes, BrowserCompileClient, wiring): `devs:typescript-dev`.
- Every constitution-I verification step (wasm API surface, zkir behavior, runtime-version claims): the `midnight-verify:verify` skill / `midnight-verify:*` agents — name the claim, demand Confirmed/Refuted evidence.
- Anything touching Compact sources or the vendored compiler behavior: `compact-core:compact-dev`.
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches.

**Model routing — which model runs what:**

- Implementation dispatches (`devs:typescript-dev`, `compact-core:compact-dev`) and `midnight-verify:*` verification dispatches run on **Opus**: pass `model: "opus"` in the Agent call.
- Review dispatches (`devs:code-reviewer`) run on **Opus** by default. Escalate a review to **Fable 5** when the diff touches the artifact-route ownership gating or the `CompileResultsInbox` projectId binding (cross-tenant surfaces — the US1 lesson class), or when a finding is still disputed after one fix loop.
- **Fable 5 is reserved** for the orchestrating session itself and the Task 0 re-planning subagent ("do not downgrade" in Task 0 stands). Never run routine implementation on Fable.

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

Write `docs/superpowers/plans/retros/P2_RETRO.md` before opening the PR. Contents, in detail:

- **Deviations** from this plan: what changed, why, and the evidence that forced it.
- **Discoveries**: verified facts (SDK shapes, tool behaviors, version constraints) that future plans must know — be specific, include exact names/versions.
- **Deferred items** (should be none): each with justification per the No-Deferral Policy.
- **Impact on remaining plans**: which upcoming tasks are now wrong/obsolete/missing, so the next plan's re-planning preamble can act on it.

---

### Task 0: Re-planning preamble

- [ ] **Step 1: Dispatch a Fable 5 re-planning subagent.** Use the Agent tool (the session model is Fable 5; do not downgrade the model for this dispatch). Give it: this plan file's path, all remaining plan files' paths (`2026-07-23-p3-dev-wallet-money.md`, `2026-07-23-p4-deploy-engine.md`, `2026-07-23-p5-demo-orchestrator.md`, `2026-07-23-p6-ui-workspace.md`), the design doc (`docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md`), every `docs/superpowers/plans/retros/*_RETRO.md`, and **both spike reports** (`SPIKE1_REPORT.md`, `SPIKE2_REPORT.md` — this plan's vendor pin, toolchain version metadata, and wasm API adapter shape MUST be rewritten from SPIKE-1's findings before any implementation). Instruct it to inspect `git log --oneline` since the plans were authored plus the current state of the files each plan touches. Its job: reconcile this plan and all remaining plans with reality — completed/obsolete tasks removed, interface drift corrected (exact names/signatures from the code as it now exists), retro discoveries folded in, missing tasks added. It edits the plan files directly.
- [ ] **Step 2: Review the subagent's plan edits** (`git diff` on `docs/superpowers/plans/`). You are accountable for the updated plan — sanity-check that edits are grounded in retros/code, not speculation.
- [ ] **Step 3: Commit** the updated plans: `git commit -m "docs: re-plan p2+ from retros and current state"`.
- [ ] **Step 4: Execute THIS plan as amended.**

---

### Task 1: `compile:run` / `compile:results` protocol events

**Files:**

- Modify: `packages/protocol/src/events.ts` (add schemas; register in both unions at `events.ts:234` and `events.ts:330`)
- Modify: `packages/protocol/src/index.ts` (re-export new names — match how existing event names are exported)
- Test: `packages/protocol/src/events.test.ts` (append)

**Interfaces:**

- Consumes: `eventSchema` helper (`events.ts:29`), `TurnIdSchema` (`primitives.ts`).
- Produces (later tasks rely on these exact names): `CompileKindSchema`/`CompileKind` (`"check" | "full"`), `CompileDiagnosticSchema`/`CompileDiagnostic`, `CompileCircuitWireSchema`, `CompileRunPayloadSchema`/`CompileRunPayload` `{ turnId, kind }`, `CompileRunEventSchema` (server→client `"compile:run"`), `CompileResultsPayloadSchema`/`CompileResultsPayload` `{ turnId, kind, ok, diagnostics, compilerVersion, durationMs, sourceHash?, circuits? }`, `CompileResultsEventSchema` (client→server `"compile:results"`).

- [ ] **Step 1: Write the failing tests** (append to `packages/protocol/src/events.test.ts`, following the file's existing per-event describe style):

```ts
describe("compile:run / compile:results (P2 browser compile)", () => {
  const turnId = "turn-1";

  it("accepts a server->client compile:run frame", () => {
    const parsed = parseServerToClientEvent({
      type: "compile:run",
      payload: { turnId, kind: "check" },
      ts: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects compile:run with an unknown kind", () => {
    const parsed = parseServerToClientEvent({
      type: "compile:run",
      payload: { turnId, kind: "half" },
      ts: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a failing check compile:results with diagnostics", () => {
    const parsed = parseClientToServerEvent({
      type: "compile:results",
      payload: {
        turnId,
        kind: "check",
        ok: false,
        diagnostics: [
          {
            severity: "error",
            source: "compactc",
            message: "undeclared identifier",
            file: "contract.compact",
            span: { start: { line: 3, column: 7 } },
          },
        ],
        compilerVersion: "0.31.1",
        durationMs: 812,
      },
      ts: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a green full compile:results carrying sourceHash + circuits", () => {
    const parsed = parseClientToServerEvent({
      type: "compile:results",
      payload: {
        turnId,
        kind: "full",
        ok: true,
        diagnostics: [],
        compilerVersion: "0.31.1",
        durationMs: 4021,
        sourceHash: "a".repeat(64),
        circuits: [{ name: "deposit", proof: true }],
      },
      ts: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a green full compile:results WITHOUT sourceHash", () => {
    const parsed = parseClientToServerEvent({
      type: "compile:results",
      payload: {
        turnId,
        kind: "full",
        ok: true,
        diagnostics: [],
        compilerVersion: "0.31.1",
        durationMs: 4021,
      },
      ts: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `sfw pnpm --filter @nyx/protocol test`
Expected: FAIL (unknown event type `compile:run`).

- [ ] **Step 3: Implement the schemas** in `packages/protocol/src/events.ts`. Place `CompileRunPayloadSchema`/event with the server→client block (near `VerifyRunEventSchema`, `events.ts:168`), and `CompileResultsPayloadSchema`/event with the client→server block (near `TestResultsEventSchema`, `events.ts:281`):

```ts
/** Compile kinds (P2): a fast per-cycle `check` vs the green-only `full` compile (D35). */
export const CompileKindSchema = z.enum(["check", "full"]);
export type CompileKind = z.infer<typeof CompileKindSchema>;

/** One structured diagnostic relayed verbatim from the browser toolchain (P2). */
export const CompileDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning", "note"]),
  source: z.enum(["compactp", "compactc"]),
  message: z.string(),
  file: z.string().optional(),
  span: z
    .object({
      start: z.object({ line: z.number(), column: z.number() }),
      end: z.object({ line: z.number(), column: z.number() }).optional(),
    })
    .optional(),
  code: z.string().optional(),
});
export type CompileDiagnostic = z.infer<typeof CompileDiagnosticSchema>;

/** One compiled circuit named in a green full result (P2). */
export const CompileCircuitWireSchema = z.object({
  name: z.string().min(1),
  proof: z.boolean(),
});
export type CompileCircuitWire = z.infer<typeof CompileCircuitWireSchema>;

/**
 * `compile:run` — the server delegates this turn's compile to the CLIENT'S wasm
 * toolchain (design §4: user code builds on the user's machine). The client
 * replies with `compile:results` carrying the same `turnId` + `kind`.
 */
export const CompileRunPayloadSchema = z.object({
  turnId: TurnIdSchema,
  kind: CompileKindSchema,
});
export type CompileRunPayload = z.infer<typeof CompileRunPayloadSchema>;
export const CompileRunEventSchema = eventSchema("compile:run", CompileRunPayloadSchema);
export type CompileRunEvent = z.infer<typeof CompileRunEventSchema>;

/**
 * `compile:results` — the client's compile verdict. A failure is DATA
 * (`ok:false` + diagnostics), never an error frame. A green `full` result MUST
 * carry the `sourceHash` the client uploaded artifacts under.
 */
export const CompileResultsPayloadSchema = z
  .object({
    turnId: TurnIdSchema,
    kind: CompileKindSchema,
    ok: z.boolean(),
    diagnostics: z.array(CompileDiagnosticSchema),
    compilerVersion: z.string().min(1),
    durationMs: z.number().nonnegative(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u, "must be a lowercase sha-256 hex source hash")
      .optional(),
    circuits: z.array(CompileCircuitWireSchema).optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.kind === "full" && payload.ok && payload.sourceHash === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceHash"],
        message: "a green full compile must carry the uploaded sourceHash",
      });
    }
  });
export type CompileResultsPayload = z.infer<typeof CompileResultsPayloadSchema>;
export const CompileResultsEventSchema = eventSchema(
  "compile:results",
  CompileResultsPayloadSchema,
);
export type CompileResultsEvent = z.infer<typeof CompileResultsEventSchema>;
```

Register `CompileRunEventSchema` in `ServerToClientEventSchema` (`events.ts:234`) and `CompileResultsEventSchema` in `ClientToServerEventSchema` (`events.ts:330`). NOTE: `z.discriminatedUnion` requires plain object schemas — the `superRefine` wraps the PAYLOAD schema, not the event envelope, so the envelope stays a plain `z.object` and the union registration is unaffected. Re-export every new name from `packages/protocol/src/index.ts` in the same style the file already uses.

- [ ] **Step 4: Run to verify pass**

Run: `sfw pnpm --filter @nyx/protocol test`
Expected: PASS (all protocol tests, existing + new).

- [ ] **Step 5 (OPTIONAL but recommended — coverage-protocol enrichment, P1 retro F1):** while touching `events.ts`, add an OPTIONAL `passedNames?: z.array(z.string())` field to `TestResultsPayloadSchema` (additive, backward-compatible — existing emitters/parsers unaffected). Grounding: the P1 review found the FR-032 coverage telemetry is information-free on real green runs because the wire DTO carries FAILING names only (`failures[]`) — green ⇒ no names ⇒ all-uncovered report (see the honest-gap comment at `apps/server/src/turn/coordinator.ts:765-771`). The consuming changes (web `container/testrunner.ts` emitting passing names from the vitest JSON report; server `agents/coverage.ts` `testNamesFromResults` folding them; `capTestResults` cap interaction) are scheduled in P6 — this step only lands the protocol field so P6's change is non-breaking. If skipped, record why in the retro.

- [ ] **Step 6: Gates + commit**

```bash
sfw pnpm --filter @nyx/protocol lint && sfw pnpm --filter @nyx/protocol typecheck
git add packages/protocol && git commit -m "feat(protocol): add compile:run and compile:results events"
```

---

### Task 2: `@nyx/compact-wasm` package (vendored toolchain + typed API)

**Files:**

- Create: `packages/compact-wasm/package.json`, `packages/compact-wasm/tsconfig.json`, `packages/compact-wasm/src/index.ts`, `packages/compact-wasm/src/meta.ts`, `packages/compact-wasm/src/source-hash.ts`, `packages/compact-wasm/src/engine.ts` (seam types), `packages/compact-wasm/src/vendored.ts` (vendor loader), `packages/compact-wasm/scripts/vendor.mjs`, `packages/compact-wasm/vendor.config.json`
- Modify: `pnpm-workspace.yaml` (only if `packages/*` is not already globbed — check first), root `.gitignore`/eslint/prettier ignore files (add `packages/compact-wasm/vendor/**` to LINT ignores, NOT to `.gitignore` — vendor is committed)
- Test: `packages/compact-wasm/tests/source-hash.test.ts`, `packages/compact-wasm/tests/compiler-facade.test.ts`, `packages/compact-wasm/tests/vendored.integration.test.ts` (guarded)

**SPIKE-1 facts this task builds on (all verified by execution — see SPIKE1_REPORT.md):**

- **The vendored artifacts MUST come from a REBUILD of the PoC at compact commit `0da5b0452eb0c1053d42418bf34b12cc29c7d63e` (`compactc-v0.31.1`)** — the PoC repo's committed `web/` artifacts are the HEAD pin (compiler 0.33.109, runtime 0.18.101) whose generated JS hard-fails on the devnet's `compact-runtime@0.16.0` stack. The rebuilt outputs land in `build/out/compactc.{js,wasm,data}` (wasm ~775 KB, boot file ~4.18 MB); the PoC's Node CLI auto-prefers `build/out/`.
- **Build recipe deltas** (Debian/Ubuntu, emscripten 3.1.69 apt, clang-19 — SPIKE-1 §Compiler pin decision): set `COMPACT_REV` in `scripts/00-env.sh`; guard the stage-03 SHA-256 patch on its anchor being present (0.31.1 predates manifest hashing); stage-04 needs the `minify_html` patch guarded, `~/.emscripten-compactc` set to `LLVM_ADD_VERSION/CLANG_ADD_VERSION = '19'`, and the hardcoded `clang-15` → `clang-19`. Stage 03 (whole-program pb compile) takes >10 min — run it in the background, it is incremental and safe to rerun. Verify with the recompile-diff: rebuilt-wasm output vs native `~/.compact/versions/0.31.1` compactc must be **byte-identical** (generated `contract/index.js` incl. `checkRuntimeVersion('0.16.0')`, ZKIR for every circuit).
- **0.31.1 emits NO `contract-manifest.json`** (no output hashing at all) — Nyx computes its OWN hashes (the Task 4 upload manifest + Task 5 store verification already do; nothing may assume a compiler-emitted manifest).
- **`--skip-zk` output has no keys and no `.bzkir`** — keys/`.bzkir` come from a SEPARATE zkir step (`zkir compile-many` semantics, zkir **2.1.0**); the SDK's `NodeZkConfigProvider`-style layout wants `keys/<circuit>.prover|.verifier` + `zkir/<circuit>.bzkir`, which is also Nyx's artifact-prefix layout. Budget the keygen step: `deposit.prover` 2.8 MB, `burn.prover` 5.2 MB, SRS download on first use (served via the Task 9 `/srs/*` route).
- **Browser keygen is GATED, not assumed** (SPIKE-1 risk 1): the published `@midnightntwrk/zkir-v2@2.1.0` wasm has NO `keygen` export; the PoC's keygen-patched build (`scripts/07-build-zkir-wasm.sh`) pins `LEDGER_TAG=ledger-9.1.0.0-rc.3`. SPIKE-2 §F is a strong prior (that ledger-9-rc keygen build produced verifier keys byte-identical to the native toolchain and its keys deployed+proved on devnet), but the SHIPPING gate is: **rebuild the patched zkir wasm at a ledger-8 tag (e.g. `ledger-8.0.2`, the compiler's own pin) and byte-compare its keys against toolchain `zkir compile-many` 2.1.0 output** for the reference circuits — the PoC README documents key-format drift between zkir builds ("v1 prover key" rejections), so same-crate-version is not proof of same-format. If the gate fails, the designed fallback (SPIKE-1 §Runtime-version strategy) is server/compile-time keygen with the toolchain zkir — record whichever path ships in the retro.

**Interfaces:**

- Consumes: SPIKE1_REPORT.md (vendor source repo + commit pin + verified toolchain version strings + the wasm module's real entry shape); SPIKE2_REPORT.md §F (keygen-build prior).
- Produces:
  - `interface CompilerEngine { check(sources: WasmSourceFile[]): Promise<EngineCheckResult>; compile(sources: WasmSourceFile[]): Promise<EngineCompileResult> }` — the raw seam the vendored wasm adapter implements and tests fake.
  - `type WasmSourceFile = { path: string; content: string }`
  - `type WasmDiagnostic = { severity: "error" | "warning" | "note"; source: "compactp" | "compactc"; message: string; file?: string; span?: { start: { line: number; column: number }; end?: { line: number; column: number } }; code?: string }`
  - `type EngineCheckResult = { ok: boolean; diagnostics: WasmDiagnostic[] }`
  - `type CompiledFile = { path: string; bytes: Uint8Array; contentType: string }`
  - `type EngineCompileResult = { ok: boolean; diagnostics: WasmDiagnostic[]; files: CompiledFile[]; circuits: { name: string; proof: boolean }[] }`
  - `createCompiler(deps: { engine: CompilerEngine; now?: () => number }): { check(sources): Promise<{ ok; diagnostics; compilerVersion; durationMs }>; compileFull(sources): Promise<{ ok; diagnostics; compilerVersion; durationMs; sourceHash?; files?; circuits? }> }`
  - `computeSourceHash(sources: WasmSourceFile[], compilerVersion: string, flags: readonly string[]): string` (lowercase sha-256 hex; sorts by path; stable JSON canonicalization)
  - `COMPACT_WASM_META` from `src/meta.ts`: `{ compilerVersion: "0.31.1", languageVersion: "0.23.0", runtimeVersion: "0.16.0", zkirVersion: "2.1.0", compactRev }` — every value READ from `vendor/meta.json` (written by the vendor script from SPIKE-1 evidence), never hardcoded in TS.
  - `loadVendoredEngine(): Promise<CompilerEngine>` — throws a named `VendoredToolchainMissingError` when `vendor/` is absent.

- [ ] **Step 1: Scaffold the package.** `package.json` (JIT pattern — mirror `packages/protocol/package.json` exports style; check it first with `cat packages/protocol/package.json`):

```json
{
  "name": "@nyx/compact-wasm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./meta": "./src/meta.ts"
  },
  "scripts": {
    "vendor": "node scripts/vendor.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint src tests --max-warnings 0"
  }
}
```

Match the root workspace conventions exactly (script names, eslint invocation shape — inspect a sibling package before writing; if siblings rely on root-level lint, drop the local lint script). `tsconfig.json`: extend the repo base, `noEmit: true`, NO `rootDir` (the US5 lesson — `rootDir:"src"` breaks `tests/`).

- [ ] **Step 2: TDD `computeSourceHash`** — write `tests/source-hash.test.ts` first:

```ts
import { describe, expect, it } from "vitest";
import { computeSourceHash } from "../src/source-hash.js";

const A = { path: "a.compact", content: "x" };
const B = { path: "b.compact", content: "y" };

describe("computeSourceHash", () => {
  it("is a lowercase sha-256 hex string", () => {
    expect(computeSourceHash([A], "0.1.0", [])).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("is order-independent over files", () => {
    expect(computeSourceHash([A, B], "0.1.0", [])).toBe(computeSourceHash([B, A], "0.1.0", []));
  });
  it("changes when content, compilerVersion, or flags change", () => {
    const base = computeSourceHash([A], "0.1.0", []);
    expect(computeSourceHash([{ ...A, content: "z" }], "0.1.0", [])).not.toBe(base);
    expect(computeSourceHash([A], "0.2.0", [])).not.toBe(base);
    expect(computeSourceHash([A], "0.1.0", ["--skip-zk"])).not.toBe(base);
  });
});
```

Implement with `node:crypto` `createHash("sha256")` over `JSON.stringify({ files: sortedByPath, compilerVersion, flags })`. This preserves the US2 rule: the hash folds compilerVersion + flags (SC-006 reuse correctness).

- [ ] **Step 3: TDD the `createCompiler` facade** against a fake `CompilerEngine` (`tests/compiler-facade.test.ts`): assert (a) `check` returns `ok`/`diagnostics` from the engine plus `compilerVersion` from meta and a `durationMs` measured with an injected `now`; (b) `compileFull` on `ok:true` computes `sourceHash` via `computeSourceHash` and passes through `files`/`circuits`; (c) `compileFull` on `ok:false` returns diagnostics with NO `sourceHash`/`files`; (d) an engine THROW is caught and surfaced as `ok:false` with a single synthesized `severity:"error", source:"compactc"` diagnostic whose message includes the thrown message (a compile failure is data — the turn loop must never crash on a wasm fault). Implement `src/index.ts` minimally to pass.

- [ ] **Step 4: Vendor script + config.** `vendor.config.json` is the SPIKE-1 parameter surface. ⚠️ Two pins live here: the PoC REPO commit to clone, and the COMPACT source rev the rebuild uses (`COMPACT_REV` in the PoC's `scripts/00-env.sh`) — the latter is the load-bearing `compactc-v0.31.1` pin:

```json
{
  "sourceRepo": "https://github.com/aaronbassett/compactc-wasm.git",
  "compactRev": "0da5b0452eb0c1053d42418bf34b12cc29c7d63e",
  "artifacts": ["build/out/compactc.js", "build/out/compactc.wasm", "build/out/compactc.data"],
  "zkirArtifactsDir": "vendor/zkir-v2-keygen",
  "meta": {
    "compilerVersion": "0.31.1",
    "languageVersion": "0.23.0",
    "runtimeVersion": "0.16.0",
    "zkirVersion": "2.1.0",
    "compactRev": "0da5b0452eb0c1053d42418bf34b12cc29c7d63e"
  }
}
```

(Set the PoC repo commit to whatever the clone resolves at vendoring time and record it too.) The artifacts are NOT the repo's committed `web/*` files (those are the unusable HEAD pin) — they are the `build/out/` outputs of the 0.31.1 REBUILD (facts block above): the vendor flow is clone → set `COMPACT_REV` → run stages 01→04 with the documented emscripten/clang-19 fixups → recompile-diff against the native 0.31.1 toolchain (byte-identical or STOP) → copy `build/out/compactc.{js,wasm,data}` into `packages/compact-wasm/vendor/` → write `vendor/meta.json` from `vendor.config.json.meta`. The zkir keygen wasm is vendored ONLY after the ledger-8 rebuild + byte-compare gate passes (facts block above); until then `zkirArtifactsDir` may be absent and the loader must surface that honestly (a named error, not a silent stub). Run it; commit the vendored files (design: consumers never run the build pipeline).

- [ ] **Step 5: Vendored engine adapter (`src/vendored.ts`).** Constitution I procedure — do NOT write this from memory: first `Read` the vendored `vendor/compactc.js` module surface AND the PoC's Node driver at the pinned commit (`node/compactc.mjs` in the cloned temp dir — the vendor script keeps a copy at `vendor/reference/compactc.mjs` for this purpose; add that to the script) to learn the REAL invocation shape (Emscripten module factory, MEMFS in/out paths, argv convention, `--skip-zk` flag, where JS/ZKIR/metadata outputs land — SPIKE-1 §1 shows `compactc.mjs --skip-zk <src> <out>` writing `contract-info.json` + per-circuit zkir). The adapter must PASS THROUGH the generated JS's `checkRuntimeVersion('0.16.0')` untouched (no-bypass rule, Global Constraints). The full-compile path additionally produces keys/`.bzkir` per circuit via the zkir 2.1.0 step (facts block above — gated keygen wasm, or the recorded fallback). Then implement `loadVendoredEngine()` mapping that real shape onto `CompilerEngine`, translating raw compiler output into `WasmDiagnostic[]` (reuse the PoC's parsing where it exists; keep the adapter thin). `tests/vendored.integration.test.ts` guards like nyxt-vault (`packages/nyxt-vault/package.json:9` pattern), but on file presence:

```ts
import { existsSync } from "node:fs";
const vendored = existsSync(new URL("../vendor/compactc.wasm", import.meta.url));
describe.skipIf(!vendored)("vendored engine (integration)", () => {
  it("check accepts a known-good contract and rejects a known-bad one", async () => {
    const engine = await loadVendoredEngine();
    const good = await engine.check([{ path: "c.compact", content: KNOWN_GOOD }]);
    expect(good.ok).toBe(true);
    const bad = await engine.check([{ path: "c.compact", content: KNOWN_BAD }]);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
  });
});
```

`KNOWN_GOOD` comes from SPIKE-1's proven inputs — the PoC's `web/examples/counter.compact` or the repo's `packages/nyxt-vault/src/nyxt-vault.compact` (`pragma language_version >= 0.23`; both compiled clean at the 0.31.1 pin, SPIKE-1 §1/§6); `KNOWN_BAD` is a mechanical corruption of it (never write fresh Compact from memory). Since vendor/ is committed, this integration test RUNS in CI — that is intentional (it is deterministic and offline).

- [ ] **Step 6: Gates + commit**

```bash
sfw pnpm install   # registers the new workspace package
sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test
git add packages/compact-wasm pnpm-workspace.yaml pnpm-lock.yaml <ignore-files>
git commit -m "feat(compact-wasm): vendored browser toolchain package"
```

---

### Task 3: Web compile worker + `CompileWorkerClient`

**Files:**

- Create: `apps/web/src/compile/worker.ts`, `apps/web/src/compile/client.ts`, `apps/web/src/compile/messages.ts`, `apps/web/src/compile/index.ts` (barrel; the editor Build button in P6 imports `CompileWorkerClient` from here)
- Modify: `apps/web/package.json` (add `"@nyx/compact-wasm": "workspace:*"`)
- Test: `apps/web/tests/compile/client.test.ts`

**Interfaces:**

- Consumes: `createCompiler`, `loadVendoredEngine`, `COMPACT_WASM_META` from `@nyx/compact-wasm`; `WasmSourceFile`.
- Produces:
  - `src/compile/messages.ts`: `type CompileWorkerRequest = { id: number; op: "check" | "full"; sources: WasmSourceFile[] }`; `type CompileWorkerResponse = { id: number; result: CheckOutput | FullOutput } | { id: number; error: string }` where `CheckOutput = { ok; diagnostics; compilerVersion; durationMs }` and `FullOutput = CheckOutput & { sourceHash?; circuits?; files?: { path: string; bytes: Uint8Array; contentType: string }[] }`.
  - `src/compile/client.ts`: `interface WorkerLike { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((e: { data: unknown }) => void) | null; terminate(): void }`; `createCompileWorkerClient(deps?: { worker?: WorkerLike }): CompileWorkerClient`; `interface CompileWorkerClient { check(sources: WasmSourceFile[]): Promise<CheckOutput>; compileFull(sources: WasmSourceFile[]): Promise<FullOutput>; dispose(): void }`.

- [ ] **Step 1: Write failing client tests** driving `createCompileWorkerClient` against a fake `WorkerLike` (echoing scripted responses): request/response correlation by `id` (two in-flight checks resolve to their own callers), an `error` response rejects that call only, `dispose()` terminates. Run `sfw pnpm --filter @nyx/web test` (verified workspace name: `@nyx/web`); expect FAIL.
- [ ] **Step 2: Implement `messages.ts` + `client.ts`** — a promise-map over `postMessage`, monotonically increasing `id`, default worker factory `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` (the standard Vite worker idiom). `Uint8Array` file bytes pass structured-clone; pass their `.buffer`s in the transfer list for the full-compile response path.
- [ ] **Step 3: Implement `worker.ts`** — a thin host: lazily `loadVendoredEngine()` + `createCompiler` on first request, then dispatch `check`/`full` and post the response. Wrap EVERYTHING in try/catch → `{ id, error: String(err) }`; the worker must never die silently. No test drives the real worker (browser-only) — the deterministic suite covers the client against the fake, and the P5 demo smoke exercises the real one.
- [ ] **Step 4: Gates + commit** (`feat(web): compile worker client over @nyx/compact-wasm`).

---

### Task 4: Web `compile:run` handler (worker → upload → `compile:results`)

**Files:**

- Create: `apps/web/src/compile/handlers.ts`, `apps/web/src/compile/upload.ts`
- Test: `apps/web/tests/compile/handlers.test.ts`, `apps/web/tests/compile/upload.test.ts`

**Interfaces:**

- Consumes: `PreviewBridge` seam (`apps/web/src/container/types.ts` — `bridge.on("compile:run", …)` + `bridge.send(event)`; read `types.ts` first: the bridge's server-event map must now include `compile:run`, which it gets automatically from the `@nyx/protocol` union), `CompileWorkerClient` (Task 3), `CompileRunPayload`/`CompileResultsPayload` (Task 1).
- Produces:
  - `upload.ts`: `uploadArtifacts(deps: { fetch?: typeof fetch; baseUrl?: string }, args: { projectId: string; sourceHash: string; compilerVersion: string; files: { path; bytes; contentType }[]; circuits: { name; proof }[] }): Promise<void>` — PUTs every file to `/projects/<projectId>/artifacts/<sourceHash>/files/<path>` (raw body, `content-type` header per file, `credentials: "same-origin"`), then POSTs the manifest to `/projects/<projectId>/artifacts/<sourceHash>/commit` LAST (manifest-last completeness marker, Task 5/6 contract). The manifest body is the §5 shape: `{ sourceHash, compilerVersion, circuits, files: [{ path, sha256, bytes, contentType }] }` with `sha256` computed via `crypto.subtle.digest("SHA-256", bytes)` hex-encoded. A non-2xx on ANY request throws a named `ArtifactUploadError` carrying `path`/`status`.
  - `handlers.ts`: `registerCompileHandlers(deps: { bridge: PreviewBridge; worker: CompileWorkerClient; projectId: string; getSources: () => Promise<WasmSourceFile[]>; upload?: typeof uploadArtifacts; now?: () => number }): Unsubscribe`.

- [ ] **Step 1: TDD `upload.ts`** with an injected fetch mock: correct URLs (path segments percent-encoded per segment, not whole-path), file PUTs happen BEFORE the commit POST, commit body matches the §5 manifest shape — NOTE the web side has NO zod manifest schema (type-only `ArtifactManifest` at `apps/web/src/artifacts/manifest.ts:45`; zod stays out of the web bundle by rule), so assert the recorded body structurally against that type (`sourceHash`/`compilerVersion`/`circuits` + per-file `path`/`sha256`/`bytes`/`contentType`) — the server's `ArtifactManifestSchema` (`apps/server/src/compile/schemas.ts:224`) is the wire authority the Task 6 commit route enforces. A 413 on a PUT throws `ArtifactUploadError` and NO commit is sent.
- [ ] **Step 2: TDD `handlers.ts`** with a fake bridge + fake worker: a `compile:run {kind:"check"}` event → `worker.check(await getSources())` → bridge sends `compile:results` echoing `turnId`, `kind:"check"`, worker verdict; a `{kind:"full"}` green run → upload called with worker outputs → results sent with `sourceHash`+`circuits` AFTER upload resolves; upload FAILURE → results sent with `ok:false` and one synthesized diagnostic naming the upload error (the server must receive a verdict either way — a missing reply would burn the server-side timeout); worker/getSources throw → same `ok:false` synthesized-diagnostic path. Assert the unsubscribe detaches.
- [ ] **Step 3: Implement both minimally; run; pass.**
- [ ] **Step 4: Wire registration point.** Read `apps/web/src/container/preview.ts` (`createPreview`/`launchPreview` coordinator) and register `registerCompileHandlers` where the existing `verify:run`-adjacent handlers are wired, constructing the worker client once per preview session and disposing on teardown. Follow the exact wiring idiom found there; add/extend its tests accordingly.
- [ ] **Step 5: Gates + commit** (`feat(web): compile:run handler with artifact upload`).

---

### Task 5: Server `ArtifactStore` (local-disk + in-memory double)

**Files:**

- Create: `apps/server/src/artifacts/store.ts`, `apps/server/src/artifacts/errors.ts`, `apps/server/src/artifacts/index.ts`
- Test: `apps/server/tests/artifacts/store.test.ts`

**Interfaces:**

- Consumes: `ArtifactManifest`/`ArtifactManifestSchema` (`apps/server/src/compile/schemas.ts:224`), `isSafePath` (`apps/server/src/projects/paths.ts:34`).
- Produces:

```ts
export interface StoredArtifactFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}
export interface ArtifactStore {
  putFile(
    projectId: string,
    sourceHash: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  commit(projectId: string, sourceHash: string, manifest: ArtifactManifest): Promise<void>;
  getManifest(projectId: string, sourceHash: string): Promise<ArtifactManifest | null>;
  getFile(projectId: string, sourceHash: string, path: string): Promise<StoredArtifactFile | null>;
}
export function createLocalArtifactStore(deps: {
  rootDir: string;
  maxFileBytes: number;
  maxBundleBytes: number;
}): ArtifactStore;
export function createInMemoryArtifactStore(deps?: {
  maxFileBytes?: number;
  maxBundleBytes?: number;
}): ArtifactStore;
```

Named errors in `errors.ts`: `ArtifactFileTooLargeError(path, limit)`, `ArtifactBundleTooLargeError(limit)`, `ArtifactHashMismatchError(path)`, `ArtifactManifestIncompleteError(path)` (a manifest listing a file never uploaded), `InvalidSourceHashError(sourceHash)`, plus re-used `UnsafePathError`. All store failures are promise REJECTIONS (repo store pattern).

- [ ] **Step 1: Write the failing behavioral suite** against BOTH impls (parameterized describe — the in-memory double and a `createLocalArtifactStore` rooted in a `fs.mkdtemp` dir): put→commit→getManifest/getFile round-trip; `getManifest` returns `null` BEFORE commit (manifest-last semantics — verifyPrefix must not see a half-uploaded prefix); commit REJECTS `ArtifactHashMismatchError` when a listed sha256 does not match uploaded bytes; commit REJECTS `ArtifactManifestIncompleteError` when the manifest lists a never-uploaded path; `putFile` rejects `UnsafePathError` for `../escape`, absolute, and `.git/…` paths and `InvalidSourceHashError` for a non-`^[a-f0-9]{64}$` hash; per-file and cumulative bundle caps reject with their named errors; a second `commit` for the same `(projectId, sourceHash)` is idempotent (resolves, content-hash-addressed prefixes are immutable).
- [ ] **Step 2: Implement the in-memory double** (a `Map` keyed `projectId/sourceHash` → `{ files: Map<path, StoredArtifactFile & { sha256 }>; manifest: ArtifactManifest | null; totalBytes: number }`); sha256 via `node:crypto`.
- [ ] **Step 3: Implement `createLocalArtifactStore`**: layout `<rootDir>/<projectId>/<sourceHash>/files/<path>` + `<…>/meta/<path>.json` (`{ contentType, sha256, bytes }`) + `<…>/manifest.json` written LAST on commit. `projectId` must also be validated (`/^[A-Za-z0-9-]+$/u` — read the actual project-id shape in `@nyx/protocol` `ProjectIdSchema` first and match it) so no path traversal enters via the id. Every write goes through `isSafePath` + a resolved-path prefix assertion (resolve and verify `startsWith(rootDir)`) — belt and braces.
- [ ] **Step 4: Run; pass. Gates + commit** (`feat(server): artifact store with manifest-last commit`).

---

### Task 6: Artifact HTTP routes + store-backed fetch adapter

**Files:**

- Create: `apps/server/src/artifacts/routes.ts`, `apps/server/src/artifacts/fetch-adapter.ts`
- Modify: `apps/server/src/app.ts` (register routes — read the file first and follow how `registerProjectRoutes` is registered, including how `requireSession` is built and passed)
- Test: `apps/server/tests/artifacts/routes.test.ts`

**Interfaces:**

- Consumes: `ArtifactStore` (Task 5), the `loadOwned` gating idiom (`apps/server/src/projects/routes.ts:63` — reimplement the ~15-line helper locally in `artifacts/routes.ts`; it is private to projects/routes), the encapsulated-scope raw-body parser precedent (READ `apps/server/src/prover/proxy.ts` route registration before writing — mirror its `addContentTypeParser("*", { parseAs: "buffer" })` child-scope pattern so sibling JSON routes are untouched).
- Produces:
  - `registerArtifactRoutes(app, deps: { store: ProjectStore; artifacts: ArtifactStore; requireSession: preHandlerAsyncHookHandler })`:
    - `PUT /projects/:id/artifacts/:sourceHash/files/*` — session + ownership (404 never 403), raw buffer body, `content-type` header recorded, maps store errors: `ArtifactFileTooLargeError`/`ArtifactBundleTooLargeError` → 413, `UnsafePathError`/`InvalidSourceHashError` → 400.
    - `POST /projects/:id/artifacts/:sourceHash/commit` — session + ownership; body zod-parsed with `ArtifactManifestSchema`; `ArtifactHashMismatchError`/`ArtifactManifestIncompleteError` → 422 with the offending `path` in the body; success → 204.
    - `GET /artifacts/:projectId/:sourceHash/*` — SESSION-LESS (mirrors the public R2 read: prefixes are content-hash addressed and unguessable; the WebContainer preview fetches with `credentials:"omit"`). Serves `manifest.json` and files with their stored `content-type`; 404 on anything absent; supports `HEAD` (Fastify serves HEAD for GET routes automatically — verify with a test, don't assume).
  - `fetch-adapter.ts`: `storeFetchAdapter(artifacts: ArtifactStore): typeof fetch` — an in-process `fetch` implementing ONLY what `ArtifactOrchestrator.verifyPrefix` (`compile/orchestrator.ts:373`) uses: GET `<prefix>/manifest.json` → 200 JSON or 404, HEAD any listed file → 200/404, over URLs of the form `<origin>/artifacts/<projectId>/<sourceHash>/<path>` (parse with `new URL`). Return real `Response` objects (`new Response(body, { status })`).

- [ ] **Step 1: Write the failing route tests** using the repo's established `app.inject()` + in-memory-store pattern (READ an existing route test, e.g. `apps/server/tests/projects/`-something, and mirror its session-minting fixture): owner PUT+commit+GET round-trip 200s; non-owner PUT → 404 (never 403); unauthenticated PUT → 401; GET without session → 200 (public read); oversize PUT → 413; bad manifest commit → 422; GET unknown → 404; HEAD listed file → 200.
- [ ] **Step 2: Implement routes; run; pass.**
- [ ] **Step 3: TDD `storeFetchAdapter`** by running the REAL `ArtifactOrchestrator.verifyPrefix` path against it: construct an orchestrator with a stub client whose full compile "succeeds" pointing at an in-memory store prefix; assert `runTurn` reaches `kind:"ready"` when the store is committed and `verification-failed` with `reason:"manifest-missing"` when not.
- [ ] **Step 4: Register in `app.ts`**, following the existing conditional route-group registration (project routes register only when the auth store exists — artifact WRITE routes share that condition; the public GET route registers unconditionally). Update `buildServer` deps type accordingly; grep for every `buildServer({` call site (tests) and pass the in-memory artifact store where required — keep the parameter OPTIONAL with an in-memory default so existing fixtures stay green.
- [ ] **Step 5: Gates + commit** (`feat(server): artifact upload and serve routes`).

---

### Task 7: `CompileResultsInbox` + `BrowserCompileClient`

**Files:**

- Create: `apps/server/src/compile/inbox.ts`, `apps/server/src/compile/browser-client.ts`
- Modify: `apps/server/src/compile/index.ts` (barrel), `apps/server/src/compile/client.ts` (KEEP `CompileClient` + `runCompileJob`; delete only the `HttpCompileClient` class + `CompileServiceClientDeps` in Task 9)
- Test: `apps/server/tests/compile/inbox.test.ts`, `apps/server/tests/compile/browser-client.test.ts`

**Interfaces:**

- Consumes: `CompileResultsPayload` (Task 1), `CompileClient`/`CheckResponse`/`CompileJob` shapes (`compile/client.ts:66`, `compile/schemas.ts`), `CompileJobTimeoutError` (`compile/errors.ts`), the `PendingTestResultsInbox` pattern (`turn/coordinator.ts:385` — projectId-bound ownership, bounded race, `finally` cleanup; copy the pattern, adapt the key).
- Produces:

```ts
// inbox.ts
export interface CompileResultsInbox {
  /** Await the client's compile:results for (turnId, kind), OWNED by projectId. Resolves null on timeout — never rejects. */
  register(
    turnId: string,
    kind: "check" | "full",
    projectId: string,
    timeoutMs: number,
  ): Promise<CompileResultsPayload | null>;
  /** Resolve a pending wait. Ignored when deliveringProjectId does not own the wait (cross-tenant guard — the US1 Defense-4 lesson) or no wait is pending. */
  deliver(payload: CompileResultsPayload, deliveringProjectId?: string): void;
}
export function createCompileResultsInbox(deps: {
  delay: (ms: number) => Promise<void>;
}): CompileResultsInbox;

// browser-client.ts
export interface BrowserCompileSession {
  readonly projectId: string;
  /** Send one server->client event on the project's live connection (wire-encoded upstream). */
  emitCompileRun(payload: CompileRunPayload): void;
}
export interface BrowserCompileClientDeps {
  readonly inbox: CompileResultsInbox;
  readonly session: BrowserCompileSession;
  /** Absolute public origin for urlPrefix construction, e.g. http://localhost:8080 (config.publicOrigin). */
  readonly publicOrigin: string;
  readonly checkTimeoutMs: number;
  readonly fullTimeoutMs: number;
}
/** Per-turn view: forTurn(turnId) returns a CompileClient the orchestrator drives unchanged. */
export function createBrowserCompileClient(deps: BrowserCompileClientDeps): {
  forTurn(turnId: string): CompileClient;
};
```

Semantics (the whole task hangs on these):

- `forTurn(t).check(req)`: `session.emitCompileRun({ turnId: t, kind: "check" })` → `await inbox.register(t, "check", session.projectId, checkTimeoutMs)`. A payload maps to `CheckResponse { ok, diagnostics (wire→server Diagnostic: add raw:false), compilerVersion, durationMs }`. A `null` timeout maps to `ok:false` with ONE synthesized diagnostic (`severity:"error"`, `source:"compactc"`, message naming the timeout) and `compilerVersion:"unknown"` — a dead tab is a failed check, never a hang (D42 discipline).
- `forTurn(t).compile(req)`: emit `{ kind: "full" }`, await with `fullTimeoutMs`. On payload: store a terminal `CompileJob` in a per-instance `Map<jobId, CompileJob>` under `jobId = `${t}:full``— `succeeded` with `result: { urlPrefix: `${publicOrigin}/artifacts/${session.projectId}/${payload.sourceHash}`, sourceHash, compilerVersion, reused: false, circuits }`, or `failed` with `error: { kind: "compile", diagnostics, compilerVersion }`. Return `{ jobId, status, sourceHash }` (empty-string sourceHash is INVALID per schema — on failure use the payload's absent hash by returning `sourceHash: "-".repeat(64)`? NO: return the schema-minimal `sourceHash: "0".repeat(64)` sentinel is dishonest — instead return the real hash when present and `"unknown"` otherwise; `CompileSubmitResponseSchema` is a SERVICE-response schema the browser client does not pass through zod, so the TS type only requires a string. Keep it honest: `payload.sourceHash ?? "unavailable"`). On `null` timeout: throw `new CompileJobTimeoutError(jobId, fullTimeoutMs, "running")` — `runCompileJob`'s caller (the orchestrator, `orchestrator.ts:281`) already maps this to the explicit `timeout` outcome.
- `forTurn(t).pollCompile(jobId)`: return the stored terminal job; unknown id → throw `CompileServiceResponseError(path, 404, "unknown job")` (reuse the existing error). `runCompileJob` always polls at least once — the stored job satisfies it with zero waiting.
- `forTurn(t).version()`: build `CompilerVersions` from `COMPACT_WASM_META` (add `"@nyx/compact-wasm": "workspace:*"` to `apps/server/package.json`) with `skew: { ok: true, detail: "browser wasm toolchain (single pinned bundle)" }`.

- [ ] **Step 1: TDD the inbox** (mirror the `PendingTestResultsInbox` tests if they exist — grep `apps/server/tests` for `inbox`): delivery resolves the matching `(turnId, kind)` wait only; a `check` delivery never resolves a `full` wait; cross-tenant delivery (wrong `deliveringProjectId`) is IGNORED and the owner's later delivery still resolves; timeout resolves `null` and frees the wait; late/duplicate delivery after resolution is a no-op.
- [ ] **Step 2: TDD the browser client** against a scripted inbox + recording session: green check maps payload→`CheckResponse`; check timeout → synthesized failing check; green full → `compile()` returns handle AND `pollCompile` returns the stored `succeeded` job with the exact `urlPrefix` `${publicOrigin}/artifacts/${projectId}/${sourceHash}`; failed full → `failed` job with `kind:"compile"` error; full timeout → `compile()` throws `CompileJobTimeoutError`; then an END-TO-END orchestrator test: real `ArtifactOrchestrator` + browser client + in-memory `ArtifactStore` (committed) + `storeFetchAdapter` → `runTurn` returns `kind:"ready"` and emits `artifacts:ready` exactly once.
- [ ] **Step 3: Implement; run; pass. Gates + commit** (`feat(server): browser-delegating compile client`).

---

### Task 8: Turn-loop wiring (`turnId` threading + coordinator + WS handler)

**Files:**

- Modify: `apps/server/src/compile/orchestrator.ts:165` (`CompileTurnInput` gains `readonly turnId: string`), `apps/server/src/agents/supervisor.ts` (thread the turn's id into every `CompileTurnInput` it constructs — grep `CompileTurnInput` and `changedPaths` to find the construction sites), `apps/server/src/turn/coordinator.ts` (deps + wiring + `compile:results` handler), `apps/server/src/protocol/` event-router registration (read `router.ts`/`events.ts` to mirror the `test:results` handler registration exactly)
- Test: existing supervisor/coordinator suites (updated), plus new cases in `apps/server/tests/turn/`

**Interfaces:**

- Consumes: `createBrowserCompileClient`/`createCompileResultsInbox` (Task 7).
- Produces: `TurnCoordinatorDeps` REPLACES `compileClient: CompileClient` with:

```ts
/** Build the per-connection browser compile factory. Tests inject a fake returning a canned CompileClient. */
readonly makeCompileClient: (session: BrowserCompileSession) => { forTurn(turnId: string): CompileClient };
```

and gains `compileInbox: CompileResultsInbox`. Coordinator wiring changes (post-P1 anchors — `checkCompile` at `coordinator.ts:732`, `runFullCompile` at `coordinator.ts:748`, `orchestratorFor` at `coordinator.ts:635`):

- `checkCompile: (input) => makeClientForProject().forTurn(input.turnId).check(toCheckRequest(input))`
- `runFullCompile`: **⚠️ P1 changed this seam — it is NO LONGER a bare orchestrator call.** The current `runFullCompile` (coordinator.ts:748-791) wraps `orchestratorFor(...).runTurn(input)` in a post-`ready` block that (a) persists the green build via `recordGreenBuildWithinBound` (I2 bounded await, FR-054) and (b) emits FR-032 coverage telemetry — the WHOLE block inside ONE throw-proof guard (I1: an escaping throw would make the supervisor's `withInfraRetry` re-run the compile → duplicate `artifacts:ready`, a D35 breach; proven load-bearing by a P1 test reproducing the 4× retry storm). **This task swaps ONLY where the orchestrator's `client` comes from** — `orchestratorFor` gains the per-turn client (`makeClientForProject().forTurn(input.turnId)` instead of `deps.compileClient`) — and MUST leave the record/coverage guard block byte-for-byte intact. Note `TurnCoordinatorDeps.projectStore` is `Pick<ProjectStore, "commit" | "recordGreenBuild">` (coordinator.ts:200) — untouched here. `makeClientForProject()` builds ONE factory per project state bound to a `BrowserCompileSession` whose `emitCompileRun` wire-encodes a `compile:run` frame through `safeEmit`/`sendOutbound(state.liveCtx, …)` (the same live-ctx deferred-closure binding `orchestratorFor(() => state.liveCtx)` already uses — reuse that exact mechanism).
- Register the `compile:results` client→server handler alongside `test:results` (`coordinator.ts:976-990`): `router.on("compile:results", (payload, ctx) => { deps.compileInbox.deliver(payload, ctx.projectId); })` — the projectId binding is the cross-tenant guard; mirror the exact registration + zod plumbing the `test:results` handler uses.

- [ ] **Step 1: Add `turnId` to `CompileTurnInput`**; fix every construction site (supervisor) and every test fixture that builds one (grep `changedPaths:` under `apps/server`). The orchestrator itself never reads it — no orchestrator behavior change, existing orchestrator tests only need the added field.
- [ ] **Step 2: TDD the coordinator changes**: existing coordinator tests swap `compileClient: fake` → `makeCompileClient: () => ({ forTurn: () => fake })` (mechanical; grep `compileClient` in tests). NEW tests: (a) a turn's check emits a `compile:run {kind:"check"}` frame on the project's connection with the ACTIVE turn's id; (b) a delivered `compile:results` from the owning project resolves the in-flight check; (c) a `compile:results` delivered on a DIFFERENT project's connection is ignored (cross-tenant); (d) no delivery → the check resolves as failing after the injected timeout and the cycle proceeds (turn settles; never hangs); (e) **P1-guard regression: a green full compile through the browser client still records the green build (`projectStore.recordGreenBuild` called once with the outcome's `urlPrefix`/`compilerVersion`) and still survives an injected throwing `logCoverage` without a second compile/`artifacts:ready`** — the P1 tests for this exist (`apps/server/tests/turn/`); they must stay green with only the mechanical seam swap.
- [ ] **Step 3: Implement; run; pass.**
- [ ] **Step 4: Full server suite** (`sfw pnpm --filter @nyx/server test`) — this task touches the money path's turn loop; every existing turn/settle/security test must stay green untouched EXCEPT the mechanical fixture swap. Any behavioral test change beyond the seam swap is a red flag — stop and re-examine.
- [ ] **Step 5: Gates + commit** (`feat(server): delegate turn compiles to the browser toolchain`).

---

### Task 9: Retirement — config, boot wiring, toolchain MCP, docs banner

**Files:**

- Modify: `apps/server/src/config/schema.ts` (remove `COMPILE_SERVICE_URL` `:121`, `COMPILE_SERVICE_TOKEN` `:149`, `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_ACCOUNT_ID` `:152-154`, `R2_PUBLIC_BASE_URL`/`R2_BUCKET` `:143-144`, `MCP_TOOLCHAIN_URL` `:117`; remove `CompileServiceConfig`, `R2ReadConfig`, `secrets.compileServiceToken`, `secrets.r2*`, `mcp.toolchainUrl`; ADD `PUBLIC_ORIGIN` (url, default `http://localhost:8080`) → `config.publicOrigin`, `ARTIFACT_STORE_ROOT` (default `./data/artifacts`), `ARTIFACT_MAX_FILE_BYTES` (default `16_777_216`), `ARTIFACT_MAX_BUNDLE_BYTES` (default `134_217_728`), `COMPILE_CHECK_TIMEOUT_MS` (default `30_000`), `COMPILE_FULL_TIMEOUT_MS` (default `300_000`), `SRS_CACHE_DIR` (optional) — all NEW vars have defaults or are optional, so fixtures need only DELETIONS)
- Modify: `apps/server/src/config/load.ts` (follow the removals through — read it first), `apps/server/src/index.ts:14,127-130` (drop `HttpCompileClient` import/construction; construct `createLocalArtifactStore`, `createCompileResultsInbox`, `makeCompileClient`, pass `artifacts` + new deps into `buildServer`/coordinator), `apps/server/src/mcp/clients.ts` (remove the `toolchain` member from `McpClients`/`createMcpClients`/`probeMcp`/`closeMcpClients` — `clients.ts:16,25,39,51,56`), `apps/server/src/turn/coordinator.ts:143-150` (`TurnCoordinatorMcp` drops `toolchain`), `apps/server/src/agents/implementation.ts` (remove the toolchain-MCP compile tool — `toolchain` dep at `implementation.ts:105-106`, `toolchainCheckTool` at `:122`, the compile-check tool + its instructions references; the per-cycle browser check is now the compile feedback), `apps/server/src/compile/client.ts` (delete `HttpCompileClient` + `CompileServiceClientDeps`; KEEP `CompileClient`, `runCompileJob`, constants), `infra/compile-service/API.md` (prepend banner)
- Test: every fixture the env-var removals break (grep-driven, below), `apps/server/tests/config/` updates

**Interfaces:**

- Produces: `Config` gains `publicOrigin: string` and `artifacts: { rootDir: string; maxFileBytes: number; maxBundleBytes: number; srsCacheDir: string | undefined }` and `tunables` gains `compileCheckTimeoutMs`/`compileFullTimeoutMs`. `PublicConfig` = `Omit<Config, "secrets">` (the `compileService` omission disappears with the field).

- [ ] **Step 1: Enumerate the blast radius BEFORE editing** (the US1 lesson — required env changes break every server-building fixture):

```bash
grep -rln "COMPILE_SERVICE_URL\|COMPILE_SERVICE_TOKEN\|R2_ACCESS_KEY_ID\|MCP_TOOLCHAIN_URL\|compileServiceToken\|toolchainUrl\|HttpCompileClient" apps/server infra apps/web | sort
```

List every hit in your working notes; each one is a required edit in this task.

- [ ] **Step 2: TDD config**: update `apps/server/tests/config` (or equivalent — find the config suite) so a MINIMAL valid env no longer includes the removed vars and DOES resolve `publicOrigin`/`artifacts` defaults; run → fail → implement schema/load changes → pass.
- [ ] **Step 3: Sweep the fixtures** — delete the removed vars from every env fixture found in Step 1; run the full server suite; fix compile errors from the removed `Config` fields (`config.compileService`, `config.r2`, `secrets.compileServiceToken`, `mcp.toolchainUrl`) at every use site.
- [ ] **Step 4: Boot wiring in `index.ts`** — replace `:127-130` with:

```ts
const artifactStore = createLocalArtifactStore({
  rootDir: config.artifacts.rootDir,
  maxFileBytes: config.artifacts.maxFileBytes,
  maxBundleBytes: config.artifacts.maxBundleBytes,
});
const compileInbox = createCompileResultsInbox({ delay: defaultDelay });
const makeCompileClient = (session: BrowserCompileSession) =>
  createBrowserCompileClient({
    inbox: compileInbox,
    session,
    publicOrigin: config.publicOrigin,
    checkTimeoutMs: config.tunables.compileCheckTimeoutMs,
    fullTimeoutMs: config.tunables.compileFullTimeoutMs,
  });
```

(`defaultDelay`: reuse/extract the unref'd-timer delay from `coordinator.ts:292` into a shared util rather than duplicating.) Pass `makeCompileClient` + `compileInbox` to `createTurnCoordinator`, `artifactStore` + `storeFetchAdapter(artifactStore)` into the coordinator's orchestrator deps (`fetchArtifact`), and `artifacts: artifactStore` into `buildServer`.

- [ ] **Step 5: Toolchain MCP removal** — implementation-agent tool + `TurnCoordinatorMcp.toolchain` + `createMcpClients` + config, with their tests. The agent's instructions text mentioning the toolchain tool must be updated in the same commit (grep the agent's instruction builder for "toolchain"/"compile").
- [ ] **Step 6: SUPERSEDED banner** at the very top of `infra/compile-service/API.md`:

```markdown
> **SUPERSEDED (2026-07-23, owner decision — design: docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md §4).**
> The Compile Service is retired. User contracts compile in the user's browser
> (`@nyx/compact-wasm`); artifacts upload to the Nyx server's ArtifactStore.
> This contract is kept for historical reference only. Do not build against it.
```

- [ ] **Step 7: SRS route** — in `app.ts`, when `config.artifacts.srsCacheDir` is set, register `GET /srs/*` serving files from that dir read-only (session-less, same child-scope static idiom as the artifact GET route; path-guard with `isSafePath` + resolved-prefix assertion). Test: 200 for a seeded file, 404 missing, 400 traversal.
- [ ] **Step 8: Full repo gates + commit** (`feat(server)!: retire compile service for browser compile` — the `!` is honest: config surface changed).

---

### Task 10: Web read-path confirmation + R2 reference cleanup

**Files:**

- Modify: `apps/web/src/artifacts/fetch.ts:1-36` (doc comment only — the fetch logic is prefix-generic and stays), `apps/web/src/container/artifacts.ts` (verify the repointer is prefix-generic; doc comment), any `R2_`/"R2" references under `apps/web/src` (grep-driven docs cleanup — no behavior change)
- Test: `apps/web/tests/artifacts.test.ts` (a flat file, not a directory — check before adding) — ADD one case proving a same-origin `/artifacts/...` prefix flows through the fetch-harness plan/report path unchanged (guards against a future absolute-URL assumption).

- [ ] **Step 1:** `grep -rn "R2\|r2" apps/web/src` — update comments/docs to name the ArtifactStore read path; ZERO logic edits (if a logic edit seems needed, stop: the urlPrefix contract was supposed to be byte-compatible — investigate and record in the retro).
- [ ] **Step 2:** Add the same-origin-prefix test; run; pass. Gates + commit (`docs(web): artifact read path now served by nyx artifact store`).

---

### Task 11: Retro + review + PR + merge + continue

- [ ] **Step 1:** Full repo gates from root: `sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test` — zero warnings.
- [ ] **Step 2:** Code-review loop per the Autonomous Execution Protocol (dispatch code-reviewer over `git diff main...HEAD`; fix; re-review until clean). Pay special review attention to: cross-tenant delivery guards (inbox), path traversal (store + routes + SRS), and that NO ledger/settle file was touched.
- [ ] **Step 3:** Write `docs/superpowers/plans/retros/P2_RETRO.md` per the Retro section. Must explicitly cover: the final vendored pin + toolchain versions; the real wasm engine invocation shape discovered in Task 2 Step 5; any drift from the canonical event/interface names (P3–P6 consume them); the upload transport chosen (staged PUT+commit) and its caps; removal of the implementation agent's toolchain tool (P6's agent-context work must know).
- [ ] **Step 4:** Commit retro; push; `gh pr create` (body: plan link, shipped summary, test counts, deviations); `gh pr checks --watch`; fix-push until green; `gh pr merge --merge --delete-branch`.
- [ ] **Step 5:** `git checkout main && git pull`, open `docs/superpowers/plans/2026-07-23-p3-dev-wallet-money.md`, begin its Task 0 immediately.
