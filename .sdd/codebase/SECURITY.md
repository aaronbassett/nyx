# Security

> **Purpose**: Document authentication, authorization, security controls, and vulnerability status.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5: Artifact pipeline security, R2 write-credential boundary, verify-before-announce integrity)

## Authentication

### Authentication Method

| Method | Implementation | Configuration |
|--------|----------------|---------------|
| SIWE-style Midnight sign-in (US5, T035) | BIP-340 Schnorr signature via `@midnight-ntwrk/ledger-v8` `verifySignature` | `apps/server/src/auth/verify.ts`, `apps/web/src/wallet/auth.ts` |
| Session validation (WS layer) | Read-only lookup via `SessionStore.get()` | `apps/server/src/protocol/session.ts` |
| WS handshake | Session cookie extracted from upgrade request, validated against DB | `apps/server/src/protocol/cookies.ts` |

### Authentication Flow (Phase 3)

| Step | Operation | Implementation | Security Checks |
|------|-----------|---|---|
| 1. Nonce request | `POST /auth/nonce` (no auth) | `apps/server/src/auth/routes.ts:42-45` | Single-use, 5-min TTL, server-issued |
| 2. Client signs | Wallet signs SIWE message with domain+nonce via Lace `signData` | `apps/web/src/wallet/auth.ts:189-194` | Signature covers whole message including nonce (cryptographic binding) |
| 3. Verify | `POST /auth/verify {address, message, signature, verifyingKey}` | `apps/server/src/auth/routes.ts:47-80` | Atomic nonce burn (CAS) → signature check → key↔address binding → account auto-create → session issue (all in one TX) |
| 4. Nonce burn | `UPDATE auth_nonces SET consumed_at = now() WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING nonce` | `apps/server/src/auth/store.ts:137-146` | Atomic compare-and-swap; burned on ANY verify attempt (success or failure) |
| 5. Signature verify | `verifySignature(verifyingKey, reconstructedBytes, signature)` | `apps/server/src/auth/verify.ts:70-81` | DoS-safe: malformed key/signature/address caught in try/catch, never crash |
| 6. Key↔address binding | `addressFromKey(verifyingKey).toLowerCase() === MidnightBech32m.parse(address).decode().hexString.toLowerCase()` | `apps/server/src/auth/verify.ts:102-112` | Blocks key-substitution bypass; address is SHA-256(verifyingKey) |
| 7. Session issue | Insert session row (7-day expiry, D44) and set HttpOnly cookie | `apps/server/src/auth/store.ts:150-170` | Server-side DB clock enforces expiry, never client clock |

### Token Configuration

| Setting | Value | Location |
|---------|-------|----------|
| Session identifier | HTTP-only cookie: `nyx_session` | `apps/server/src/auth/cookie.ts` |
| Session lifetime | 7-day sliding expiry (604,800,000 ms, D44) | `apps/server/src/config/schema.ts` |
| Session validation | Checked against `sessions` table: `expires_at > now()` and `revoked_at IS NULL` | `apps/server/src/protocol/session.ts:54-60` |
| Nonce lifetime | 5 minutes (300,000 ms) | `apps/server/src/auth/store.ts:71` |
| Nonce single-use | Atomic `UPDATE ... WHERE consumed_at IS NULL` with DB-side burn | `apps/server/src/auth/store.ts:137-146` (FR-039) |
| Signature algorithm | BIP-340 Schnorr over secp256k1 (`k256::schnorr`) | `@midnight-ntwrk/ledger-v8` via SDK |
| Signing mechanism | Wallet signs `UTF8("midnight_signed_message:" + byteLength + ":") ‖ payloadBytes` | `apps/server/src/auth/verify.ts:37-53` |

### Session Management

| Setting | Value | Status |
|---------|-------|--------|
| Session storage | Postgres `sessions` table (T036, US5) | Implemented |
| Session issuance | `POST /auth/verify` issues session on successful nonce burn + signature verify + key binding check | Implemented (T035) |
| Session expiry slide | `GET /auth/session` (resume-on-reload) resets `expires_at` to `now() + 7 days` | Implemented (requireSession middleware) |
| Logout revocation | `POST /auth/logout` sets `revoked_at = now()` and clears cookie | Implemented (T037) |
| Database clock validation | `now()` function used server-side for all expiry checks, never client clock | Enforced |
| Account auto-create | Account keyed by unshielded address (D43); created on first successful verify | Implemented |

