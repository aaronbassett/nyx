# Known Concerns

> **Purpose**: Document technical debt, known risks, bugs, fragile areas, and improvement opportunities.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5: Compile Service integration, R2 boundary, manifest integrity)

## Security Concerns

### High Priority

| ID | Area | Description | Risk Level | Mitigation | Effort |
|----|------|-------------|------------|------------|--------|
| SEC-001 | `apps/server/src/projects/routes.ts:47-64` | **[PHASE 4 COMPLETE]** Ownership isolation (D43/SC-027) now implemented & tested. All `/projects/:id*` routes require `project.owner_address === request.auth.address`; non-owned or missing projects return 404 (never 403), so existence never leaks. Tested matrix: owner 200 / other-account 404 / unauthenticated 401 across read/rename/delete routes. | Low | Verification complete; monitor for regressions. | Done |
| SEC-010 | `apps/server/src/auth/verify.ts:26-36` | ⚠️ **OWNER-GATED / UNVERIFIED**: The wallet (Lace) is believed to sign `UTF8("midnight_signed_message:" + byteLength + ":") ‖ payloadBytes`, but the exact byte reconstruction is NOT pinned by spec and Lace is closed-source. Unit tests prove only that byte reconstruction is internally consistent with a synthetic SDK keypair. The real Lace `signData` prefix/response format must be confirmed by an empirical round-trip on a real Lace browser before it can be trusted against a real wallet. | High | Empirical validation: test round-trip signature verify with a real Lace browser `signData` response before production deployment. | Medium |
| SEC-011 | `apps/server/src/auth/routes.ts:47-80` | Server-side domain binding not yet enforced. The SIWE message includes a `Domain: <domain>` line (per spec, `buildSiweMessage` includes it), but `/auth/verify` does not assert that the domain in the signed message matches the expected server domain. Current reliance on the nonce being server-issued + single-use is sound, but a future domain-mismatch attack (e.g., attacker replays a signature from a different domain) should be blocked at the server level. | High | Add expected-domain assertion in `/auth/verify` after nonce burn succeeds: extract domain from message, compare against `config.domain` (or inferred from request). | Medium |
| SEC-020 | `apps/server/src/projects/lifecycle.ts:40-55` | **[PHASE 4 STUB]** Ephemeral cascade teardown seams are NO-OP stubs; deleted projects retain on-chain contracts, R2 artifacts, and live sessions. Soft-delete is durable (row recovery works) but cleanup is incomplete. Three injectable seams (`teardownContracts`, `cleanupR2Prefix`, `terminateSessions`) each marked `TODO(T158/R2/WS)` and will be filled by their owning stories (S8, D7/D26, D40). | High | Wire seams during S8/S6/S7 implementations. Monitor for orphaned resources. | High |
| SEC-021 | `apps/server/src/projects/store.ts:104-109` | **[PHASE 4 CONFIG GAP]** Soft-delete recovery window is hardcoded to 30 days via `DEFAULT_DELETION_RECOVERY_DAYS` constant; no config tunable (e.g., `DELETION_RECOVERY_DAYS` env var or config option) to adjust at deployment time. If operational practice or security policy requires a different window, operator must rebuild. | Low | Add `DELETION_RECOVERY_DAYS` config tunable with default 30; expose via `config.tunables` or dedicated setting. | Low |
| SEC-030 | `infra/compile-service/API.md` + `apps/server/src/compile/` | **[PHASE 5 UNVERIFIED]** The Compile Service (constitution III boundary holder) is owned and built by the project owner; Nyx is tested ONLY against mock/injectable clients. The real service + R2 integration is UNVERIFIED — no devnet/staging integration test has confirmed that the service actually (a) holds R2 credentials server-side, (b) refuses raw R2 access over the public token, (c) publishes artifacts immutably to the content-hashed prefix, and (d) enforces manifest-as-completeness correctly. Trust depends on service implementation correctness (owner responsibility). | High | After service is deployed: integration test against the real service on devnet (compose-up, submit compile, verify R2 prefix). Audit the service source for (a)–(d) before production scale. | High |
| SEC-031 | `apps/server/src/config/schema.ts` | **[PHASE 5 CONFIG DEFERRED]** `COMPILE_SERVICE_TOKEN` env var is specified in the API contract (infra/compile-service/API.md §2) and documented in SECURITY.md as a server-only secret (constitution III), but NOT YET wired into `config/schema.ts`. The token is injected directly into the client (`apps/server/src/compile/client.ts:87-91`) as a string, but there is no schema validation, no required-field check, and no path to override/rotate the token at deployment time. Missing this wiring means the token cannot be set via `.env` on deployment. | High | Add `COMPILE_SERVICE_TOKEN` to `EnvSchema` in `config/schema.ts` as a required string (min length 1); validate presence on boot; surface the token via `config.secrets.compileServiceToken` (frozen). | Medium |
| SEC-032 | `apps/server/src/compile/orchestrator.ts:verifyPrefix()` + `apps/web/src/artifacts/fetch.ts:fetchArtifacts()` | **[PHASE 5 PARTIAL INTEGRITY CHECK]** Verify-before-announce (FR-014) fetches every artifact listed in the manifest and confirms the fetch returns 2xx (presence check, HEAD-only). However, the SHA-256 of each artifact against the manifest's `sha256` field is NOT verified — only the presence is checked. A corrupted artifact (truncated, modified bytes, stale cache) would still pass the verify gate if it returns 2xx. A fuller integrity check would: fetch each artifact body (not just HEAD), compute sha256 client-side, and compare against manifest's hash. | Medium | Add optional sha256 verification in artifact verify loop (toggle via config for performance; consider deferring to when/if truncation attacks are a known threat). For now, immutable cache headers (R3) + atomic manifest-last-upload provide sufficient practical safety. | Medium |

