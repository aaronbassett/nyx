# External Integrations

> **Purpose**: Document all external services, APIs, databases, and third-party integrations.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5: Compile Service integration added for smart contract compilation + R2 publishing)

## Databases & Data Stores

| Service | Type | Purpose | Configuration Location |
|---------|------|---------|------------------------|
| PostgreSQL | Relational Database | Primary data store: NYXT ledger (D13/D34), projects/files, sessions (D44), deposits (D45/D46), deploy registry (FR-057) | `apps/server/src/db/client.ts`, `DATABASE_URL` env var |

### Connection Patterns

- **Connection Pooling**: Yes, via `pg.Pool` with configurable max (default 10) in `apps/server/src/db/client.ts`
- **Query Builder**: Raw SQL + parameterized queries (no ORM)
- **Migration Approach**: Manual SQL migrations in `apps/server/src/db/migrations/` (0001_initial_schema.up/down.sql)
- **Transaction Support**: Built-in via `db.transaction()` wrapper (FR-043, FR-047 atomic ledger + state pairs); also used for atomic project file commits (US7, SC-026)

## Authentication & Authorization

| Provider | Purpose | Configuration Location |
|----------|---------|------------------------|
| Lace Wallet (dapp-connector v4) | User authentication via SIWE-style proof with unshielded address (Phase 3, D43/D44/T035) | Web: `@midnight-ntwrk/dapp-connector-api@4.0.1` detection via `window.midnight` UUID map |
| Session Store (PostgreSQL) | Authenticated session storage (7-day sliding window D44) | `apps/server/src/protocol/session.ts`, `SESSION_LIFETIME_MS` config |

### Auth Flow

- **Wallet Connection**: Web client detects Lace wallet via `window.midnight` (dapp-connector v4 InitialAPI; checks for `io.lace.wallet` rdns), calls `connect('<networkId>')`
- **Address Retrieval**: Client calls `getUnshieldedAddress()` to retrieve the user's unshielded address
- **SIWE-Style Proof**: Client requests nonce from `/auth/nonce` → creates domain-bound message → calls `signData(message, { encoding:'text', keyType:'unshielded' })`
- **Server Verification**: Client POST to `/auth/verify` with `{ address, signature, message, verifyingKey }` (BIP-340 Schnorr via `@midnight-ntwrk/ledger-v8@8.1.0`)
- **Session Issuance**: Server verifies signature against unshielded address (computed from `verifyingKey` via `@midnight-ntwrk/wallet-sdk-address-format@3.1.2`), creates account on first sign-in, issues session cookie (FR-034/FR-039)
- **Session Lifetime**: Configurable 7 days (default `SESSION_LIFETIME_MS = 604_800_000`ms); sliding-window refresh on each request (D44)
- **Logout**: POST `/auth/logout` invalidates session in PostgreSQL registry (FR-050)

**Security Details:**
- **Nonce Lifecycle**: Single-use, short-lived expiry (burned on any verification attempt, SC-017/SC-018)
- **Key Verification**: `verifyingKey` (BIP-340 hex) is required in `/auth/verify` to confirm key↔address binding; blocks key-substitution auth bypass (constitution III)
- **No Client Export**: Session tokens never exposed to client; all session state server-side in PostgreSQL (constitution III)

## External APIs

### First-Party APIs (Nyx Services)

| Service | Purpose | Endpoint Config | Client Location | Note |
|---------|---------|-----------------|-----------------|------|
| **Compile Service** | Compile Compact contracts, generate proving keys/verifier keys/zkIR, publish to R2 (Phase 5, US2) | `COMPILE_SERVICE_URL` | `apps/server/src/compile/client.ts` | Bearer token auth (`COMPILE_SERVICE_TOKEN`); stateless w.r.t. workspaces; R2 is durable store. Exposes `/v1/check` (fast static validity, no upload), `/v1/compile` (async job: full build + R2 publish), `/v1/compile/{jobId}` (poll), `/v1/version` (compiler versions). See `infra/compile-service/API.md` for full contract. |
| Midnight SDK | Chain access: contract deployment (D50), indexer observation for deposit crediting (D45) | Via `@midnight-ntwrk/*` npm packages (versions via `npm view`, not hardcoded) | Not yet installed; will be in `apps/server/src/chain/` | Public npm; only orchestrator→chain, never server→client (constitution III) |