### Session Cookie Security

| Attribute | Value | Purpose |
|-----------|-------|---------|
| `HttpOnly` | Enabled | Prevent JavaScript access; only sent on HTTP requests |
| `Secure` | Enabled | Require HTTPS; cookie not sent over plain HTTP |
| `SameSite` | Lax | Allow top-level navigation from external sites; block cross-site form posts (CSRF mitigation) |
| `Path` | `/` | Cookie sent to all paths (standard) |
| `Max-Age` | 604,800 (7 days) | Sliding window per D44 (set on every `/auth/session` call) |

## Authorization

### Authorization Model (Phase 4)

| Model | Description | Status |
|-------|-------------|--------|
| **Ownership isolation (D43/SC-027)** | Every `/projects/:id*` route (read, rename, delete, restore, chat, manifest, files) requires a live session AND `project.owner_address === request.auth.address`. A missing or non-owned project returns **404** (never 403), so ownership never leaks a project's existence. | Implemented & tested (routes.test.ts:148-195) |
| Account-project ownership seam | All project operations scoped to authenticated session address | Enforced at route layer via `loadOwned()` helper |
| Single-live-session takeover | Last-tab-wins registry (D40) enforced per `(account, project)` pair | Implemented |

### Roles & Permissions

| Role | Scope | Implementation |
|------|-------|-----------------|
| Authenticated user | Account tied to Midnight unshielded address; session-bound | SIWE sign-in required; account address stored in `sessions.account_address` |
| Project owner | Must match `project.owner_address` to touch the project; non-owners see 404 | `loadOwned()` gate in `apps/server/src/projects/routes.ts:47-64` (SC-027) |
| Anonymous | No WS connection or project access without valid session | Closes socket: `WS_CLOSE.UNAUTHENTICATED (4401)` |

### Permission Checks

| Location | Pattern | Example |
|----------|---------|---------|
| Nonce request | No authentication required | `POST /auth/nonce` open to all |
| Verify endpoint | Schema validation + nonce extraction + nonce burn + signature checks | `apps/server/src/auth/routes.ts:47-80` |
| Session resume | Requires live session cookie | `GET /auth/session` with preHandler `requireSession` |
| Logout | Requires live session cookie | `POST /auth/logout` with preHandler `requireSession` |
| WS upgrade | Session cookie validation + project ID extraction | `apps/server/src/protocol/handler.ts:118-144` |
| WS frame dispatch | Event schema validation via `parseEvent("client-to-server", …)` | `apps/server/src/protocol/router.ts:105-107` |
| **Project read/write/delete** | **Ownership check: `loadOwned()` returns 404 if missing OR not owned** | `apps/server/src/projects/routes.ts:47-64`; tested matrix (owner 200 / other 404 / anon 401) |

## Input Validation

### Validation Strategy

| Layer | Method | Library |
|-------|--------|---------|
| Auth verify body | Schema validation (nonce, signature, verifying key, address) | `@nyx/protocol` via Zod (`AuthVerifyRequestSchema`) |
| Signature & key | Try-catch wrapping SDK calls; malformed hex → `false`, never crash | `apps/server/src/auth/verify.ts:70-81, 102-112` |
| WS frames | Schema validation (discriminated union) | `@nyx/protocol` via Zod |
| Server-to-client events | Outbound validation before serialization | `apps/server/src/protocol/router.ts:151-157` |
| Configuration | Environment variable schema + JSON routing table | Zod (strict mode) in `apps/server/src/config/schema.ts` |
| URLs | Fastify route parameters and query strings | TypeScript via Zod schema inference |
| **Route parameters (UUID)** | **Malformed UUID route param (e.g., `:id` in `/projects/:id`) caught by Postgres 22P02 error and treated as not-found (404) rather than 500** | `apps/server/src/projects/store.ts:144-146, 210-225` |
| Compile service responses | Zod schema validation (CheckResponse, CompileJob, CompilerVersions) | `apps/server/src/compile/schemas.ts` |
| Artifact manifest | Zod validation against §5 schema before fetch plan executes | `apps/server/src/compile/schemas.ts` (ArtifactManifestSchema) |

