-- 0004_reconcile_amount_width.down.sql
-- Reverts 0004: narrow the reconcile_runs money columns numeric(40,0) -> bigint.
--
-- WARNING: narrowing can FAIL if any stored drift/burn_amount exceeds the bigint range
-- (the very range 0004 was added to hold). That is an acceptable schema-rollback hazard —
-- a down-migrate over data that already relies on the wider type cannot be lossless.
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT here.

ALTER TABLE reconcile_runs ALTER COLUMN burn_amount TYPE bigint USING burn_amount::bigint;
ALTER TABLE reconcile_runs ALTER COLUMN drift TYPE bigint USING drift::bigint;