### Third-Party APIs

#### Model Context Protocol (MCP) Clients

Three named MCP servers, configured at boot (T019) via config schema in `apps/server/src/config/schema.ts`:

| Provider | Purpose | Endpoint Config | SDK/Client | Rate Limits |
|----------|---------|-----------------|-----------|-------------|
| Toolchain MCP | Compact contract compile/check (D30/D31, T067) — **internal to Compile Service only** | `MCP_TOOLCHAIN_URL` (server-private, not client-bound) | `@modelcontextprotocol/sdk` (1.29.0) | Bounded concurrency (default 4); Compile Service manages the gate |
| Tome MCP | Agent skill routing (US1, supervisor swarm) | `MCP_TOME_URL` | `@modelcontextprotocol/sdk` | Bounded concurrency (default 4) |
| Midnight Manual (mnm) | Docs Q&A for orchestrator context (US1) | `MCP_MNM_URL` | `@modelcontextprotocol/sdk` | Bounded concurrency (default 4) |

**Connection Details:**
- **Transport**: Streamable HTTP (via @modelcontextprotocol/sdk)
- **Timeouts**: Per-request timeout (connect + call) of `MCP_TIMEOUT_MS` (default 10_000ms, D31 "no call may hang")
- **Health Probes**: Shorter `MCP_HEALTH_TIMEOUT_MS` (default 5_000ms) for `/health/mcp` endpoint
- **Client Location**: `apps/server/src/mcp/clients.ts`, `apps/server/src/mcp/client.ts`
- **Toolchain MCP Note**: Toolchain MCP is called only by the Compile Service (internal to `COMPILE_SERVICE_URL`). Nyx does not call it directly; it calls Compile Service instead (constitution III: no direct MCP-to-browser exposure).

#### Proof Server (Interim D37)

| Provider | Purpose | Endpoint Config | Auth | Rate Limits |
|----------|---------|-----------------|------|-------------|
| Nyx-hosted Midnight Proof Server | ZK proof generation for contract circuits | `PROVER_URL` | Session-bound proving tokens (D52) | Per-session window: `PROVER_RATE_LIMIT_MAX` (default 60 req/min), window `PROVER_RATE_LIMIT_WINDOW_MS` (default 60_000ms) |

**Details:**
- **Token Lifetime**: 5 minutes (`PROVING_TOKEN_LIFETIME_MS`, default 300_000ms)
- **Internal Only**: URL not exposed to clients (constitution III, D52)
- **Transition**: Watching item to flip back to in-wallet proving

## Internal API Endpoints (Fastify Routes)

### Authentication Endpoints (Phase 3, T035)

| Endpoint | Method | Request Body | Response | Purpose |
|----------|--------|--------------|----------|---------|
| `/auth/nonce` | POST | `{}` | `{ nonce: string, expiresAt: number }` | Issue single-use nonce for SIWE message (no auth required) |
| `/auth/verify` | POST | `{ address: string, signature: string, message: string, verifyingKey: string }` | Sets session cookie; `{ accountId: string }` on success | Verify BIP-340 signature; create account on first sign-in; burn nonce (FR-034, FR-039) |
| `/auth/logout` | POST | `{}` (authenticated) | `{}` | Invalidate session in PostgreSQL registry (FR-050) |

**Implementation Notes:**
- **Signature Verification**: Uses `@midnight-ntwrk/ledger-v8@8.1.0` for BIP-340 Schnorr verification
- **Address Validation**: Uses `@midnight-ntwrk/wallet-sdk-address-format@3.1.2` for Bech32m encoding/decoding and key↔address binding
- **Session Cookie**: HTTP-only, secure, same-site (CSRF protection); backed by PostgreSQL `PgSessionStore` (FR-050)

### Projects & Files Endpoints (Phase 4, T052/T054/T055)