### Sanitization

| Data Type | Sanitization | Location |
|-----------|--------------|----------|
| Nonce (input) | Extracted via regex from signed message; treated as opaque string | `apps/server/src/auth/verify.ts:123-126` |
| Verifying key (input) | Hex string; malformed → try-catch → `false` (SDK validates) | `apps/server/src/auth/verify.ts:70-81` |
| Address (input) | Bech32m; malformed → try-catch → `false` (address codec validates) | `apps/server/src/auth/verify.ts:102-112` |
| Signature (input) | Hex string; malformed → try-catch → `false` (SDK validates) | `apps/server/src/auth/verify.ts:70-81` |
| Message (input) | Text string; no modification; used in signature verification | `apps/server/src/auth/verify.ts:46-53` |
| Client frames | Parsed via `@nyx/protocol`, invalid frames logged but not echoed | `apps/server/src/protocol/router.ts:97-128` |
| JSON parsing | Try-catch on frame parsing; malformed frames reported as `invalid-json` | `apps/server/src/protocol/router.ts:98-102` |
| Event payloads | Zod schema validation; unknown fields rejected in strict mode | `apps/server/src/config/schema.ts:72` (`.strict()`) |
| Query strings | `URLSearchParams` for safe parameter extraction | `apps/server/src/protocol/handler.ts:76` |

## Data Protection

### Sensitive Data Handling

| Data Type | Protection Method | Storage | Boundary |
|-----------|-------------------|---------|----------|
| Session ID | HTTP-only cookie (opaque) | Postgres `sessions` table (encrypted at rest via DB) | Server-only; never in WS frames |
| Verifying key | Received in auth verify body; used only for signature + binding checks; never stored | Memory (not persisted) | Server-side computation only |
| Signature | Received in auth verify body; used only for verification; never stored | Memory (not persisted) | Discarded after verification |
| Deploy key | Never serialized; server-only secret | `config.secrets` (frozen object, inaccessible after boot) | Server-only; never reaches client |
| R2 credentials (read/write) | Server-only secrets; never serialized to client | `config.secrets.r2*` (frozen) | Server-only compartmentalization |
| Proving tokens | Short-lived (5 min), session-bound (D52) | `proving_tokens` table (pending implementation) | Browser-reachable but authenticated |
| Account address | Midnight unshielded address; public per session | `sessions.account_address` (Postgres) | Transparent to authenticated user; account key for auto-create (D43) |
| Nonce | Server-issued, server-stored; burned after use | Postgres `auth_nonces` table; `consumed_at` marks burn | Single-use; transport only in signed message |
| **Compile Service token** | **Server-only bearer token (constitution III, D50)** | `config.secrets.compileServiceToken` (pending wiring in config/schema.ts) | **Server-only; never reaches client or WebContainer; grants compile+publish to Compile Service, NOT raw R2 access** |

### Encryption

| Type | Algorithm | Key Management | Status |
|------|-----------|-----------------|--------|
| At rest (database) | Database-level encryption (platform responsibility) | Host provider (Fly.io) | Configured |
| In transit (HTTPS) | TLS 1.2+ (platform enforcement) | Let's Encrypt (platform) | Configured |
| In transit (WS) | TLS via Fastify (platform requirement) | Let's Encrypt | Required |
| Application layer | None; message integrity via schema validation | — | Not needed; TLS provides confidentiality |

## Resource-Exhaustion Controls (Phase 4, D49)

### File & Project Size Quotas

