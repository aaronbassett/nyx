# Data Model: Nyx platform

> Phase 1 projection of the spec's Key Entities into concrete schema shape. All tables Postgres (D26). Monetary amounts are bigints in NYXT base units; addresses are Midnight unshielded addresses (D43). Every mutation that pairs ledger + domain state runs in one transaction (FR-043, FR-047).

## Account & Session

**accounts** — one per wallet (D43)
| field | type | notes |
|---|---|---|
| address | text PK | unshielded address; the identity key everywhere |
| created_at | timestamptz | first successful sign-in (auto-create) |

**sessions** (D44)
| field | type | notes |
|---|---|---|
| id | uuid PK | cookie-bound, HttpOnly/Secure/SameSite |
| account_address | FK accounts | |
| expires_at | timestamptz | 7-day sliding: bumped on activity |
| revoked_at | timestamptz? | logout = immediate revocation |

**auth_nonces** (FR-034/039): `nonce PK, issued_at, expires_at (short), consumed_at?` — single-use, burned on any verification attempt.

**proving_tokens** (D52): `token PK, session_id FK, expires_at (short), rate window counters` — issued via live session; prover validates.

## Project & Files

**projects** (D49): `id PK, owner_address FK, name, created_at, deleted_at? (soft-delete; purge job after 30d), clone_token? (revocable, D58), clone_materialized_at_version? (repo cache watermark, FR-076)`
Clone-URL access attempts (incl. brute-force rejections, EC-55) log to standard request logging with the token prefix redacted.
State machine: `active → soft-deleted → purged`; delete cascades immediately to R2 prefix cleanup + contract teardown + session termination; restore within window rehydrates (contracts redeploy fresh).

**project_files** + **project_file_versions** (D26, D48)
| field | type | notes |
|---|---|---|
| project_id, path | PK | latest row carries current content + content_hash |
| content, content_hash, size | | caps enforced (config; 1 MB/file, 50 MB/project defaults) |
| version | bigint | monotonic per project; turn commits share one version stamp |
| author | enum(agent, user) | agent = turn-scoped batch tx; user = immediate single-file tx |
Version history retained per config retention window; **manifest** = `(path, content_hash)[]` at latest committed version (D38) — serves reopen + reconnect resync.

**chat_messages** (D23): `project_id FK, seq, role, content, turn_id?, created_at` — rehydrated on open.

## Turn & Ledger

**turns** (D21/D34): `id PK, project_id FK, status(classifying → reserved → running → settled|declined), cycles_used ≤ 3, reserve_entry FK?, settle_entry FK?, started_at, ended_at`
Charging invariants: declined ⇒ no reserve (D25); every non-declined turn ends with exactly one settlement at actual consumption (no refunds, D34); overage allowed on final completed cycle (balance may go negative; new prompts require available ≥ flat reserve).

**ledger_entries** — append-only (FR-043)
| field | type | notes |
|---|---|---|
| id | bigserial PK | |
| account_address | FK | |
| kind | enum(deposit_credit, reserve, reserve_release, settlement) | burn accounting lives in reconcile_runs (vault-global, not per-account) |
| amount | bigint | signed by kind |
| ref | text? | deposit_ref / turn_id / reconcile_run_id linkage |
Settlement writes `reserve_release` + `settlement` in **one transaction** — this pair is the spec's "one atomic ledger entry" (Story 6 scenario 4). Derived balances: `available` and `reserved` are pure folds over entries — the UI never computes client-side (FR-070); invariant `available + reserved = credits − settlements` (SC-023).

**deposit_refs** (D45/D46): `ref PK (random), account_address FK, expected_amount, created_at, expires_at (TTL), status(preregistered → seen → credited | expired)` — exactly-once credit on finalized SUCCESS observation; **orphan_deposits**: finalized on-chain deposits with unknown refs (manual resolution only).

**reconcile_runs** (D55/D56): `id PK, ran_at, inputs (ledger totals, on-chain deposit total, vault balance), drift?, burn_amount?, burn_tx?, watermark, outcome` — idempotent by watermark; drift alarms, never auto-corrects.

## Deploy

**deploy_registry** (FR-057): `project_id FK, address, version, status(active | superseded | torn_down), deployed_at, tx_ref`
Invariant: exactly one `active` per project. Pipeline state (per request): `requested → validating → proving → submitting → awaiting_finality → finalized(emit contract:deployed) | failed`. One in-flight per project; requests during turns queue.

## On-chain (NyxtVault, Compact — design per R4 brief; final shapes tool-verified at implementation)

- Public ledger state: `deposits: Map<Bytes<32>, Uint<128>>` (ref → amount; contract rejects duplicate refs), vault-held unshielded NYXT balance
- Circuits: `deposit(depositRef, amount)` (guaranteed-phase: receive tNIGHT + mint to `kernel.self()` + record ref); `burn(amount)` (orchestrator-only auth; exactly-once per reconcile watermark — design via mnm/MNE at S10)

## Config tunables (D47 pattern — boot-validated, DS-003)

exchange rate (tNIGHT→NYXT), flat reserve, minimum deposit, low-balance threshold, size caps, project quota, version retention, deposit-ref TTL, reconcile cadence, prover rate limits, session/proving-token lifetimes, model routing table (D19).