### Medium Priority

| ID | Area | Description | Risk Level | Mitigation | Effort |
|----|------|-------------|------------|------------|--------|
| SEC-002 | `packages/protocol/src/` | Bigint↔string wire codec is encode-only. `serializeEvent()` converts `bigint` to string, but no symmetric decoder exists for inbound frames (`turn:settled`, `ledger:update`). Client receives strings; deserialization contract missing. | Medium | Add `deserializeEvent()` paired with `parseEvent()` for symmetric roundtrip. | Medium |
| SEC-003 | `apps/server/src/db/schema.test.ts:22-33` | `proving_tokens` table defined but no implementation wired. Rate limiting is configured (`PROVER_RATE_LIMIT_MAX`, `PROVER_RATE_LIMIT_WINDOW_MS`) but token issuance/validation and rate-limit enforcement are pending. | Medium | Wire prover token flow in D52 implementation (issue tokens on nonce, validate on proof request). | High |
| SEC-004 | `apps/server/src/config/schema.ts:133-134` | R2 credentials are server-only but lack enforcement layer. `DEPLOY_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID` are in `config.secrets`, but no middleware/guard prevents accidental serialization. | Medium | Add static type assertions and linting rule to prevent `config.secrets` from reaching client code. | Low |
| SEC-005 | `apps/web/src/lib/isolation-headers.ts` | COOP/COEP cross-origin isolation headers implemented, but `/webcontainer/connect/*` carve-out needs broader testing. Escape-hatch bridge (FR-021, D39) serves `unsafe-none` to allow non-isolated openers; potential for misconfigured bridge paths. | Medium | Add end-to-end tests for all bridge path variants; audit frame escaping logic. | Medium |
| SEC-006 | `apps/server/src/protocol/router.ts:117-127` | Handler errors are caught silently; promise rejections swallowed. If an event handler throws or rejects, the socket continues without error propagation. Difficult to detect handler bugs in production. | Medium | Implement structured error propagation with optional logging/metrics collection. | Medium |
| SEC-007 | `apps/server/src/auth/routes.ts:42-45` | Nonce issuance (`POST /auth/nonce`) has no rate limiting. Attacker can mint unlimited nonces, filling the `auth_nonces` table or consuming rate-limit budget on downstream services. | Medium | Add rate limit on nonce issuance (e.g., 10 nonces per IP per 1 minute, or per session if authenticated). Implement via middleware or dedicated store counter. | Medium |
| SEC-008 | `apps/server/src/auth/` | Nonce exhaustion during testing: each test scenario issues fresh nonces, potentially filling `auth_nonces` table if cleanup is not enforced. Expired nonces (5 min TTL) should be cleaned up periodically. | Medium | Add background job to delete `auth_nonces` rows older than TTL; consider adding compound index on `(nonce, expires_at)` for faster scans. | Low |
| SEC-009 | Root project | General security headers (CSP, X-Frame-Options, X-Content-Type-Options, HSTS) not configured. Vite/Fastify pipeline has no default security headers. | Medium | Add helmet or equivalent; configure CSP policy for trusted sources only. | Medium |