| Control | Value | Implementation | Error Code |
|---------|-------|---|---|
| **Per-file byte cap** | `maxFileBytes` (config tunable, e.g., 10 MB) | Checked up-front before TX commit; computed via `Buffer.byteLength(content, "utf8")` (never silent truncation) | **413** (File Too Large) |
| **Per-project total-byte cap** | `maxProjectBytes` (config tunable, e.g., 100 MB) | Atomic check within commit TX: `current_total - overwritten + incoming > limit` → reject. Computed by SQL sum on `project_files.size`. | **413** (Project Quota Exceeded) |
| **Per-account project count quota** | `projectQuotaPerAccount` (config tunable, e.g., 50) | Atomic count-guarded INSERT: `WHERE (SELECT count(*) FROM projects WHERE owner_address = $1 AND deleted_at IS NULL) < $3`; if INSERT returns no rows, quota exceeded. | **409** (Conflict) |

### Error Handling & Visibility

| Scenario | HTTP Status | Body | Notes |
|----------|---|---|---|
| Single file exceeds limit | 413 | `{ error: "file too large", path, limit }` | Named error; client can retry after resizing or deleting other files |
| Project total would exceed limit | 413 | `{ error: "project size quota exceeded", projectId, limit }` | Named error; commit rejected atomically, project state unchanged |
| Account project count at limit | 409 | `{ error: "project quota exceeded", limit }` | Prevents further creations; user must delete a project to proceed |

### Query Safety

All quota checks use **parameterized queries with bound variables** (never SQL concatenation); Postgres enforces the limits atomically within transactions.

## Soft-Delete Safety (Phase 4, D49)

### Deletion & Recovery Model

| Aspect | Implementation | Location |
|--------|---|---|
| **Deletion type** | Soft-delete: `UPDATE projects SET deleted_at = now()` | `apps/server/src/projects/store.ts:241-253` |
| **Recovery window** | 30 days (DB-clock enforced: `deleted_at < now() - ('30 days'::interval)` → expired) | `apps/server/src/projects/store.ts:255-295` (restoreProject) |
| **Soft-deleted visibility** | Excluded from `listProjects()` (WHERE `deleted_at IS NULL`) and all ownership checks | `apps/server/src/projects/store.ts:183-191` |
| **Turn-scoped atomicity** | Each commit (agent turn or user edit) is a single `db.transaction` allocating a version; crash mid-batch rolls back and leaves previous version intact | `apps/server/src/projects/store.ts:308-370` (commit TX) |
| **Ephemeral cascade** | Runs immediately synchronously after soft-delete commit; DB row stays recoverable while side effects tear down | `apps/server/src/projects/routes.ts:164-167` (delete route) |

### Cascade Seams (Phase 4, D49)

The deletion cascade has three injectable seams, each a TODO stub for US7 (real implementations land with owning stories):

| Seam | Purpose | Status | Effort |
|------|---------|--------|--------|
| **`teardownContracts`** | Tear down active deploys through the deploy registry (S8 responsibility) | **Stub: TODO(T158)** | S8 implementation |
| **`cleanupR2Prefix`** | Delete the project's compiled-artifact prefix in R2 (D7/D26 responsibility) | **Stub: TODO(R2)** | R2 integration |
| **`terminateSessions`** | Terminate the live session with notice to connected clients (D40 responsibility) | **Stub: TODO(WS)** | WS session management |

**Critical**: Deleted projects' on-chain contracts, R2 artifacts, and live sessions are NOT actually torn down until later stories fill these seams. The durable soft-delete is correct; ephemeral cleanup is incomplete.

## Security Headers

| Header | Value | Purpose | Location |
|--------|-------|---------|----------|
| Cross-Origin-Opener-Policy | `same-origin` (default) or `unsafe-none` (`/webcontainer/connect/*`) | Isolation boundary enforcement (FR-021) | `apps/web/src/lib/isolation-headers.ts` |
| Cross-Origin-Embedder-Policy | `require-corp` (default) or `unsafe-none` (`/webcontainer/connect/*`) | SharedArrayBuffer + WebContainer support | `apps/web/src/lib/isolation-headers.ts` |
| Content-Security-Policy | NOT CONFIGURED | XSS protection (gap) | — |
| X-Frame-Options | NOT CONFIGURED | Clickjacking protection (gap) | — |
| X-Content-Type-Options | NOT CONFIGURED | MIME sniffing protection (gap) | — |
| Strict-Transport-Security | Delegated to platform | HTTPS enforcement | Fly.io |

