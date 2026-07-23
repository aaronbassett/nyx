# P5 — Demo Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command (`pnpm demo`) that provisions and runs the entire local demo stack — devnet, funded wallets, deployed NyxtVault, Postgres + migrations, server container, MCP servers, SRS cache, generated env files, and the web app — idempotently, with `demo:down`, `--reset`, and `--check` lifecycle commands.

**Architecture:** A `tsx` CLI in `infra/demo/` built as a sequence of idempotent phases over injectable seams (exec, fs, fetch, clock, log). One demo compose file layers Postgres and the nyx-server container onto the three pinned devnet images. Machine state (generated keys, vault address, funding evidence) lives in gitignored `infra/demo/.state/`. Everything deterministic is unit-tested with fakes; everything touching live services is `DEVNET_URL`-gated.

**Tech Stack:** TypeScript/Node ≥22, tsx, vitest, docker compose, pnpm\@10 workspaces, Socket Firewall (`sfw`), the pinned Midnight devnet images (node `0.22.5`, indexer-standalone `4.2.1`, proof-server `8.1.0` — never bump from memory).

## Global Constraints

- Host-side installs/builds/scripts: always `sfw pnpm …`, never bare `pnpm`, never `npm` (design §7). Inside the user-facing WebContainer runtime only: plain `npm`.
- Devnet image pins are load-bearing: `midnightntwrk/midnight-node:0.22.5` (< 1.0.0), `midnightntwrk/indexer-standalone:4.2.1` (< 4.3.0), `midnightntwrk/proof-server:8.1.0`. Copy verbatim from `infra/devnet/docker-compose.yml`; do not bump.
- Devnet ports 9944 / 6300 / 8088 are pinned and never remapped; Nyx's OWN services (Postgres, server, web) get non-conflicting ports.
- Genesis dev seed `0000000000000000000000000000000000000000000000000000000000000001` is PUBLIC — local devnet only; the CLI must refuse to run funding phases when `NYX_NETWORK !== "local-devnet"`.
- Constitution I: every key-derivation, funding, DUST-registration, node/indexer probe shape is verified against the live devnet / installed SDK types before coding — never from memory. Steps below encode probe-then-code.
- Secrets (deploy key, LLM keys) never enter git: `.state/`, `.env.demo`, `.env.demo.local`, `apps/web/.env.local` are gitignored; only `.env.demo.example` is committed.
- Warnings are errors; conventional commits (lowercase subject, ≤72 chars); never `--no-verify`.
- ESM everywhere (`"type": "module"`); repo TS strict mode; `interface` over `type` where the repo does so (repo-wide lint rule).

## Autonomous Execution Protocol

This plan is executed **fully autonomously**. Do not wait for human input at any point unless every alternative is exhausted — a hard external blocker such as a credential no task can generate, a third-party outage, or a destructive/irreversible decision outside this plan's scope. Otherwise: decide, document the decision in the retro, and keep moving.

**Branch:** create `demo/p5-demo-orchestrator` off up-to-date `main` before the first task.

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
5. **Immediately** check out `main`, pull, open the next plan (`docs/superpowers/plans/2026-07-23-p6-ui-workspace.md`), and begin it — starting with its Task 0 re-planning preamble. Do not pause between plans.

## Subagent Routing

Use the right agent type for each dispatch — do not run everything as a generic agent:

- CLI/phase-engine/Dockerfile/compose TypeScript + infra tasks: `devs:typescript-dev`.
- Funding/DUST/vault-bootstrap verification steps (live-devnet recipes): the `midnight-verify:verify` skill / `midnight-verify:sdk-tester`; the `midnight-tooling:devnet` skill for devnet management questions.
- CI workflow changes (if any): `gha:gha-creator` + `gha:review`.
- Pre-PR review loop: `devs:code-reviewer` — always this type for review dispatches.

**Model routing — which model runs what:**

- Implementation dispatches (`devs:typescript-dev`, `gha:*`) and `midnight-verify:*` verification dispatches run on **Opus**: pass `model: "opus"` in the Agent call.
- Review dispatches (`devs:code-reviewer`) run on **Opus** by default. Escalate a review to **Fable 5** when the diff touches secrets handling (key generation, `.state/` persistence, env-file generation — nothing secret may reach git or logs), or when a finding is still disputed after one fix loop.
- **Fable 5 is reserved** for the orchestrating session itself, the Task 0 re-planning subagent, and the secrets-handling review above. Never run routine implementation on Fable.

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

Write `docs/superpowers/plans/retros/P5_RETRO.md` before opening the PR. Contents, in detail:

- **Deviations** from this plan: what changed, why, and the evidence that forced it.
- **Discoveries**: verified facts (SDK shapes, tool behaviors, version constraints) that future plans must know — be specific, include exact names/versions.
- **Deferred items** (should be none): each with justification per the No-Deferral Policy.
- **Impact on remaining plans**: which upcoming tasks are now wrong/obsolete/missing, so the next plan's re-planning preamble can act on it.

---

### Task 0: Re-planning preamble

