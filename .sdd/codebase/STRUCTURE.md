# Project Structure

> **Purpose**: Document directory layout, module boundaries, and where to add new code.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5 update: compile pipeline + artifacts modules)

## Directory Layout

```
nyx/
├── apps/
│   ├── server/                          # Orchestrator (Fly.io app #1)
│   │   ├── src/
│   │   │   ├── index.ts                 # Entry point (config, DI, listen)
│   │   │   ├── app.ts                   # buildServer(deps) — no side effects
│   │   │   ├── config/                  # Environment validation (fail-fast)
│   │   │   │   ├── schema.ts            # Zod config schema
│   │   │   │   ├── load.ts              # loadConfig(env) — pure
│   │   │   │   ├── errors.ts            # ConfigValidationError
│   │   │   │   └── index.ts             # Exports
│   │   │   ├── auth/                    # SIWE auth + session management (T035/T036)
│   │   │   │   ├── routes.ts            # POST /auth/nonce, /verify, GET /session, POST /logout
│   │   │   │   ├── verify.ts            # Signature + key↔address binding verification
│   │   │   │   ├── store.ts             # SessionAuthStore interface + PgSessionAuthStore
│   │   │   │   ├── middleware.ts        # createRequireSession (sliding-resume preHandler)
│   │   │   │   ├── cookie.ts            # Session cookie building + parsing
│   │   │   │   ├── index.ts             # Exports
│   │   │   │   └── *.test.ts            # Unit tests
│   │   │   ├── db/                      # PostgreSQL persistence
│   │   │   │   ├── client.ts            # Db client, connection pool
│   │   │   │   ├── migrate.ts           # Migration runner
│   │   │   │   ├── schema.test.ts       # Schema validation
│   │   │   │   └── index.ts             # Exports
│   │   │   ├── mcp/                     # MCP client connections
│   │   │   │   ├── client.ts            # McpClient (one server)
│   │   │   │   ├── clients.ts           # createMcpClients (multi)
│   │   │   │   ├── concurrency.ts       # Semaphore
│   │   │   │   ├── errors.ts            # McpError, subclasses
│   │   │   │   └── index.ts             # Exports
│   │   │   ├── protocol/                # WS session, auth, routing
│   │   │   │   ├── session.ts           # SessionStore, PgSessionStore (read-only)
│   │   │   │   ├── registry.ts          # SessionRegistry (D40 takeover)
│   │   │   │   ├── router.ts            # EventRouter, parseEvent dispatch
│   │   │   │   ├── handler.ts           # createWsHandler (connection entry)
│   │   │   │   ├── cookies.ts           # readSessionCookie
│   │   │   │   ├── session.test.ts      # Unit tests
│   │   │   │   ├── registry.test.ts     # Unit tests
│   │   │   │   ├── router.test.ts       # Unit tests
│   │   │   │   └── index.ts             # Public exports
│   │   │   ├── projects/                # File store, manifest, lifecycle, chat (T051-T055)
│   │   │   │   ├── store.ts             # ProjectStore interface + PgProjectStore (versioned files, D26/D38)
│   │   │   │   ├── chat.ts              # ChatStore interface + PgChatStore (per-project seq, D23)
│   │   │   │   ├── lifecycle.ts         # DeletionCascade + CascadeSeams (soft-delete, D49)
│   │   │   │   ├── routes.ts            # HTTP routes: list, create, rename, delete, restore, manifest, file read, chat
│   │   │   │   ├── errors.ts            # Named errors: ProjectNotFoundError, ProjectQuotaExceededError, etc.
│   │   │   │   ├── index.ts             # Barrel export
│   │   │   │   └── *.test.ts            # Unit + integration tests
│   │   │   ├── compile/                 # Compile pipeline — HTTP client + orchestration (US2, T066/T070)
│   │   │   │   ├── client.ts            # HttpCompileClient, runCompileJob (injectable HTTP+bearer, FR-016)
│   │   │   │   ├── orchestrator.ts      # ArtifactOrchestrator.runTurn (verify-before-announce, SC-006, D35)
│   │   │   │   ├── schemas.ts           # Zod schemas for Compile Service contract (§3/§4/§5)
│   │   │   │   ├── errors.ts            # Named errors: CompileServiceError, CompileJobTimeoutError, etc.
│   │   │   │   ├── index.ts             # Exports
│   │   │   │   └── *.test.ts            # Unit + integration tests
│   │   │   ├── http/                    # HTTP routes (non-WS)
│   │   │   │   ├── health.ts            # GET /health (db + mcp probes)
│   │   │   │   └── index.ts             # Exports
│   │   │   ├── ws/                      # WebSocket endpoint
│   │   │   │   └── index.ts             # registerWs(app, path, handler?)
│   │   │   └── agents/                  # AI SDK supervisor + sub-agents (T021+)
│   │   ├── tests/
│   │   │   └── integration.test.ts      # Full-stack tests (T024)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                             # Client (React 19 + WebContainer)
│       ├── src/
│       │   ├── main.tsx                 # React root mount
│       │   ├── App.tsx                  # Root component
│       │   ├── index.css                # Global styles
│       │   ├── chat/                    # Chat UI + activity stream
│       │   │   ├── Chat.tsx             # Main chat component
│       │   │   ├── ActivityStream.tsx   # Turn activity display (D20)
│       │   │   └── index.ts             # Exports
│       │   ├── container/               # WebContainer boot + VFS
│       │   │   ├── WebContainer.tsx     # Boot, file sync
│       │   │   ├── useVfs.ts            # File operations hook
│       │   │   └── index.ts             # Exports
│       │   ├── editor/                  # Monaco + Monarch tokenizer
│       │   │   ├── Editor.tsx           # Monaco wrapper
│       │   │   ├── compact.monarch.ts   # Compact syntax highlighting (D18)
│       │   │   └── index.ts             # Exports
│       │   ├── wallet/                  # Wallet detection, classification, SIWE flow (US5/T038)
│       │   │   ├── detect.ts            # Discover installed wallet extensions
│       │   │   ├── classify.ts          # Pure four-state classifier (ConnectState)
│       │   │   ├── connect.ts           # Active connect flow orchestration
│       │   │   ├── remember.ts          # Remembered wallet selection
│       │   │   ├── auth.ts              # SIWE client (/auth/nonce → /verify → /session)
│       │   │   ├── types.ts             # Wallet + connect types
│       │   │   ├── config.ts            # Wallet config (network ID, etc.)
│       │   │   ├── WalletConnect.tsx    # Multi-state render surface
│       │   │   ├── WalletConnectView.tsx # View wrapper
│       │   │   ├── useWalletConnect.ts  # Custom hook (state + side effects)
│       │   │   ├── index.ts             # Exports
│       │   │   └── *.test.ts            # Unit + integration tests
│       │   ├── artifacts/               # R2 artifact fetch harness (T070, US2)
│       │   │   ├── fetch.ts             # Fetch matrix planning + execution (mode:"cors", injectable fetch)
│       │   │   ├── manifest.ts          # ArtifactManifest types (distinct from VFS D38 manifest)
│       │   │   ├── index.ts             # Exports
│       │   │   └── *.test.ts            # Unit tests
│       │   ├── ledger/                  # NYXT balance + ledger UI
│       │   │   ├── LedgerCard.tsx       # Balance display
│       │   │   ├── TransactionFeed.tsx  # Transaction list
│       │   │   └── index.ts             # Exports
│       │   ├── projects/                # Project CRUD + handoff
│       │   │   ├── ProjectList.tsx      # List/create/delete
│       │   │   ├── ProjectRename.tsx    # Rename dialog
│       │   │   ├── HandoffUI.tsx        # Handoff flow (S13)
│       │   │   └── index.ts             # Exports
│       │   ├── hatch/                   # Escape-hatch bridge UX (S9, ⛔ Q3)
│       │   │   ├── HatchOpen.tsx        # Open bridge
│       │   │   ├── HatchLifetime.tsx    # Lifetime mgmt
│       │   │   └── index.ts             # Exports
│       │   ├── components/              # UI kit (shadcn)
│       │   │   ├── ui/
│       │   │   │   ├── button.tsx       # Button component
│       │   │   │   ├── card.tsx         # Card component
│       │   │   │   └── ...              # Other shadcn components
│       │   │   ├── Shell.tsx            # App shell layout
│       │   │   ├── IsolationGate.tsx    # Runtime isolation check gate
│       │   │   └── index.ts             # Exports
│       │   ├── lib/                     # Utilities
│       │   │   ├── utils.ts             # General utilities
│       │   │   ├── isolation.ts         # isCrossOriginIsolated() check
│       │   │   ├── isolation-headers.ts # isolationHeadersFor(pathname)
│       │   │   └── index.ts             # Exports
│       │   └── hooks/                   # Custom React hooks
│       │       ├── useWs.ts             # WebSocket connection hook
│       │       ├── useProject.ts        # Project state hook
│       │       └── index.ts             # Exports
│       ├── tests/
│       │   ├── isolation.test.ts        # COOP/COEP logic tests
│       │   ├── wallet.test.ts           # Wallet classification + connect flow tests
│       │   └── components.test.tsx      # Component unit tests
│       ├── vite.config.ts               # Vite dev server + plugins
│       ├── index.html                   # HTML entry
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── protocol/                        # Shared event/DTO schemas (single source of truth)
│   │   ├── src/
│   │   │   ├── primitives.ts            # Branded IDs (ProjectId, TurnId, etc.), amounts, timestamps
│   │   │   ├── entities.ts              # Data models (Project, File, LedgerEntry, ChatMessage, etc.)
│   │   │   ├── events.ts                # ServerToClientEvent, ClientToServerEvent, parseEvent
│   │   │   ├── http.ts                  # REST DTOs (auth, manifest, deposit, deploy, etc.)
│   │   │   ├── index.ts                 # Main exports
│   │   │   ├── events.test.ts           # Event parsing tests
│   │   │   └── http.test.ts             # HTTP schema tests
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── scaffold/                        # Generated-app template + agent steering (S1)
│   │   ├── src/
│   │   │   ├── templates/               # Asset bundles (Compact, React, test)
│   │   │   └── prompts/                 # Agent steering content
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── nyxt-vault/                      # NyxtVault contract + suite (S6/S10, ⛔ vault-funding spike)
│       ├── src/
│       │   ├── NyxtVault.compact        # Ledger definition, circuits
│       │   ├── witnesses.ts             # TypeScript witness functions
│       │   ├── witnesses.test.ts        # Witness unit tests
│       │   ├── simulator.ts             # OpenZeppelin simulator wrapper
│       │   └── simulator.test.ts        # Full simulator suite
│       ├── package.json
│       └── tsconfig.json
│
├── infra/
│   ├── fly.toml                         # Fly.io orchestrator config
│   ├── prover/
│   │   ├── Dockerfile                   # Proof server image (D37/D52)
│   │   └── fly.toml                     # Proof server Fly.io app
│   ├── compile-service/                 # Owner-built Compile Service (US2, T066)
│   │   ├── API.md                       # HTTP contract (§1-§7: endpoints, schemas, artifact upload, manifest)
│   │   └── ...                          # Implementation (not Nyx-managed)
│   └── r2-setup.md                      # R2 bucket config (R3: CORS, CORP rule, caching)
│
├── specs/
│   └── 001-nyx-platform/
│       ├── spec.md                      # Feature specification
│       ├── plan.md                      # Implementation plan (this document references it)
│       ├── data-model.md                # Phase 1 entities + state machines
│       ├── quickstart.md                # Dev setup + commands
│       ├── contracts/
│       │   ├── websocket-protocol.md    # D12 WS event contract
│       │   └── http-api.md              # auth/manifest/deposit/handoff/prover APIs
│       ├── checklists/
│       │   └── requirements.md          # Spec quality gate (complete)
│       └── retro/                       # Phase retrospectives
│
├── discovery/                           # Phase 0 research (archived)
│   ├── SPEC.md                          # Owner-approved specification (pre-port)
│   ├── archive/
│   │   └── DECISIONS.md                 # D1–D62 + R1–R8 with rationale
│   └── ...                              # Research artifacts
│
├── .sdd/
│   ├── codebase/                        # Generated architecture docs (this output)
│   │   ├── ARCHITECTURE.md
│   │   ├── STRUCTURE.md
│   │   ├── STACK.md
│   │   └── ...
│   └── memory/
│       ├── constitution.md              # v1.1.0, owner-approved governance
│       └── PRD.initial.md               # Product requirements
│
├── pnpm-workspace.yaml                  # Monorepo root config
├── pnpm-lock.yaml                       # Dependency lock file
└── package.json                         # Root workspace metadata
```