## CORS Configuration

| Setting | Value | Status |
|---------|-------|--------|
| Allowed origins | Single origin (app co-hosted with server) | Implicit; not explicitly configured |
| Allowed methods | WS + HTTP (POST for auth, GET for session resume, POST for logout) | Fastify WebSocket + REST routes |
| Allowed headers | Cookie (session) + standard WS headers + JSON content-type | Implicit in WebSocket protocol + REST headers |
| Credentials | Sessions via HTTP-only cookies | Required; no CORS credential bypass |
| **Artifact read domain (R2 public)** | **`credentials: "omit"` (no session cookie on public R2 read domain)** | **Enforced via `ARTIFACT_FETCH_INIT` in `apps/web/src/artifacts/fetch.ts:33-36`** |

## Rate Limiting

| Endpoint/Flow | Limit | Window | Implementation | Status |
|---|---|---|---|---|
| Auth nonce issuance | NOT LIMITED | — | No rate limit on `/auth/nonce` | Potential DoS concern (not yet mitigated) |
| Verify attempts | Nonce TTL enforced (5 min) | Per nonce | Single-use nonce prevents brute-force on same nonce | Built-in via nonce burn |
| Prover requests | 60 requests | 1 minute (60,000 ms) per session | `config.prover.rateLimit` | Configured; not yet wired (D52) |
| Session-based rate limiting | Per authenticated session | N/A | Design ready | Pending implementation |
| Login attempts | NOT IMPLEMENTED | — | — | Deferred (US5 boundary) |
| General API | NOT CONFIGURED (no REST API yet) | — | — | N/A for Phase 4 |

## Secrets Management

### Environment Variables

| Category | Naming Convention | Example | Required |
|----------|-------------------|---------|----------|
| Database | `DATABASE_URL` | Postgres connection string | Yes |
| Deployment | `DEPLOY_KEY` | Server-side deploy key (constitution III) | Yes |
| R2 Storage | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | S3-compatible credentials (server-only) | Yes |
| Model routing | `MODEL_ROUTING` | JSON object mapping agent roles to model providers | Yes |
| Prover | `PROVER_URL` | Internal token-gated proof server endpoint | Yes |
| MCP infrastructure | `MCP_TOOLCHAIN_URL`, `MCP_TOME_URL`, `MCP_MNM_URL` | Model Context Protocol server endpoints | Yes |
| **Compile Service** | **`COMPILE_SERVICE_TOKEN`** | **Server-only bearer token for Compile Service (constitution III, D50)** | **Yes (deferred to US1 wiring in config/schema.ts)** |

### Secrets Storage

| Environment | Method | Status |
|-------------|--------|--------|
| Development | `.env` (gitignored) + `.env.local` | Manual configuration |
| CI/CD | GitHub Secrets (environment-specific) | Platform responsibility |
| Production | Fly.io secrets (environment variables) | Platform responsibility |
| Config isolation | `config.secrets` object sealed via `deepFreeze()` | Code-enforced; inaccessible after boot |

### Secrets Boundary (Zero-Trust Model)

The following secrets MUST never reach the browser or WebContainer boundary:

1. **Deploy key** (`DEPLOY_KEY`) — server-side only; controls Compact deployment
2. **R2 write credentials** (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`) — server-side only; used by Compile Service for artifact storage
3. **Database URL** (`DATABASE_URL`) — server-side only; direct DB connection
4. **Compile Service token** (`COMPILE_SERVICE_TOKEN`) — server-side only; authenticates Nyx to the Compile Service (constitution III, D50)

Secrets are projected via `publicConfig()` type (omits `config.secrets`); any route exposing config must use this type.

## Artifact Pipeline Security (Phase 5, D50)

### R2 Write-Credential Boundary (Zero-Trust Architecture)

| Layer | Role | Credential Access | Location |
|-------|------|-------------------|----------|
| **Compile Service** | Sole artifact publisher to R2 | Holds only R2 write credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`) | Private service (`flycast` 6PN / no public IP) |
| **Nyx Orchestrator** | Compile coordinator; R2 reader only | Authenticates to Compile Service with bearer `COMPILE_SERVICE_TOKEN` (compile+publish grant, NOT raw R2 access) | `apps/server/src/compile/client.ts:94-111` |
| **Browser Preview** | Artifact consumer (read-only) | No credentials; reads from public R2 read domain over CORS | `apps/web/src/artifacts/fetch.ts` |

