# Architecture

> **Purpose**: Document system design, patterns, component relationships, and data flow.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5 update: compile pipeline architecture)

## Architecture Overview

Nyx is a bidirectional WebSocket-based prompt-to-DApp platform for Midnight Network. The architecture follows a lean, dependency-injected design:

- **Orchestrator** (Fly.io, Node.js): Fastify HTTP + WebSocket server, orchestrates AI agents, manages sessions and projects, interfaces with compile toolchain via Compile Service (HTTP) and MCP, proxies to Midnight infrastructure
- **Client** (Browser): React 19 + WebContainer (in-browser runtime), cross-origin-isolated browsing context with strict COOP/COEP headers, communicates via typed WebSocket events, reads compiled artifacts from R2
- **Auth** (SIWE): Sign-In-with-Ethereum-style flow on Midnight (bech32m addresses), nonce-based replay protection, 7-day sliding session cookies
- **Persistence** (PostgreSQL): Append-only transaction ledger, project files with version history, session state (auth_nonces, sessions, accounts), deploy registry, reconciliation state, chat history
- **Compile Pipeline**: Nyx → Compile Service (HTTP, holds R2 write creds) → MCP compact toolchain; service publishes content-hashed artifacts to R2, Nyx verifies completeness before announcing
- **Protocol** (Type-Safe Spine): Zod-based event schemas shared between apps via `@nyx/protocol` package — single source of truth for wire format

The architecture prioritizes **type safety**, **testability**, and **boundary enforcement** through dependency injection and side-effect-free component construction.

## Architecture Pattern

| Pattern | Description |
|---------|-------------|
| Dependency Injection | `buildServer({config, db, mcp, wsHandler?, authStore?})` is side-effect-free; index.ts owns config loading, fail-fast validation, and server boot |
| Layered + Event-Driven | Session/auth layer → Router → Typed event handlers; all frames validated before dispatch via `parseEvent` from `@nyx/protocol` |
| SIWE on Midnight | Nonce issuance → message signing → atomic signature + key↔address binding verification → session issuance; nonce single-use guarantee via database clock |
| Monorepo (pnpm) | Two apps + three packages; `packages/protocol` enforces schema alignment |
| Contract-Based Integration | MCP clients (toolchain, Tome, mnm) are encapsulated; HTTP compile client interfaces Compile Service; WS event contract enforces typing both directions |
| Versioned Project Persistence | Turn-scoped atomic commits, monotonic per-project version counter, manifest convergence, soft-delete with 30-day recovery window |
| Compile Pipeline (Content-Addressed) | Source hash folds compiler version + flags (SC-006, D35); service compiles and publishes to `<projectId>/<sourceHash>/` prefix; verify-before-announce gates announcement (FR-014) |

## Core Components

### Orchestrator (`apps/server/`)

**Purpose**: Boot the Nyx HTTP + WebSocket server, orchestrate AI agent swarms, manage project state, interface Midnight infrastructure and Compile Service

**Location**: `apps/server/src/`

**Dependencies**:
- Fastify (HTTP framework)
- `@fastify/websocket` (WS upgrade)
- `@modelcontextprotocol/sdk` (MCP client SDK)
- PostgreSQL driver (`pg`)
- Zod (schema validation)
- `@nyx/protocol` (shared event + DTO schemas)

**Key Modules**:
- `config/` — Environment validation (fail-fast, pure)
- `auth/` — SIWE nonce + verify + logout routes, key↔address binding, session auth store
- `db/` — PostgreSQL wiring + migration runner
- `mcp/` — MCP client connections (toolchain, Tome, mnm)
- `protocol/` — Session validation, typed event router, single-live-session registry
- `projects/` — File store, manifest, lifecycle, chat history (D26, D38, D49)
- `compile/` — HTTP client to Compile Service, artifact orchestration, verify-before-announce (US2, T066)
- `http/` — Health check routes
- `ws/` — WebSocket endpoint seam

**Dependents**: Client (web) via WebSocket; Midnight infrastructure via MCP; Compile Service via HTTP

### Web Client (`apps/web/`)

**Purpose**: React + WebContainer DApp IDE, cross-origin-isolated browsing context for `SharedArrayBuffer` access, reads compiled artifacts from R2

**Location**: `apps/web/src/`

**Dependencies**:
- React 19 (UI framework)
- Vite (dev server + bundler)
- shadcn (headless components)
- Tailwind CSS v4 (styling)
- `@webcontainer/api` (in-browser runtime)
- Monaco (code editor)
- `@nyx/protocol` (shared event schemas)

**Key Modules**:
- `chat/` — Conversation UI + activity stream
- `container/` — WebContainer boot, VFS sync, process feedback
- `editor/` — Monaco + Monarch Compact tokenizer
- `wallet/` — Wallet detection, connector state classification, SIWE signing client, connection flow, remembered selections
- `ledger/` — NYXT balance card + transaction feed
- `projects/` — Project CRUD + handoff UI
- `artifacts/` — R2 artifact fetch harness, manifest types (T070, US2)
- `lib/isolation.ts` — Cross-origin isolation runtime check
- `lib/isolation-headers.ts` — COOP/COEP decision logic

**Dependents**: Orchestrator (via WebSocket), Midnight Wallet SDK, R2 (public read, no creds)

### Auth Layer (`apps/server/src/auth/`)

**Purpose**: Sign-In-with-Ethereum-style authentication on Midnight; nonce-based replay protection; session issuance and management

