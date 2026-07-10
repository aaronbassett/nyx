-- 0001_initial_schema.up.sql
-- Nyx platform initial schema (T016) — implements specs/001-nyx-platform/data-model.md.
--
-- Conventions:
--   * Monetary amounts are bigint NYXT base units; entry amounts are stored as
--     positive magnitudes and the sign is applied by kind in the balance folds
--     ("signed by kind"). Derived balances may go negative (overage, D34) — that
--     is a property of the fold, not of any single row.
--   * Account identity everywhere is the Midnight unshielded address (D43).
--   * Status-ish fields use CHECK constraints rather than Postgres enum types so
--     later migrations can evolve them without ALTER TYPE ceremony.
--   * The migration runner wraps this file in a single transaction; no BEGIN/COMMIT here.
--   * Requires Postgres >= 13 (built-in gen_random_uuid()).

-- ============================================================================
-- Account & Session
-- ============================================================================

-- One row per wallet; auto-created on first successful sign-in (D43).
CREATE TABLE accounts (
  address    text        PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cookie-bound sessions, 7-day sliding expiry, logout = immediate revocation (D44).
CREATE TABLE sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_address text        NOT NULL REFERENCES accounts (address) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_account_address_idx ON sessions (account_address);

-- Single-use SIWE nonces, burned on any verification attempt (FR-034/039).
CREATE TABLE auth_nonces (
  nonce       text        PRIMARY KEY,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

-- Short-lived prover tokens issued via a live session (D52).
-- "rate window counters" projected as a window start + a count within the window.
CREATE TABLE proving_tokens (
  token                  text        PRIMARY KEY,
  session_id             uuid        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  expires_at             timestamptz NOT NULL,
  rate_window_started_at timestamptz NOT NULL DEFAULT now(),
  rate_window_count      integer     NOT NULL DEFAULT 0 CHECK (rate_window_count >= 0)
);

CREATE INDEX proving_tokens_session_id_idx ON proving_tokens (session_id);

-- ============================================================================
-- Project & Files
-- ============================================================================

-- State machine: active -> soft-deleted -> purged (purge job after 30d, D49).
-- clone_token is revocable (D58); clone_materialized_at_version is the repo
-- cache watermark (FR-076).
CREATE TABLE projects (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address                 text        NOT NULL REFERENCES accounts (address),
  name                          text        NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  deleted_at                    timestamptz,
  clone_token                   text,
  clone_materialized_at_version bigint
);

CREATE INDEX projects_owner_address_idx ON projects (owner_address);

-- Clone URLs resolve a token to exactly one project.
CREATE UNIQUE INDEX projects_clone_token_key
  ON projects (clone_token)
  WHERE clone_token IS NOT NULL;

-- Latest row per (project, path) carries current content + content_hash (D26, D48).
-- version is monotonic per project; turn commits share one version stamp.
CREATE TABLE project_files (
  project_id   uuid   NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path         text   NOT NULL,
  content      text   NOT NULL,
  content_hash text   NOT NULL,
  size         bigint NOT NULL CHECK (size >= 0),
  version      bigint NOT NULL CHECK (version >= 1),
  author       text   NOT NULL CHECK (author IN ('agent', 'user')),
  PRIMARY KEY (project_id, path)
);

-- Version history, retained per config retention window (created_at drives pruning).
CREATE TABLE project_file_versions (
  project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path         text        NOT NULL,
  version      bigint      NOT NULL CHECK (version >= 1),
  content      text        NOT NULL,
  content_hash text        NOT NULL,
  size         bigint      NOT NULL CHECK (size >= 0),
  author       text        NOT NULL CHECK (author IN ('agent', 'user')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path, version)
);

-- Manifest = (path, content_hash)[] at the latest committed version (D38).
CREATE INDEX project_file_versions_project_version_idx
  ON project_file_versions (project_id, version);

-- ============================================================================
-- Turn & Ledger
-- ============================================================================

-- Append-only NYXT ledger (FR-043). Burn accounting is NOT here — it is
-- vault-global and lives in reconcile_runs (D55/D56). Derived balances
-- (available, reserved) are pure folds over these entries (FR-070, SC-023).
CREATE TABLE ledger_entries (
  id              bigserial   PRIMARY KEY,
  account_address text        NOT NULL REFERENCES accounts (address),
  kind            text        NOT NULL
                              CHECK (kind IN ('deposit_credit', 'reserve', 'reserve_release', 'settlement')),
  amount          bigint      NOT NULL CHECK (amount > 0),
  ref             text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_address_idx ON ledger_entries (account_address, id);

-- Append-only enforcement: block UPDATE/DELETE/TRUNCATE at the database layer
-- regardless of connecting role.
CREATE FUNCTION ledger_entries_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (FR-043): % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_forbid_mutation();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_forbid_mutation();

-- Turn lifecycle (D21/D34): classifying -> reserved -> running -> settled | declined.
-- Charging invariants (D25/D34): declined turns never reserve or settle; settled
-- turns carry exactly one settlement entry. The reserve_release + settlement pair
-- is written in one transaction at settle time (application-enforced, FR-047).
CREATE TABLE turns (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status        text        NOT NULL DEFAULT 'classifying'
                            CHECK (status IN ('classifying', 'reserved', 'running', 'settled', 'declined')),
  cycles_used   smallint    NOT NULL DEFAULT 0 CHECK (cycles_used >= 0 AND cycles_used <= 3),
  reserve_entry bigint      REFERENCES ledger_entries (id),
  settle_entry  bigint      REFERENCES ledger_entries (id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  CONSTRAINT turns_declined_never_charged
    CHECK (status <> 'declined' OR (reserve_entry IS NULL AND settle_entry IS NULL)),
  CONSTRAINT turns_settled_has_settlement
    CHECK (status <> 'settled' OR settle_entry IS NOT NULL)
);

CREATE INDEX turns_project_id_idx ON turns (project_id);

-- Chat history, rehydrated on project open (D23).
CREATE TABLE chat_messages (
  project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  seq        bigint      NOT NULL CHECK (seq >= 1),
  role       text        NOT NULL,
  content    text        NOT NULL,
  turn_id    uuid        REFERENCES turns (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq)
);

CREATE INDEX chat_messages_turn_id_idx ON chat_messages (turn_id) WHERE turn_id IS NOT NULL;

-- Pre-registered deposit references with TTL; exactly-once credit on finalized
-- SUCCESS observation (D45/D46).
CREATE TABLE deposit_refs (
  ref             text        PRIMARY KEY,
  account_address text        NOT NULL REFERENCES accounts (address),
  expected_amount bigint      NOT NULL CHECK (expected_amount > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  status          text        NOT NULL DEFAULT 'preregistered'
                              CHECK (status IN ('preregistered', 'seen', 'credited', 'expired'))
);

CREATE INDEX deposit_refs_account_address_idx ON deposit_refs (account_address);

-- Finalized on-chain deposits whose ref is unknown; manual resolution only (D46).
-- The vault contract rejects duplicate refs, so each orphan ref is observed once.
CREATE TABLE orphan_deposits (
  id              bigserial   PRIMARY KEY,
  ref             text        NOT NULL UNIQUE,
  amount          bigint      NOT NULL CHECK (amount > 0),
  tx_ref          text,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution_note text
);

-- Reconcile job reports (D55/D56): idempotent by watermark; drift alarms,
-- never auto-corrects. Vault-global burn accounting lives here.
-- inputs holds the snapshot the run computed from: ledger totals, on-chain
-- deposit total, vault balance.
CREATE TABLE reconcile_runs (
  id          bigserial   PRIMARY KEY,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  inputs      jsonb       NOT NULL,
  drift       bigint,
  burn_amount bigint      CHECK (burn_amount >= 0),
  burn_tx     text,
  watermark   text        NOT NULL UNIQUE,
  outcome     text        NOT NULL CHECK (outcome IN ('reconciled', 'drift', 'error'))
);

-- ============================================================================
-- Deploy
-- ============================================================================

-- Registry of finalized deploys (FR-057). Pipeline state is per-request and
-- transient; only finalized deploys land here.
CREATE TABLE deploy_registry (
  id          bigserial   PRIMARY KEY,
  project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  address     text        NOT NULL,
  version     bigint      NOT NULL CHECK (version >= 1),
  status      text        NOT NULL CHECK (status IN ('active', 'superseded', 'torn_down')),
  deployed_at timestamptz NOT NULL DEFAULT now(),
  tx_ref      text        NOT NULL,
  UNIQUE (project_id, version)
);

-- Invariant: exactly one active deploy per project (FR-057).
CREATE UNIQUE INDEX deploy_registry_one_active_per_project
  ON deploy_registry (project_id)
  WHERE status = 'active';