**Constitution III guarantee (non-negotiable):** R2 write credentials NEVER cross the server/Compile-Service boundary. Nyx never issues raw S3-compatible requests to R2; it delegates to the service and reads back the published `urlPrefix`.

### Compile Service Authentication

| Aspect | Implementation | Location |
|--------|---|---|
| **Auth header** | `Authorization: Bearer <COMPILE_SERVICE_TOKEN>` on every request | `apps/server/src/compile/client.ts:94-98` |
| **Token scope** | Compile+publish (full builds + uploads); NOT raw R2 access | Service-side enforcement (token is opaque to Nyx) |
| **Missing/invalid token** | Service returns `401 Unauthorized` | `infra/compile-service/API.md` §2 |
| **Transport** | Stateless JSON over HTTP to private service endpoint | `COMPILE_SERVICE_URL` (server-only config) |

### Web Artifact Reads (CORS + Isolation)

| Control | Value | Purpose | Location |
|---------|-------|---------|----------|
| **`mode`** | `"cors"` | Exempts the fetch from COEP policy; required for cross-origin reads under `require-corp` | `apps/web/src/artifacts/fetch.ts:33-36` |
| **`credentials`** | `"omit"` | Strips session cookie from the public R2 read domain (constitution III — creds never cross that boundary) | `apps/web/src/artifacts/fetch.ts:33-36` |
| **Fetch policy** | No application-layer auth; R2 object has public read ACL (R3 policy handles CORS + CORP) | Content-addressed immutable artifacts published by the Compile Service | `apps/web/src/artifacts/fetch.ts:158-196` |

### Verify-Before-Announce Integrity (FR-014)

| Phase | Action | Implementation | Security Guarantee |
|-------|--------|---|---|
| **1. Compile** | Submit full build + await terminal status | `apps/server/src/compile/orchestrator.ts:runTurn()` → `runCompileJob()` | Compile Service confirms: proof generation complete, artifacts uploaded to R2 |
| **2. Manifest fetch** | Get `<urlPrefix>/manifest.json` to validate structure | `apps/server/src/compile/orchestrator.ts:verifyPrefix()` | Manifest schema validated against `ArtifactManifestSchema` before fetch plan is built |
| **3. Artifact verification** | Fetch every listed artifact under `urlPrefix`; confirm all return 2xx | `apps/web/src/artifacts/fetch.ts:204-229` (or orchestrator-side variant) | Every file in manifest is fetchable from R2 (complete upload marker) |
| **4. Announce** | Emit `artifacts:ready { urlPrefix }` only if ALL checks pass | `apps/server/src/compile/orchestrator.ts` (at most once per green turn) | Incomplete/stale/tampered prefixes are refused; maps to reopen guidance (D36) |

**Failure modes (not announced):**
- Manifest fetch throws (DNS/CORS/TLS) → `"manifest-unfetchable"`
- Manifest returns non-2xx (stale prefix, D36) → `"manifest-missing"`
- Manifest body invalid JSON or schema mismatch → `"manifest-invalid"`
- Any listed artifact returns non-2xx → `"incomplete"` (with `missingPath` for diagnostics)

All failures result in `kind: "verification-failed"` outcome with reopen guidance, never a silent hang.

## Audit Logging

