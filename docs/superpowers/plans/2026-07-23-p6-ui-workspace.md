# P6 — UI Shell, Workspace & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Shell with the full product UI — Landing + Workspace (chat sidebar with token meter and top-up, Monaco code pane with Compact highlighting and save/build/deploy, WebContainer preview) — polished to sell the project to non-technical stakeholders, ending in a demo-ready golden-path rehearsal.

**Architecture:** A minimal two-route shell (no router dependency) mounts the ALREADY-BUILT, tested feature modules (`@/chat`, `@/ledger`, `@/wallet` top-up, `@/container` preview) — this plan is mostly composition plus the new editor feature. The editor follows the demo-shaped US14 semantics: read-only + live-updating during a turn, editable when idle, explicit save via `file:changed` (server task adds the missing handler → `ProjectStore.commit`), unsaved-changes guard on prompt send, user-edit diffs into the next agent turn (FR-080). **P1 made the read path real:** settled turns now persist their files (supervisor `commitFiles` is a REQUIRED dep, bounded `persistTurnFiles` on all four verify-loop endings), so `GET /projects/:id/manifest` + `/files/*` return real `project_files`/`project_file_versions` rows for any project that has run a turn — the editor and the FR-080 diff context read real data, not hollow projects.

**Tech Stack:** React 19, Vite 8, Tailwind v4 + shadcn/ui, `@monaco-editor/react@4.7.0` + `monaco-editor@0.55.1` (already deps), `@nyx/protocol` events, vitest + @testing-library/react + jsdom.

## Global Constraints