- [ ] **Step 1: Dispatch a Fable 5 re-planning subagent.** Use the Agent tool (the session model is Fable 5; do not downgrade the model for this dispatch). Give it: this plan file's path, all remaining plan files' paths (`docs/superpowers/plans/2026-07-23-p6-ui-workspace.md`), the design doc (`docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md`), every `docs/superpowers/plans/retros/*_RETRO.md` (P0–P4 plus both spike reports), and instructions to inspect `git log --oneline` since the plans were authored plus the current state of the files each plan touches. Its job: reconcile this plan and all remaining plans with reality — completed/obsolete tasks removed, interface drift corrected (exact names/signatures from the code as it now exists), retro discoveries folded in, missing tasks added. It edits the plan files directly. **Pay special attention to:** the P4 retro's verified funding/DUST-registration recipe and executor SDK shapes (Task 7 here reuses them), the P2 retro's SRS parameter set + artifact-store config names (Tasks 10–11), and the P3 retro's dev-wallet env var names (Task 11).
- [ ] **Step 2: Review the subagent's plan edits** (`git diff` on `docs/superpowers/plans/`). You are accountable for the updated plan — sanity-check that edits are grounded in retros/code, not speculation.
- [ ] **Step 3: Commit** the updated plans: `git commit -m "docs: re-plan p5+ from retros and current state"`.
- [ ] **Step 4: Execute THIS plan as amended.**

---

### Task 1: Server start script + Dockerfile

**Files:**

- Modify: `apps/server/package.json` (add `start` script)
- Create: `apps/server/Dockerfile`
- Create: `apps/server/.dockerignore`

**Interfaces:**

- Consumes: `apps/server/src/index.ts` (existing boot entry: config-load fail-fast + listen), repo pnpm\@10 workspace layout.
- Produces: image `nyx-server` exposing port 8080, started by Task 8's compose; `sfw pnpm --filter @nyx/server start` for local runs.

- [ ] **Step 1: Add the start script.** In `apps/server/package.json` scripts add:

```json
"start": "tsx src/index.ts"
```

Note `tsx` is currently a devDependency; the image installs the full workspace (dev deps included) — acceptable for the demo image, and it avoids inventing a build step the repo doesn't have (`typecheck` is `noEmit`). Record this trade-off in the retro.

- [ ] **Step 2: Write `apps/server/.dockerignore`:**

```
node_modules
**/node_modules
.git
data
*.md
```

- [ ] **Step 3: Write `apps/server/Dockerfile`** (build context is the REPO ROOT — the workspace needs sibling packages):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
# Socket Firewall guards every registry fetch inside the build (design §7).
RUN npm install -g sfw@latest pnpm@10.0.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/scaffold/package.json packages/scaffold/
COPY packages/nyxt-vault/package.json packages/nyxt-vault/
COPY infra/package.json infra/
RUN sfw pnpm install --frozen-lockfile --filter @nyx/server...

FROM node:22-slim AS runtime
WORKDIR /app
COPY --from=deps /app ./
COPY packages ./packages
COPY apps/server ./apps/server
USER node
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["../../node_modules/.bin/tsx", "src/index.ts"]
```

⚠️ The `npm install -g sfw` bootstrap is the ONE permitted npm use (there is no pnpm before it exists in the image); everything package-related after it goes through `sfw pnpm`. If P0's retro established a different sfw install channel, use that. Adjust the `COPY .../package.json` list to the actual current workspace members (`ls apps packages infra`) before building. If `@nyx/compact-wasm` exists by now (P2), add its `package.json` COPY too — `@nyx/server` may not depend on it, in which case leave it out; check `apps/server/package.json` dependencies.

- [ ] **Step 4: Build the image and smoke it.** From the repo root:

Run: `docker build -f apps/server/Dockerfile -t nyx-server:demo .`
Expected: build succeeds.

Run: `docker run --rm nyx-server:demo ../../node_modules/.bin/tsx --version`
Expected: prints the tsx version (proves runtime layout + non-root user work).

Run: `docker run --rm nyx-server:demo`
Expected: exits non-zero quickly with the config fail-fast error naming missing env vars (proves `index.ts` boots and validates; DS-003). Capture the printed missing-var list — it is the authoritative input to Task 11's `.env.demo.example`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/Dockerfile apps/server/.dockerignore apps/server/package.json
git commit -m "feat(demo): server dockerfile with sfw-guarded pnpm build"
```

---

### Task 2: Demo compose file

**Files:**

- Create: `infra/demo/docker-compose.yml`
- Modify: `.gitignore` (add `infra/demo/.state/`)

**Interfaces:**

- Consumes: `infra/devnet/docker-compose.yml` service definitions (copy the three services VERBATIM — image pins, env, healthchecks, ports), `apps/server/Dockerfile` (Task 1).
- Produces: compose project `nyx-demo` with services `node`, `indexer`, `proof-server`, `postgres`, `nyx-server`; Postgres published on host `5433`; server on host `8080`.

- [ ] **Step 1: Write `infra/demo/docker-compose.yml`.** Copy the `node`, `indexer`, `proof-server` service blocks byte-for-byte from `infra/devnet/docker-compose.yml` (KEEP the container_name values so the two stacks can never run concurrently — the preflight also prevents it), then add:

```yaml
  postgres:
    image: postgres:17
    container_name: nyx-demo-postgres
    ports:
      - "5433:5432" # host 5433 — never fight a locally-installed postgres on 5432
    environment:
      POSTGRES_USER: nyx
      POSTGRES_PASSWORD: nyx-local-demo # local demo only, never a real secret
      POSTGRES_DB: nyx
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nyx -d nyx"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      - nyx-demo-pgdata:/var/lib/postgresql/data

  nyx-server:
    build:
      context: ../..
      dockerfile: apps/server/Dockerfile
    container_name: nyx-demo-server
    ports:
      - "8080:8080"
    env_file:
      - ../../.env.demo
    environment:
      # In-network overrides: the container reaches siblings by service DNS, not localhost.
      DATABASE_URL: "postgres://nyx:nyx-local-demo@postgres:5432/nyx"
      NYX_NODE_URL: "http://node:9944"
      NYX_INDEXER_URL: "http://indexer:8088"
      PROVER_URL: "http://proof-server:6300"
    depends_on:
      postgres:
        condition: service_healthy
      node:
        condition: service_healthy
      indexer:
        condition: service_healthy

volumes:
  nyx-demo-pgdata:
```

Set the top-level `name: nyx-demo`. Check `apps/server/src/config/schema.ts` for the exact override var names (`NYX_NODE_URL`/`NYX_INDEXER_URL` exist today; verify nothing was renamed by P2–P4). Two P2-driven mounts on `nyx-server`: the SRS cache (`- ./srs-cache:/srs-cache` with `SRS_CACHE_DIR=/srs-cache` in the container env — Task 9's srs phase downloads into `infra/demo/srs-cache/`, gitignored) and the artifact store (`- nyx-demo-artifacts:/artifacts` named volume with `ARTIFACT_STORE_ROOT=/artifacts`, so artifacts survive container rebuilds); add `nyx-demo-artifacts` to the volumes block and `infra/demo/srs-cache/` to `.gitignore` in Step 3.

- [ ] **Step 2: Validate.**

Run: `docker compose -f infra/demo/docker-compose.yml config --quiet`
Expected: exit 0 (fails until `.env.demo` exists — if so, `touch .env.demo` temporarily, validate, delete; Task 11 generates the real one).

- [ ] **Step 3: Gitignore state dir.** Append to `.gitignore`:

```
infra/demo/.state/
.env.demo
.env.demo.local
```

- [ ] **Step 4: Commit**

```bash
git add infra/demo/docker-compose.yml .gitignore
git commit -m "feat(demo): compose stack layering postgres and server onto devnet"
```

---

### Task 3: Demo port preflight

**Files:**

- Create: `infra/demo/ports.ts`
- Test: `infra/tests/demo-ports.test.ts`

**Interfaces:**

- Consumes: `assertPortsFree(ports, host)` / `PortsInUseError` from `infra/devnet/preflight.ts` (reuse, do not reimplement).
- Produces: `DEMO_STATIC_PORTS: readonly number[]` and `demoPreflight(extraPorts: readonly number[]): Promise<void>` used by the CLI (Task 9); throws `PortsInUseError` naming every busy port.

- [ ] **Step 1: Write the failing test** `infra/tests/demo-ports.test.ts` (mirror the style of `infra/tests/preflight.test.ts` — ephemeral listeners on 127.0.0.1):

```typescript
import { createServer, type AddressInfo, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { PortsInUseError } from "../devnet/preflight.js";
import { DEMO_STATIC_PORTS, demoPreflight } from "../demo/ports.js";

const HOST = "127.0.0.1";

function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected AddressInfo"));
        return;
      }
      resolve({ server, port: (address satisfies AddressInfo).port });
    });
  });
}

describe("demoPreflight", () => {
  it("includes the devnet trio, postgres, server, and web ports", () => {
    for (const port of [9944, 6300, 8088, 5433, 8080, 5173]) {
      expect(DEMO_STATIC_PORTS).toContain(port);
    }
  });

  it("rejects with PortsInUseError when an extra port is occupied", async () => {
    const { server, port } = await listenEphemeral();
    try {
      await expect(demoPreflight([port])).rejects.toBeInstanceOf(PortsInUseError);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails.**

Run: `sfw pnpm --filter @nyx/infra test -- demo-ports`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `infra/demo/ports.ts`:**

```typescript
import { assertPortsFree } from "../devnet/preflight.js";

/**
 * Ports the demo stack must be able to claim: the Lace-pinned devnet trio
 * (9944 node / 6300 proof / 8088 indexer), demo Postgres (5433), the server
 * container (8080), and the host Vite dev server (5173). MCP ports come from
 * the services manifest at runtime and are passed as `extraPorts`.
 */
export const DEMO_STATIC_PORTS: readonly number[] = [9944, 6300, 8088, 5433, 8080, 5173];

const DEMO_HOST = "127.0.0.1";

/** Fail-fast bind probe over every demo port. Never attaches to foreign services. */
export async function demoPreflight(extraPorts: readonly number[] = []): Promise<void> {
  await assertPortsFree([...DEMO_STATIC_PORTS, ...extraPorts], DEMO_HOST);
}
```

- [ ] **Step 4: Run the test — PASS.** Then gates: `sfw pnpm --filter @nyx/infra lint && sfw pnpm --filter @nyx/infra typecheck && sfw pnpm --filter @nyx/infra test` (if `@nyx/infra` has no lint script, run repo-root `sfw pnpm lint`).

- [ ] **Step 5: Commit**

```bash
git add infra/demo/ports.ts infra/tests/demo-ports.test.ts
git commit -m "feat(demo): port preflight covering demo stack and mcp extras"
```

---

### Task 4: Phase engine

**Files:**

- Create: `infra/demo/phase.ts`
- Test: `infra/tests/demo-phase.test.ts`

**Interfaces:**

- Consumes: nothing internal.
- Produces: the seam every later phase implements —

```typescript
export interface PhaseCtx {
  readonly exec: (cmd: string, args: readonly string[], opts?: ExecOpts) => Promise<ExecResult>;
  readonly fetch: typeof globalThis.fetch;
  readonly log: (line: string) => void;
  readonly clock: { now(): number; sleep(ms: number): Promise<void> };
  readonly stateDir: string; // infra/demo/.state
}
export interface ExecOpts {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}
export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface Phase {
  readonly name: string;
  isSatisfied(ctx: PhaseCtx): Promise<boolean>;
  run(ctx: PhaseCtx): Promise<void>;
}
export class PhaseError extends Error {
  constructor(phase: string, hint: string, cause?: unknown);
  readonly phase: string;
  readonly hint: string; // actionable operator guidance, printed on failure
}
export async function runPhases(phases: readonly Phase[], ctx: PhaseCtx): Promise<void>;
```

- [ ] **Step 1: Write the failing test** `infra/tests/demo-phase.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { PhaseError, runPhases, type Phase, type PhaseCtx } from "../demo/phase.js";

function fakeCtx(lines: string[]): PhaseCtx {
  return {
    exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    fetch: globalThis.fetch,
    log: (line) => lines.push(line),
    clock: { now: () => 0, sleep: () => Promise.resolve() },
    stateDir: "/tmp/unused",
  };
}

describe("runPhases", () => {
  it("skips satisfied phases and runs unsatisfied ones, logging progress", async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const phases: Phase[] = [
      {
        name: "already-done",
        isSatisfied: () => Promise.resolve(true),
        run: () => {
          ran.push("already-done");
          return Promise.resolve();
        },
      },
      {
        name: "needed",
        isSatisfied: () => Promise.resolve(false),
        run: () => {
          ran.push("needed");
          return Promise.resolve();
        },
      },
    ];
    await runPhases(phases, fakeCtx(lines));
    expect(ran).toEqual(["needed"]);
    expect(lines.join("\n")).toContain("already-done");
    expect(lines.join("\n")).toContain("needed");
  });

  it("wraps a phase throw in PhaseError carrying the phase name and hint", async () => {
    const failing: Phase = {
      name: "explodes",
      isSatisfied: () => Promise.resolve(false),
      run: () => Promise.reject(new Error("boom")),
    };
    const attempt = runPhases([failing], fakeCtx([]));
    await expect(attempt).rejects.toBeInstanceOf(PhaseError);
    await expect(attempt).rejects.toThrow("explodes");
  });

  it("stops at the first failing phase", async () => {
    const ran: string[] = [];
    const phases: Phase[] = [
      {
        name: "fails",
        isSatisfied: () => Promise.resolve(false),
        run: () => Promise.reject(new Error("no")),
      },
      {
        name: "never-reached",
        isSatisfied: () => Promise.resolve(false),
        run: () => {
          ran.push("never-reached");
          return Promise.resolve();
        },
      },
    ];
    await expect(runPhases(phases, fakeCtx([]))).rejects.toBeInstanceOf(PhaseError);
    expect(ran).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL** (`sfw pnpm --filter @nyx/infra test -- demo-phase`).

- [ ] **Step 3: Implement `infra/demo/phase.ts`** exactly to the Produces block: `runPhases` iterates in order; per phase logs `▸ <name>` then either `✓ <name> (already satisfied)` or runs and logs `✓ <name>`; a `run` rejection is wrapped in `PhaseError(phase.name, hintFrom(phase), cause)` — give each phase an optional `hint` field (add `readonly hint?: string` to `Phase`) whose text is included in `PhaseError.message` so the operator sees remediation, e.g. "is Docker running?".

- [ ] **Step 4: Run — PASS.** Gates.

- [ ] **Step 5: Commit** — `git commit -m "feat(demo): idempotent phase engine with actionable failures"`.

---

### Task 5: State store

**Files:**

- Create: `infra/demo/state.ts`
- Test: `infra/tests/demo-state.test.ts`

**Interfaces:**

- Produces:

```typescript
export interface DemoState {
  readonly deployKeySeed?: string; // 32-byte hex, generated (NOT the genesis seed)
  readonly userWalletSeed?: string; // 32-byte hex, generated
  readonly deployAddress?: string; // derived unshielded address (bech32m)
  readonly userAddress?: string;
  readonly vaultAddress?: string; // NyxtVault contract address after bootstrap deploy
  readonly fundedAt?: string; // ISO timestamp of successful funding phase
}
export async function readState(stateDir: string): Promise<DemoState>;
export async function writeState(stateDir: string, patch: Partial<DemoState>): Promise<DemoState>;
```

- [ ] **Step 1: Failing test** `infra/tests/demo-state.test.ts` — use `fs.mkdtemp(os.tmpdir())`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState, writeState } from "../demo/state.js";

describe("demo state store", () => {
  it("returns {} for a missing state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyx-demo-state-"));
    await expect(readState(dir)).resolves.toEqual({});
  });

  it("merges patches and round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyx-demo-state-"));
    await writeState(dir, { userWalletSeed: "ab".repeat(32) });
    const merged = await writeState(dir, { vaultAddress: "mn_shield-addr_test1..." });
    expect(merged.userWalletSeed).toBe("ab".repeat(32));
    expect(merged.vaultAddress).toContain("mn_");
    await expect(readState(dir)).resolves.toEqual(merged);
  });
});
```

(The address literal is only an opaque string to this store — no format assumption is load-bearing here.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — JSON at `join(stateDir, "demo-state.json")`, `mkdir` the dir recursively on write, read-merge-write, pretty-printed. File mode `0o600` (holds seeds).
- [ ] **Step 4: Run — PASS.** Gates.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): persisted state store for keys and addresses"`.

