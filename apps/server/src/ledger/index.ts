/**
 * Public surface of the US6 NYXT ledger (metering rail, D13/D34).
 *
 * `ledger.ts` — the reserve-then-settle account ledger (append-only entries,
 * server-derived available/reserved folds, no credit-backs).
 * `deposits.ts` — the deposit flow (preregistration + TTL, finality-gated
 * exactly-once credit by depositRef, orphans) built on the ledger's
 * `creditDeposit`. The indexer→observation adapter is owner-gated.
 */
export * from "./ledger.js";
export * from "./deposits.js";