**Location**: `apps/server/src/auth/`

**Components**:

#### Auth Routes (`routes.ts`)
- **POST /auth/nonce** — Issue single-use nonce with short expiry (5 min); no auth required
- **POST /auth/verify** — Verify signature + key↔address binding; atomically burn nonce (FR-039); auto-create account (D43); issue session cookie
- **GET /auth/session** — Resume on reload; validate session cookie; slide expiry forward (7-day sliding window, D44); return account address
- **POST /auth/logout** — Immediate server-side revocation; clear session cookie

#### Session Auth Store (`store.ts`)
- **Interface**: `SessionAuthStore` extends read-only `SessionStore` with write operations
- **Single-use nonce**: `issueNonce()` — Mint + persist with database-clock expiry
- **Atomic issue**: `issue(nonce, address, verifyFn)` — One transaction: burn nonce → verify → auto-create account → issue session
  - Burn is CAS (compare-and-swap); nonce spent on ANY attempt even if verify fails
  - Account auto-create via upsert (idempotent, D43)
  - Session issued with 7-day sliding expiry (D44)
- **Sliding renewal**: `slide(sessionId)` — Extend expiry on active session
- **Revocation**: `revoke(sessionId)` — Idempotent logout
- **Implementation**: `PgSessionAuthStore` (Postgres-backed); deterministic via injected clock + nonce generator (testable without `Date.now()`)

#### Verification (`verify.ts`)
- **`extractNonce(message)`** — Parse nonce from signed message
- **`verifyMessageSignature({verifyingKey, message, signature})`** — EdDSA25519 signature validation
- **`verifyKeyAddressBinding({verifyingKey, address})`** — Hash key to Bech32m address; ensure match

#### Middleware (`middleware.ts`)
- **`createRequireSession(deps)`** — Prehandler for protected routes
- **Behavior**: On incoming request, read session cookie → call `store.slide()` → on success, populate `request.auth` + slide expiry; on failure, 401
- **Result**: GET /auth/session + POST /auth/logout are protected; sliding resume on every authenticated request

**Dependents**: HTTP routes (auth endpoints); protocol layer (session validation); integration tests

### Projects & Persistence Layer (`apps/server/src/projects/`)

**Purpose**: File store, version history, manifest convergence, soft-delete + recovery, chat history (D26, D38, D48, D49)

**Location**: `apps/server/src/projects/`

**Components**:

#### File Store (`store.ts`)
- **Interface**: `ProjectStore` extends `ChatStore` with file + project operations
- **Implementation**: `PgProjectStore` (Postgres-backed)
- **Authoritative rows**: `project_files` (current state, one row per path), `project_file_versions` (append-only history)
- **Key abstractions**:
  - `commit(projectId, CommitRequest)` — Turn-scoped atomic batch write: lock project row, allocate monotonic version, UPSERT files + INSERT history (SC-026)
  - `getManifest(projectId)` — `(path, contentHash)[]` ordered by path (D38 convergence surface)
  - `getFile(projectId, path)` — Current content at latest version
  - `listProjects(ownerAddress)` — Live (non-deleted) projects
  - `createProject`, `renameProject`, `softDeleteProject` — Project lifecycle
  - `restoreProject` — Restore within 30-day recovery window (D49)
  - `purgeDeletedProjects`, `pruneFileVersions` — Operator routines (D48)
- **Size quotas** (SC-026):
  - Per-file cap: `maxFileBytes` (e.g., 1 MB)
  - Per-project cap: `maxProjectBytes` (e.g., 50 MB)
  - Per-account cap: `projectQuotaPerAccount` (e.g., 10 live projects)
  - Rejected up-front by byte length; never truncated

#### Chat Store (`chat.ts`)
- **Interface**: `ChatStore` (read/append)
- **Implementation**: `PgChatStore`
- **Key abstractions**:
  - `appendChat(projectId, message)` — Allocate next `seq`, insert message, return with timestamp (D23)
  - `getChat(projectId)` — Full history ordered by `seq` for reopen rehydration
  - Seq allocation locked per-project (defensive; D40 single-live-session gates writes)

#### Lifecycle & Cascade (`lifecycle.ts`)
- **Soft-delete with recovery**: `deletedAt` timestamp, 30-day recovery window, hard-delete after window
- **Ephemeral cascade**: Three injectable seams (all no-ops for US7):
  - `teardownContracts` — Tear down active deploys (S8, T158)
  - `cleanupR2Prefix` — Delete compiled artifacts prefix (D7, R2)
  - `terminateSessions` — Evict live sessions with notice (D40, WS)
- **Synchronous cascade**: Fired immediately on soft-delete, while durability persists

#### HTTP Routes (`routes.ts`)
- **GET /projects** — List caller's live projects
- **POST /projects {name}** — Create (per-account count quota, D49)
- **PATCH /projects/:id {name}** — Rename
- **DELETE /projects/:id** — Soft-delete + ephemeral cascade
- **POST /projects/:id/restore** — Restore within 30-day window
- **GET /projects/:id/manifest** — Convergence surface (D38)
- **GET /projects/:id/files/\*** — Current file content (read-only)
- **GET /projects/:id/chat** — Chat history for rehydration (D23)
- **Auth**: All routes require `requireSession` preHandler; ownership check returns 404 for missing OR unowned (SC-027)
- **File writes**: Not here; agent turns and user edits commit through the store (internal API)

