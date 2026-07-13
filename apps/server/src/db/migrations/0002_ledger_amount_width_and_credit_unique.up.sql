-- 0002_ledger_amount_width_and_credit_unique.up.sql
-- Two HIGH money-path fixes on the US6 ledger (code-review defects H1 + H2).
--
-- H1 — amount width. The NyxtVault contract
-- (packages/nyxt-vault/src/nyxt-vault.compact) accepts + mints a single deposit up to its
-- per-deposit mint cap 2^64-1 (Uint<64>, = 18446744073709551615). The 0001 columns are
-- `bigint` (max 2^63-1), so a finalized deposit in (2^63-1, 2^64-1] mints on-chain yet
-- overflows on INSERT (22003 numeric_value_out_of_range) — the ref never flips to credited
-- and funds strand. A cumulative Σdeposit_credit past 2^63-1 likewise overflows the balance
-- fold's ::bigint cast and freezes every balance read. Widen the three amount columns to
-- numeric(40,0), which holds the full Uint128 range with headroom. The existing
-- CHECK (amount > 0) / CHECK (expected_amount > 0) constraints operate on numeric unchanged.
--
-- H2 — deposit-credit exactly-once. `creditDeposit`'s FOR UPDATE + NOT EXISTS guard is safe
-- only under READ COMMITTED; under REPEATABLE READ / SERIALIZABLE a frozen snapshot's
-- NOT EXISTS can miss a concurrent insert and double-credit. A partial unique index makes
-- exactly-once STRUCTURAL under any isolation level (the store handles the 23505 as a no-op).
--
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT here.
-- NOTE: an ALTER COLUMN TYPE performs a table rewrite, which is DDL and does NOT fire the
-- ledger_entries append-only row triggers (they are BEFORE UPDATE/DELETE DML triggers).

-- ── H1: widen amount columns bigint -> numeric(40,0) ─────────────────────────
ALTER TABLE ledger_entries ALTER COLUMN amount TYPE numeric(40, 0);
ALTER TABLE deposit_refs ALTER COLUMN expected_amount TYPE numeric(40, 0);
ALTER TABLE orphan_deposits ALTER COLUMN amount TYPE numeric(40, 0);

-- ── H2: structural exactly-once for deposit credits ──────────────────────────
-- One deposit_credit per ref, enforced by the index rather than by lock ordering.
-- (Creation fails if the table already holds duplicate deposit_credit refs — the READ
-- COMMITTED guard should have prevented any, so existing data is expected to be clean.)
CREATE UNIQUE INDEX ledger_entries_deposit_credit_ref_key
  ON ledger_entries (ref)
  WHERE kind = 'deposit_credit';