## Technical Debt

### High Priority

| ID | Area | Description | Impact | Effort |
|----|------|-------------|--------|--------|
| TD-001 | `packages/protocol/src/` | `@midnight-ntwrk/*` SDK not yet installed (constitution I violation). All Compact/SDK shapes must be tool-verified; no direct memory access. Adds friction to any SDK integration task. | Blocking | Install SDK, add to package.json, configure tsconfig paths. | Low |
| TD-002 | `apps/server/src/mcp/` | MCP tool names unknown-by-design (source at US1/US2). No runtime discovery or validation of tool availability. If toolchain/tome/mnm endpoints go down, no graceful degradation. | Degradation | Add health checks + circuit breaker pattern for MCP clients. | Medium |
| TD-003 | `apps/server/src/auth/` | Nonce extraction via regex (`/(?:^|\n)Nonce:[ \t]*(\S+)/`) assumes well-formed SIWE message. Attacker-controlled message could have a malformed nonce line (e.g., "Nonce: "); extraction would fail cleanly but cryptographic binding is lost. Should clarify error handling. | Medium | Add explicit validation that nonce is non-empty UUID-like before burning; reject malformed nonces. | Low |

### Medium Priority

| ID | Area | Description | Impact | Effort |
|----|------|-------------|--------|--------|
| TD-004 | `apps/server/src/config/schema.ts` | Monetary tunables are placeholders (D47). `NYXT_EXCHANGE_RATE`, `FLAT_RESERVE`, `MINIMUM_DEPOSIT`, etc. are documented as "concrete numbers are placeholders tuned at implementation against real model costs." | Config risk | Implement tuning during implementation phase; add monitoring for cost overruns. | High |
| TD-005 | `apps/server/src/protocol/session.ts:53-64` | Session lookup query lacks explicit index hints. Query performance depends on automatic index selection; no explicit index on `(id, expires_at, revoked_at)`. | Performance | Add database index on session lookup columns; benchmark lookup latency. | Low |
| TD-006 | `apps/web/src/lib/isolation.ts` | `crossOriginIsolated` property is DOM-spec-dependent. Older browsers, jsdom, and some test runtimes lack the property; defensive coercion to `boolean` works but fallback behavior undefined. | Test fragility | Document supported browser/runtime matrix; add CI gates for cross-origin isolation. | Low |
| TD-007 | `apps/server/src/protocol/router.ts:80-89` | `frameToText()` handles three data buffer formats but lacks test coverage. Binary frames (unexpected) converted to UTF-8; behavior undefined for malformed UTF-8. | Fragile | Add tests for binary frame handling; consider rejecting binary frames outright. | Low |

### Low Priority

| ID | Area | Description | Impact | Effort |
|----|------|-------------|--------|--------|
| TD-008 | `apps/server/src/app.ts` | Fastify logger enabled by default (`Fastify({ logger: true })`). No log level configuration or redaction for sensitive data. | Observability | Add log level env var; configure structured logging with redaction rules. | Low |
| TD-009 | `apps/server/src/index.ts:43-48` | Global error handler writes to stderr but does not flush; process may exit before error is written. | Reliability | Wrap with `process.stderr.write()` callback or add explicit flush before exit. | Low |

## Known Bugs

| ID | Description | Status | Workaround | Severity |
|----|-------------|--------|------------|----------|
| NONE | No active bugs reported at Phase 5. | Tracking | N/A | — |

## Fragile Areas