All endpoints require **live session authentication** via `requireSession` preHandler. All endpoints enforce **ownership on the unshielded address** (D43): a project the caller does not own—or that does not exist—answers 404, so ownership never leaks project existence (SC-027).

#### Project Lifecycle

| Endpoint | Method | Request Body | Response | Status | Purpose |
|----------|--------|--------------|----------|--------|---------|
| `/projects` | GET | — | `Project[]` | 200 | Retrieve caller's live (non-deleted) projects, oldest first |
| `/projects` | POST | `{ name: string }` | `Project` | 201 | Create a new project; rejects past per-account count quota (D49) |
| `/projects/:id` | PATCH | `{ name?: string }` | `Project` | 200 | Rename a live project; no-op if name is omitted |
| `/projects/:id` | DELETE | — | `Project` | 200 | Soft-delete a live project; triggers immediate ephemeral cascade (D49) |
| `/projects/:id/restore` | POST | — | `Project` | 200 | Restore a soft-deleted project within 30-day recovery window (D49); rejects if window expired |

#### Content & Metadata

| Endpoint | Method | Request Body | Response | Status | Purpose |
|----------|--------|--------------|----------|--------|---------|
| `/projects/:id/manifest` | GET | — | `[{ path: string, contentHash: string }, ...]` ordered by path | 200 | D38 convergence surface: paths + SHA-256 content hashes at latest version for client reopen comparison (SC-025) |
| `/projects/:id/files/*` | GET | — | `{ path: string, content: string }` | 200 | Retrieve current file content at latest version |
| `/projects/:id/files/*` | GET | — | — | 404 | File not found; error includes project ID + path for debugging (EC-34) |
| `/projects/:id/chat` | GET | — | `ChatMessage[]` | 200 | Chat history for rehydration (D23, T055) |

**Response Schema Details:**
- **Manifest**: `ManifestEntry[]` (zod: `{ path: string, contentHash: string }`), ordered by path; hashes are SHA-256 hex computed server-side via `node:crypto` (D38, SC-025)
- **File**: `ProjectFileResponse` (zod: `{ path: string, content: string }`)
- **Project**: `Project` (zod: `{ id: string, name: string, ownerAddress: string, createdAt: number, deletedAt?: number }`)
- **Chat**: `ChatMessage[]` (zod: `{ id: string, role: 'user'|'assistant', content: string, timestamp: number }`)

**Error Handling:**
- **401 Unauthenticated**: When no session is present
- **404 Not Found**: When project is missing OR owned by someone else (SC-027 existence privacy); includes `projectId` in error
- **409 Project Quota Exceeded**: When creating past per-account limit; includes `limit` in error (D49)
- **410 Restore Window Expired**: When restoring beyond 30-day window; includes `projectId` in error (D49)
- **413 File/Project Size Quota**: Single file exceeds `maxFileBytes` OR project total exceeds `maxProjectBytes`; includes `path` and `limit` in error (D49, SC-026)

**Implementation Notes (T052/T054/T055):**
- **Authorization**: Ownership checked in `loadOwned()` helper before any data is returned; 404 response hides existence (SC-027)
- **Content Hashing**: SHA-256 computed server-side via `node:crypto.createHash("sha256")` during file commits; identical content always yields identical hash (D38, SC-025)
- **Manifest Endpoint**: Only reads `(path, contentHash)` from `project_files` table, ordered by path; stable for change detection (SC-025)
- **File Retrieval**: Returns current (`latest version`) file content; 404 if path does not exist (EC-34)
- **Transaction Atomicity**: File commits allocate a monotonic project-wide version; all files in a batch update atomically, failure rolls back entire batch (US7, SC-026)
- **Soft-Delete + Cascade**: DELETE soft-deletes the row (`deleted_at` set); ephemeral cascade runs immediately while row stays recoverable within 30-day window (D49)
- **Route Location**: `apps/server/src/projects/routes.ts`
- **Store Location**: `apps/server/src/projects/store.ts` (authoritative Postgres store, D26)

### Compile Service Endpoints (Phase 5, US2)

**All endpoints require bearer token authentication** via `Authorization: Bearer <COMPILE_SERVICE_TOKEN>` header (D52, constitution III).

