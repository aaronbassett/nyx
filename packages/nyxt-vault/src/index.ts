// @nyx/nyxt-vault — public API surface for the NyxtVault Compact contract (US6, D45).
//
// Source of truth: src/nyxt-vault.compact. `pnpm compact:build` runs the Compact
// compiler, which generates the TypeScript contract into build/nyxt-vault/. This
// barrel re-exports the compiled contract together with its (empty) witness set so
// the orchestrator can construct the contract and decode its ledger state without
// reaching into the build directory.

export { Contract, ledger, pureCircuits } from "../build/nyxt-vault/contract/index.js";
export type {
  Circuits,
  ImpureCircuits,
  Ledger,
  Witnesses,
} from "../build/nyxt-vault/contract/index.js";

export { nyxtVaultWitnesses, type NyxtVaultPrivateState } from "./witnesses.js";