| Area | Why Fragile | Precautions | Tests |
|------|-------------|-------------|-------|
| `apps/server/src/auth/` (SIWE sign-in) | Cryptographic binding of signature, nonce, address, and key; single bug = auth bypass. Wallet prefix (`midnight_signed_message:`) unverified against real Lace. | Add comprehensive integration tests for nonce issue → sign → verify flow; empirically validate Lace `signData` format; add domain binding check server-side. | Partial (verify.test.ts); Lace validation pending |
| `apps/server/src/projects/routes.ts` (ownership isolation) | Ownership check gates all project mutations and reads; bypass = unauthorized access. Must correctly map 401/404/200 based on auth state + ownership. | Matrix test: owner 200 / other-account 404 / unauthenticated 401 across all routes (manifest, file, chat, rename, delete, restore). | Good (routes.test.ts:148-195) |
| `apps/server/src/protocol/handler.ts` (auth pipeline) | Sequential auth checks with multiple early returns; missing one check = security bypass. | Add comprehensive integration tests for each close code (4401, 4400, 4403, 4409). | Partial (T024) |
| `apps/server/src/projects/store.ts` (quota enforcement) | Resource quotas are critical to prevent exhaustion attacks; single buggy comparison = quota bypass. All checks must account for bigint string-to-number conversion and avoid off-by-one errors. | Parameterized queries; atomic count-guarded INSERT for project quota; per-file and per-project size checks within TX. Test matrix: at-limit, over-limit, under-limit edge cases. | Good (store.test.ts quota tests) |
| `apps/server/src/config/` (secrets compartmentalization) | Config must remain frozen; accidental mutation could leak secrets. | Use `Object.freeze()` and prevent spread/destructuring; use type-level guarantees. | Good (config.test.ts) |
| `packages/protocol/src/` (wire schema) | Single source of truth; schema changes break both client and server silently if not coordinated. | Always increment `NYX_PROTOCOL_VERSION`; add version negotiation before Phase 3. | Good (events.test.ts, http.test.ts) |
| `apps/server/src/projects/lifecycle.ts` (cascade seams) | Cascade fires immediately but is incomplete; no-op seams mean deleted projects leak resources (R2, contracts, sessions). Danger is silent — no error, just orphaned resources accumulating. | Add observability/audit logging for each seam execution; add metrics to track orphaned resources; fill seams before production scale-up. | Partial (lifecycle.test.ts cascade firing tested; actual seams not tested) |
| `apps/server/src/mcp/client.ts` (third-party tool integration) | MCP client failures can cascade; toolchain timeout blocks proof generation. | Add timeouts, circuit breaker, fallback error messages; never let MCP hang. | Partial (mcp.test.ts) |
| `apps/server/src/compile/` (Compile Service boundary) | **[PHASE 5]** The Compile Service is the sole holder of R2 write credentials (constitution III). A service failure, breach, or misconfiguration directly violates the security model. Nyx is tested only against mocks; real service is unverified. | Add real service integration test on devnet; audit service source for credential isolation + manifest integrity enforcement; monitor service health and logs in production. | Partial (client.test.ts uses mock; real service integration test pending) |
| `apps/web/src/artifacts/fetch.ts` (artifact integrity) | **[PHASE 5]** Verify-before-announce checks presence (2xx status) but not sha256 correctness. A stale cache or in-flight write could serve a corrupted artifact undetected. | Add sha256 verification for each artifact (or document immutable cache + manifest-last-upload as sufficient defense). Impact is low if cache headers are truly immutable. | Partial (fetch tests mock responses; real R2 cache headers not tested) |

## Deprecated Code

| Area | Deprecation Reason | Removal Target | Replacement | Status |
|------|-------------------|----------------|------------|--------|
| NONE | No deprecated code identified at Phase 5. | — | — | — |

## TODO Items

Active TODO comments in codebase:

| Location | TODO | Priority | Story |
|----------|------|----------|-------|
| `apps/server/src/projects/lifecycle.ts:47-52` | Ephemeral cascade teardown seams (contract registry, R2 prefix, WS sessions) — currently no-op stubs | High | S8/S6/S7 |
| `apps/server/src/auth/verify.ts:26-36` | Empirically validate Lace `signData` prefix/format against a live wallet before production | High | US5 pre-prod validation |
| `apps/server/src/auth/routes.ts:~55` | Add server-side domain binding assertion after nonce burn | High | US5 or US6 |
| `apps/server/src/config/schema.ts` (line ~14) | **[PHASE 5]** Wire `COMPILE_SERVICE_TOKEN` as required env var (constitution III, D50) | High | US1 wiring / pre-deploy validation |
| `apps/server/src/compile/orchestrator.ts` (verifyPrefix) | **[PHASE 5]** Add sha256 integrity check for each artifact (currently HEAD-only presence check) | Medium | Phase 5 hardening or Phase 6 if acceptable as-is |
| `apps/server/src/auth/routes.ts:42-45` | Implement rate limiting on nonce issuance | Medium | Security hardening |
| `apps/server/src/config/schema.ts` (line ~14) | Tune monetary constants against real model costs (D47) | Medium | Tuning sprint |
| `packages/protocol/src/router.ts` (line ~138) | Add symmetric decoder for bigint wire codec | Medium | Wire codec completion |
| `apps/server/src/projects/store.ts:104-109` | Add config tunable for `DELETION_RECOVERY_DAYS` (currently hardcoded to 30) | Low | Config completeness |

