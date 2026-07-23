# Quickstart: Nyx platform development

## Prerequisites
- Node.js ≥ 22 LTS, pnpm (installed via the owner's `sfw pnpm` wrapper — use it for ALL JS installs)
- Compact CLI (pinned version surfaced by the toolchain MCP; local: `compact check`)
- Access to: the owner's toolchain MCP, Tome, mnm hosted MCP (assumed reachable, D28/D30)
- Postgres (local dev instance), Fly CLI for deploy work, a Lace-equipped Chrome profile for wallet flows

## Setup
```bash
sfw pnpm install         # activates husky hooks on first run
sfw pnpm build           # builds packages/protocol first (both apps depend on it)
```

## Available scripts (root)
- `pnpm lint` / `pnpm format:check` — ESLint + Prettier (DS-001; CI-enforced)
- `pnpm typecheck` — tsc strict, all workspaces
- `pnpm test` — Vitest, all workspaces (deterministic only — a flaky test is a bug, constitution IV)
- `pnpm dev` — server + web in watch mode (once apps exist)

## Environment
Config schema is validated at boot; missing/invalid vars fail fast with named errors (DS-003). Tunables (D47): exchange rate, flat reserve, minimum deposit, low-balance threshold, size caps, project quota, version retention, deposit-ref TTL, reconcile cadence, prover rate limits, token lifetimes, and the per-agent model routing table (D19). Secrets (deploy key, R2 write creds — toolchain MCP only, DB URL, provider keys) live in Fly secrets, never in client-reachable config (constitution III).

## Non-negotiables while coding here
1. **Never hand-write Compact or Midnight SDK calls from memory** — retrieve via Tome/MNE/mnm, verify with the compiler MCP and `midnight-verify` (constitution I)
2. **Conventional commits** (DS-002) — the release flow (DS-004, release-plz process) depends on them
3. **Planning artifacts are local-only**: never `git add` `specs/`, `.sdd/`, `discovery/`, `CLAUDE.md`
4. **Pre-implementation gates**: S9 is ⛔ blocked until the Q3 injection run passes (`pocs/webcontainer-lace/`, `./run.sh`); S6 freeze needs the vault-funding spike; S8/S10 need mnm research at implementation

## PoCs (reference implementations, branch `worktree-agent-ab47e5ba8f8087738`)
- `pocs/webcontainer-lace/` — WebContainer boot + COOP/COEP carve-out + wallet-injection detection (R6)
- `pocs/lace-proving/` — connector v4 flow, provider suite wiring, in-wallet vs proof-server toggle (R5/R7/R8)
