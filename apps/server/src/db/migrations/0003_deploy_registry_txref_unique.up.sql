-- 0003_deploy_registry_txref_unique.up.sql
-- Structural exactly-once for finalized deploys (code-review defect C1, belt-and-suspenders).
--
-- recordDeploy allocates MAX(version)+1 and INSERTs on every call, so two calls carrying the
-- SAME on-chain tx_ref — the deploy pipeline's post-finality record RETRY racing itself, or a
-- fresh-requestId retry of a finalized-but-unrecorded deploy — would insert TWO rows for ONE
-- on-chain deploy. tx_ref is a globally-unique on-chain transaction reference, so a UNIQUE
-- index over it makes recording a given finalized tx EXACTLY-ONCE at the DB layer: the store
-- (registry.ts recordDeploy) handles the resulting 23505 as an idempotent "already recorded"
-- inside a SAVEPOINT, mirroring the ledger's deposit_credit exactly-once index in 0002.
--
-- (Creation FAILS if the table already holds duplicate tx_ref rows — a fresh deploy_registry
-- has none; the pre-fix insert-always path is exactly the double-record this index closes.)
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT here.

CREATE UNIQUE INDEX deploy_registry_tx_ref_key ON deploy_registry (tx_ref);