## External Dependencies at Risk

| Package | Concern | Action Needed | Status |
|---------|---------|---------------|--------|
| `@midnight-ntwrk/ledger-v8` | SDK used for cryptographic verification (`verifySignature`, `addressFromKey`); correctness is critical (constitution III) | Verify SDK installed and pinned; monitor for updates; validate on empirical wallet test | Active |
| `@midnight-ntwrk/wallet-sdk-address-format` | SDK used for Bech32m address decoding; correctness is critical (constitution III) | Verify SDK installed and pinned; monitor for updates | Active |
| `@midnight-ntwrk/dapp-connector-api` | DApp Connector type imports for `ConnectedAPI`; used in wallet auth flow | Verify SDK installed and pinned; monitor for updates | Active |
| `@nyx/protocol` | Internal package with shared DTO schemas; SIWE message format embedded here; ownership schema critical to SC-027 | Schema changes require coordination; increment `NYX_PROTOCOL_VERSION` on breaking changes | Active |
| `fastify` | Minor version bumps may include security fixes; no SemVer lock documented. | Pin to known-good version; monitor release notes. | Active |
| `ws` | WebSocket library; ensure version supports required close codes (4000-4999 range). | Verify 4xxx close code support in current version. | Active |
| `zod` | Schema validation library; major updates may break strict mode behavior. | Monitor Zod releases for breaking changes to strict mode semantics. | Active |

## Improvement Opportunities

| Area | Current State | Desired State | Benefit | Effort |
|------|---------------|---------------|---------|--------|
| SIWE message format | Built into `buildSiweMessage`, no shared spec reference | Document SIWE format in a spec file (e.g., SPECIFICATION.md:SIWE-Message-Format) with regex/validation contract | Easier handoff to future clients (mobile, CLI) | Low |
| Nonce issuance rate limiting | No rate limit on `/auth/nonce` | Implement per-IP or per-session rate limiting (e.g., 10 nonces per minute) | Prevent nonce exhaustion attacks | Medium |
| Domain binding | Domain line in SIWE message but not enforced server-side | Add server-side check: extract domain from signed message, assert `config.domain` match | Defend against replay-from-different-domain attacks | Medium |
| Rate limiting | Configured in schema, not wired | Implement per-session token bucket with DB backing | Prevent brute-force attacks on prover | Medium |
| Ownership audit trail | Ownership checks logged but access denied silently (404) | Add structured audit log (who attempted access, when, project, outcome) with no existence leak | Operational visibility into access patterns | Medium |
| Cascade observability | Cascade seams fire silently with no metrics or audit | Add metrics for each seam (contract teardown, R2 cleanup, WS termination) and audit log to track resource cleanup | Detect orphaned resources; validate cleanup completion | Medium |
| Session expiry | Fixed 7 days (sliding bump on every /auth/session call) | Already sliding; no further improvement needed | Better UX for active users | Done |
| Error handling | Silent handler errors logged only | Structured error types with recovery strategies | Easier debugging and monitoring | Medium |
| Logging | Unstructured text to stderr | JSON structured logging with correlation IDs | Production observability | Medium |
| Database indices | Assumed automatic optimization | Explicit indices on hot query paths (session lookup, nonce lookup, turn queries, ownership checks) | Performance under load | Low |
| **[PHASE 5] Compile Service observability** | **Service errors logged as strings; no structured telemetry on compile latency, retry patterns, or success rates** | **Structured metrics for compile latency, reuse rate, failure reasons, job queue depth** | **Detect service slowdown; diagnose compiler issues** | **Medium** |
| **[PHASE 5] Artifact prefix validation** | **Verify-before-announce checks presence (2xx); immutable cache headers + last-upload marker provide practical safety** | **Optional sha256 verification of each artifact against manifest (toggle for performance cost)** | **Detect corrupted artifacts or stale cache serving** | **Medium** |

