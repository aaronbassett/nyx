import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import { Contract, ledger, type Ledger } from "../build/nyxt-vault/contract/index.js";
import { nyxtVaultWitnesses, type NyxtVaultPrivateState } from "../src/witnesses.js";

// A deterministic caller coin public key. NyxtVault does not use caller identity,
// so any fixed value works; a fixed value keeps derived token colors deterministic.
const COIN_PUBLIC_KEY = "0".repeat(64);

// A fixed deployment address keeps the derived NYXT token color deterministic.
const CONTRACT_ADDRESS = dummyContractAddress();

// nativeToken() (tNIGHT) is the all-zero unshielded token color.
const NATIVE_TOKEN_RAW = "0".repeat(64);

/**
 * The NYXT domain separator: the ASCII bytes of "nyx:nyxt:v1" right-padded to 32
 * bytes and hex-encoded — exactly how the contract's `pad(32, "nyx:nyxt:v1")`
 * renders, and the key under which the mint appears in `effects.unshieldedMints`.
 */
export const NYXT_DOMAIN_SEP_HEX: string = ((): string => {
  const buf = Buffer.alloc(32);
  Buffer.from("nyx:nyxt:v1", "utf8").copy(buf);
  return buf.toString("hex");
})();

/**
 * The token effects a single `deposit` produces, as they would appear on-chain and
 * to the indexer. These are what let the suite assert "the mint credits the vault"
 * deterministically and in-process.
 */
export interface DepositEffects {
  /** NYXT created in this call — `effects.unshieldedMints[NYXT_DOMAIN_SEP_HEX]`. */
  readonly nyxtMinted: bigint;
  /** tNIGHT the contract claims as an input (funded by the wallet on-chain). */
  readonly tnightReceived: bigint;
  /** NYXT credited to the vault — the self-mint registers this unshielded input. */
  readonly nyxtVaultCredited: bigint;
  /** The derived NYXT token color (raw 32-byte hex). */
  readonly nyxtColor: string;
}

type CircuitStateArg = Parameters<typeof createCircuitContext>[2];
type LedgerStateArg = Parameters<typeof ledger>[0];

/**
 * Self-contained, in-process driver for NyxtVault over @midnight-ntwrk/compact-runtime.
 *
 * The OpenZeppelin `contracts-simulator` package is not published to public npm, so
 * this hand-rolled harness plays the same role: it threads the CircuitContext across
 * calls, exposes the decoded ledger, and surfaces the token effects. It is fully
 * deterministic and touches no chain, node, or devnet.
 *
 * Construct a fresh instance per test. A failing `assert` in a circuit throws
 * (message: "failed assert: <text>") and leaves the retained state untouched, so a
 * rejected deposit does not corrupt subsequent assertions.
 */
export class NyxtVaultSimulator {
  private readonly contract: Contract<NyxtVaultPrivateState>;
  private state: CircuitStateArg;

  constructor() {
    this.contract = new Contract<NyxtVaultPrivateState>(nyxtVaultWitnesses);
    const init = this.contract.initialState(
      createConstructorContext<NyxtVaultPrivateState>({}, COIN_PUBLIC_KEY),
    );
    this.state = init.currentContractState;
  }

  /** The current decoded public ledger. */
  public ledger(): Ledger {
    // `initialState` yields a ContractState (ledger at `.data`); a circuit result
    // yields a ChargedState directly. `.data ?? state` accepts both.
    const container = this.state as unknown as { readonly data?: LedgerStateArg };
    const stateValue: LedgerStateArg = container.data ?? (this.state as LedgerStateArg);
    return ledger(stateValue);
  }

  /**
   * Run `deposit(depositRef, amount)`. On success the evolved state is retained so
   * the next call chains from it; on a failed assert this throws before the state is
   * updated.
   */
  public deposit(depositRef: Uint8Array, amount: bigint): DepositEffects {
    const context = createCircuitContext<NyxtVaultPrivateState>(
      CONTRACT_ADDRESS,
      COIN_PUBLIC_KEY,
      this.state,
      {},
    );
    const result = this.contract.circuits.deposit(context, depositRef, amount);
    this.state = result.context.currentQueryContext.state;

    const effects = result.context.currentQueryContext.effects;
    let tnightReceived = 0n;
    let nyxtVaultCredited = 0n;
    let nyxtColor = "";
    // Only unshielded token types (native tNIGHT + NYXT) appear as inputs here;
    // narrow the TokenType union to read the raw color.
    for (const [tokenType, value] of effects.unshieldedInputs) {
      if (tokenType.tag !== "unshielded") continue;
      if (tokenType.raw === NATIVE_TOKEN_RAW) {
        tnightReceived = value;
      } else {
        nyxtVaultCredited = value;
        nyxtColor = tokenType.raw;
      }
    }

    return {
      nyxtMinted: effects.unshieldedMints.get(NYXT_DOMAIN_SEP_HEX) ?? 0n,
      tnightReceived,
      nyxtVaultCredited,
      nyxtColor,
    };
  }
}

/** A deterministic 32-byte depositRef derived from a label. */
export function ref(label: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(label, "utf8").copy(buf);
  return new Uint8Array(buf);
}
