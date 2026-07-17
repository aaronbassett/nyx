import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";

import type { Ledger, Witnesses } from "../build/nyxt-vault/contract/index.js";

/**
 * NyxtVault's only witness is `orchestratorSecret`, which supplies the platform
 * orchestrator's private 32-byte secret from local private state.
 *
 * The secret NEVER leaves the prover: at construction the contract pins only a
 * domain-separated hash of it (`orchestratorAuthority`) into public ledger state,
 * and `burn` re-derives that hash from this witness inside the ZK circuit to gate
 * the call. Whoever holds the secret whose hash was pinned is the orchestrator; a
 * forged secret hashes differently and the burn assertion rejects it. This is the
 * proven "witness-secret" authorization pattern — there is no trustworthy
 * `msg.sender` in Compact, so identity must be re-established inside the circuit.
 *
 * `deposit` declares no witness and does not read private state; only construction
 * and `burn` invoke `orchestratorSecret`.
 *
 * ⚠️ SECRET-STRENGTH GUARD (security review M1). The on-chain authority is an UNSALTED,
 * PUBLIC hash of this secret, so the entire "orchestrator-only" guarantee reduces to the
 * secret's confidentiality + entropy: a weak or defaulted secret makes the commitment
 * offline-reproducible and `burn` universally bypassable. The witness therefore rejects an
 * all-zero secret (the value a default/uninitialised `Uint8Array(32)` would carry) as well as
 * a wrong length. The operational secret MUST be CSPRNG-generated and, ideally, DISTINCT per
 * deployment (a distinct per-deploy secret also makes each deployment's commitment unique,
 * neutralising the cross-deploy linkability the reviewer noted for the shared-secret case).
 */
export interface NyxtVaultPrivateState {
  /** The orchestrator's private 32-byte secret. Its hash is the on-chain authority. */
  readonly orchestratorSecretKey: Uint8Array;
}

export const nyxtVaultWitnesses: Witnesses<NyxtVaultPrivateState> = {
  orchestratorSecret: ({
    privateState,
  }: WitnessContext<Ledger, NyxtVaultPrivateState>): [
    NyxtVaultPrivateState,
    { bytes: Uint8Array },
  ] => {
    const secret = privateState.orchestratorSecretKey;
    if (!(secret instanceof Uint8Array) || secret.length !== 32) {
      throw new Error(
        "orchestratorSecret: orchestratorSecretKey is missing or not exactly 32 bytes",
      );
    }
    // Reject the all-zero secret (a default/uninitialised private state): its hash is a known
    // public preimage, so accepting it would make `burn` bypassable by anyone (review M1).
    if (secret.every((b) => b === 0)) {
      throw new Error(
        "orchestratorSecret: refusing all-zero/default secret (weak-key guard) — use a CSPRNG-generated 32-byte secret",
      );
    }
    // Return the private state unchanged (the witness is a pure read) alongside the
    // secret the circuit derives the authority commitment from.
    return [privateState, { bytes: secret }];
  },
};