## Key Directories

### `apps/server/src/` — Orchestrator Application

| Directory | Purpose | Naming Convention |
|-----------|---------|-------------------|
| `config/` | Environment validation, boot-time schema checks | `{aspect}.ts` (schema, load, errors, index) |
| `auth/` | SIWE nonce + verify routes, session auth store, middleware | `routes.ts`, `store.ts`, `verify.ts`, `middleware.ts`, `cookie.ts` |
| `db/` | PostgreSQL client, migrations, schema validation | `client.ts`, `migrate.ts`, `schema.test.ts` |
| `mcp/` | MCP server connections (toolchain, Tome, mnm) | `client.ts`, `clients.ts`, `concurrency.ts`, `errors.ts` |
| `protocol/` | WS authentication, session management, typed routing | `session.ts`, `registry.ts`, `router.ts`, `handler.ts`, `cookies.ts` |
| `projects/` | File persistence, manifest, lifecycle, chat (T051-T055) | `store.ts`, `chat.ts`, `lifecycle.ts`, `routes.ts`, `errors.ts` |
| `compile/` | Compile Service HTTP client, artifact orchestration, verify-before-announce (US2, T066) | `client.ts`, `orchestrator.ts`, `schemas.ts`, `errors.ts` |
| `http/` | HTTP routes (non-WebSocket) | `{resource}.ts` (health, status, etc.) |
| `ws/` | WebSocket endpoint registration | `index.ts` only |
| `agents/` | AI SDK supervisor + sub-agents (scaffolding, planning, implementation, review) | `{agent-type}.ts`, `supervisor.ts` |