**Dependents**: Protocol layer (typed event handlers), agent orchestration (turn commits), client UI (manifest + file reads), compile layer

### Compile Pipeline Layer (`apps/server/src/compile/`)

**Purpose**: Interface Compile Service, orchestrate artifact generation and publication, verify completeness before announcement (US2, T066, T070)

**Location**: `apps/server/src/compile/`

**Components**:

#### HTTP Compile Client (`client.ts`)
- **Purpose**: Injectable HTTP client to owner-built Compile Service (`infra/compile-service/API.md`)
- **Contract**: Validates all 2xx responses against §3/§4 contract schemas via Zod
- **Endpoints**:
  - `check(request)` — Syntax + type check on `.compact` files without compilation
  - `compile(request)` — Full compile: check + circuit generation + artifact upload to R2
  - `pollCompile(jobId)` — Poll compile job status (queued/running/succeeded/failed)
  - `version()` — Fetch available compiler versions
- **Error Handling**: Compile failure is DATA (`ok:false`, job `status:"failed"`); only transport/service faults throw `CompileServiceError`
- **Submit→Poll Loop**: `runCompileJob(client, request, options)` enforces bounded max-wait with injectable delay + clock (FR-016, deterministic testing); returns `CompileProgress` updates and terminal outcome
- **Dependencies**: Injectable `{ fetch, baseUrl, token }` (testable; no real service in unit tests)

