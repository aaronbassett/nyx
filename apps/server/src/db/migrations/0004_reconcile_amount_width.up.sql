-- 0004_reconcile_amount_width.up.sql
-- Widen the reconcile_runs money columns bigint -> numeric(40,0) (US10, code-review carry
-- from US6 P8: "reconcile_runs.drift/burn_amount are still bigint — Story 10 should widen").
--
-- Same money-width reason as 0002's ledger_entries.amount (H1): NYXT is minted 1:1 with
-- on-chain deposits up to the vault's Uint<64> per-deposit cap (2^64-1), and both the batched
-- burn (Σsettlement delta, D55) and the drift signal (onchainDepositTotal − ledgerCredits)
-- are computed from cumulative totals that can exceed 2^63-1. A bigint drift/burn_amount would
-- overflow (22003) exactly when the ledger is largest. numeric(40,0) holds the full Uint128
-- range with headroom; the store writes $N::numeric and reads ::text -> BigInt() (never
-- ::bigint / Number()), so precision is preserved end to end.
--
-- burn_amount keeps its CHECK (burn_amount >= 0) unchanged (it operates on numeric); drift is
-- signed (onchainDepositTotal may trail credits) and stays nullable. The migration runner
-- wraps this file in a single transaction; no BEGIN/COMMIT here. An ALTER COLUMN TYPE rewrite
-- is DDL and fires no DML triggers (reconcile_runs has none regardless).

ALTER TABLE reconcile_runs ALTER COLUMN drift TYPE numeric(40, 0);
ALTER TABLE reconcile_runs ALTER COLUMN burn_amount TYPE numeric(40, 0);
