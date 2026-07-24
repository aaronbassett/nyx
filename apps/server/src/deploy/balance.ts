/**
 * The real deploy-wallet tDUST {@link BalanceQuery} (P4 Task 3) — the production filling of the
 * EC-38 monitor's balance seam (`wallet.ts`). `createDeployWalletMonitor` consumes a
 * `BalanceQuery = () => Promise<bigint>` (base units); this module builds a real one that reads the
 * deploy wallet's spendable DUST off the Midnight wallet SDK. Task 4 wires it into `index.ts` in
 * place of the current fail-closed "not wired" stub.
 *
 * ⚠️ CONSTITUTION I — THIS FILE CONTAINS ZERO `@midnight-ntwrk/*` IMPORTS. Every SDK shape lives
 * behind the injectable {@link BalanceSdk} seam whose ONLY production implementation is
 * `balance-sdk-adapter.ts` (the single SDK-touching module, built from `sdk-recipe.md` element 5).
 * This module is pure orchestration: pick the evaluation instant from the injected clock, delegate
 * the wallet read to the seam, and hand back the DUST balance. That keeps the query deterministically
 * testable with a FAKE `BalanceSdk` — no wallet, no chain, no key — and the SDK boundary in exactly
 * one owner-gated place (the Task 2 executor / `sdk-adapter.ts` precedent).
 *
 * WHY THE QUERY GATES ON DUST (recipe element 5): fees are spent in DUST, so the monitor's floor
 * gates on the DUST read. The seam ALSO returns NIGHT (generation capacity) as a diagnostic — but
 * the `BalanceQuery` contract is a single `bigint`, and that `bigint` is DUST. Both are native
 * `bigint`, threaded through untouched — NEVER `Number()` (a balance can exceed 2^63).
 *
 * ⚠️ FAIL-CLOSED (money safety): a seam rejection PROPAGATES verbatim — it is NEVER caught and
 * softened to `0n`. A zero DUST balance means "exhausted" (the wallet can't fund a deploy); a
 * rejection means "unknown" (the balance is unavailable). `classifyBalance` (`wallet.ts`) must not
 * conflate them, so `assertCanDeploy` fails closed on a rejection. The unwired default seam
 * (`balance-sdk-adapter.ts`) rejects with `BalanceSdkNotWiredError` for exactly this reason.
 *
 * ⚠️ CONSTITUTION III / SC-031 — the `signingKey` (the server-side deploy credential, D50) flows into
 * the seam call and NOWHERE else: it is never logged, never returned, and never folded into an error
 * by this module (it constructs no error at all — a rejection is the seam's own, and the default is a
 * FIXED key-free `BalanceSdkNotWiredError`). The deterministic suite proves this with a canary key.
 */
import type { NetworkProfile } from "../config/index.js";
import type { BalanceQuery } from "./wallet.js";

/**
 * A deploy-wallet balance reading [recipe element 5]. Both fields are native `bigint` base units —
 * `dust` is fee capacity (what the monitor's floor gates on, since fees are spent in DUST) and
 * `night` is generation capacity (the diagnostic explanation when DUST is low: unregistered NIGHT
 * generates no DUST). NEVER `Number()` either — a balance can exceed 2^63.
 */
export interface BalanceReading {
  /** Spendable DUST (fee capacity) in base units — the value the {@link BalanceQuery} returns. */
  readonly dust: bigint;
  /** NIGHT (DUST-generation capacity) in base units — diagnostic only. */
  readonly night: bigint;
}

/**
 * The narrow SDK boundary — the ONE seam `balance-sdk-adapter.ts` implements against the installed
 * `@midnight-ntwrk/*` wallet SDK (constitution I). A single method so the orchestrator can inject
 * the time-dependent evaluation instant and thread the deploy credential. The `signingKey` is passed
 * IN for the wallet build and is the ONLY place it flows; the adapter must never echo it into a
 * result or error.
 */
export interface BalanceSdk {
  /**
   * Read the deploy wallet's DUST + NIGHT balances [recipe element 5]. `at` is the evaluation
   * instant — the DUST read is TIME-DEPENDENT (DUST accrues from registered NIGHT), so the caller's
   * injected clock decides it. Resolves a {@link BalanceReading}; REJECTS on a transport/sync/not-
   * wired fault (fail-closed — never a false `0n`).
   */
  readBalance(input: {
    readonly signingKey: string;
    readonly network: NetworkProfile;
    readonly at: Date;
  }): Promise<BalanceReading>;
}

/** Dependencies for {@link createDevnetBalanceQuery}. */
export interface DevnetBalanceQueryDeps {
  /** Resolved network endpoints the wallet syncs against (node/indexer/proof). */
  readonly network: NetworkProfile;
  /** Server-side deploy signing credential (D50/constitution III — never client-routed/logged). */
  readonly signingKey: string;
  /** The SDK seam; defaults to the lazily-loaded real `balance-sdk-adapter.ts`. Tests inject a fake. */
  readonly sdk?: BalanceSdk;
  /**
   * Clock supplying the time-dependent DUST evaluation instant; defaults to `() => new Date()`.
   * Injected so the read is deterministic in tests (DUST accrues, so the instant is load-bearing).
   */
  readonly now?: () => Date;
}

/**
 * A lazily-loaded real {@link BalanceSdk} backed by `balance-sdk-adapter.ts`. The dynamic `import()`
 * keeps `@midnight-ntwrk/*` OUT of this module's static graph — so a deterministic test that injects
 * a fake `sdk` never loads the SDK — while a real query transparently pulls it in on first use
 * (mirrors the Task 2 executor's `createLazyRealSdk`).
 */
function createLazyRealBalanceSdk(): BalanceSdk {
  let loaded: Promise<BalanceSdk> | undefined;
  const load = (): Promise<BalanceSdk> => {
    loaded ??= import("./balance-sdk-adapter.js").then((module) =>
      module.createBalanceSdkAdapter(),
    );
    return loaded;
  };
  return {
    readBalance: async (input) => (await load()).readBalance(input),
  };
}

/**
 * Build the real deploy-wallet tDUST {@link BalanceQuery} over its injected seams. Side-effect-free
 * at construction (opens no wallet/chain/key). The returned query, on each call, evaluates the clock
 * for the DUST accrual instant, delegates the wallet read to the {@link BalanceSdk} seam, and returns
 * the DUST balance (fees are DUST). A seam rejection propagates (fail-closed) — the query never
 * resolves a false `0n` on error, and never echoes the signing key into a rejection.
 */
export function createDevnetBalanceQuery(deps: DevnetBalanceQueryDeps): BalanceQuery {
  const { network, signingKey } = deps;
  const sdk = deps.sdk ?? createLazyRealBalanceSdk();
  const now = deps.now ?? ((): Date => new Date());

  return async (): Promise<bigint> => {
    // Evaluate the clock per call — DUST accrues, so the read is a function of `at` (recipe element
    // 5). A seam rejection propagates verbatim (fail-closed): never softened to 0n, never key-bearing.
    const reading = await sdk.readBalance({ signingKey, network, at: now() });
    return reading.dust;
  };
}