| Event | Logged Data | Retention | Status |
|-------|-------------|-----------|--------|
| Nonce issuance | Request timestamp (via Fastify logger) | Fastify logger | Implemented |
| Verify request | Schema validation failures (400) | Fastify logger | Implemented |
| Nonce burn | Atomic burn outcome (success/already consumed/expired) | SQL row count (implicit) | Implemented via DB transaction |
| Signature verification failure | Event logged but message/signature not echoed | Fastify logger | Implemented (DoS-safe) |
| Key↔address binding failure | Event logged but details not echoed | Fastify logger | Implemented (DoS-safe) |
| Session creation | New session ID (on successful verify) | Postgres audit (via DB logging if enabled) | Implemented |
| Session resume | Sliding expiry bump (on GET /auth/session) | Implicit in session timestamp | Implemented via middleware |
| Logout | Revocation timestamp (revoked_at) | Postgres audit (via DB logging if enabled) | Implemented |
| WS connection rejection | Close code, reason, session validation outcome | Fastify logger | Implemented |
| Frame dispatch errors | Event type, outcome status, issues | Fastify logger | Implemented |
| **Project ownership check** | **Existence never logged; 404 sent regardless of missing vs. non-owned** | Fastify logger (no distinguishing data) | Implemented (SC-027) |
| **Compile Service requests** | **Bearer token presence logged; token value never echoed** | Fastify logger + service request payload | Service request failures logged with status/error detail |
| **Artifact verification** | **Per-outcome: manifest-unfetchable / manifest-missing / manifest-invalid / incomplete with missingPath** | Telemetry attached to compile outcome | Orchestrator surfaces to verify loop for diagnostics |

## Cryptographic Standards

| Use Case | Algorithm/Library | Reference | Status |
|----------|-------------------|-----------|--------|
| Signature generation (wallet) | BIP-340 Schnorr over secp256k1 | `k256::schnorr` (via Lace wallet) | External; client-side only |
| Signature verification (server) | BIP-340 Schnorr over secp256k1 via `verifySignature` | `@midnight-ntwrk/ledger-v8` | Verified (constitution I) |
| Key↔address binding | SHA-256 (via `addressFromKey`) | `@midnight-ntwrk/ledger-v8` | Verified (constitution I) |
| Nonce generation | Cryptographically-random UUID | `node:crypto` `randomUUID` | Implemented |
| SIWE message prefix | `midnight_signed_message:` (length-prefixed) | Domain separation per spec | Implemented; verification unconfirmed (see CONCERNS.md) |
| Proving tokens | Opaque token format (not yet specified) | D52 | Pending |
| NYXT amounts | Bigint (native; no crypto) | N/A | Current |
| **Content hashing** | **SHA-256 server-side (deterministic)** | Manifest convergence (D38) | Implemented: `computeContentHash()` |
| **Artifact prefix hashing** | **SHA-256 (source files + compiler version + flags)** | Content-addressed immutability (D50) | Implemented by Compile Service (verified by schema) |

## Known Gaps & Seams

1. **Ephemeral cascade seams (Phase 4)** — Contract teardown, R2 cleanup, and session termination are stubs (TODO T158/R2/WS); deletion is soft but side effects incomplete.
2. **Deletion recovery config** — `DEFAULT_DELETION_RECOVERY_DAYS` constant is fixed at 30; no tunable config option yet.
3. **Bigint wire codec** — Amounts encoded as strings (encode-only); symmetric decoder not yet implemented.
4. **General security headers** — CSP, X-Frame-Options, X-Content-Type-Options not configured.
5. **Prover rate limiting** — Configured but not wired into the prover token issue/validation flow.
6. **SIWE domain binding enforcement** — Domain line is built into the message (SIWE spec) but not yet asserted server-side (see CONCERNS.md).
7. **Compile Service token config (Phase 5)** — `COMPILE_SERVICE_TOKEN` env var not yet wired into `config/schema.ts`; must be added before deployment.
8. **Manifest integrity (Phase 5)** — Verify-before-announce checks artifact presence (HEAD-only); sha256 of each artifact against manifest is not yet verified (would be fuller integrity check).

---

## What Does NOT Belong Here

- Tech debt and risks → CONCERNS.md
- Testing strategy → TESTING.md
- Code conventions → CONVENTIONS.md

---

*This document defines security controls. Update when security posture changes.*
