/**
 * Dev wallet ceremony SELECTOR (P3 Task 5, Step 7).
 *
 * Chooses the {@link DepositCeremony} the top-up flow runs: the real dev-wallet
 * ceremony when the demo env gating is active (`VITE_DEV_WALLET === "1"`), else the
 * owner-gated stub (`createOwnerGatedCeremony`, topup.tsx) — production never ships the
 * dev ceremony. `topup.tsx` itself is UNMODIFIED; P6's TopUpModal mounts `TopUp` with
 * this selector's result (the ceremony is chosen at MOUNT, there is no construction site
 * inside topup.tsx).
 *
 * When active it composes `createDevWalletCeremony` with:
 *  - the WASM prover as PRIMARY + the proxy prover as the designed FALLBACK (SPIKE-2
 *    verdict — a one-line proofProvider swap over the SAME client key material), via
 *    {@link withFallback};
 *  - the NyxtVault address from the `config.ts` chokepoint (`NYXT_VAULT_ADDRESS`), never
 *    an env read inside the ceremony;
 *  - submissions SERIALIZED per wallet ({@link serializeSubmissions}, SPIKE-2 risk 7 —
 *    concurrent submits from one seed race its UTXO/nonce state).
 *
 * The real prove (~23–26 s, k=13) and the real build/submit are owner/`DEVNET_URL`-gated
 * (`dev-ceremony-tx.ts`); the proving-budget UX (progress state, Web Worker, key-material
 * prefetch — SPIKE-2 risk 1) is surfaced by the top-up state machine's existing
 * `awaiting-signature` phase, which already reads "Waiting for signature and proof…".
 * Every seam is injectable so this selector is unit-tested with fakes.
 */
import { NYXT_VAULT_ADDRESS } from "../config";
import {
  createDevWalletCeremony,
  type CeremonyProver,
  type DepositTxBuilder,
  type TxSubmitter,
} from "./dev-ceremony";
import { createDepositTxBuilder, createDevnetSubmitter } from "./dev-ceremony-tx";
import type { DevSigner } from "./dev-signer";
import { createOwnerGatedCeremony, type DepositCeremony } from "./topup";

/** Read `import.meta.env` defensively (mirrors `dev-wallet.ts` / `config.ts`). */
function readEnv(): Record<string, string | undefined> {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return meta.env ?? {};
}

/** A terse, safe rendering of an unknown thrown value for a diagnostic message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Combine two provers into one that tries `primary`, and on ANY rejection falls back to
 * `fallback` (SPIKE-2's wasm→proof-server swap). With no `fallback` it is just `primary`.
 * The same unproven bytes are re-proven by the fallback — proving is a pure function of
 * the tx + key material, so a retry is safe. If BOTH legs fail, the surfaced error RETAINS the
 * primary (wasm) failure as its `cause` (Opus-2) so no diagnostic is lost.
 */
export function withFallback(primary: CeremonyProver, fallback?: CeremonyProver): CeremonyProver {
  if (fallback === undefined) {
    return primary;
  }
  return {
    async prove(unprovenTx: Uint8Array): Promise<Uint8Array> {
      let primaryError: unknown;
      try {
        return await primary.prove(unprovenTx);
      } catch (error) {
        primaryError = error;
      }
      try {
        // The proof-server fallback re-proves the SAME tx with the SAME key material.
        return await fallback.prove(unprovenTx);
      } catch (fallbackError) {
        // Opus-2 — both legs failed. Surface the fallback error but RETAIN the primary (wasm)
        // failure as its `cause` (the bare `catch {}` used to swallow it — a lost diagnostic
        // when the proxy also fails).
        throw new Error(
          `dev ceremony proving failed on both legs (wasm: ${describeError(primaryError)}; ` +
            `proxy: ${describeError(fallbackError)})`,
          { cause: primaryError },
        );
      }
    },
  };
}

/**
 * Wrap a submitter so calls from one wallet NEVER overlap (SPIKE-2 risk 7): each
 * submission awaits the previous one's settlement before starting. A single promise chain
 * per selector instance (= per wallet) is the serialization boundary; a failed submission
 * does not wedge the queue (the chain continues regardless of outcome).
 */
export function serializeSubmissions(submit: TxSubmitter): TxSubmitter {
  let tail: Promise<unknown> = Promise.resolve();
  return (provenTx: Uint8Array) => {
    const run = tail.then(
      () => submit(provenTx),
      () => submit(provenTx),
    );
    // Keep the chain alive on either outcome without surfacing an unhandled rejection.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Injected inputs for {@link selectDepositCeremony} (all SDK/env access is a seam). */
export interface SelectCeremonyDeps {
  /** The connected dev wallet's signer (the SIWE/account identity; diagnostics-only). */
  readonly signer: DevSigner;
  /** NyxtVault address; defaults to the `config.ts` chokepoint value ({@link NYXT_VAULT_ADDRESS}). */
  readonly contractAddress?: string;
  /** Env source (defensive); defaults to `import.meta.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Unproven-tx assembly seam; defaults to the owner-gated {@link createDepositTxBuilder}. */
  readonly buildTx?: DepositTxBuilder;
  /** Submit seam (pre-serialization); defaults to the owner-gated {@link createDevnetSubmitter}. */
  readonly submit?: TxSubmitter;
  /** PRIMARY (wasm) prover; defaults to an owner-gated wasm-leg prover. */
  readonly prover?: CeremonyProver;
  /** FALLBACK (proxy) prover; defaults to an owner-gated proxy-leg prover. */
  readonly fallbackProver?: CeremonyProver;
  /** Non-dev-path factory; defaults to {@link createOwnerGatedCeremony}. */
  readonly ownerGated?: () => DepositCeremony;
}

/** A default owner-gated prover (rejects) so the wasm/proxy wiring is present without fakes. */
function ownerGatedProver(leg: string): CeremonyProver {
  return {
    prove: () =>
      Promise.reject(
        new Error(
          `dev ceremony ${leg} prover is owner-gated (Task 4 provider + same-origin key ` +
            "source): inject a real CeremonyProver. See dev-ceremony-tx.ts.",
        ),
      ),
  };
}

/**
 * Select the deposit ceremony for the current build. Returns the dev-wallet ceremony when
 * `VITE_DEV_WALLET === "1"`, otherwise the owner-gated stub. See the module docstring for
 * the composition (fallback prover, config-sourced vault address, serialized submits).
 */
export function selectDepositCeremony(deps: SelectCeremonyDeps): DepositCeremony {
  const env = deps.env ?? readEnv();
  const ownerGated = deps.ownerGated ?? createOwnerGatedCeremony;
  if (env.VITE_DEV_WALLET !== "1") {
    return ownerGated();
  }

  const contractAddress = deps.contractAddress ?? NYXT_VAULT_ADDRESS;
  const buildTx = deps.buildTx ?? createDepositTxBuilder({ signer: deps.signer });
  const submit = serializeSubmissions(deps.submit ?? createDevnetSubmitter());
  const prover = withFallback(
    deps.prover ?? ownerGatedProver("wasm"),
    deps.fallbackProver ?? ownerGatedProver("proxy"),
  );

  return createDevWalletCeremony({
    signer: deps.signer,
    prover,
    buildTx,
    submit,
    contractAddress,
  });
}
