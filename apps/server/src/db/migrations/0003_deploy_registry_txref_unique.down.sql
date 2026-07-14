-- 0003_deploy_registry_txref_unique.down.sql
-- Reverts 0003: drop the tx_ref exactly-once unique index. Dropping it re-opens the
-- double-record window (defect C1) — a down-migrate only makes sense to roll the schema back.
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT here.

DROP INDEX deploy_registry_tx_ref_key;