**Entry Points**:
- `index.ts` — Application bootstrap (config load, DI setup, listen)
- `app.ts` — `buildServer()` function (no side effects)

**Test Pattern**:
- `*.test.ts` — Unit tests for each module
- `tests/integration.test.ts` — Full-stack tests

### `apps/server/src/auth/` — SIWE Authentication

| File | Purpose |
|------|---------|
| `routes.ts` | HTTP endpoints: POST /auth/nonce, POST /auth/verify, GET /auth/session, POST /auth/logout |
| `store.ts` | `SessionAuthStore` interface + `PgSessionAuthStore` implementation (nonce + session write operations) |
| `verify.ts` | Signature verification + key↔address binding check |
| `middleware.ts` | `createRequireSession` preHandler for protected routes (sliding-resume) |
| `cookie.ts` | Session cookie building + parsing |
| `index.ts` | Public exports (registerAuthRoutes, etc.) |

**Boundary Rules**:
- Single-use nonce enforcement via database CAS (compare-and-swap)
- Atomic verify-and-issue: burn nonce → verify → auto-create account → issue session (one transaction)
- Sliding renewal: every authenticated request extends session expiry via `slide()`
- Injected dependencies: clock, nonce generator, db handle (testability)

### `apps/server/src/projects/` — File Persistence & Lifecycle (Phase 4)

