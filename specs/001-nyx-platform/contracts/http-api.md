# Contract: HTTP API surfaces

All REST endpoints session-authenticated (HttpOnly cookie) unless noted. DTO schemas in `packages/protocol`.

## Auth (S5 — D13/D43/D44)
- `POST /auth/nonce` → `{ nonce, expiresAt }` — single-use, short expiry (no auth)
- `POST /auth/verify` `{ address, signature, message, verifyingKey }` → sets session cookie; creates account on first sign-in; burns nonce on any attempt (FR-034/039; SC-017/018). `verifyingKey` (BIP-340 hex) is required — the unshielded address is a hash of the key, so the server needs the key itself to verify the signature and confirm the key↔address binding (blocks key-substitution auth bypass, constitution III)
- `GET /auth/session` → `{ address }` — resume on reload from the session cookie only (no wallet); slides the 7-day expiry (D44; SC-019); 401 when the session is absent, expired, or revoked
- `POST /auth/logout` → immediate server-side invalidation

## Projects & files (S7)
- `GET /projects` / `POST /projects` / `PATCH /projects/:id` / `DELETE /projects/:id` (soft-delete + immediate cascade, D49) / `POST /projects/:id/restore`
- `GET /projects/:id/manifest` → `[{ path, contentHash }]` at last committed version (D38) — the reopen/resync convergence surface
- `GET /projects/:id/files/:path` → content at latest version
- `GET /projects/:id/chat` → history for rehydration (D23)
- All gated by ownership on unshielded address (FR-051; SC-027)

## Ledger & deposits (S6/S12)
- `GET /ledger` → `{ available, reserved, entries[] }` — server-derived only (FR-070)
- `POST /deposits` `{ amount }` → `{ depositRef, expiresAt }` — preregisters the ref (D45)
- `GET /deposits/:ref` → `{ status: preregistered|seen|credited|expired, txRef? }`

## Deploy (S8)
- deploys travel over WS (`deploy:request`); registry read: `GET /projects/:id/deploys` → registry rows (exactly one active)

## Handoff (S13 — D58/D59)
- `GET /projects/:id/archive` → zip of latest committed tree + README (owner-only)
- `POST /projects/:id/clone-token` / `DELETE .../clone-token` → mint/revoke (revocation immediate, SC-043)
- `GET /git/:cloneToken/...` → read-only git HTTP for the materialized repo (token auth, rate-limited; history synthesized from turn versions)

## Prover (D37/D52/D62)

The proof server itself is **foundational infrastructure** (provisioned in Phase 2; private-mesh access for the orchestrator's own proving — deposits from Phase 8, deploys from Phase 10). Two access paths:
- **Nyx-app flows**: session-authenticated same-origin proxy `POST /prover/prove` — no tokens needed (cookie auth)
- **Generated apps in escape-hatch tabs (S9, ⛔ gated by Q3/D54)**: the public token-gated exposure below
- `POST /prover/token` → short-lived proving token bound to the session (scaffold injects into generated app config)
- Prover endpoint itself (separate Fly app): accepts stock Midnight proof-server API requests bearing a valid token; per-session rate limits; unauthorized/expired/exceeded → rejected (FR-062; SC-033)

## Ops (internal)
- Health/readiness endpoints; reconcile reports are operator-only, not exposed to user sessions (S10)
