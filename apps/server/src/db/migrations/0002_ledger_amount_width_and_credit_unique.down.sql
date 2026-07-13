-- 0002_ledger_amount_width_and_credit_unique.down.sql
-- Reverts 0002 in the reverse of its apply order: drop the partial unique index, then
-- narrow the amount columns back to bigint.
--
-- WARNING: narrowing numeric(40,0) -> bigint can FAIL if any stored value exceeds 2^63-1
-- (the very range 0002 was added to hold). That is an acceptable schema-rollback hazard —
-- a down-migrate over data that already relies on the wider type cannot be lossless.
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT here.

DROP INDEX ledger_entries_deposit_credit_ref_key;

ALTER TABLE orphan_deposits ALTER COLUMN amount TYPE bigint USING amount::bigint;
ALTER TABLE deposit_refs ALTER COLUMN expected_amount TYPE bigint USING expected_amount::bigint;
ALTER TABLE ledger_entries ALTER COLUMN amount TYPE bigint USING amount::bigint;