| File | Purpose |
|------|---------|
| `store.ts` | `ProjectStore` interface + `PgProjectStore` implementation (versioned files, project + file operations, D26/D38) |
| `chat.ts` | `ChatStore` interface + `PgChatStore` implementation (per-project seq monotonic counter, chat history, D23) |
| `lifecycle.ts` | `DeletionCascade` + `CascadeSeams` (soft-delete + injectable ephemeral teardown seams, D49) |
| `routes.ts` | HTTP endpoints: GET /projects, POST /projects, PATCH /projects/:id, DELETE /projects/:id, POST /projects/:id/restore, GET /projects/:id/manifest, GET /projects/:id/files/*, GET /projects/:id/chat |
| `errors.ts` | Named error classes (ProjectNotFoundError, ProjectCountQuotaExceededError, FileTooLargeError, ProjectQuotaExceededError, RestoreWindowExpiredError) |
| `index.ts` | Barrel export of public API |

**Boundary Rules**:
- File writes are internal to the store; all HTTP routes are read-only (except lifecycle: delete, restore)
- Atomic commits: all-or-nothing batch writes locked per-project; no partial updates (SC-026, D40)
- Versioning: per-project monotonic counter; each commit allocates next N; serialized via FOR UPDATE lock
- Manifest: deterministic (path, contentHash)[] ordered by path; server-side SHA-256 hashing (SC-025, D38)
- Soft-delete: sets `deletedAt`; cascade runs immediately; hard-delete after 30-day window (D49); recovery enforced by DB clock
- Quotas: per-file, per-project, per-account byte caps; rejected up-front; never truncated (SC-026)
- Chat seq: per-project counter allocated under project-row lock (defensive, D23, D40)

### `apps/server/src/compile/` — Compile Pipeline (Phase 5)

| File | Purpose |
|------|---------|
| `client.ts` | `HttpCompileClient` + `runCompileJob` (injectable HTTP+bearer; compile failure is data not throw; bounded job-poll with injectable delay/clock, FR-016) |
| `orchestrator.ts` | `ArtifactOrchestrator.runTurn` (EC-11 skip, check-per-iteration D35, full-on-green, verify-before-announce FR-014, reuse SC-006, reopen FR-050/D36; discriminated `CompileOutcome` union; stateless per turn) |
| `schemas.ts` | Zod definitions for Compile Service contract (§3: CheckRequest/Response, §4: CompileRequest/CompileJob, §5: ArtifactManifest) |
| `errors.ts` | Named error types (CompileServiceError, CompileServiceUnavailableError, CompileServiceProtocolError, CompileJobTimeoutError) |
| `index.ts` | Public exports |

**Boundary Rules**:
- HTTP client is injectable (testable; no real service in unit tests)
- Compile failure is DATA (`ok:false`, job `status:"failed"`) — only transport/service faults throw
- Orchestrator is stateless per turn; all I/O injected (client, emitArtifactsReady seam, R2 fetch, clock)
- Verify-before-announce: manifest fetch + file HEAD checks before announcing `artifacts:ready`
- Reuse (SC-006): One `compile` call; service decides reuse; Nyx still announces once
- Bounded poll (FR-016): Injected delay + clock; explicit timeout if max-wait exceeded (never silent hang)
- Service holds R2 creds: Nyx never writes R2 directly (constitution III, D52)

### `apps/server/src/protocol/` — WebSocket Layer

| File | Purpose |
|------|---------|
| `session.ts` | `SessionStore` interface + `PgSessionStore` implementation (read-only session validation) |
| `registry.ts` | `SessionRegistry<TSocket>` (per-(account, project) takeover, D40 last-tab-wins) |
| `router.ts` | `EventRouter` + `parseEvent` (typed event dispatch, non-throwing) |
| `handler.ts` | `createWsHandler` (WS connection orchestration) |
| `cookies.ts` | Cookie parsing utilities |

**Boundary Rules**:
- SessionStore is read-only (writes via `SessionAuthStore` in `auth/`)
- Router never throws on malformed frames (returns `DispatchOutcome`)
- Generic registry testable with sentinel objects
- Handler receives all dependencies injected

### `apps/web/src/` — Client Application

| Directory | Purpose | Naming Convention |
|-----------|---------|-------------------|
| `chat/` | Chat UI, activity stream fanout | `Chat.tsx`, `ActivityStream.tsx` |
| `container/` | WebContainer boot, VFS sync, process feedback | `WebContainer.tsx`, `useVfs.ts` |
| `editor/` | Monaco editor wrapper, Monarch syntax highlighting | `Editor.tsx`, `compact.monarch.ts` |
| `wallet/` | Wallet detection, state classification, SIWE flow, connection | `detect.ts`, `classify.ts`, `connect.ts`, `remember.ts`, `auth.ts` |
| `artifacts/` | R2 artifact fetch harness, manifest types (T070, US2) | `fetch.ts`, `manifest.ts` |
| `ledger/` | NYXT balance card, transaction feed | `LedgerCard.tsx`, `TransactionFeed.tsx` |
| `projects/` | Project CRUD, handoff UI | `ProjectList.tsx`, `ProjectRename.tsx`, `HandoffUI.tsx` |
| `hatch/` | Escape-hatch bridge UX (S9, gated Q3) | `HatchOpen.tsx`, `HatchLifetime.tsx` |
| `components/` | Shared UI (shadcn kit, shell, isolation gate) | `ui/` (shadcn), `Shell.tsx`, `IsolationGate.tsx` |
| `lib/` | Utilities (isolation check, COOP/COEP logic) | `isolation.ts`, `isolation-headers.ts`, `utils.ts` |
| `hooks/` | Custom React hooks (WebSocket, project, wallet) | `use{Purpose}.ts` |

**Entry Points**:
- `main.tsx` — React root mount
- `App.tsx` — Root component
- `index.html` — HTML template

**Test Pattern**:
- `tests/*.test.ts` or `tests/*.test.tsx` — Component/integration tests
- `*.test.ts` collocated for utilities

### `apps/web/src/wallet/` — Wallet Connect (Phase 3)

| File | Purpose |
|------|---------|
| `types.ts` | Type definitions (DiscoveredWallet, ConnectState, ConnectProbe) |
| `config.ts` | Wallet config (network ID, etc.) |
| `detect.ts` | Discover installed wallet extensions via `window.midnight.wallet` API |
| `classify.ts` | Pure state classifier: `classifyConnectState(probe) → ConnectState` (7 named outcomes) |
| `connect.ts` | Orchestrate: detect → classify → prompt if needed → request signature |
| `remember.ts` | Persist + restore user's wallet choice (browser storage) |
| `auth.ts` | SIWE client: `/auth/nonce` → sign → `/auth/verify` → `/auth/session` |
| `WalletConnect.tsx` | Multi-state render component (prompt / selection / network mismatch / sign / success) |
| `WalletConnectView.tsx` | View wrapper for isolation |
| `useWalletConnect.ts` | Custom hook (state + side effects, non-blocking) |
| `index.ts` | Barrel export |

**Boundary Rules**:
- `classify` is pure (no side effects, dependency-free)
- `connect` is non-blocking and never throws
- Storage is optional (remembered selection is UX, not auth)
- HTTP calls go to `auth` module (separate concern)

### `apps/web/src/artifacts/` — Artifact Fetch Harness (Phase 5)

| File | Purpose |
|------|---------|
| `fetch.ts` | Fetch matrix planning + execution (mode:"cors", injectable fetch; EC-10 oversize detection, no DOM side effects) |
| `manifest.ts` | Type definitions for `ArtifactManifest` (NOT a WS DTO; mirrors `infra/compile-service/API.md` §5) |
| `index.ts` | Exports |

**Boundary Rules**:
- `manifest.ts` contains types only (no runtime logic)
- `fetch` is pure with injectable `fetch` (default `globalThis.fetch`)
- No credentials cross R2 boundary (constitution III)
- `mode: "cors"` for every artifact (R3: exempt from COEP under `require-corp`)
- Deterministic with identical inputs → identical plan

### `packages/protocol/` — Shared Protocol

| File | Purpose |
|------|---------|
| `primitives.ts` | Branded IDs, amounts (NYXT), timestamps |
| `entities.ts` | Data models (Project, File, LedgerEntry, ChatMessage, Deployment, etc.) |
| `events.ts` | `ServerToClientEvent`, `ClientToServerEvent`, `parseEvent()` |
| `http.ts` | REST DTO schemas (auth, manifest, deposit, handoff, deploy, prover) |
| `index.ts` | Main export file — re-exports all schemas |

**Auth-Specific** (Phase 3):
- `AuthNonceResponse` — `{ nonce, expiresAt }`
- `AuthVerifyRequest` — `{ address, signature, message, verifyingKey }`
- `AuthVerifyResponse` — `{ address }`
- `AuthSessionResponse` — `{ address }`

**Projects-Specific** (Phase 4):
- `Project` — `{ id, ownerAddress, name, createdAt, deletedAt? }`
- `ProjectFileResponse` — `{ path, content }`
- `ManifestEntry` — `{ path, contentHash }`
- `ChatMessage` — `{ seq, role, content, createdAt, turnId? }`
- `CreateProjectRequest`, `UpdateProjectRequest` — HTTP bodies

**Compile-Specific** (Phase 5):
- `ArtifactsReadyPayload` — `{ urlPrefix }` (WS event for announcing compiled artifacts)

**No module-local schemas**: All WS event and REST shapes are defined here; apps import via `@nyx/protocol`.

## Module Boundaries

### Server Auth Module

```
src/auth/
├── routes.ts          # HTTP endpoints, error handling
├── store.ts           # SessionAuthStore interface + PgSessionAuthStore
├── verify.ts          # Signature + key↔address checks
├── middleware.ts      # Sliding-resume preHandler
├── cookie.ts          # Cookie serialization
└── index.ts           # Public exports
```

**Boundary Rules**:
- Session validation only (read); nonce + session writes encapsulated
- Router never throws on malformed frames
- Store delegates reads to `PgSessionStore`; writes express single-use/expiry/revocation in SQL
- Middleware runs on protected routes; idempotent on repeat calls

### Server Projects Module

```
src/projects/
├── store.ts           # ProjectStore interface + PgProjectStore (versioned files, D26/D38)
├── chat.ts            # ChatStore interface + PgChatStore (chat seq, D23)
├── lifecycle.ts       # DeletionCascade + CascadeSeams (soft-delete, D49)
├── routes.ts          # HTTP endpoints (read-only + lifecycle)
├── errors.ts          # Named error classes
└── index.ts           # Public exports
```

**Boundary Rules**:
- File writes are internal; HTTP routes expose read + lifecycle only
- Atomic commits: all-or-nothing; FOR UPDATE lock serializes version allocation (D40)
- Manifest convergence: deterministic hash-ordered set (SC-025, D38)
- Soft-delete: cascade seams injectable, all no-ops for US7 (D49, T158)
- Quotas: per-file, per-project, per-account byte caps; rejected up-front (SC-026)
- Injected dependencies: db handle with transaction support, optional cascade seams

### Server Compile Module

```
src/compile/
├── client.ts          # HttpCompileClient (injectable HTTP+bearer, FR-016)
├── orchestrator.ts    # ArtifactOrchestrator.runTurn (verify-before-announce, SC-006, D35)
├── schemas.ts         # Zod schemas for Compile Service contract
├── errors.ts          # Named error types
└── index.ts           # Public exports
```

**Boundary Rules**:
- HTTP client is testable (injectable transport; no real service in tests)
- Compile failure is data, not exception (`ok:false`, job `status:"failed"`)
- Orchestrator is stateless per turn; all I/O injected (client, seam, R2 fetch, clock)
- Verify-before-announce: manifest schema validation + file fetchability checks before announcing
- Reuse (SC-006): One `compile` call; service decides reuse; Nyx announces once regardless
- Bounded poll (FR-016): Injected delay + clock; explicit timeout (never silent hang)
- Service holds R2 creds (constitution III, D52); Nyx bearer token is compile+publish only

### Server Protocol Module

```
src/protocol/
├── session.ts         # SessionStore interface + PgSessionStore implementation (read-only)
├── registry.ts        # SessionRegistry<TSocket> (generic takeover)
├── router.ts          # EventRouter + parseEvent dispatch
├── handler.ts         # createWsHandler orchestration
├── cookies.ts         # Cookie parsing utilities
└── index.ts           # Public exports
```

**Boundary Rules**:
- SessionStore is read-only (issuance delegated to SessionAuthStore in `auth/`)
- Router never throws on malformed frames
- Generic registry testable with sentinel objects
- Handler receives all dependencies injected

### Client Isolation Module

```
src/lib/
├── isolation.ts       # isCrossOriginIsolated() runtime check
└── isolation-headers.ts # isolationHeadersFor(pathname) decision logic
```

**Boundary Rules**:
- Pure functions (no DOM side effects)
- Can be imported by Vite plugin (dev + preview)
- Defensively handles missing `crossOriginIsolated` property

### Client Wallet Module

```
src/wallet/
├── types.ts           # Type definitions
├── config.ts          # Configuration
├── detect.ts          # Extension discovery (side effect: reads window.midnight.wallet)
├── classify.ts        # Pure state classifier (no dependencies)
├── connect.ts         # Orchestration (non-blocking)
├── remember.ts        # Storage operations
├── auth.ts            # HTTP client integration
├── WalletConnect.tsx  # Render surface
└── useWalletConnect.ts # Hook (coordinates above)
```

**Boundary Rules**:
- `classify` is pure; always resolves to one named `ConnectState`
- `connect` never throws; returns structured outcome
- Storage is optional (remembered selection is UX, not auth)
- HTTP calls go to `auth` module (separate concern)

### Client Artifacts Module

```
src/artifacts/
├── fetch.ts           # Fetch plan + execution (injectable fetch, no DOM)
├── manifest.ts        # ArtifactManifest type definitions
└── index.ts           # Exports
```

**Boundary Rules**:
- `manifest.ts` is types-only (consumed at client-side, not transferred over WS)
- `fetch.ts` is pure; injectable `fetch` (default `globalThis.fetch`)
- R2 reads use `mode: "cors"` + `credentials: "omit"` (constitution III, R3)
- No exception on incomplete/unfetchable prefix (structured error reporting instead)

## Where to Add New Code

| If you're adding... | Put it in... | Example |
|---------------------|--------------|---------|
| **New server route (HTTP)** | `apps/server/src/http/{resource}.ts` | `apps/server/src/http/status.ts` |
| **New auth endpoint** | `apps/server/src/auth/routes.ts` (expand as needed) | New handler in `registerAuthRoutes` |
| **New auth verification check** | `apps/server/src/auth/verify.ts` | New function (e.g., `verifyKeyFormat`) |
| **New server MCP call** | `apps/server/src/mcp/` (expand clients.ts or client.ts) | Call `toolchain.tools.invoke()` |
| **New project-related route** | `apps/server/src/projects/routes.ts` (expand) | New endpoint in `registerProjectRoutes` |
| **New file persistence logic** | `apps/server/src/projects/store.ts` | Method on `ProjectStore` interface + `PgProjectStore` impl |
| **New deletion side effect** | `apps/server/src/projects/lifecycle.ts` | New seam in `CascadeSeams` + inject in `buildServer` |
| **New compile service endpoint** | `apps/server/src/compile/client.ts` | New method on `HttpCompileClient` + schema in `schemas.ts` |
| **New compile orchestration scenario** | `apps/server/src/compile/orchestrator.ts` | New `CompileOutcome` variant + logic in `runTurn` |
| **New server business logic** | `apps/server/src/{domain}/` (create if needed) | `apps/server/src/deploy/`, `apps/server/src/ledger/` |
| **New WS event type** | `packages/protocol/src/events.ts` | Add to `ServerToClientEvent` or `ClientToServerEvent` |
| **New REST DTO** | `packages/protocol/src/http.ts` | Add schema, infer type |
| **New project entity type** | `packages/protocol/src/entities.ts` | Extend `Project`, `File`, `ChatMessage`, etc. |
| **New wallet state** | `apps/web/src/wallet/types.ts` (expand ConnectState or add new type) | New `ConnectState` variant |
| **New wallet behavior** | `apps/web/src/wallet/{module}.ts` (expand detect/classify/connect/auth as needed) | Extend `classifyConnectState` logic |
| **New React component** | `apps/web/src/{feature}/` | `apps/web/src/ledger/BalanceCard.tsx` |
| **New custom hook** | `apps/web/src/hooks/` or `apps/web/src/{feature}/use*.ts` | `apps/web/src/hooks/useProject.ts` |
| **New artifact fetch scenario** | `apps/web/src/artifacts/fetch.ts` | New fetch strategy or error case handling |
| **New artifact type** | `apps/web/src/artifacts/manifest.ts` | New field in `ArtifactManifest` or `ArtifactCircuit` |
| **New shared utility** | `apps/web/src/lib/` | `apps/web/src/lib/format.ts` |
| **New primitive type** | `packages/protocol/src/primitives.ts` | Branded ID, amount, timestamp |
| **Config tunable** | `apps/server/src/config/schema.ts` | New Zod field + env var |
| **Database migration** | Auto-discovered in `apps/server/src/db/migrations/` | `{timestamp}_{name}.sql` |

## Import Paths

### Monorepo Workspace Aliases

All packages use workspace: protocol:

```typescript
// In apps/server/package.json and apps/web/package.json
"@nyx/protocol": "workspace:*"

// Import in either app:
import { ProjectIdSchema, FileWriteEvent, parseEvent, AuthNonceResponseSchema, ArtifactsReadyPayload } from "@nyx/protocol";
```

### Internal Imports (within an app)

Use relative imports or tsconfig paths (if configured):

```typescript
// In apps/server/src/app.ts
import { buildServer } from "./app.js";          // relative
import type { ServerDeps } from "./app.js";     // type import

// In apps/server/src/index.ts
import { registerAuthRoutes } from "./auth/index.js";  // relative
import { registerProjectRoutes } from "./projects/index.js";  // relative
import { ArtifactOrchestrator } from "./compile/orchestrator.js";  // relative

// In apps/web/src/chat/Chat.tsx
import { useWs } from "../hooks/useWs.js";      // relative
import { useWalletConnect } from "../wallet/useWalletConnect.js";  // relative
import { fetchArtifacts } from "../artifacts/fetch.js";  // relative
```

## Entry Points

| File | Purpose | Launch Command |
|------|---------|----------------|
| `apps/server/src/index.ts` | Orchestrator boot (config → DI → listen) | `node dist/apps/server/src/index.js` |
| `apps/web/src/main.tsx` | React root mount (Vite dev/build) | `vite dev` or `vite build` |
| `apps/web/vite.config.ts` | Vite dev server + plugins (isolation headers) | Loaded by `vite` CLI |

## Generated Files & Artifacts

Files that are auto-generated and should NOT be manually edited:

| Location | Generator | Regenerate Command |
|----------|-----------|-------------------|
| `apps/server/dist/` | TypeScript compiler (tsc) | `pnpm typecheck` (checking only); build via build tool |
| `apps/web/dist/` | Vite bundler | `pnpm run build` (from apps/web) |
| `pnpm-lock.yaml` | pnpm lock file generator | `pnpm install` or `pnpm update` |
| `packages/*/dist/` | Build artifacts (monorepo packages) | Built by bundler on app build |

**Note**: Source maps and type definitions in `dist/` are generated; keep source in `src/`.

## Naming Conventions

### TypeScript Files

- **Components** (React): `PascalCase.tsx`
  - `Chat.tsx`, `WalletConnect.tsx`, `IsolationGate.tsx`, `Editor.tsx`
- **Utilities/Hooks**: `camelCase.ts`
  - `isolation.ts`, `useWs.ts`, `useWalletConnect.ts`, `fetch.ts`
- **Index files**: `index.ts` (barrel export)
  - Re-export all public symbols from a directory

### Database Files

- **Migrations**: `{timestamp}_{name}.sql`
  - `001_create_sessions.sql`, `002_create_projects.sql`

### Tests

- **Unit**: `{module}.test.ts`
  - `session.test.ts`, `router.test.ts`, `classify.test.ts`, `client.test.ts`
- **Integration**: `integration.test.ts` or `{feature}.spec.ts`
  - `integration.test.ts`, `websocket.spec.ts`, `wallet.test.ts`, `compile.spec.ts`

## Project Dependencies & Workspace Usage

### Root `package.json`

```json
{
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "dev": "pnpm -r dev"
  }
}
```

### Per-App/Package `package.json`

Each app declares:
- `@nyx/protocol` as `"workspace:*"`
- Dev scripts: `typecheck`, `test`, `lint`
- Build tool config (Vite, TypeScript, etc.)

### Running Commands

```bash
# Typecheck all packages
pnpm typecheck

# Run tests (all apps + packages)
pnpm test

# Install/update dependencies
pnpm install
pnpm update

# From within one app
cd apps/server && pnpm typecheck  # Workspace isolation
cd apps/web && pnpm dev
```

---

## What Does NOT Belong Here

- Architecture patterns → ARCHITECTURE.md
- Technology choices → STACK.md
- Code style rules → CONVENTIONS.md
- Test patterns → TESTING.md

---

*This document shows WHERE code lives. Update when directory structure changes.*