---

### Task 6: Compose + docker adapter and devnet health-wait

**Files:**

- Create: `infra/demo/docker.ts`
- Create: `infra/demo/health.ts`
- Test: `infra/tests/demo-docker.test.ts`, `infra/tests/demo-health.test.ts`

**Interfaces:**

- Consumes: `PhaseCtx.exec` / `PhaseCtx.fetch` (Task 4).
- Produces:

```typescript
// docker.ts
export const DEMO_COMPOSE_FILE = "infra/demo/docker-compose.yml";
export async function composeUp(ctx: PhaseCtx, services?: readonly string[]): Promise<void>; // docker compose -f <file> up -d [services]
export async function composeDown(ctx: PhaseCtx, opts?: { volumes?: boolean }): Promise<void>;
export async function composeBuild(ctx: PhaseCtx, service: string): Promise<void>;
export async function serviceHealthy(ctx: PhaseCtx, container: string): Promise<boolean>; // docker inspect --format {{.State.Health.Status}}
// health.ts
export async function waitForDevnet(ctx: PhaseCtx, opts?: { timeoutMs?: number }): Promise<void>;
export async function waitForHttpOk(
  ctx: PhaseCtx,
  url: string,
  opts?: { timeoutMs?: number },
): Promise<void>;
```

- [ ] **Step 1: PROBE FIRST (constitution I / design §3).** Bring the plain devnet up (`sfw pnpm devnet:up` in one terminal or `docker compose -f infra/devnet/docker-compose.yml up -d`) and capture real shapes:

Run: `curl -sf http://localhost:9944/health && echo OK`
Run: `docker inspect --format '{{.State.Health.Status}}' nyx-devnet-node`
Run: `docker inspect --format '{{.State.Health.Status}}' nyx-devnet-indexer`
Run: `curl -s http://localhost:6300/ -o /dev/null -w '%{http_code}\n'` (learn what the proof server answers on its root — record the real status)

For "block height advancing": the node is substrate-based, but do NOT assume the RPC shape — probe it:

Run: `curl -s -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' http://localhost:9944/ | head -c 400`

Record the exact response JSON in a comment block at the top of `health.ts`. If `chain_getHeader` is not served, fall back to the container healthchecks alone (`serviceHealthy` on all three containers) + indexer readiness file check already encoded in the compose healthcheck — that is sufficient "liveness" for the demo; note the outcome in the retro. Tear the devnet down after probing (`docker compose -f infra/devnet/docker-compose.yml down`).

- [ ] **Step 2: Failing tests.** `demo-docker.test.ts`: assert `composeUp` invokes `exec("docker", ["compose", "-f", DEMO_COMPOSE_FILE, "up", "-d"])` via a recording fake; `composeDown` with `{volumes:true}` appends `-v`; `serviceHealthy` parses `"healthy\n"` → true, `"starting\n"` → false, non-zero exit → false. `demo-health.test.ts`: `waitForHttpOk` polls injected fetch until 200 with `clock.sleep`, throws `PhaseError`-compatible timeout error after `timeoutMs`; `waitForDevnet` composes the three probes captured in Step 1 (drive with a scripted fake fetch/exec returning the REAL captured shapes).

- [ ] **Step 3: Run — FAIL. Step 4: Implement. Step 5: Run — PASS. Gates.**

- [ ] **Step 6: Commit** — `git commit -m "feat(demo): docker adapter and probed devnet health-wait"`.

---

### Task 7: Keygen + funding phase (NIGHT + DUST)

**Files:**

- Create: `infra/demo/fund.ts`
- Test: `infra/tests/demo-fund.test.ts` (deterministic) and `infra/tests/demo-fund.devnet.test.ts` (`DEVNET_URL`-gated)

**Interfaces:**

- Consumes: `readState`/`writeState` (Task 5), `PhaseCtx`, the **P4 retro's verified recipe** for key derivation, NIGHT transfer, and DUST registration (P4's `DeployExecutor` + `BalanceQuery` work already verified wallet/SDK shapes against the devnet — REUSE those exact packages/calls; do not re-derive from memory).
- Produces: `createFundingPhase(deps): Phase` where `deps` injects `{ derive(seed): Promise<{address: string}>, transferNight(from, to, amount): Promise<{txRef: string}>, registerDust(seed): Promise<void>, queryNight(address): Promise<bigint>, queryDust(address): Promise<bigint> }` — a `FundingOps` seam with a real adapter `createDevnetFundingOps(networkProfile)` and a fake for tests. Satisfied when state has `fundedAt` AND live balances are still positive.