| Endpoint | Method | Request Body | Response | Purpose |
|----------|--------|--------------|----------|---------|
| `/v1/check` | POST | `{ files: [{ path, content }][], entry?: string }` | `{ ok: boolean, diagnostics: [], compilerVersion, durationMs }` | Fast static validity check (`--skip-zk`), no keygen, no R2 upload; feeds verify loop on failed check |
| `/v1/compile` | POST | `{ projectId: string, files: [{ path, content }][], entry?: string }` | `{ jobId, status: "queued"\|"running"\|"succeeded"\|"failed", sourceHash }` (202 or 200) | Async full compile + R2 publish; status is "queued"/"running" initially, "succeeded"/"failed" terminal; reuses artifacts if sourceHash already exists on R2 (SC-006) |
| `/v1/compile/{jobId}` | GET | — | `{ jobId, status, sourceHash, progress?, result?, error? }` (200) | Poll a compile job; `progress` present while queued/running; `result` present on "succeeded" (includes `urlPrefix`, `reused`, `compilerVersion`, circuits); `error` present on "failed" |
| `/v1/version` | GET | — | `{ compilerVersion, languageVersion, ledger, runtime, cli, compactp, skew }` (200) | Pinned Compact toolchain versions (D6); also embedded in every check/compile result |

**Implementation Notes (Phase 5, US2):**
- **Compile Service Location**: Hosted at `COMPILE_SERVICE_URL`; private-by-construction (Fly 6PN / private mesh)
- **Client Location**: `apps/server/src/compile/client.ts` (Nyx calls Compile Service, Compile Service calls Toolchain MCP internally)
- **Source of Truth**: Compile Service computes content hash deterministically (sha256 of canonical file order + compiler version + flags); reuse lookup is O(1) check of R2 prefix existence + manifest fetch
- **Verify-Before-Announce**: Job reaches "succeeded" only after all artifacts + manifest are uploaded and refetched to confirm completeness (FR-014)
- **Concurrency**: Compile Service manages Toolchain MCP concurrency gate; Nyx treats compile jobs as independent async units
- **Trust Boundary**: Compile Service holds **the only R2 write credentials** (never cross to Nyx, browser, WebContainer, or generated file, D50/D6/constitution III). Nyx only _reads_ R2 via public domain.
- **Artifact Lifecycle**: All artifacts uploaded with `Cache-Control: public, max-age=31536000, immutable` and correct `Content-Type`. R2 lifecycle expires prefixes on D7 window (~1 day); stale fetch triggers reopen→recompile (D36). See `infra/compile-service/API.md` §5 for full R2 layout and `manifest.json` schema.

## File Storage

| Service | Purpose | Configuration | Authentication |
|---------|---------|-----------------|-----------------|
| Cloudflare R2 | Store ZK artifacts (prover/verifier keys, zkIR) for cross-origin-isolated preview pages (COEP require-corp, R3) | Bucket: `R2_BUCKET`, public base URL: `R2_PUBLIC_BASE_URL` | **Compile Service only** (bearer token): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` on write; Nyx reads via public domain with no credentials (constitution III, D50) |

**Hosting & CDN:**
- **Custom Domain**: `zk.<nyx-domain>` (Cloudflare Transform Rule + Smart Tiered Cache, R3)
- **Headers (Transform Rule)**: `Cross-Origin-Resource-Policy: cross-origin`, optionally `Access-Control-Allow-Origin: *`
- **Cache Rule (Mandatory)**: Match hostname, Edge TTL "respect origin" (prevents silent no-cache drift on `.prover`/`.verifier`/`.bzkir`)
- **Immutability**: Content-hashed paths with `Cache-Control: public, max-age=31536000, immutable` (R3)
- **Client Access (Phase 5)**: Web app `FetchZkConfigProvider` fetches artifacts from R2 content-hashed prefix (e.g., `https://zk.<nyx-domain>/<projectId>/<sourceHash>/keys/<circuit>.prover`) in cors mode (credentialless), within cross-origin-isolated context (R6 carve-out). Nyx emits `artifacts:ready { urlPrefix }` over WS protocol (D12) once compile job succeeds and manifest is verified complete.