- FR-070: the client NEVER computes a balance — every figure rendered comes verbatim from server payloads (the `useLedger` reducer already enforces this; do not undermine it in composition).
- Turn lock (FR-047): while a turn is active the editor is read-only and `file:changed` is rejected server-side — the UI must never offer an interaction the server will reject without explaining why.
- Ownership: all project-scoped calls ride the session cookie; ownership denials are 404, never 403; never trust a client-supplied projectId beyond routing (the server re-checks).
- Contract addresses reach the generated DApp only via the config chokepoint / `VITE_CONTRACT_ADDRESS` env-merge (constitution VII) — the UI displays addresses but never injects them anywhere else.
- Host-side commands: always `sfw pnpm …`, never bare `pnpm`/`npm`. Inside the user's WebContainer only: plain `npm`.
- Warnings are errors; conventional commits (lowercase subject, ≤72 chars); never `--no-verify`.
- Money display: `bigint` in code, formatted via `@/ledger` `formatNyxt` — never `Number()` on amounts.
- New web code lives under `apps/web/src/` following the existing barrel-per-feature pattern (`index.ts` re-export); tests under `apps/web/tests/<feature>/` in the `@testing-library/react` + `data-testid` idiom used by `tests/ledger/*.test.tsx`.

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p6-ui-workspace` off up-to-date `main` before the first task.

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
4. Update the retro if the CI loop forced deviations.
5. P6 is the FINAL plan. After merging, do NOT look for a next plan. Instead: check out `main`, pull, run `pnpm demo -- --check` (all ✓ required), then execute the full golden-path rehearsal from `docs/superpowers/plans/retros/GOLDEN_PATH.md` (Task 12) end-to-end against the running demo stack. Fix anything the rehearsal surfaces (small fixes as direct PRs through the same gates). Only when the rehearsal passes cleanly, report demo-ready status to the human — this is the single intended human touchpoint of the whole plan sequence.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- React components/panels/editor UI: `devs:react-dev`.
- Non-component wiring (reducers, WS handlers, server-side FR-080 context path, routing): `devs:typescript-dev`.
- Monarch grammar port + tokenization snapshots: `devs:typescript-dev`, with the grammar source fetched from LFDT-Minokawa (Rover/octocode) — never written from memory.
- Polish tasks: load the `frontend-design:frontend-design` skill in the executing context (skill, not subagent — it steers the work).
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches.

**Model routing — which model runs what:**

- Implementation dispatches (`devs:react-dev`, `devs:typescript-dev`) run on **Opus**: pass `model: "opus"` in the Agent call.
- Review dispatches (`devs:code-reviewer`) run on **Opus** by default. Escalate a review to **Fable 5** when the diff touches the server-side FR-080 context path or the `file:changed` ownership/turn-lock gating (cross-tenant + agent-context surfaces), or when a finding is still disputed after one fix loop.
- **Fable 5 is reserved** for the orchestrating session itself (including the golden-path rehearsal judgment and the demo-ready report) and the Task 0 re-planning subagent. Never run routine implementation on Fable — including the polish pass, which runs on Opus with the frontend-design skill loaded in the dispatch's context.

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

Write `docs/superpowers/plans/retros/P6_RETRO.md` before opening the PR. Contents, in detail:

- **Deviations** from this plan: what changed, why, and the evidence that forced it.
- **Discoveries**: verified facts (SDK shapes, tool behaviors, version constraints) that future work must know — be specific, include exact names/versions.
- **Deferred items** (should be none): each with justification per the No-Deferral Policy.
- **Impact on remaining work**: anything the golden-path rehearsal or post-demo work must know.

---

### Task 0: Re-planning preamble

- [ ] **Step 1: Dispatch a Fable 5 re-planning subagent.** Use the Agent tool (the session model is Fable 5; do not downgrade the model for this dispatch). Give it: this plan file's path (the last plan), the design doc (`docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md`), every `docs/superpowers/plans/retros/*_RETRO.md` (P0–P5 + spike reports + `P5_FUNDING_EVIDENCE.md`), and instructions to inspect `git log --oneline` since plan authorship plus the current state of the files this plan touches. Its job: reconcile this plan with reality — completed/obsolete tasks removed, interface drift corrected (exact names/signatures from the code as it now exists: the P2 `CompileWorkerClient` surface, the P3 dev-wallet/ceremony/env names, the P4 `deploy:status` payload shape, the P5 demo commands), missing tasks added. It edits this plan file directly.
- [ ] **Step 2: Review the subagent's plan edits** (`git diff` on `docs/superpowers/plans/`). You are accountable for the updated plan — sanity-check that edits are grounded in retros/code, not speculation.
- [ ] **Step 3: Commit**: `git commit -m "docs: re-plan p6 from retros and current state"`.
- [ ] **Step 4: Execute THIS plan as amended.**

---

### Task 1: Minimal shell router

**Files:**

- Create: `apps/web/src/shell/router.tsx`, `apps/web/src/shell/index.ts`
- Test: `apps/web/tests/shell/router.test.tsx`

**Interfaces:**

- Consumes: nothing (history API only — the repo has no router dependency and two routes do not justify one).
- Produces:

```typescript
export type Route = { name: "landing" } | { name: "workspace"; projectId: string };
export function parseRoute(pathname: string): Route; // "/" → landing, "/p/<id>" → workspace
export function routePath(route: Route): string;
export function useRoute(): { route: Route; navigate: (route: Route) => void }; // pushState + popstate
```

- [ ] **Step 1: Write the failing test** `apps/web/tests/shell/router.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseRoute, routePath, useRoute } from "@/shell/router";

afterEach(cleanup);

describe("parseRoute / routePath", () => {
  it("maps / to landing and /p/:id to workspace", () => {
    expect(parseRoute("/")).toEqual({ name: "landing" });
    expect(parseRoute("/p/abc-123")).toEqual({ name: "workspace", projectId: "abc-123" });
    expect(parseRoute("/nonsense/deep")).toEqual({ name: "landing" }); // unknown → landing
    expect(routePath({ name: "workspace", projectId: "x" })).toBe("/p/x");
  });
});

function Probe() {
  const { route, navigate } = useRoute();
  return (
    <div>
      <span data-testid="route-name">{route.name}</span>
      <button data-testid="go" onClick={() => navigate({ name: "workspace", projectId: "p1" })} />
    </div>
  );
}

describe("useRoute", () => {
  it("navigates via pushState and reacts to popstate", () => {
    window.history.pushState({}, "", "/");
    render(<Probe />);
    expect(screen.getByTestId("route-name").textContent).toBe("landing");
    fireEvent.click(screen.getByTestId("go"));
    expect(screen.getByTestId("route-name").textContent).toBe("workspace");
    expect(window.location.pathname).toBe("/p/p1");
  });
});
```

- [ ] **Step 2: Run — FAIL** (`sfw pnpm --filter @nyx/web test -- shell/router`).
- [ ] **Step 3: Implement** `router.tsx`: `parseRoute` with a `/^\/p\/([^/]+)$/` match; `useRoute` = `useState(parseRoute(location.pathname))` + `useEffect` popstate listener + `navigate` doing `history.pushState` then state update. Barrel `shell/index.ts` re-exports.
- [ ] **Step 4: Run — PASS. Gates.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): minimal two-route shell router"`.

---

### Task 2: Session bootstrap with dev-wallet silent sign-in

**Files:**

- Create: `apps/web/src/shell/session.tsx`
- Test: `apps/web/tests/shell/session.test.tsx`

**Interfaces:**

- Consumes: `resumeSession`, `signIn`, `Account` from `@/wallet/auth`; `useWalletConnect` from `@/wallet/useWalletConnect`; the P3 dev wallet (`installDevWallet` runs at app start when `VITE_DEV_WALLET=1`, so detection finds `window.midnight.nyxDev` — confirm exact install entry from the P3 retro).
- Produces: `useSessionBootstrap(deps): { status: "checking" | "signing-in" | "ready" | "error"; account: Account | null; error?: string }` — resume first; if no session and a wallet is detectable, silent connect + SIWE; deps injectable (`{ resume, doSignIn }`) for tests. `SessionProvider`/`useSession` context exposing `{ account }` to Landing/Workspace, plus a wallet chip view model `{ shortAddress: string }`.

- [ ] **Step 1: Failing test**: fake `resume` returning an account → status ready without `doSignIn`; fake `resume` null + `doSignIn` resolving → transitions checking → signing-in → ready and exposes the account; `doSignIn` rejecting → status error with the message rendered. Use `@testing-library/react` `renderHook`-style via a probe component (repo has no `renderHook` import pattern — check `tests/ledger/state.test.tsx` and mirror it).
- [ ] **Step 2: FAIL → implement → PASS. Gates.**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): session bootstrap with silent dev-wallet sign-in"`.

---

### Task 3: Projects client + landing page

**Files:**

- Create: `apps/web/src/shell/projects-client.ts`, `apps/web/src/shell/Landing.tsx`
- Test: `apps/web/tests/shell/projects-client.test.ts`, `apps/web/tests/shell/Landing.test.tsx`

**Interfaces:**

- Consumes: server routes `GET /projects` and `POST /projects` (both `requireSession`-gated — read `apps/server/src/projects/routes.ts:151-206` for the response DTOs and the create request body; the wire DTO types live in `@nyx/protocol` — import type-only, per the web rule).
- Produces:

```typescript
export interface ProjectsClient {
  list(): Promise<ProjectSummary[]>; // name, id, updatedAt, deploy status if present in DTO
  create(name: string): Promise<{ id: string }>;
}
export function createProjectsClient(deps?: {
  fetch?: typeof fetch;
  baseUrl?: string;
}): ProjectsClient;
export function Landing(props: {
  client: ProjectsClient;
  onOpen: (projectId: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: Read the DTOs.** Open `apps/server/src/projects/routes.ts` + the protocol project schemas; note EXACT field names (do not guess `updatedAt` vs `lastActiveAt` — copy what exists; if the list DTO lacks a deploy-status field, render cards without it and note in the retro rather than adding server surface here).
- [ ] **Step 2: Failing client test** — fake fetch: `list()` hits `/projects` with `credentials:"include"`... **verify**: read how existing web clients pass cookies (`@/ledger/client.ts` — same-origin fetch with default credentials; mirror it exactly), decodes the real DTO shape; non-200 → typed error with actionable message (401 → "session expired — reload to sign in again").
- [ ] **Step 3: Failing Landing test** — renders a hero (`data-testid="landing-hero"`, product name + one-line pitch), a card per project (name + relative last-active via a small `timeAgo` util), an empty-state invite when no projects, a "New project" button that calls `create` then `onOpen(id)`; loading + error states have testids.
- [ ] **Step 4: FAIL → implement → PASS. Gates.** Style with the existing shadcn `Card`/`Button` components (`@/components/ui`), matching `Shell.tsx`'s current idiom.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): landing page with project cards and create flow"`.

---

### Task 4: Workspace layout frame (split + collapse)

**Files:**

- Create: `apps/web/src/workspace/Layout.tsx`, `apps/web/src/workspace/index.ts`
- Test: `apps/web/tests/workspace/Layout.test.tsx`

**Interfaces:**

- Produces: `WorkspaceLayout({ sidebar, codePane, previewPane }: { sidebar: ReactNode; codePane: ReactNode; previewPane: ReactNode })` — left sidebar (fixed min/max width), main area = resizable Code | Preview split (pointer-drag divider storing a `%` in state, double-click resets to 50/50), per-side collapse buttons (`data-testid="collapse-code"` / `"collapse-preview"`); both visible by default (the design's "money shot" is agent-writes + HMR side by side).

- [ ] **Step 1: Failing test** — renders all three slots; clicking `collapse-code` hides the code slot and shows an expand affordance; divider has `role="separator"` and `aria-orientation="vertical"`. (Pointer-drag math is a pure function `nextSplit(clientX, containerRect): number` — unit-test it directly: clamps to [20, 80].)
- [ ] **Step 2: FAIL → implement — PASS. Gates.** CSS grid `grid-template-columns: minmax(280px, 340px) 1fr`; the split via inline `style={{width: pct + "%"}}` flex children; no new deps.
- [ ] **Step 3: Commit** — `git commit -m "feat(web): workspace layout with resizable code/preview split"`.

---

### Task 5: Sidebar — chat, turn progress, meter, top-up modal

**Files:**

- Create: `apps/web/src/workspace/Sidebar.tsx`, `apps/web/src/workspace/TurnProgress.tsx`, `apps/web/src/workspace/TopUpModal.tsx`
- Test: `apps/web/tests/workspace/Sidebar.test.tsx`, `apps/web/tests/workspace/TurnProgress.test.tsx`

**Interfaces:**

- Consumes: `Chat` + `ChatBridge` + `useTurnState`/`TurnState` from `@/chat`; `BalanceCard`, `EntryFeed`, `LowBalanceNudge`, `useLedger`, `formatNyxt` from `@/ledger`; `TopUp` (props = `UseTopUpOptions` seams: `DepositClient`, `DepositCeremony` ← P3's `createDevWalletCeremony`, `DepositSubscription`, `TopUpClock`) from `@/wallet/topup`; a shadcn `Dialog` (add `components/ui/dialog.tsx` via the existing shadcn pattern if not present — copy the idiom of `components/ui/button.tsx`, no CLI).
- Produces: `Sidebar({ bridge, projectId, ledger, onTopUpOpen, ... })` composing: `Chat` (flex-1 scroll), `TurnProgress` strip, compact `BalanceCard` + entry-feed disclosure (collapsible section showing `EntryFeed`), `LowBalanceNudge`, and `TopUpModal` (Dialog hosting `TopUp`). `TurnProgress({ state: TurnState })` renders the stage strip: classify → reserve → cycle n/3 → settle.

- [ ] **Step 1: Read `@/chat/turn-state.tsx`** (`TurnState` shape, which actions/stages it exposes) and pick the exact fields for the strip — the strip is a PURE view over `TurnState`; if `TurnState` lacks an explicit stage enum, derive one in a pure exported function `turnStage(state: TurnState): { label: string; cycle?: number } | null` and unit-test the derivation from real `ChatAction` sequences (copy event fixtures from `tests/chat/turn-state.test.tsx`).
- [ ] **Step 2: Failing `TurnProgress` test** — no active turn → renders nothing; mid-cycle state → shows "cycle 2/3" with the earlier stages marked done; settle → strip clears after the terminal event.
- [ ] **Step 3: Failing `Sidebar` test** — chat renders with the injected fake bridge; BalanceCard shows the fake ledger's `available`/`reserved` verbatim (FR-070 — values come from the injected state, NEVER computed); clicking the top-up CTA opens the modal (`data-testid="topup-modal"`); the entry-feed disclosure toggles.
- [ ] **Step 4: FAIL → implement → PASS. Gates.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): workspace sidebar composing chat, meter, and top-up modal"`.

---

### Task 6: Real ledger WS bridge (US12 wiring gap)

**Files:**

- Create: `apps/web/src/ledger/bridge.ts`
- Modify: `apps/web/src/ledger/index.ts` (export it)
- Test: `apps/web/tests/ledger/bridge.test.ts`

**Interfaces:**

- Consumes: `LedgerBridge` type from `@/ledger/types` (the injectable seam `useLedger` folds over — read its exact `{ on(type, handler): Unsubscribe }` shape); `PreviewBridgeConnection` from `@/container/ws-client` (structural `send`/`on`).
- Produces: `createWsLedgerBridge(connection: Pick<PreviewBridgeConnection, "on">): LedgerBridge` — adapts the live WS connection's `ledger:update` and `turn:settled` subscriptions to the `LedgerBridge` seam. This closes the "real WS bridge wiring" owner-gated note from Phase 13.

- [ ] **Step 1: Failing test** — a fake connection records subscriptions; emitting a `ledger:update` event through the fake reaches the bridge handler with the same payload; unsubscribe propagates; a `turn:settled` event likewise. Reuse the event fixtures from `tests/ledger/state.test.tsx` so payload shapes stay honest.
- [ ] **Step 2: FAIL → implement (thin adapter, ~20 lines) → PASS. Gates.**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): real ws ledger bridge closing the us12 wiring gap"`.

---

### Task 7: Server — `file:changed` handler + FR-080 user-edit context

**Files:**

- Create: `apps/server/src/projects/user-edits.ts`
- Modify: the WS event router registration site (find it: `grep -rn "test:results" apps/server/src/turn/coordinator.ts` — register `file:changed` alongside), `apps/server/src/agents/supervisor.ts` (context assembly)
- Test: `apps/server/tests/projects/user-edits.test.ts` (extend the coordinator test harness style — read `apps/server/tests/turn/*.test.ts` first)

**Interfaces:**

- Consumes: `FileChangedEventSchema` payload (`@nyx/protocol` events.ts:318-327 — already defined, currently UNHANDLED server-side); `ProjectStore.commit(projectId, request)` (`store.ts:102`; `CommitRequest` at `store.ts:57-60` is `{ author: FileAuthor; files: readonly FileWrite[] }` — the user-edit marker is `author: "user"`, the D59 source distinction); `getVersionHistory` (`store.ts:110`) returning `VersionSnapshot[]` (`store.ts:78-85`: `{ version, author, createdAt, files: HandoffFile[] }` — filter `author === "user"`); the per-project turn-active state in the coordinator (`TurnGate.isTurnActive`, `coordinator.ts:960-971`; handler registration site: `router.on("test:results", …)` at `coordinator.ts:976` — register `file:changed` alongside).
- Produces:
  - a `file:changed` handler: ownership-checked `ctx.projectId` (iron rule: never trust client ids), REJECTED with an error event while a turn is active for that project (FR-047/D60 — find the existing error-event idiom the router uses and reuse it), otherwise `store.commit(ctx.projectId, { files: [{ path, content }], source: <user-edit marker> })`.
  - `collectUserEditContext(store, projectId, sinceVersion): Promise<string>` — renders a bounded summary (paths + unified-ish diffs, capped at 16KB with an honest truncation marker, mirroring the `capTestResults` discipline) of user-edit versions since the last turn, from `getVersionHistory` (read its row shape — it already distinguishes user-edit sources for D59).
  - supervisor: prepend that summary to the next turn's agent context with the instruction sentence: "The user edited these files since your last turn. Review the changes, keep them unless they conflict with the request, re-verify, and re-deploy if a deploy is active." Record `lastTurnVersion` per project (in the turn state the coordinator already keeps per project).

- [ ] **Step 1: Read first** (coordinator handler registration, `CommitRequest`, `getVersionHistory` row shape, supervisor context assembly seam). Adjust names below to what EXISTS — this task touches US1 code; drift here is likely, and Task 0 should already have aligned it.
- [ ] **Step 2: Failing handler tests** — (a) idle project: `file:changed` commits exactly one version with the user-edit source and echoes success; (b) active turn: no commit, error event emitted naming the turn lock; (c) cross-project spoof: payload for project B on a connection bound to project A → rejected, nothing committed (bind to `ctx.projectId`, ignore any payload project field).
- [ ] **Step 3: Failing `collectUserEditContext` tests** — no edits → empty string; two edited files → both paths + diffs present; oversized content → truncated at the cap with marker; only USER-sourced versions included (agent-turn versions excluded).
- [ ] **Step 4: Failing supervisor test** — with recorded user edits since last turn, the sub-agent context contains the summary + instruction; with none, context unchanged.
- [ ] **Step 5: FAIL → implement → PASS. Gates.** (Known carry from the P1 retro, note-only: the coordinator's `lastResultsByProject`/`consoleByProject`/`projects` maps share a coordinator-lifetime no-eviction pattern — if this task adds any per-project map, follow the same pattern and the same "evict together in a future connection-cleanup pass" note rather than inventing a new lifecycle.)
- [ ] **Step 6: Commit** — `git commit -m "feat(server): file:changed commits and user-edit context for agents"`.

---

### Task 7b (OPTIONAL, recommended): coverage-protocol enrichment — `test:results` carries passing names

**Grounding (P1 retro, review finding F1):** the FR-032 per-circuit coverage telemetry is information-free on real GREEN runs — the wire DTO carries FAILING test names only, so green ⇒ `failures: []` ⇒ an honest all-uncovered report (documented at `apps/server/src/turn/coordinator.ts:765-771`; tests assert the honest gap). The real fix was explicitly recorded for P2/P6 re-planning. P2's Task 1 (optional step) lands the additive protocol field `passedNames?: string[]` on `TestResultsPayloadSchema`; this task lands the two consumers. Skip only with a retro note.

**Files:**

- Modify: `apps/web/src/container/testrunner.ts` (emit passing test `fullName`s from the vitest JSON report's `assertionResults` where `status === "passed"` — the parser already walks them), `apps/server/src/agents/coverage.ts` (`testNamesFromResults` folds `passedNames` alongside failure names; `capTestResults` must cap the enlarged payload under the same FR-033 32KB wire frame — passing names are the FIRST thing truncated, failures keep priority), and the P2 protocol field if P2 skipped it.
- Test: extend `apps/web/tests/container`/testrunner + `apps/server/tests/` coverage suites: a green run now yields covered circuits when test names mention them; the cap truncates passing names before failure detail; a legacy payload WITHOUT `passedNames` still parses (backward compat).

- [ ] **Step 1:** FAIL → implement → PASS across web + server + protocol suites. Gates.
- [ ] **Step 2:** Commit — `git commit -m "feat: carry passing test names for circuit coverage telemetry"`.

---

### Task 8: Compact Monarch grammar

**Files:**

- Create: `apps/web/src/editor/compact-monarch.ts`, `apps/web/src/editor/index.ts`
- Test: `apps/web/tests/editor/compact-monarch.test.ts`

**Interfaces:**

- Produces: `compactLanguageId = "compact"`, `compactMonarch: monaco.languages.IMonarchLanguage` (pure data), `registerCompactLanguage(monacoApi): void` (idempotent), and — for jsdom-safe testing — `KEYWORDS`, `TYPE_KEYWORDS`, `OPERATORS` exported as plain arrays.

- [ ] **Step 1: Fetch the real grammar (constitution I — do not write keyword lists from memory).** Locate the TextMate grammar in the LFDT-Minokawa/compact repo: search the repo for `tmLanguage` / `syntaxes/` (octocode `ghSearchCode` on repo LFDT-Minokawa/compact, query `tmLanguage`), fetch the grammar file, and save a working copy under `docs/superpowers/plans/retros/compact.tmLanguage.json.ref` (reference only, gitignore-exempt is fine — it documents provenance). Cross-check the keyword set against the pinned compiler's language version (`compact check` says 0.31.1 / language ≥0.23; the P2 retro records the wasm pin — prefer ITS keyword set if they diverge, and note divergence in the retro).
- [ ] **Step 2: Failing tests** — grammar-data tests that run WITHOUT monaco in jsdom: every TextMate keyword appears in `KEYWORDS`/`TYPE_KEYWORDS`; tokenizer root rules cover line + block comments, strings, numbers (incl. hex), `pragma`, ledger/circuit/witness declarations. THEN a tokenization smoke test: `import { editor, languages } from "monaco-editor/esm/vs/editor/editor.api"` is heavyweight in jsdom — attempt `languages.registerLanguage` + `editor.tokenize` on a sample NyxtVault snippet; if the import proves jsdom-incompatible (document the actual error), keep the grammar-data tests as the unit layer and move tokenize verification to the manual visual QA in Task 11 — record which path was taken in the retro.
- [ ] **Step 3: FAIL → port the grammar** rule-by-rule from TextMate scopes to Monarch states (comments, strings, keywords, types, numbers, operators, brackets; `@keywords`/`@typeKeywords` token maps). **PASS. Gates.**
- [ ] **Step 4: Commit** — `git commit -m "feat(web): compact monarch grammar ported from textmate source"`.

---

### Task 9: File tree + editor pane (turn lock, live updates, dirty state)

**Files:**

- Create: `apps/web/src/editor/FileTree.tsx`, `apps/web/src/editor/EditorPane.tsx`, `apps/web/src/editor/editor-state.ts`
- Test: `apps/web/tests/editor/editor-state.test.ts`, `apps/web/tests/editor/FileTree.test.tsx`, `apps/web/tests/editor/EditorPane.test.tsx`

**Interfaces:**

- Consumes: `GET /projects/:id/manifest` → `ManifestEntry[]` (`{ path, contentHash }` — type-only import from `@nyx/protocol`), `GET /projects/:id/files/*` (raw content — read `routes.ts:256` for the exact path pattern + response), `file:write` events from the bridge (agent writes during a turn), turn-active signal (from `useTurnState` — same source Task 5 uses).
- Produces:

```typescript
// editor-state.ts — a PURE reducer, monaco-free, fully unit-tested:
export interface EditorFile {
  readonly path: string;
  readonly serverContent: string;
  readonly draft?: string;
} // draft ≠ undefined ⇒ dirty
export interface EditorState {
  readonly files: readonly EditorFile[];
  readonly activePath?: string;
  readonly turnActive: boolean;
}
export type EditorAction =
  | { kind: "open"; path: string; content: string }
  | { kind: "select"; path: string }
  | { kind: "edit"; path: string; draft: string }
  | { kind: "agent-write"; path: string; content: string } // file:write during a turn
  | { kind: "save-committed"; path: string } // file:changed acked → draft becomes serverContent
  | { kind: "discard"; path: string }
  | { kind: "turn"; active: boolean };
export function editorReducer(state: EditorState, action: EditorAction): EditorState;
export function dirtyPaths(state: EditorState): readonly string[];
// EditorPane props:
export interface EditorPaneProps {
  readonly state: EditorState;
  readonly dispatch: (a: EditorAction) => void;
  readonly onSave: (path: string, content: string) => void; // sends file:changed
}
```

- [ ] **Step 1: Failing reducer tests** (the load-bearing semantics — test EXHAUSTIVELY):
  - `edit` while `turnActive` is a NO-OP (read-only during turns, FR-047);
  - `agent-write` on a clean file replaces `serverContent`; on a DIRTY file it updates `serverContent` but PRESERVES the draft (the user's idle-time edit survives a late agent write — and note in a comment this state means stale-draft, surfaced as a badge);
  - `save-committed` promotes draft → serverContent and clears dirty; `discard` drops the draft;
  - `turn: true` does NOT drop drafts (the unsaved-guard in Task 10 has already run before any prompt was sent).
- [ ] **Step 2: FAIL → implement reducer → PASS.**
- [ ] **Step 3: Failing FileTree test** — builds a collapsible dir tree from flat manifest paths (pure `buildTree(paths)` helper unit-tested: nesting, sorting dirs-first), dirty badge dot on dirty files, active highlight, click → `select`.
- [ ] **Step 4: Failing EditorPane test** — mock `@monaco-editor/react` (`vi.mock` returning a `<textarea data-testid="monaco-stub">` that forwards value/onChange/options.readOnly): readOnly true while `turnActive`; typing dispatches `edit`; the read-only banner ("agent is working — editor locked") shows during turns.
- [ ] **Step 5: FAIL → implement components (real `@monaco-editor/react` `Editor` with `language="compact"`, `registerCompactLanguage` on mount, theme wired to the app dark theme) → PASS. Gates.**
- [ ] **Step 6: Commit** — `git commit -m "feat(web): editor pane with turn lock, live agent writes, dirty tracking"`.

---

### Task 10: Toolbar (save/build/deploy + shortcuts) and unsaved-changes guard

**Files:**

- Create: `apps/web/src/editor/Toolbar.tsx`, `apps/web/src/editor/UnsavedGuard.tsx`, `apps/web/src/editor/shortcuts.ts`
- Test: `apps/web/tests/editor/Toolbar.test.tsx`, `apps/web/tests/editor/UnsavedGuard.test.tsx`, `apps/web/tests/editor/shortcuts.test.ts`

**Interfaces:**

- Consumes: `dirtyPaths`/`EditorState` (Task 9); the bridge `send` for `file:changed` and `deploy:request` (payload `{}` — events.ts:314) and `deploy:status` subscription; P2's `CompileWorkerClient.check(sources)` for Build, exported from the `apps/web/src/compile/` barrel (exact surface from the P2 retro; diagnostics → monaco markers via `monaco.editor.setModelMarkers`). Timing/version for the pitch chip come from the compile result itself — P2's `compile:results`/worker results carry `durationMs` and `compilerVersion` (plus optional `circuits`); render `durationMs` as seconds and show `compilerVersion` in the chip tooltip. Never measure with `Date.now()` around the call when the result already reports its own duration.
- Produces:
  - `Toolbar({ state, onSaveAll, onBuild, onDeploy, deployStatus, buildStatus })` — Save (disabled when no dirty files), Build, Deploy buttons with status chips: build chip shows the pitch line "compiled in your browser — {seconds}s" on success (design §9) with `data-testid="build-chip"`, seconds derived from the result's `durationMs` and the tooltip naming `compilerVersion`; deploy chip renders `deploy:status` progression and the deployed address with a copy button (`navigator.clipboard.writeText`).
  - `shortcuts.ts`: `matchShortcut(e: KeyboardEvent): "save" | "build" | "deploy" | null` — ⌘S/Ctrl+S, ⌘B/Ctrl+B, ⌘⇧D/Ctrl+Shift+D; pure and unit-tested (both metaKey and ctrlKey forms; ⌘S must `preventDefault`).
  - `UnsavedGuard`: `guardPromptSubmit(dirty: readonly string[], submit: () => void): GuardDecision` flow — a modal listing dirty files with **Save all / Discard all / Cancel**; save-all saves every dirty file then submits; discard-all discards then submits; cancel closes without submitting. Exposed as a wrapper around the sidebar's `PromptInput` `onSubmit` (Task 5 wires it: `<Chat>`'s submit path must route through the guard — read how `Chat` accepts its submit seam; if `Chat` owns `PromptInput` internally, lift the guard to intercept `bridge.send` of `prompt:submit` via a wrapping bridge, which is cleaner than forking Chat — decide by reading `Chat.tsx`, record the choice in the retro).
- [ ] **Step 1: Failing shortcut tests** (all three combos, both modifier forms, plain `s` → null).
- [ ] **Step 2: Failing Toolbar tests** — save disabled/enabled by dirty state; build click calls `onBuild` and renders the timing chip from `buildStatus`; deploy click sends `onDeploy`; address chip copies.
- [ ] **Step 3: Failing UnsavedGuard tests** — submit with clean state passes straight through (no modal); dirty → modal lists files; each of the three buttons behaves per the spec above (save-all invokes `onSave` per file THEN submit exactly once; cancel never submits).
- [ ] **Step 4: FAIL → implement → PASS. Gates.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): save/build/deploy toolbar, shortcuts, unsaved-changes guard"`.

---

### Task 11: Preview pane, workspace assembly, App wiring

**Files:**

- Create: `apps/web/src/workspace/PreviewPane.tsx`, `apps/web/src/workspace/Workspace.tsx`
- Modify: `apps/web/src/App.tsx`, delete-in-place rewrite: `apps/web/src/components/Shell.tsx` (replaced by shell router mount)
- Test: `apps/web/tests/workspace/PreviewPane.test.tsx`, `apps/web/tests/workspace/Workspace.test.tsx`

**Interfaces:**

- Consumes: `createPreview`/`launchPreview`/`PreviewController` + `dev:status` payloads (`{ state, phase?, detail? }`) from `@/container`; console relay stream (read `@/container/streams.ts` exports); everything from Tasks 1–10.
- Produces: `PreviewPane({ controller })` — staged boot loader (each `dev:status` phase a row with spinner/✓/✗; `crashed` state renders the crash card with the D39 reboot messaging), the served-URL iframe once ready, a collapsible console drawer streaming relay lines (auto-scroll, cap 500 lines). `Workspace({ projectId })` — assembles bridge (`createPreviewBridge`), session, ledger (`useLedger` + Task 6 bridge), sidebar, editor (load manifest+files via projects client), toolbar handlers (save → `file:changed`; build → worker check; deploy → `deploy:request`), preview. `App.tsx`: isolation gate → `SessionProvider` → route switch (landing/workspace).

- [ ] **Step 1: Failing PreviewPane test** — fake controller/bridge: boot phases render in order as events arrive; `ready` swaps in the iframe (`data-testid="preview-iframe"` with the served URL); `crashed` shows the crash card; console drawer appends lines.
- [ ] **Step 2: Failing Workspace test** — with all seams faked: renders sidebar + editor + preview; a `file:write` event lands in the editor state; a `ledger:update` reaches the BalanceCard; save flow sends `file:changed` over the fake bridge.
- [ ] **Step 3: Failing App test** — update the existing shell/isolation tests (`tests/isolation-gate.test.tsx` still passes; a new test asserts the landing route renders post-gate with a faked session).
- [ ] **Step 4: FAIL → implement → PASS. Gates.** Keep `Shell.tsx` as a thin re-export of the new shell mount OR delete it and update imports — grep for `Shell` usages first; adjust tests accordingly.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): assembled workspace and app routing over isolation gate"`.

---

### Task 12: Golden-path rehearsal script

**Files:**

- Create: `docs/superpowers/plans/retros/GOLDEN_PATH.md`

- [ ] **Step 1: Write the rehearsal script** — the EXACT demo sequence with expected observations at each beat, so any run is reproducible: (1) `pnpm demo -- --reset && pnpm demo` → all phases ✓, URL printed; (2) open the app → landing hero, silent sign-in, wallet chip shows the dev address; (3) new project → workspace opens, preview boots through visible `dev:status` phases; (4) top-up modal → deposit N NYXT → pending → credited row + balance update (real on-chain leg); (5) golden prompt (write it verbatim — pick a small, rehearsed DApp the swarm handles well, e.g. a counter with one guarded circuit; refine the wording during rehearsal until reliable) → turn strip progresses, files stream into the editor, tests go green, compile chip shows browser-compile timing, `artifacts:ready`; (6) Deploy → status chip → deployed address; (7) interact with the DApp in the preview (its tx proves + submits; proof chip); (8) EDIT a file while idle (change a UI string) → dirty badge → prompt "make the button label say X" with unsaved changes → guard modal → Save all → agent reviews the edit (FR-080 visible in its narration) → re-verify → re-deploy; (9) ledger feed shows reserve/settle rows for both turns. Include a "reset between rehearsals" note (`pnpm demo -- --reset`).
- [ ] **Step 2: Commit** — `git commit -m "docs(demo): golden-path rehearsal script"`.

---

### Task 13: Polish pass (frontend-design)

**Files:**

- Modify: everything visual under `apps/web/src/` (shell, workspace, editor, chat/ledger composition styling — NOT the feature modules' logic)

- [ ] **Step 1: REQUIRED — load the `frontend-design` skill** (Skill tool) before touching any styling. This pass is what sells the demo to non-technical stakeholders (design §1); it deserves real design intent, not default shadcn gray.
- [ ] **Step 2: Establish the design system pass**: typography scale + display font choice, a distinctive dark theme as default (the demo is dark-room friendly), spacing rhythm, motion (turn-strip stage transitions, compile/proof chip enter animations, preview boot loader), consistent empty/loading/error states for every surface built in Tasks 3–11 (landing empty state, editor no-file state, preview pre-boot state, ledger empty feed, chat first-run invite: "Describe the DApp you want. The Nyx swarm builds it.").
- [ ] **Step 3: The pitch moments** get deliberate emphasis: browser-compile chip and proof chip styled as the hero micro-interactions they are (design §9 — these are the architecture claims made visible).
- [ ] **Step 4: Visual QA**: run the stack (`pnpm demo` or `sfw pnpm --filter @nyx/web dev` against fakes), walk every GOLDEN_PATH beat, screenshot each screen, fix what looks default or broken. All existing tests stay green after every styling change (`sfw pnpm --filter @nyx/web test`).
- [ ] **Step 5: Commit in coherent slices** — e.g. `style(web): dark theme and typography system`, `style(web): workspace motion and state polish`.

---

### Task 14: Retro, review loop, PR, final gate

- [ ] **Step 1:** Write `docs/superpowers/plans/retros/P6_RETRO.md` per the Retro section.
- [ ] **Step 2:** Full repo gates; code-reviewer subagent loop until clean (this branch is large — review in two passes: server changes, web changes).
- [ ] **Step 3:** Push, `gh pr create`, `gh pr checks --watch`, fix-until-green, `gh pr merge --merge --delete-branch`.
- [ ] **Step 4 (FINAL GATE — replaces "next plan"):** on `main`: `pnpm demo -- --check` → all ✓. Then execute `docs/superpowers/plans/retros/GOLDEN_PATH.md` end-to-end against the live stack. Fix anything it surfaces via small PRs through the same gates, re-run the rehearsal until it passes cleanly twice in a row from `--reset`.
- [ ] **Step 5:** Report demo-ready status to the human: what works, rehearsal timings, known rough edges, and the exact `pnpm demo` invocation — the single intended human touchpoint of the P0–P6 sequence.