- [ ] **Step 1: VERIFY THE RECIPE (constitution I — the design flags this as the riskiest step).** Read the P4 retro + `apps/server/src/deploy/executor.ts` as merged to learn the verified wallet-sdk derivation/submission surfaces. Then dispatch `/midnight-verify:verify` with the concrete claim set: "(a) deriving the genesis dev account from seed 0x00…01 with <the wallet-sdk package P4 used>, (b) building + submitting an unshielded NIGHT transfer on the local devnet, (c) DUST-registering an account so it can pay fees — exact calls, against the running devnet". Bring the demo devnet up for this. Capture the verified call sequence + package versions in `docs/superpowers/plans/retros/P5_FUNDING_EVIDENCE.md`.
- [ ] **Step 2: Failing deterministic test** — `createFundingPhase` over a fake `FundingOps`: generates two fresh 32-byte hex seeds when state lacks them (crypto.randomBytes via injected `randomSeed` for determinism), derives addresses, transfers a configured NIGHT amount from the genesis account to BOTH, DUST-registers BOTH, writes `fundedAt` + seeds + addresses to state; `isSatisfied` false when `fundedAt` missing; refuses to run (throws with hint) when `networkId !== "Undeployed"` (genesis-seed safety per Global Constraints).
- [ ] **Step 3: Run — FAIL. Step 4: Implement `fund.ts`** (phase + `FundingOps` seam + real adapter delegating to the verified calls from Step 1). **Step 5: deterministic test PASS.**
- [ ] **Step 6: `DEVNET_URL`-gated integration test** `demo-fund.devnet.test.ts`: skipped unless `process.env.DEVNET_URL` set (same pattern as the server's `DATABASE_URL`-gated pg tests — read one, e.g. `apps/server/tests/*pg*.test.ts`, and mirror the skip idiom). With the devnet live: run the real phase against a temp state dir; assert `queryNight(userAddress) > 0n` and `queryDust(userAddress) > 0n` afterwards. Run it locally with the devnet up: `DEVNET_URL=http://localhost:9944 sfw pnpm --filter @nyx/infra test -- demo-fund.devnet`. Expected: PASS — this is the plan's proof the funding recipe works.
- [ ] **Step 7: Gates. Commit** — `git commit -m "feat(demo): verified keygen and night/dust funding phase"`.

---

### Task 8: Platform-contract compile + vault bootstrap deploy phase

**Files:**

- Create: `infra/demo/vault.ts`
- Test: `infra/tests/demo-vault.test.ts` (deterministic) + `infra/tests/demo-vault.devnet.test.ts` (`DEVNET_URL`-gated)

**Interfaces:**

- Consumes: `packages/nyxt-vault` build (the existing compact-CLI build — check its `package.json` scripts; the build GUARDS on `command -v compact`), the P4-verified deploy path (`createDevnetDeployExecutor` deps or the lower-level SDK calls its retro documents), state store.
- Produces: `createVaultPhase(deps): Phase` — deps inject `{ compileVault(): Promise<{buildDir: string}>, deployVault(deployKeySeed: string): Promise<{contractAddress: string}> }` (`VaultOps` seam + real adapter). Satisfied when `state.vaultAddress` set AND a live existence probe passes (indexer lookup of the address — reuse the probe P4's `awaitFinality` work established). Writes `vaultAddress` to state; the design's constitution-VII flow delivers it to web env in Task 11.

- [ ] **Step 1: Failing deterministic test** — fake `VaultOps`: phase compiles then deploys with `state.deployKeySeed`, persists `vaultAddress`; `isSatisfied` true when address present and existence probe true; PhaseError with hint "install the compact CLI (midnight-tooling:install-cli)" when `compileVault` rejects with the guard error.
- [ ] **Step 2: Run — FAIL. Step 3: Implement** — real `compileVault` = `ctx.exec("sfw", ["pnpm", "--filter", "@nyx/nyxt-vault", "build"], ...)` (confirm the actual script name in `packages/nyxt-vault/package.json`; it is the compact-CLI local build per design §2 "our code compiles on our machine"); real `deployVault` reuses the P4 executor path with the vault's compiled artifacts — the P5 Task 0 re-planning has aligned the exact call; do NOT invent SDK calls here.
- [ ] **Step 4: PASS + gates.**
- [ ] **Step 5: `DEVNET_URL`-gated test**: with devnet live + funding phase done, run the vault phase for real; assert the contract address round-trips through the existence probe. Run and PASS locally.
- [ ] **Step 6: Commit** — `git commit -m "feat(demo): nyxt-vault compile and bootstrap deploy phase"`.

---

### Task 9: Migration, SRS, and MCP phases

**Files:**

- Create: `infra/demo/migrate.ts`, `infra/demo/srs.ts`, `infra/demo/services.ts`
- Test: `infra/tests/demo-migrate.test.ts`, `infra/tests/demo-srs.test.ts`, `infra/tests/demo-services.test.ts`

**Interfaces:**

- Consumes: `apps/server` migrate CLI (`tsx src/db/migrate-cli.ts up`, reads `DATABASE_URL`); the SRS parameter set established by P2 (see its retro — the compactc-wasm PoC caches from `https://srs.midnight.network` into `~/.cache/midnight/zk-params`; P2 fixed the actual file list the browser prover needs, and the server serves the cache from its `SRS_CACHE_DIR` config — the srs phase MUST download into the same directory `.env.demo` sets for `SRS_CACHE_DIR`); `.env.demo.local` for MCP launch commands (Tome + mnm ONLY — compact-mcp is retired).
- Produces:

```typescript
export function createMigratePhase(): Phase; // exec: sfw pnpm --filter @nyx/server exec tsx src/db/migrate-cli.ts up  (env: DATABASE_URL=postgres://nyx:nyx-local-demo@localhost:5433/nyx)
export function createSrsPhase(deps: {
  paramFiles: readonly string[];
  baseUrl: string;
  cacheDir: string;
}): Phase; // download-if-missing each file, sha-logged
export interface McpService {
  readonly name: "tome" | "mnm";
  readonly command: string;
  readonly args: readonly string[];
  readonly port: number;
  readonly healthUrl: string;
}
export function loadServicesManifest(env: Record<string, string | undefined>): McpService[]; // from TOME_MCP_COMMAND/TOME_MCP_PORT/MNM_MCP_COMMAND/MNM_MCP_PORT in .env.demo.local
export function createMcpPhase(deps: { services: readonly McpService[]; spawn: SpawnFn }): Phase; // spawn detached, wait healthUrl 200, record pid in state dir
```

- [ ] **Step 1: Failing tests** for all three: migrate phase execs the exact command+env (recording fake); srs phase skips existing files (fake fs) and downloads missing ones (fake fetch) writing to `cacheDir`; `loadServicesManifest` builds the two services from env vars and throws a `PhaseError`-worthy error naming the missing var when a command is absent; mcp phase spawns each service and awaits its health URL.
- [ ] **Step 2: FAIL → implement → PASS → gates.** MCP launch commands are machine-specific and belong in `.env.demo.local` (documented in Task 11's example file) — the manifest is data, the phase is generic (design §3 "launch commands live in a services manifest so the script doesn't hardcode paths").
- [ ] **Step 3: Commit** — `git commit -m "feat(demo): migrate, srs prefetch, and mcp launch phases"`.

---

### Task 10: Env generation phase

**Files:**

- Create: `infra/demo/env-gen.ts`
- Create: `.env.demo.example` (repo root, COMMITTED)
- Test: `infra/tests/demo-env-gen.test.ts`

**Interfaces:**

- Consumes: `DemoState` (seeds, vault address), `.env.demo.local` (operator-provided LLM keys + MODEL_ROUTING + MCP commands), `apps/server/src/config/schema.ts` (authoritative required-var list — READ IT at execution; P2 removed `MCP_TOOLCHAIN_URL`/`COMPILE_SERVICE_*`/`R2_*` and added artifact-store vars).
- Produces: `createEnvGenPhase(deps): Phase` writing `.env.demo` (server) and `apps/web/.env.local` (web). Pure function core: `renderServerEnv(state, operatorEnv): string` and `renderWebEnv(state): string` — unit-testable string builders.

- [ ] **Step 1: Derive the authoritative var list.** Open `apps/server/src/config/schema.ts` (post-P2/P4 state) and enumerate every REQUIRED var + every demo-relevant optional. Cross-check against Task 1 Step 4's captured fail-fast output. As of plan authorship the expected server set is: `DATABASE_URL` (localhost:5433 for host-run tools; the compose in-network override handles the container), `PORT`, `MCP_TOME_URL`, `MCP_MNM_URL`, `PROVER_URL=http://localhost:6300`, `NYX_NETWORK=local-devnet`, `DEPLOY_KEY` (from `state.deployKeySeed`), `MODEL_ROUTING` (operator), one or more LLM API keys (operator), plus the P2-introduced keys (defaulted/optional — set explicitly in `.env.demo` so the demo is self-describing): `PUBLIC_ORIGIN`, `ARTIFACT_STORE_ROOT`, `ARTIFACT_MAX_FILE_BYTES`, `ARTIFACT_MAX_BUNDLE_BYTES`, `COMPILE_CHECK_TIMEOUT_MS`, `COMPILE_FULL_TIMEOUT_MS`, `SRS_CACHE_DIR`; economic tunables left to defaults. `MCP_TOOLCHAIN_URL` no longer exists (compact-mcp removed in P2) — it must NOT appear in `.env.demo` or the example file. Web set: `VITE_DEV_WALLET=1`, `VITE_DEV_WALLET_SEED` (from `state.userWalletSeed`), `VITE_NYX_NETWORK=local-devnet`, the vault-address var P3 established (expected `VITE_NYXT_VAULT_ADDRESS` — confirm against `apps/web/src/config.ts` as amended by P3; the address must flow ONLY via the config chokepoint, constitution VII).
- [ ] **Step 2: Write `.env.demo.example`** — every operator-supplied var with a comment line each (MODEL_ROUTING example JSON matching `ModelRoutingTableSchema`, `ANTHROPIC_API_KEY=`, `TOME_MCP_COMMAND=`, `TOME_MCP_PORT=`, `MNM_MCP_COMMAND=`, `MNM_MCP_PORT=`), and a header explaining: copy to `.env.demo.local`, fill in, never commit.
- [ ] **Step 3: Failing tests** for `renderServerEnv`/`renderWebEnv`: given a full state + operator env, output contains each expected `KEY=value` line; missing operator keys produce a thrown error listing exactly what to add to `.env.demo.local`; the genesis seed NEVER appears in any rendered output (regression: the deploy key is a generated seed, not `0x00…01`).
- [ ] **Step 4: FAIL → implement → PASS → gates.** Phase `isSatisfied`: both files exist AND contain the current state's values (re-render + compare).
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): env generation from state and operator config"`.

---

### Task 11: CLI assembly + package scripts

**Files:**

- Create: `infra/demo/cli.ts`
- Modify: root `package.json` (scripts)
- Test: `infra/tests/demo-cli.test.ts`

**Interfaces:**

- Consumes: every phase factory (Tasks 3–10), `runPhases`, `composeDown`.
- Produces: `pnpm demo` (full setup+run), `pnpm demo:down`, `pnpm demo -- --reset`, `pnpm demo -- --check`. Exposes `buildPhases(mode: "up" | "check"): Phase[]` and `parseArgs(argv: string[]): { mode: "up" | "down" | "reset" | "check" }` for tests.

- [ ] **Step 1: Failing test** — `parseArgs`: `[]`→up, `["--reset"]`→reset, `["--check"]`→check, unknown flag → error naming it. `buildPhases("up")` returns phases in EXACTLY this order: preflight → compose-up(devnet trio + postgres) → devnet-health → funding → vault → migrate → srs → env-gen → compose-build+up(nyx-server) → server-health (`waitForHttpOk` on `http://localhost:8080/health` — confirm the server's health route path by reading `apps/server/src/index.ts`/`buildServer`; adjust if it is `/healthz` or similar) → mcp → vite (spawn `sfw pnpm --filter @nyx/web dev`, wait on 5173) → print-url.
- [ ] **Step 2: FAIL → implement `cli.ts`** — assemble real `PhaseCtx` (`node:child_process` execFile wrapper, real fetch, console log with phase prefixes, `infra/demo/.state`), dispatch by mode: `up` = runPhases(buildPhases("up")); `down` = stop vite/mcp pids from state + `composeDown(ctx)`; `reset` = down + `composeDown({volumes:true})` + delete `.state/`; `check` = runPhases(buildPhases("check")) where check-mode phases are probe-only (Task 12). Root scripts:

```json
"demo": "tsx infra/demo/cli.ts",
"demo:down": "tsx infra/demo/cli.ts --down"
```

(`--reset`/`--check` pass through `pnpm demo -- --reset`.) NOTE: keep `--down` as the flag behind `demo:down` so all modes flow through one entrypoint; `parseArgs` maps it to `down`.

- [ ] **Step 3: PASS → gates → commit** — `git commit -m "feat(demo): single-command demo cli with lifecycle modes"`.

---

### Task 12: `--check` smoke mode

**Files:**

- Create: `infra/demo/check.ts`
- Test: `infra/tests/demo-check.test.ts` (fakes) + `infra/tests/demo-check.devnet.test.ts` (`DEVNET_URL`-gated)

**Interfaces:**

- Consumes: `waitForHttpOk`, `serviceHealthy`, state store, the vault existence probe (Task 8).
- Produces: `buildCheckPhases(): Phase[]` — probe-only, NEVER mutates: devnet containers healthy; server `GET /health` 200; postgres reachable (server health implies it — plus a direct `pg_isready` exec against 5433); vault address present in state AND live on-chain; web port 5173 responding if running (warn, not fail, when web is down — `--check` may run pre-launch). Prints a ✓/✗ table and exits non-zero on any ✗.

- [ ] **Step 1: Failing tests** over fakes (each probe pass/fail combination renders the right table + exit intent). **Step 2: implement → PASS → gates.**
- [ ] **Step 3: Live proof**: with the full stack up (`pnpm demo`), run `pnpm demo -- --check`. Expected: all ✓, exit 0. This command is the executable definition of demo-ready (design §12) — P6's final gate reuses it.
- [ ] **Step 4: Commit** — `git commit -m "feat(demo): probe-only check mode as demo-ready gate"`.

---

### Task 13: End-to-end idempotency + runbook

**Files:**

- Create: `infra/demo/README.md`
- Test: manual scripted verification (recorded in the retro)

- [ ] **Step 1: Full cold run.** `pnpm demo -- --reset && pnpm demo`. Expected: every phase runs, ends with the URL printed. Record wall-clock per phase in the retro.
- [ ] **Step 2: Idempotency run.** Re-run `pnpm demo` immediately. Expected: every setup phase logs "already satisfied"; only run-phases (server/mcp/vite) restart. Any phase that re-runs work is a bug — fix before proceeding.
- [ ] **Step 3: Write `infra/demo/README.md`**: prerequisites (Docker, compact CLI, sfw, `.env.demo.local` from `.env.demo.example`), the four commands, the phase list with what each does, where state lives, troubleshooting table keyed by `PhaseError` hints (ports busy / docker down / compact missing / missing operator env / devnet unhealthy).
- [ ] **Step 4: Commit** — `git commit -m "docs(demo): orchestrator runbook"`.

---

### Task 14: Retro, review loop, PR

- [ ] **Step 1:** Write `docs/superpowers/plans/retros/P5_RETRO.md` per the Retro section (include the funding-evidence file reference, phase timings, and any recipe deviations — P6's rehearsal depends on them).
- [ ] **Step 2:** Full repo gates; code-reviewer subagent loop per the protocol (review → fix → re-review until clean).
- [ ] **Step 3:** Push, `gh pr create`, `gh pr checks --watch`, fix-until-green, `gh pr merge --merge --delete-branch`.
- [ ] **Step 4:** Check out `main`, pull, open `docs/superpowers/plans/2026-07-23-p6-ui-workspace.md`, begin its Task 0 immediately.