**Artifact Layout (§5 of `infra/compile-service/API.md`):**
```
<projectId>/<sourceHash>/
  manifest.json                     # integrity manifest (uploaded LAST = completeness marker)
  keys/<circuit>.prover
  keys/<circuit>.verifier
  zkir/<circuit>.bzkir
```

`manifest.json` contains: `sourceHash`, `compilerVersion`, `circuits`, file inventory with SHA-256 hashes. Uploaded last to signal prefix completeness.

## Model Routing (D19 Agent Supervisor)

Configuration: `MODEL_ROUTING` (JSON) in environment, validated at boot.

| Role | Provider Options | Config Location | Note |
|------|------------------|-----------------|------|
| supervisor | Anthropic, OpenAI, Gemini, OpenRouter, openai-compatible | `MODEL_ROUTING.supervisor` | Routes all orchestration decisions |
| scaffolding | (same) | `MODEL_ROUTING.scaffolding` | Generates app code |
| planning | (same) | `MODEL_ROUTING.planning` | Designs implementation |
| implementation | (same) | `MODEL_ROUTING.implementation` | Writes code |
| review | (same) | `MODEL_ROUTING.review` | Reviews and audits code |

**Schema Location**: `apps/server/src/config/schema.ts` (ModelProviderSchema, ModelRouteSchema, ModelRoutingTableSchema)

**Configuration Pattern**:
```json
{
  "supervisor": { "provider": "anthropic", "model": "claude-3-5-sonnet-..." },
  "scaffolding": { "provider": "openai", "model": "gpt-4-turbo" },
  ...
}
```

**Provider Details**:
- **openai-compatible**: Requires `baseUrl` (self-hosted vLLM/Ollama/TGI or OpenRouter endpoint)
- **openai, anthropic, gemini, openrouter**: Use standard SDK endpoints (no baseUrl)

## Message Queues & Event Systems

| Service | Purpose | Configuration Location | Protocol |
|---------|---------|------------------------|----------|
| WebSocket (/ws endpoint) | Bidirectional client-server events (D12 protocol, T021) | Fastify + `@fastify/websocket`, route: `/ws` | WS event schemas in `@nyx/protocol/src/events.ts` |

**Protocol Details**:
- **Event Schemas**: Discriminated unions `ServerToClientEvent`, `ClientToServerEvent` (zod, `packages/protocol/src/events.ts`)
- **Session Routing**: `PgSessionStore` maintains active WS connections per session (session registry FR-050)
- **Handler**: `createWsHandler()` in `apps/server/src/protocol/index.ts`, injected with session store + config

## Caching

| Service | Purpose | Configuration | Defaults |
|---------|---------|------------------|----------|
| PostgreSQL Query Result Cache | Implicit via connection pooling | No explicit application cache layer | Session/registry queries cached in pg.Pool |
| R2 Edge Cache | ZK artifact delivery via Cloudflare edge (R3) | Smart Tiered Cache on `zk.<nyx-domain>` | Content-hashed immutable paths: 1-year TTL |

## Environment Variables (Critical)

### Connection & Infrastructure

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host/nyx` |
| `PORT` | No (default 8080) | HTTP server port | `8080` |
| `NODE_ENV` | No (production in Fly) | Runtime environment | `production` |
| `MCP_TOOLCHAIN_URL` | Yes | Toolchain compile MCP endpoint (server-private, used by Compile Service) | `http://toolchain.6pn:8080` |
| `MCP_TOME_URL` | Yes | Tome skill routing MCP endpoint | `http://tome:8080` |
| `MCP_MNM_URL` | Yes | Midnight Manual docs MCP endpoint | `http://mnm:8080` |
| `PROVER_URL` | Yes | Midnight proof server endpoint | `http://prover:8080` |
| `COMPILE_SERVICE_URL` | Yes | Compile Service HTTP endpoint (Phase 5, US2) | `http://compile-service.6pn:8080` |

### Compile Service Authentication (Phase 5, US2)

