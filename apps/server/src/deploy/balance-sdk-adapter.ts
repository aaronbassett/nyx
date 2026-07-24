/**
 * The SDK boundary for the deploy-wallet tDUST/NIGHT balance read (P4 Task 3) — the module that
 * WILL touch the Midnight wallet SDK, implementing the {@link BalanceSdk} seam `balance.ts`
 * orchestrates. Mirrors the Task 2 `sdk-adapter.ts` precedent: the ONE place `@midnight-ntwrk/*`
 * lives, lazily loaded so the deterministic suite (which injects a fake `BalanceSdk`) never pulls
 * the SDK into its graph. Every shape cites the verified `sdk-recipe.md` element 5 (constitution I
 * — retrieval-sourced, never memory).
 *
 * ⚠️ CONSTITUTION I — WHAT IS VERIFIED vs OWNER-GATED (recorded out loud, constitution VIII).
 * Unlike the Task 2 finality query (a raw indexer GraphQL poll that needs NO funds and so ships as
 * REAL production code), a balance read has NO wallet-free transport: `sdk-recipe.md` element 5
 * reads the balance off the wallet-sdk STATE object, which requires a FUNDED, DUST-registered,
 * SYNCED wallet — `MidnightWalletProvider.build(logger, env, seed)` + `.start()` (~30 s sync, and
 * `.start()` is what auto-registers NIGHT for DUST generation) + `firstValueFrom(wallet.state())`.
 * That funded credential is the P5-provided deploy wallet the brief pre-declares owner-gated. So
 * the ENTIRE real read is behind the {@link ReadWalletBalance} seam, which DEFAULTS to throwing
 * {@link BalanceSdkNotWiredError} — an unwired adapter can NEVER read as a working `0n` balance
 * (fail-closed money safety: a rejection is "balance unavailable", a `0n` is "exhausted", and the
 * EC-38 monitor's `classifyBalance` must never conflate them).
 *
 * VERIFIED recipe to wire the seam body (each shape read from the INSTALLED `.d.ts`, 2026-07-24,
 * NOT memory — see `sdk-recipe.md` element 5):
 *
 *   import * as Rx from "rxjs";
 *   import { unshieldedToken } from "@midnight-ntwrk/midnight-js-protocol/ledger";
 *   import { MidnightWalletProvider } from "@midnight-ntwrk/testkit-js"; // build(logger, env, seed)
 *   // env: EnvironmentConfiguration built from `network` (node WS :9944 / indexer :8088 / proof :6300).
 *   // `seed` is the deploy wallet's hex seed derived from `signingKey` per the recipe.
 *   const provider = await MidnightWalletProvider.build(logger, env, seed);
 *   await provider.start();                                   // sync + DUST-registration; ~30 s
 *   const state = await Rx.firstValueFrom(provider.wallet.state()); // FacadeState (Observable)
 *   const dust  = state.dust.balance(at);                     // DustWalletState.balance(time: Date): bigint
 *   const night = state.unshielded.balances[unshieldedToken().raw] ?? 0n; // Record<RawTokenType, bigint>
 *   return { dust, night };
 *
 * Installed-`.d.ts` anchors (verified, not memory): `wallet-sdk-dust-wallet@4.1.0`
 * `DustWalletState.balance(time: Date): Balance` with `Balance = bigint` (`dist/DustWallet.d.ts`);
 * `wallet-sdk-facade@4.0.1` `FacadeState { readonly unshielded; readonly dust; get isSynced }` and
 * `unshielded.balances: Record<ledger.RawTokenType, bigint>` (`dist/index.d.ts`); `testkit-js@4.1.1`
 * `MidnightWalletProvider.build(logger, env, seed?)` + `.start(waitForFundsInWallet?)` + `.wallet:
 * WalletFacade` (`dist/wallet/midnight-wallet-provider.d.ts`). Both amounts are native `bigint` —
 * NEVER `Number()` (a per-deposit/NIGHT magnitude can exceed 2^63).
 *
 * ⚠️ CONSTITUTION III / SC-031 — the `signingKey`/derived seed reaching {@link ReadWalletBalance} is
 * NEVER logged, NEVER returned, and NEVER folded into an error here. {@link BalanceSdkNotWiredError}
 * is a FIXED, key-free string.
 */
import type { NetworkProfile } from "../config/index.js";
import type { BalanceReading, BalanceSdk } from "./balance.js";

/**
 * Thrown by the OWNER-GATED {@link ReadWalletBalance} seam until the real wallet-SDK balance read is
 * wired against a funded, DUST-registered deploy wallet (P5). Deliberately unmistakable so a stubbed
 * adapter can never read as a working `0n` balance. The `balance.ts` query propagates it verbatim —
 * `createDeployWalletMonitor.assertCanDeploy` then fails CLOSED (a rejection, never a false balance).
 * The message is FIXED and key-free (SC-031).
 */
export class BalanceSdkNotWiredError extends Error {
  constructor() {
    super(
      "owner-gated: real deploy-wallet tDUST/NIGHT balance read needs a funded, DUST-registered " +
        "deploy wallet + a devnet round-trip to confirm the wallet-facade state read " +
        "(MidnightWalletProvider.build/start + firstValueFrom(wallet.state())) — see sdk-recipe.md element 5",
    );
    this.name = "BalanceSdkNotWiredError";
  }
}

/**
 * The OWNER-GATED wallet balance read [recipe element 5]. Given the deploy `signingKey`, the target
 * `network`, and the time-dependent evaluation instant `at` (DUST accrues, so the read is a function
 * of time), resolves the wallet's DUST + NIGHT base-unit balances. Wire its body with the verified
 * recipe in this module's docblock once the funded wallet lands; it MUST NEVER fold `signingKey` into
 * a result or an error, and a fee-wallet with no DUST resolves `dust: 0n` (never rejects — the read
 * succeeded, the balance is just zero). A genuine transport/sync fault is a REJECTION (fail-closed).
 */
export type ReadWalletBalance = (input: {
  readonly signingKey: string;
  readonly network: NetworkProfile;
  readonly at: Date;
}) => Promise<BalanceReading>;

/** Options for {@link createBalanceSdkAdapter}. The owner-gated read seam defaults to throwing. */
export interface BalanceSdkAdapterDeps {
  /** OWNER-GATED wallet balance read; omitted → {@link BalanceSdkNotWiredError} on every call. */
  readonly readWalletBalance?: ReadWalletBalance;
}

/**
 * Build the {@link BalanceSdk} adapter. With no `readWalletBalance` wired the read is fail-closed
 * ({@link BalanceSdkNotWiredError}); the owner injects the real wallet-facade read (this module's
 * verified recipe) once the funded deploy wallet lands. Side-effect-free at construction (opens no
 * wallet/chain). Constructed with no args by `balance.ts`'s lazy default.
 */
export function createBalanceSdkAdapter(deps: BalanceSdkAdapterDeps = {}): BalanceSdk {
  return {
    readBalance: (input) => {
      if (deps.readWalletBalance === undefined) {
        return Promise.reject(new BalanceSdkNotWiredError());
      }
      return deps.readWalletBalance(input);
    },
  };
}