#### Artifact Orchestrator (`orchestrator.ts`)
- **Purpose**: Nyx-side compile pipeline decision logic (T066)
- **Pipeline**:
  - **EC-11 skip**: No `.compact` changed in turn ⇒ SKIP (no service call, no announce; SC-006 reuse via sourceHash)
  - **D35 check-per-iteration**: Structured diagnostics; check failure surfaces immediately (scenario 1)
  - **Full on green**: Submit compile, poll to terminal, surface queued/running progress (FR-016 bounded wait)
  - **Verify-before-announce (FR-014)**: On `succeeded`, fetch `<urlPrefix>/manifest.json`, validate schema, HEAD every listed file to confirm fetchability BEFORE emitting `artifacts:ready { urlPrefix }` — at most once per green turn (scenario 2)
  - **Reuse (SC-006)**: `reused:true` result still announces once; one `compile` call (service's decision)
  - **Reopen (FR-050/D36)**: Stale-prefix verify failure re-submits full compile to repopulate fresh prefix (scenario 8)
- **Outcomes**: Discriminated union `CompileOutcome` encodes scenario (skip/check-failed/timeout/failed/reused/succeeded/reopen-guidance) + telemetry (compilerVersion, checkLatency, etc.)
- **Stateless per turn**: All I/O injected (client, emitArtifactsReady seam, R2 fetch, clock)

#### Schemas & Errors (`schemas.ts`, `errors.ts`)
- **Request/Response schemas**: Zod definitions for Compile Service contract (§3: CheckRequest/Response, §4: CompileRequest/CompileJob, §5: ArtifactManifest)
- **Named error types**:
  - `CompileServiceError` — Base class (transport/service fault)
  - `CompileServiceUnavailableError` — 5xx or connection failure
  - `CompileServiceProtocolError` — Invalid response schema
  - `CompileJobTimeoutError` — Bounded poll timeout exceeded (FR-016)

**Dependents**: Agent orchestration (turn layer invokes `runTurn`), artifact announcement via WS (`artifacts:ready` event)

### Artifact Fetch Harness (`apps/web/src/artifacts/`)

**Purpose**: Read compiled artifacts from R2 under cross-origin isolation, verify integrity, prepare for preview runtime (T070, US2)

**Location**: `apps/web/src/artifacts/`

**Components**:

#### Artifact Manifest Types (`manifest.ts`)
- **Purpose**: Type definitions for `manifest.json` (NOT a WS DTO; lives here, not `@nyx/protocol`)
- **Contract**: Mirrors `infra/compile-service/API.md` §5 verbatim
- **Types**:
  - `ArtifactManifest` — Integrity record at `<urlPrefix>/manifest.json` (uploaded last = completeness marker)
    - `sourceHash` — Content hash addressing the immutable prefix (folds compiler version + flags, SC-006)
    - `compilerVersion` — Exact pinned version (D6, telemetry)
    - `circuits` — Array of `{ name, proof }` entries
    - `files` — Array of `ArtifactManifestFile` (path, sha256, bytes, contentType)
  - `ArtifactCircuit`, `ArtifactManifestFile` — Supporting types
- **Constant**: `ARTIFACT_MANIFEST_FILENAME = "manifest.json"` (loaded first, marks prefix completeness)

#### Artifact Fetch Core (`fetch.ts`)
- **Purpose**: Plan and execute R2 artifact fetch matrix under cross-origin isolation
- **Input**: `urlPrefix` (e.g., `https://r2.example.com/projectId/sourceHash/`) + parsed `manifest.json`
- **Fetch Settings**:
  - `mode: "cors"` — Load-bearing (R3: cors-mode fetch exempt from COEP; works under `require-corp`); `credentials: "omit"` (constitution III — creds never cross boundary)
  - Every object cached immutable (R3) except oversized (EC-10 threshold ~512 MB edge-cache limit)
- **Output**: Structured fetch report
  - Status for each file (fetched/oversized-uncached/failed)
  - Telemetry (latency, oversized count)
  - No DOM side effects; deterministic with injectable `fetch`
- **Error Handling**: Incomplete/unfetchable prefix does NOT block (no throw); maps to reopen guidance (client-side)

**Dependents**: Browser preview runtime (`FetchZkConfigProvider`), verify-before-announce orchestrator (R2 HEAD checks)

### Wallet Connect Layer (`apps/web/src/wallet/`)

**Purpose**: Connector detection, state classification, SIWE flow orchestration; mirrors the `isolationHeadersFor` decision-function pattern

**Location**: `apps/web/src/wallet/`

**Components**:

#### Connector Detection (`detect.ts`)
- Discover installed wallet extensions (Lace v4, v3, etc.)
- Probe each for API version and readiness
- Return `DiscoveredWallet[]` with `{ id, name, generation, ... }`

#### State Classification (`classify.ts`)
- **Pure decision function**: `classifyConnectState(probe) → ConnectState`
- **Named outcomes** (never generic failures):
  1. `no-extension` — No wallets detected
  2. `unsupported-wallet` — No v4 wallets found
  3. `needs-selection` — Multiple v4 candidates, user must pick
  4. `not-authorized` — User rejected or not yet prompted
  5. `authorized-but-unavailable` — Connected but wallet unusable (R8)
  6. `wrong-network` — Connected but network mismatch
  7. `connected` — Ready for signing (T039 seam)

#### Active Connect Flow (`connect.ts`)
- Orchestrate: detect → classify → prompt if needed → request signature
- Non-blocking; never throws; returns structured outcome
- Integrates with remembered selection

#### Remembered Selection (`remember.ts`)
- Persist user's wallet choice in browser storage
- Restore on next session load (UX improvement, not auth)

#### SIWE Client (`auth.ts`)
- Integrate with server `/auth/nonce` → `/auth/verify` → `/auth/session` flow
- Sign message via wallet SDK
- Post signature to verify; receive session cookie
- Slide session via resumption endpoint

#### React Surface
- **`WalletConnect` component** — Multi-state render surface (show extension prompt / selection / network mismatch / sign challenge / success)
- **`useWalletConnect()` hook** — Encapsulate state + side effects (detect, classify, connect, persist)

**Dependents**: Top-level app; ledger, projects modules (read account state)

### Shared Protocol (`packages/protocol/`)

**Purpose**: Single source of truth for wire format — Zod schemas for WS events and REST DTOs

**Location**: `packages/protocol/src/`

**Exports**:
- `primitives.ts` — Branded identifiers (ProjectId, TurnId, ContractAddress, etc.), NYXT amounts, timestamps
- `entities.ts` — Data models (LedgerEntry, Project, File, etc.)
- `events.ts` — `ServerToClientEvent` and `ClientToServerEvent` discriminated unions + `parseEvent` router
- `http.ts` — REST DTO schemas (auth: nonce/verify/session responses, manifest, deposit, deploy, etc.)

**Auth-Specific Exports** (Phase 3):
- `AuthNonceResponse` — `{ nonce, expiresAt }`
- `AuthVerifyRequest` — `{ address, signature, message, verifyingKey }`
- `AuthVerifyResponse` — `{ address }`
- `AuthSessionResponse` — `{ address }`

**Project-Specific Exports** (Phase 4):
- `Project` — `{ id, ownerAddress, name, createdAt, deletedAt? }`
- `ProjectFileResponse` — `{ path, content }`
- `ManifestEntry` — `{ path, contentHash }`
- `ChatMessage` — `{ seq, role, content, createdAt, turnId? }`
- `CreateProjectRequest`, `UpdateProjectRequest` — HTTP bodies
- `CommitRequest` schema — File batch + author

**Compile-Specific Exports** (Phase 5):
- `ArtifactsReadyPayload` — `{ urlPrefix }` (WS event payload for compiled artifacts announcement)

**Key Exports**:
- `parseEvent(direction, bytes)` — Non-throwing frame parser, returns `DispatchOutcome`
- `ServerToClientEvent | ClientToServerEvent` — Typed discriminated unions
- Zod schemas for all DTOs

**Dependents**: Both `apps/server` and `apps/web` import schemas; shared index.ts re-exports all

### Database Layer (`apps/server/src/db/`)

**Purpose**: PostgreSQL persistence, migration runner, typed query interface

**Key Abstractions**:
- `Queryable` — Minimal interface for database queries (abstraction boundary for testability)
- `Db` — Pooled connection, migration state tracking
- `PgSessionStore` — SessionStore implementation backed by sessions table

**Storage Entities**:
- `auth_nonces` — Single-use nonces with expiry and consumption timestamp (T035)
- `accounts` — Account records, auto-created on first sign-in (D43)
- `sessions` — Session id, account address, expiry, revocation state (T035/T036)
- `projects` — Project metadata, owner, creation timestamp, soft-delete timestamp (D49)
- `project_files` — Current state: (project_id, path, content, content_hash, size, version, author), PK on (project_id, path) (D26)
- `project_file_versions` — Append-only history: (project_id, path, version, content, content_hash, size, author, created_at), FK back to project (D48)
- `chat_messages` — Chat history: (project_id, seq, role, content, turn_id, created_at), seq per-project monotonic (D23)
- `ledger` — Append-only NYXT reserve/settle transactions (D34)
- `deposits` — Deposit references, reconciliation state (D45/D46)
- `deployments` — Deploy registry, state transitions (FR-057)
- `reconciliation` — Burn circuit state, reconcile job results (D55/D56)

**Dependents**: All server-side layers (protocol, auth, ledger, projects, deploy, compile)

### Protocol Layer (`apps/server/src/protocol/`)

**Purpose**: WebSocket authentication, session takeover, typed event routing

**Components**:

#### SessionStore (`session.ts`)
- **Interface**: `SessionStore.get(sessionId): Promise<Session | null>`
- **Implementation**: `PgSessionStore` queries sessions table with expiry/revocation checks
- **Injectable** for testing with in-memory variant
- **Read-only** (writes delegated to `SessionAuthStore` in `auth/store.ts`)

#### SessionRegistry (`registry.ts`)
- **Purpose**: Single-live-session registry for per-(account, project) takeover (D40, last-tab-wins)
- **Generic** over socket type (testable with sentinels)
- **Methods**:
  - `claim(key, socket)` — Register socket, return displaced prior socket
  - `release(key, socket)` — Remove if still live
  - `get(key)` — Retrieve current live socket
- **Key**: JSON-encoded `[accountAddress, projectId]` tuple

#### EventRouter (`router.ts`)
- **Purpose**: Non-throwing typed event dispatcher
- **Exports**: `createEventRouter()`, `sendEvent()`, `serializeEvent()`
- **Frame Format**: `{ type, payload, ts }` (timestamp is epoch-ms)
- **Parsing**: `parseEvent("client-to-server", bytes)` from `@nyx/protocol` — handles malformed JSON/schema misses, returns `DispatchOutcome`
- **Handlers**: Registered per event type, receive narrowed event + `ConnectionContext`
- **Context**: Provides authenticated `session`, scoped `projectId`, `send()`, `close()`

#### ConnectionHandler (`handler.ts`)
- **Purpose**: Wire protocol handler for one WebSocket connection
- **Task**: T022 (authenticated connection handler)
- **Orchestrates**: SessionStore lookup, SessionRegistry claim/release, EventRouter dispatch
- **Output**: On authenticated connection, emits `ConnectionContext` to registered handlers

## Data Flow

### SIWE Authentication Flow (Phase 3, T035)

```
[Client: Initiate Connect]
    ↓
[GET /auth/nonce (unauthenticated)]
    ├→ Orchestrator: issueNonce()
    ├→ DB: INSERT auth_nonces (single-use, 5-min expiry)
    └→ Client receives { nonce, expiresAt }
        ↓
[Client: Sign nonce with wallet]
    ├→ Message format: "Sign this nonce: {nonce}"
    ├→ Wallet SDK: request signature
    └→ Client: EdDSA25519 signature received
        ↓
[POST /auth/verify { address, signature, message, verifyingKey }]
    ├→ Orchestrator: extract nonce from message
    ├→ DB transaction:
    │  ├→ Atomic burn: UPDATE auth_nonces WHERE nonce = ? AND consumed_at IS NULL
    │  ├→ If no rows: return { ok: false, reason: "nonce" }
    │  ├→ Verify: EdDSA25519 signature + key→address hash check
    │  ├→ If verify fails: return { ok: false, reason: "signature" } (nonce already spent)
    │  ├→ Account auto-create: INSERT accounts ON CONFLICT DO NOTHING
    │  └→ Session issuance: INSERT sessions (7-day expiry), return sessionId
    └→ Client: SET-COOKIE session cookie; redirect to app
        ↓
[GET /auth/session (authenticated)]
    ├→ Fastify preHandler: readSessionCookie() → store.slide() → refresh expiry
    ├→ On success: request.auth = { sessionId, address }
    └→ Client: Resume app state (account address available)
```

**Key Properties**:
- Nonce single-use: CAS burn happens BEFORE verify, so nonce is spent even on rejection (FR-039)
- 7-day sliding expiry: Every authenticated request (via `requireSession` preHandler) extends the session (D44)
- Auto-account: First sign-in creates account row; subsequent logins reuse it (D43)
- Database clock: All expiry checks use `now()`, never process clock

### Primary WebSocket Connection Flow

```
Client Browser
    ↓
[WS Upgrade Request + session cookie]
    ↓ (Fastify @fastify/websocket)
[createWsHandler]
    ├→ SessionStore.get(sessionId from cookie)
    ├→ SessionRegistry.claim(key) [D40 takeover]
    └→ ConnectionContext created
        ↓
    [Client → Server Event]
        ├→ parseEvent (validate frame)
        ├→ Router dispatch (handler lookup)
        └→ Handler executes
            ↓
        [Server → Client Event]
            ├→ sendEvent (validate)
            ├→ serializeEvent
            └→ socket.send()
```

### Project Persistence & Rehydration Flow (Phase 4, D26/D38)

```
[Agent/Editor: File write(s)]
    ↓
[Orchestrator: commit(projectId, CommitRequest)]
    ├→ Validate file sizes (per-file + per-project caps, SC-026)
    ├→ DB transaction:
    │  ├→ FOR UPDATE lock project row (serializes version allocation, D40)
    │  ├→ Allocate monotonic version N
    │  ├→ For each changed path:
    │  │  ├→ Compute SHA-256 content hash (deterministic, SC-025)
    │  │  ├→ UPSERT project_files (current state at version N)
    │  │  └→ INSERT project_file_versions (append-only history)
    │  └→ Atomicity guarantee (SC-026): mid-batch failure rolls back; previous version intact
    └→ Return { version: N }
        ↓
[Client reopen/reconnect]
    ├→ GET /projects/:id/manifest
    │  └→ Manifest = (path, contentHash)[] ordered by path (SC-025 stable set)
    ├→ Client compares with local VFS hash
    ├→ If mismatch: fetch changed paths via GET /projects/:id/files/:path
    └→ Sync to WebContainer VFS (HMR or rebuild as needed)
        ↓
[Chat rehydration]
    ├→ GET /projects/:id/chat
    └→ Full history ordered by seq (D23)
```

**Key Properties**:
- Monotonic version per project: Each commit allocates next N; agent turns batch many files as one version (D26)
- Atomic commit: All-or-nothing; no partial edits; failure rolls back and preserves prior consistent state (SC-026)
- Manifest convergence: Deterministic hash-ordered set for stable reconnection (D38, SC-025)
- Content hashing: Server-side SHA-256; identical content always yields identical hash
- Soft-delete: Sets `deletedAt`; cascade runs immediately (inject no-op seams for US7); hard-delete after 30 days (D49)
- Chat seq: Per-project monotonic counter allocated under project-row lock (D23, D40 defensive)

### Compile Pipeline Flow (Phase 5, T066/T070)

```
[Agent turn: File write(s) with .compact changes]
    ↓
[ArtifactOrchestrator.runTurn]
    ├→ EC-11 skip: No .compact in changeset ⇒ SKIP (SC-006 reuse via sourceHash)
    ├→ D35 check-per-iteration: `check(request)` → diagnostics (no .compact ⇒ early exit)
    │  └→ Check failure → structured outcome (scenario 1)
    └→ Full on green: `compile(request)` → poll to terminal
        ├→ Progress updates: queued → running
        ├→ Bounded max-wait (FR-016): `runCompileJob` with injected delay + clock
        └→ Terminal outcome:
            ├→ `failed` → Orchestrator returns failure outcome (nonce spent, user resumes, scenario 5)
            ├→ `timeout` → Explicit timeout (never silent hang, FR-016, scenario 7)
            └→ `succeeded` (or `reused:true`)
                ↓
            [Verify-before-announce (FR-014)]
                ├→ GET `<urlPrefix>/manifest.json` → Zod-validate
                ├→ HEAD each file in manifest (confirm fetchability under CORS)
                ├→ On any failure:
                │  ├→ `reopen` flag (scenario 8)
                │  └→ Re-submit full compile to repopulate fresh prefix
                └→ On success:
                    ├→ Emit WS: `artifacts:ready { urlPrefix }`
                    └→ Announce exactly once per green turn
```

**Key Properties**:
- Content-addressed prefix: `<projectId>/<sourceHash>/` (sourceHash folds compiler version + flags, SC-006)
- Compile failure is data, not throw: `ok:false` or job `status:"failed"` is structural outcome
- Check-per-iteration: D35 gates full compile; structured diagnostics (scenario 1)
- Verify-before-announce: FR-014 ensures completeness before announcement; reopen on verify failure (scenario 8)
- Reuse (SC-006): One `compile` call; service decides reuse; still announces once
- Bounded poll: FR-016 prevents silent timeouts; explicit `timeout` outcome with injected clock
- Service holds R2 creds: Constitution III; Nyx never writes R2 directly

### Turn/Agent Orchestration Flow (D21)

```
[Client: chat message]
    ↓ (via WS)
[Orchestrator: Turn start, model routing D19]
    ├→ Supervisor agent (Vercel AI SDK)
    ├→ Sub-agents: Scaffold, Plan, Implement, Review
    ├→ MCP calls to toolchain (compile check/build)
    ├→ Artifact flow: compile → verify → announce (Phase 5, T066)
    └→ Activity stream fanout (D20)
        ↓ (via WS: activity:update)
[Client: HMR, file updates, test results]
```

### Cross-Origin Isolation (R6, FR-021)

```
[Client requests any path]
    ↓
[Vite dev middleware / app.ts]
    ├→ isolationHeadersFor(pathname)
    ├→ If /webcontainer/connect/* → unsafe-none / unsafe-none (D53 bridge)
    └→ Else → require-corp / same-origin
        ↓
[Browser checks COOP/COEP pair]
    ├→ Grants SharedArrayBuffer access
    └→ Blocks cross-origin embedding
        ↓
[WebContainer uses SharedArrayBuffer]
    └→ In-browser process isolation
        ↓
[Artifact fetch under require-corp]
    ├→ R2 artifacts fetched with `mode: "cors"` (exempt from COEP, R3)
    └→ `credentials: "omit"` (constitution III)
```

## Layer Boundaries

| Layer | Responsibility | Can Access | Cannot Access |
|-------|----------------|------------|---------------|
| API (HTTP/WS) | Request demux, protocol handling | Config, MCP, Services, Compile | Database directly, Agent internals |
| Auth (HTTP routes) | Nonce issuance, signature verification, session issuance | SessionAuthStore, Verify fns | Raw frames, Agent state |
| Session/Auth | Cookie auth, session validation, nonce management | SessionAuthStore, Database | Ledger, Projects, Agent state |
| Protocol Router | Event parsing, frame dispatch | Handlers, Context, SessionStore | Raw socket, Database, Auth write |
| Projects | File persistence, manifest, lifecycle | Database, ProjectStore | HTTP context, raw frames |
| Compile | HTTP client to service, artifact orchestration, verify-before-announce | CompileClient, Database, artifact fetch | File edits, session state |
| Services (Ledger, Deploy) | Business logic, orchestration | Database, MCP, Compile | HTTP context, raw frames |
| Database | Persistence, transactions | Migrations, Query building | Application logic |
| MCP | External tool/toolchain integration | Transport, error handling | Database, session state |

## Dependency Rules

- **Higher layers can depend on lower layers, not vice versa**: Services depend on DB; API depends on Services; Compile depends on database + service HTTP client
- **Interfaces face up**: `SessionStore`, `SessionAuthStore`, `ProjectStore`, `Queryable`, `EventRouter`, `CompileClient` are injected abstractions
- **No cross-package imports except via public index.ts**: All `@nyx/protocol` imports go through `index.ts` re-exports
- **Single-responsibility**: Each module exports one primary abstraction or function family
- **Testability via injection**: `buildServer`, event handlers, repositories, auth stores, compile clients accept their dependencies (clock, nonce generator, DB, HTTP, artifact fetch, etc.)
- **Auth writes do not cross protocol boundary**: Session issuance and nonce management live in `auth/` module; protocol layer reads via `SessionStore` interface
- **Project commits are atomic**: All-or-nothing batch writes; no partial updates; file writes happen only via internal store API, not HTTP
- **Compile service holds R2 creds**: Nyx never writes R2; service is sole publisher (constitution III, D52)

## Key Interfaces & Contracts

| Interface | Purpose | Location | Implementations |
|-----------|---------|----------|-----------------|
| `SessionStore` | Session validation contract (read-only) | `protocol/session.ts` | `PgSessionStore`, in-memory mock |
| `SessionAuthStore` | Session + nonce write contract (extends SessionStore) | `auth/store.ts` | `PgSessionAuthStore` |
| `ProjectStore` | File store + project lifecycle (extends ChatStore) | `projects/store.ts` | `PgProjectStore` |
| `ChatStore` | Chat read/append contract | `projects/chat.ts` | `PgChatStore` |
| `ProjectDb` | Transaction-capable DB (read + transact) | `projects/store.ts` | `Db` (postgres pool) |
| `Queryable` | Database query abstraction (read-only) | `db/index.ts` | `Db` (postgres pool), transaction handle |
| `EventRouter` | Typed event handler registry | `protocol/router.ts` | Built via `createEventRouter()` |
| `SessionRegistry<TSocket>` | Takeover registry (generic) | `protocol/registry.ts` | Built via `createSessionRegistry()` |
| `Sendable` | Minimal send-capable socket | `protocol/router.ts` | WebSocket, mock for tests |
| `ClientEventHandler<T>` | Per-event-type handler | `protocol/router.ts` | User-supplied callbacks |
| `DeletionCascade` | Ephemeral teardown contract | `projects/lifecycle.ts` | Built via `createDeletionCascade()` |
| `CompileClient` | HTTP client to Compile Service | `compile/client.ts` | `HttpCompileClient` (injectable transport) |

## State Management

| State Type | Location | Pattern | Consistency |
|------------|----------|---------|-------------|
| Auth nonces | PostgreSQL `auth_nonces` table | Single-use: CAS burn on any attempt; 5-min expiry | Database clock (server-driven) |
| Session state | PostgreSQL `sessions` table | Sliding 7-day expiry; revocation flag | Database clock (server-driven expiry) |
| Live connections | In-memory `SessionRegistry` | Per-(account, project) singleton | Volatile; lost on restart (acceptable) |
| Accounts | PostgreSQL `accounts` table | Auto-create on first sign-in (D43); idempotent upsert | Immutable after creation |
| Project metadata | PostgreSQL `projects` table | Soft-delete with 30-day recovery; hard-delete after window (D49) | Durable; recovery window enforced by DB clock |
| Project files (current) | PostgreSQL `project_files` table | Version-per-turn (D26), one row per path, UPSERT on commit | Versioned; current at latest version |
| Project files (history) | PostgreSQL `project_file_versions` table | Append-only history indexed by (project_id, path, version) | Immutable; pruned by age + count (D48) |
| Chat messages | PostgreSQL `chat_messages` table | Per-project seq monotonic counter, allocated under project-row lock (D23) | Append-only; immutable |
| Transaction ledger | PostgreSQL `ledger` table (append-only) | Reserve → Settle state machine (D34) | Immutable; auditable |
| Deploy state | PostgreSQL `deployments` table | State machine: pending → compiled → deployed | Replayed from state column |
| Compile jobs | Compile Service (transient) | Poll-based status tracking; long-running but bounded (FR-016) | Service-owned; Nyx polls, does not store |

## Cross-Cutting Concerns

| Concern | Implementation | Location |
|---------|----------------|----------|
| Configuration validation | Zod schema, fail-fast on boot | `config/schema.ts`, `config/load.ts`, `index.ts` |
| Error handling | Non-throwing event router (`DispatchOutcome`), typed errors in MCP layer, named project errors, compile service errors | `protocol/router.ts`, `mcp/errors.ts`, `projects/errors.ts`, `compile/errors.ts` |
| Auth error handling | Typed `IssueResult` (ok/reason), structured HTTP responses | `auth/routes.ts`, `auth/store.ts` |
| Compile error handling | Discriminated `CompileOutcome` union; compile failure is data, not throw | `compile/orchestrator.ts`, `compile/schemas.ts` |
| Type safety | Zod schemas in `@nyx/protocol`, strict TypeScript config, compile service contract schemas | `packages/protocol/src/`, `tsconfig.json`, `compile/schemas.ts` |
| Session lifecycle | Injected `SessionStore`, `SessionAuthStore` for write; lifecycle bound to nonce + signature | `protocol/session.ts`, `auth/store.ts` |
| Project lifecycle | Injected `ProjectStore`; lifecycle bound to ownership + soft-delete + recovery window | `projects/store.ts`, `projects/routes.ts` |
| Compile lifecycle | Injected `CompileClient` + artifact fetch; bounded poll + verify-before-announce | `compile/client.ts`, `compile/orchestrator.ts`, `artifacts/fetch.ts` |
| Concurrency | Semaphore in MCP clients, DB connection pool, atomic CAS nonce burn, FOR UPDATE project-row locks | `mcp/concurrency.ts`, `db/client.ts`, `auth/store.ts`, `projects/store.ts` |
| Logging | Fastify logger | `app.ts` (Fastify({ logger: true })) |
| Cross-origin isolation | Vite plugin + runtime check | `apps/web/lib/isolation-headers.ts`, `apps/web/lib/isolation.ts` |
| Wallet connect | Pure state classifier mirrors `isolationHeadersFor` pattern (no side effects) | `apps/web/src/wallet/classify.ts` |
| Content integrity | SHA-256 server-side hashing, deterministic manifest generation, hash-ordered path ordering, R2 manifest verify | `projects/store.ts`, `protocol/http.ts`, `compile/orchestrator.ts` |
| Artifact fetch | R2 CORS reads with injectable fetch, no credentials | `artifacts/fetch.ts`, `artifacts/manifest.ts` |

## Architectural Constraints

1. **Dependency Injection** (testability): No singletons; `buildServer({config, db, mcp, wsHandler?, authStore?, projectStore?, compileClient?})` receives all deps
2. **Non-throwing routing** (availability): Event frames never crash the connection; malformed frames return `DispatchOutcome`
3. **Nonce single-use guarantee** (security, FR-039): CAS burn via database; nonce is spent on ANY attempt (success or failure)
4. **Atomic verify-and-issue** (security): In one transaction: burn nonce → verify → auto-create account → issue session; rejection still spends nonce
5. **Atomic commit** (SC-026): File batches commit all-or-nothing; mid-failure rolls back; previous consistent state intact
6. **Monotonic versioning** (SC-026): Per-project version counter; each commit allocates next N; no holes; serialized via FOR UPDATE lock (D40)
7. **Manifest convergence** (SC-025, D38): Deterministic (path, contentHash)[] ordered by path; stable set for reconnection; content hash is server-side SHA-256
8. **Content quotas** (SC-026): Per-file, per-project, per-account byte caps; rejected up-front; never truncated
9. **Soft-delete with recovery** (D49): Sets `deletedAt`, cascade runs immediately; hard-delete after 30-day window; recovery enforced by DB clock
10. **Ephemeral cascade injection** (D49, T158): Three injectable seams (teardownContracts, cleanupR2Prefix, terminateSessions); all no-ops for US7
11. **7-day sliding session** (UX, D44): Every authenticated request extends expiry; no re-login within window
12. **Auto-account on first sign-in** (UX, D43): Account created at verify time; subsequent logins reuse
13. **Single SessionStore** (abstraction): Session validation delegates to injected `SessionStore`; production uses `PgSessionStore`; writes via separate `SessionAuthStore`
14. **Last-tab-wins takeover** (D40): New connection displaces prior socket for same (account, project) key; FOR UPDATE locks serialize per-project version allocation
15. **One protocol schema** (type safety): All WS event and REST DTO shapes defined once in `@nyx/protocol`
16. **Append-only ledger** (auditability, D34): Financial transactions only INSERT; no UPDATE/DELETE
17. **Chat seq monotonic** (D23, D40): Per-project counter allocated under project-row lock; defensive belt-and-braces over single-live-session
18. **Fail-fast config** (boot safety): Invalid config exits with named error; no silent defaults
19. **Side-effect-free app builder**: `buildServer` constructs dependencies, does not load config or listen
20. **Pure state classifier for wallet** (testability): `classifyConnectState` is dependency-free; always resolves to one named `ConnectState`
21. **Database clock for all time-based decisions** (consistency): Expiry, single-use, replay protection, soft-delete recovery all use database `now()`, never process clock
22. **Content-addressed compile prefix** (SC-006, reuse): sourceHash folds compiler version + flags; same source ⇒ same prefix ⇒ artifact reuse; service decides, Nyx checks
23. **Verify-before-announce** (FR-014): No artifact announcement until completeness verified (manifest fetch + file HEAD checks under CORS)
24. **Compile failure is data** (FR-016): `ok:false`, job `status:"failed"`, or timeout are structured outcomes, never exceptions
25. **Bounded compile poll** (FR-016): Injected delay + clock; explicit timeout if max-wait exceeded (never silent hang)
26. **Compile service isolation** (constitution III, D52): Service holds sole R2 write credentials; Nyx bearer token grants compile+publish, not raw R2 access
27. **R2 artifact CORS reads** (R3, FR-014): Every artifact fetched with `mode: "cors"`, exempt from COEP under `require-corp`
28. **Immutable R2 prefix** (SC-006): Content-addressed addressing; same content hash ⇒ same prefix; mutations never occur

---

## What Does NOT Belong Here

- Directory structure details → STRUCTURE.md
- Technology versions → STACK.md
- External service configs → INTEGRATIONS.md
- Code style rules → CONVENTIONS.md

---

*This document describes HOW the system is organized. Keep focus on patterns and relationships.*