| Variable | Required | Purpose | Note |
|----------|----------|---------|------|
| `COMPILE_SERVICE_TOKEN` | Yes | Bearer token for Compile Service calls | Constitution III: never client-bound; server-only secret |

### MCP Client Tunables (D31)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_TIMEOUT_MS` | 10_000 | Per-request timeout (connect + call) |
| `MCP_HEALTH_TIMEOUT_MS` | 5_000 | Health probe timeout (shorter) |
| `MCP_MAX_CONCURRENCY` | 4 | Bounded concurrency per MCP client |

### File Storage (R2, Public Read-Only)

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `R2_PUBLIC_BASE_URL` | No (optional until R2 wired) | Public R2 bucket URL (client-safe for FetchZkConfigProvider artifact reads, Phase 5) | `https://zk.nyx.example.com` |
| `R2_BUCKET` | No (optional until R2 wired) | R2 bucket name | `nyx-zk-artifacts` |

### Server-Only Secrets (Never Client-Bound)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DEPLOY_KEY` | Yes | Server-only deploy key (D52, constitution III) |
| `R2_ACCESS_KEY_ID` | Yes | R2 write credential (server-only; held by Compile Service only, D50) |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 write credential (server-only; held by Compile Service only, D50) |
| `R2_ACCOUNT_ID` | Yes | R2 account identifier (server-only; held by Compile Service only, D50) |

### Agent Model Routing (D19)

| Variable | Required | Purpose |
|----------|----------|---------|
| `MODEL_ROUTING` | Yes | JSON object mapping each agent role → `{ provider, model, baseUrl? }` |

### Economic & Operational Tunables (D47/D48/D49/D44/D56)

| Variable | Default | Purpose | Units |
|----------|---------|---------|-------|
| `NYXT_EXCHANGE_RATE` | 1_000n | NYXT base units minted per tNIGHT unit | NYXT |
| `FLAT_RESERVE` | 100n | Per-prompt reserve (D34) | NYXT |
| `MINIMUM_DEPOSIT` | 1_000n | Smallest accepted deposit (D45) | NYXT |
| `LOW_BALANCE_THRESHOLD` | 500n | UI low-balance warning (S6) | NYXT |
| `MAX_FILE_BYTES` | 1_048_576 | 1 MB file limit (D49) | bytes |
| `MAX_PROJECT_BYTES` | 52_428_800 | 50 MB project limit (D49) | bytes |
| `PROJECT_QUOTA_PER_ACCOUNT` | 20 | Per-account project cap (D49) | count |
| `VERSION_RETENTION_COUNT` | 50 | Versions retained per project (D48) | count |
| `VERSION_RETENTION_DAYS` | 30 | Version retention period (D48) | days |
| `DEPOSIT_REF_TTL_MS` | 3_600_000 | 1 hour deposit-ref TTL (D45) | ms |
| `RECONCILE_CADENCE_MS` | 86_400_000 | Daily reconciliation cadence (D56) | ms |
| `SESSION_LIFETIME_MS` | 604_800_000 | 7-day sliding session (D44) | ms |
| `PROVING_TOKEN_LIFETIME_MS` | 300_000 | 5 min proving token (D52) | ms |
| `PROVER_RATE_LIMIT_MAX` | 60 | Requests per rate-limit window per session (D52) | count |
| `PROVER_RATE_LIMIT_WINDOW_MS` | 60_000 | 1 min rate-limit window (D52) | ms |

## Configuration Loading & Validation

- **Entry Point**: `apps/server/src/config/load.ts` (DS-003 fail-fast boot)
- **Schema**: `apps/server/src/config/schema.ts` (zod)
- **Error Handling**: Named validation errors printed to stderr with exact variable path; `process.exit(1)` on failure
- **Bootstrap**: `apps/server/src/index.ts` (fail-fast; only place that exits)

---

## What Does NOT Belong Here

- Internal code architecture → ARCHITECTURE.md
- Testing infrastructure → TESTING.md
- Security policies → SECURITY.md
- Dependency versions → STACK.md

---

*This document maps external service dependencies. Update when adding new integrations.*
