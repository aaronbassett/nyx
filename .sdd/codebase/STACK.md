# Technology Stack

> **Purpose**: Document what executes in this codebase - languages, runtimes, frameworks, and critical dependencies.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5: Compile Service integration added; no new dependencies)

## Languages & Runtimes

| Language | Version | Purpose |
|----------|---------|---------|
| TypeScript | 5.7.x | Primary application language |
| Node.js | 22+ | Runtime (mandated by packageManager constraint) |
| JavaScript (ESM) | ES2023+ | Runtime modules throughout |

## Frameworks

| Framework | Version | Purpose |
|-----------|---------|---------|
| Fastify | 5.10.0 | HTTP + WebSocket server (orchestrator, T015) |
| Vite | 8.1.4 | Build tool and dev server (web app) |
| React | 19.2.7 | UI framework (web app) |
| Vercel AI SDK | (configured, not yet npm-installed) | Agent supervisor swarm, per-agent routing (D19) |

## Critical Dependencies

| Package | Version | Purpose | Usage Scope |
|---------|---------|---------|-------------|
| @fastify/websocket | 11.3.0 | WebSocket support for bidirectional protocol (D12) | Server event routing |
| @modelcontextprotocol/sdk | 1.29.0 | MCP clients for toolchain, Tome, mnm (T019) | Compile, skill routing, docs |
| @midnight-ntwrk/ledger-v8 | 8.1.0 | BIP-340 Schnorr signature verification + address derivation (Phase 3, T035) | Server auth verification |
| @midnight-ntwrk/wallet-sdk-address-format | 3.1.2 | Bech32m codecs for unshielded address encoding/decoding (Phase 3, T035) | Server auth, address formatting |
| @midnight-ntwrk/dapp-connector-api | 4.0.1 | Wallet DApp connector v4 client (`window.midnight` UUID map, `connect`, `signData`, `getUnshieldedAddress`) (Phase 3, T035) | Web app wallet integration |
| zod | 3.25.76 | Schema validation and boot config (DS-003) | All API boundaries, env config |
| pg | 8.22.0 | PostgreSQL driver with connection pooling | DB queries, migrations, sessions |
| @nyx/protocol | workspace:* | Zod schemas for wire protocol (events, HTTP DTOs) | Client-server contract, TS inference |
| @tailwindcss/vite | 4.3.2 | Tailwind CSS v4 + Vite integration | Web app styling |
| shadcn | (via components.json) | Headless UI components (Radix primitives) | Web app component library |
| @webcontainer/api | (configured, web app ready) | WebContainer runtime in iframe (D29) | Generated app execution |

## Built-In Node.js Modules

| Module | Purpose | Usage Scope |
|--------|---------|-------------|
| node:crypto | Deterministic server-side SHA-256 content hashing (D38 convergence) | Project file manifest generation |

## Package Managers & Build Tools

| Tool | Version | Purpose |
|------|---------|---------|
| pnpm | 10.0.0 | Monorepo package manager (workspace: 4 apps/packages) |
| TypeScript compiler | 5.7.0 | Type checking (via `pnpm typecheck`) |
| ESLint | 9.0.0 | Linting (Flat Config) |
| Prettier | 3.0.0 | Code formatting |
| Vitest | 3.0.0 (root), 4.1.10 (web) | Unit testing framework |

## Runtime Environment

| Environment | Details |
|-------------|---------|
| Node.js | 22+ (packaged in `package.json` engines) |
| OS Targets | Linux containers (Fly.io), macOS/Linux development |
| Deployment | Docker containers on Fly.io; scale-to-zero posture (constitution VI) |
| Process Model | Single Fastify HTTP+WS server per instance |

## Monorepo Structure

| Workspace | Type | Purpose |
|-----------|------|---------|
| `apps/server` | Express-like HTTP server | Orchestrator: HTTP routes, WebSocket, DB, MCP clients, Midnight SDK integration, Compile Service client (T015, T035, Phase 5) |
| `apps/web` | Vite + React SPA | Nyx web UI shell with COOP/COEP carve-out plugin (R6/FR-021), Lace wallet connector (T035), FetchZkConfigProvider for R2 artifacts (Phase 5) |
| `packages/protocol` | Zod schema library | Single source of truth for wire protocol (events, DTOs, types) |
| `packages/scaffold` | (initialized, not yet populated) | Generated app scaffolding (D4 stack: Vite+React+shadcn+Tailwind) |
| `packages/nyxt-vault` | (initialized, not yet populated) | Wallet/NYXT integration layer |

---

## What Does NOT Belong Here

- Directory structure → STRUCTURE.md
- System design patterns → ARCHITECTURE.md
- External service integrations → INTEGRATIONS.md
- Dev tools (linting, formatting) → CONVENTIONS.md
- Test frameworks → TESTING.md

---

*This document captures only what executes. Keep it focused on languages, frameworks, and dependencies.*
