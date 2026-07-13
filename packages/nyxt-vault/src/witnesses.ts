import type { Witnesses } from "../build/nyxt-vault/contract/index.js";

/**
 * NyxtVault declares **no witnesses**: `deposit` takes only public parameters
 * (`depositRef`, `amount`) and needs no off-chain private data. There is likewise
 * no private state.
 *
 * `NyxtVaultPrivateState` is the empty object type, and `nyxtVaultWitnesses` is the
 * empty witness set. The explicit `Witnesses<NyxtVaultPrivateState>` annotation is
 * a compile-time conformance check against the compiler-generated interface — if a
 * future circuit ever adds a `witness` declaration, this assignment stops compiling
 * until the implementation is supplied.
 */
export type NyxtVaultPrivateState = Record<string, never>;

export const nyxtVaultWitnesses: Witnesses<NyxtVaultPrivateState> = {};