## Monitoring Gaps

| Area | Missing | Impact | Priority |
|------|---------|--------|----------|
| Ownership enforcement | No metrics on access attempts (owner OK / other denied / anon denied) | Can't detect if authorization logic is broken or under attack | Medium |
| Quota enforcement | No metrics on file size cap / project size cap / project count quota enforcement | Can't diagnose if limits are too tight or if attackers are probing | Medium |
| Cascade execution | No metrics on contract teardown / R2 cleanup / WS termination success/failure | Can't detect if cascade seams are failing silently (resource leaks) | High |
| Nonce lifecycle | No metrics on nonce issued/burned/expired/reused | Can't detect if attackers are saturating nonce table or bypassing single-use checks | Medium |
| Auth verify endpoint | No per-outcome metrics (nonce, signature, binding failures) | Can't diagnose if a wallet or Lace version is broken | Medium |
| Session lookups | No latency/error-rate metrics | Can't detect database slow-down affecting auth | Medium |
| MCP calls | No call count/latency/error-rate histograms | Can't diagnose toolchain issues or timeout causes | Medium |
| Proving tokens | No token issuance/validation metrics | Can't track rate-limit enforcement effectiveness | Medium |
| WS connections | No active connection count or churn metrics | Can't diagnose connection storms or leaks | Low |
| **[PHASE 5] Compile Service** | **No metrics on submit/poll latency, queue depth, or service health** | **Can't detect service overload or failures; reopen storms unnoticed** | **High** |
| **[PHASE 5] Artifact verification** | **No metrics on verify-before-announce outcomes (success / manifest-missing / incomplete)** | **Can't diagnose if R2 prefix completeness checks are failing** | **Medium** |

## Hard Gates (Blocking Future Stories)

These must be resolved before proceeding:

| Gate | Stories Blocked | Reason | Current Status |
|------|---|---|---|
| **Cascade seam implementations (T158/R2/WS)** | US8, US9 (Project cleanup at scale) | Soft-delete is durable but ephemeral cleanup is stubbed. Must fill seams before storing real artifacts in R2 or deploying long-running contracts. | Blocked on S8/S6/S7 |
| **Lace `signData` validation (SEC-010)** | US5 production deployment | Empirical round-trip test against real Lace wallet required before trust | Pending: needs live Lace browser test |
| **Domain binding enforcement (SEC-011)** | US6+ (multi-project) | Server-side domain check required before defending against cross-domain replay | Implement before US6 |
| **[PHASE 5] Compile Service integration test** | US2, US6+ (real compile pipeline) | Real service must be verified on devnet to confirm R2 boundary + manifest integrity before staging/prod | Blocked on service deployment |
| **[PHASE 5] COMPILE_SERVICE_TOKEN config** | US1, US2 (Nyx orchestrator boot) | Token must be wired into `config/schema.ts` as required env var before server can connect to real service | Implement before service deployment |
| **T115: Vault-funding spike** | US6 (Midnight integration) | Deposit pipeline design requires proof of real ledger interaction. | Blocked on ledger integration |
| **T185: Q3 injection run** | US9 (Code injection safeguard) | All S9 work gated; requires compiler + SDK maturity. | Blocked on external schedule |
| **T155: Teardown semantics** | US8, US9 (Project cleanup) | Container/WebContainer shutdown must be safe; requires teardown specification. | Spec pending |
| **T172: Burn-circuit design** | US6 (Token burning) | NYXT burn circuit must be proven before on-chain integration. | Circuit pending |

---

## Concern Severity Guide

| Level | Definition | Response Time |
|-------|------------|----------------|
| Critical | Production impact, security breach, data loss | Immediate |
| High | Degraded functionality, security risk, compliance issue | This sprint |
| Medium | Developer experience, performance, minor security gap | Next sprint |
| Low | Nice to have, cosmetic, optimization opportunity | Backlog |

---

## What Does NOT Belong Here

- Active implementation tasks → GitHub issues / project board
- Security controls (what we do right) → SECURITY.md
- Architecture decisions → ARCHITECTURE.md
- Code conventions → CONVENTIONS.md

---

*This document tracks what needs attention. Update when concerns are resolved or discovered.*
