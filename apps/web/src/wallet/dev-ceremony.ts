/**
 * Dev wallet deposit-ceremony ORCHESTRATION (P3 Task 5).
 *
 * Fills the `DepositCeremony` seam (`topup.tsx`) for the demo's dev wallet:
 * build → prove → submit a NyxtVault `deposit(depositRef, amount)` transaction,
 * resolving the submitted `{ txRef }`. This module is PURE orchestration over
 * injectable seams — it holds NO `@midnight-ntwrk/*` imports; every SDK-touching
 * step (tx assembly, contract-circuit proving, wallet balance/sign/finalize/submit)
 * lives behind the {@link DepositTxBuilder} / {@link CeremonyProver} / {@link TxSubmitter}
 * seams, whose real (owner/`DEVNET_URL`-gated) adapters live in `dev-ceremony-tx.ts`.
 * The split keeps the state-machine wiring deterministic and unit-testable with
 * fakes, exactly as the top-up flow's other seams are.
 *
 * Contract (from `topup.tsx` `DepositCeremony`, verified against the state machine):
 *  - RESOLVES `{ txRef }` ONLY once the deposit tx is submitted (the on-chain
 *    credit is observed LATER via the ledger subscription — never here);
 *  - REJECTS on any build / prove / submit failure — never a false "pending". The
 *    top-up reducer maps any ceremony rejection to `ceremony-rejected`
 *    (`topup.tsx` `TopUpErrorReason`), so a rejection is the honest failure signal.
 *  - the amount is a `bigint` end-to-end, NEVER routed through `Number()` (iron
 *    rules: money is bigint in code, decimal-string on the wire).
 *
 * ⚠️ TWO-DERIVATION note (SPIKE-2 risk 6, recorded in the Task 5 report): the
 * {@link DevSigner} here is the SIWE/account identity (ledger-v8 sample key). It is
 * NOT necessarily the funded on-chain wallet that pays the deposit's fee leg — the
 * NyxtVault attributes a deposit by its `depositRef` (off-chain channel, no
 * msg.sender), so the funding-wallet identity and the account identity are decoupled
 * BY the ref. The signer is carried here only for diagnostics; the funded wallet is
 * wired inside the (owner-gated) {@link TxSubmitter}. See `dev-ceremony-tx.ts`.
 */
import type { DepositCeremony, CeremonyParams, CeremonyResult } from "./topup";
import type { DevSigner } from "./dev-signer";

// ── Orchestration seams ────────────────────────────────────────────────────────

/**
 * Assemble the UNPROVEN NyxtVault `deposit(depositRef, amount)` transaction, returning
 * its serialized bytes. The contract address is passed EXPLICITLY (sourced from the
 * `config.ts` chokepoint, never an env read inside the ceremony). The real adapter
 * (`createDepositTxBuilder`) uses `midnight-js-contracts` `ContractCallPrototype` +
 * `Transaction.fromPartsRandomized` (owner-gated; see `dev-ceremony-tx.ts`).
 */
export type DepositTxBuilder = (params: {
  readonly depositRef: string;
  readonly amount: bigint;
  readonly contractAddress: string;
}) => Promise<{ readonly unprovenTx: Uint8Array }>;

/**
 * Turn an unproven transaction into a proven one (serialized bytes → serialized bytes).
 * The real adapter drives the SUPPORTED `Transaction.prove(provingProvider, costModel)`
 * seam (SPIKE-2 §D) with the Task 4 wasm/proxy proving provider; here it is a narrow
 * higher-level seam so the orchestration stays SDK-free and testable.
 */
export interface CeremonyProver {
  prove(unprovenTx: Uint8Array): Promise<Uint8Array>;
}

/**
 * Balance, sign, finalize, and SUBMIT the proven transaction, returning its on-chain
 * `txRef`. The real adapter (`createDevnetSubmitter`) uses the wallet-sdk facade
 * (`balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe` → `submitTransaction`)
 * over the Task 1 node WS relay (owner-gated; see `dev-ceremony-tx.ts`).
 */
export type TxSubmitter = (provenTx: Uint8Array) => Promise<{ readonly txRef: string }>;

/**
 * The injected seams a dev-wallet ceremony composes.
 *
 * NOTE (interface refinement vs the plan's DevCeremonyDeps sketch): `contractAddress`
 * is a first-class dep here — the `DepositTxBuilder` signature requires it and the
 * ceremony sources it from the `config.ts` chokepoint (never an env read), so it must
 * be injected rather than closed over. The selector (`ceremony-select.ts`) supplies it.
 */
export interface DevCeremonyDeps {
  /** The connected dev wallet's signer — the SIWE/account identity (diagnostics only). */
  readonly signer: DevSigner;
  /** Contract-circuit proving seam (Task 4 wasm-primary / proxy-fallback). */
  readonly prover: CeremonyProver;
  /** Unproven `deposit(ref, amount)` assembly seam. */
  readonly buildTx: DepositTxBuilder;
  /** Balance/sign/finalize/submit seam (funded wallet, node WS relay). */
  readonly submit: TxSubmitter;
  /** The NyxtVault contract address, from the `config.ts` chokepoint (`VITE_NYXT_VAULT_ADDRESS`). */
  readonly contractAddress: string;
}

/** Which ceremony leg failed — surfaced for diagnostics (the reducer needs only "it failed"). */
export type CeremonyStage = "build" | "prove" | "submit";

/**
 * A named ceremony failure. The top-up reducer maps ANY ceremony rejection to
 * `ceremony-rejected`, so the class exists for diagnostics/telemetry (which leg failed,
 * for which account) — NEVER to leak an SDK/proof-server internal into the UI. The
 * underlying `cause` is retained for logs only.
 */
export class DevCeremonyError extends Error {
  readonly stage: CeremonyStage;
  /** The depositor's account (bech32m) address — routes the diagnostic, never a secret. */
  readonly address: string;

  constructor(stage: CeremonyStage, address: string, cause: unknown) {
    super(`dev ceremony ${stage} failed`, { cause });
    this.name = "DevCeremonyError";
    this.stage = stage;
    this.address = address;
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────────

/**
 * Build a {@link DepositCeremony} from the injected seams. `runCeremony` pipes
 * build → prove → submit, wrapping each leg's failure in a stage-tagged
 * {@link DevCeremonyError} so a rejection is always the honest, never-a-false-pending
 * signal (and never resolves before submission).
 */
export function createDevWalletCeremony(deps: DevCeremonyDeps): DepositCeremony {
  return {
    async runCeremony(params: CeremonyParams): Promise<CeremonyResult> {
      // `amount` stays a bigint the entire way through — never coerced to a JS number.
      const { depositRef, amount } = params;
      const address = deps.signer.address;

      let unprovenTx: Uint8Array;
      try {
        ({ unprovenTx } = await deps.buildTx({
          depositRef,
          amount,
          contractAddress: deps.contractAddress,
        }));
      } catch (cause) {
        throw new DevCeremonyError("build", address, cause);
      }

      let provenTx: Uint8Array;
      try {
        provenTx = await deps.prover.prove(unprovenTx);
      } catch (cause) {
        throw new DevCeremonyError("prove", address, cause);
      }

      let txRef: string;
      try {
        ({ txRef } = await deps.submit(provenTx));
      } catch (cause) {
        throw new DevCeremonyError("submit", address, cause);
      }

      return { txRef };
    },
  };
}
