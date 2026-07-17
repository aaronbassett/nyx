import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  type TokenType,
} from "@midnight-ntwrk/compact-runtime";

import { Contract, ledger, type Ledger } from "../build/nyxt-vault/contract/index.js";
import { nyxtVaultWitnesses, type NyxtVaultPrivateState } from "../src/witnesses.js";

// A deterministic caller coin public key. NyxtVault never authorizes on caller
// identity (it uses the witness-secret authority), so any fixed value works; a
// fixed value keeps derived token colors deterministic.
const COIN_PUBLIC_KEY = "0".repeat(64);

// A fixed deployment address keeps the derived NYXT token color deterministic.
const CONTRACT_ADDRESS = dummyContractAddress();

// nativeToken() (tNIGHT) is the all-zero unshielded token color.
const NATIVE_TOKEN_RAW = "0".repeat(64);

/**
 * The default orchestrator secret. The contract pins `deriveOrchestratorAuthority`
 * of this at construction, so a simulator built with it (the default) can burn.
 * A distinct 32-byte pattern makes it obvious in traces.
 */
export const DEFAULT_ORCHESTRATOR_SECRET: Uint8Array = new Uint8Array(32).fill(0x11);

/** An all-zero 32-byte "secret" — models a prover holding NO valid authorization. */
export const ABSENT_ORCHESTRATOR_SECRET: Uint8Array = new Uint8Array(32);

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

/**
 * The token effects a single `burn` produces. The burn `sendUnshielded`s NYXT to
 * the all-zero UserAddress, which registers as an unshielded OUTPUT — the vault's
 * net balance falls by exactly this amount.
 */
export interface BurnEffects {
  /** NYXT removed from the vault — `effects.unshieldedOutputs[NYXT color]`. */
  readonly nyxtBurned: bigint;
  /** The derived NYXT token color (raw 32-byte hex). */
  readonly nyxtColor: string;
}

/** Options for a `burn` call in the simulator. */
export interface BurnOptions {
  /**
   * The secret the prover's witness returns for THIS call. Defaults to the secret
   * the simulator was constructed with (the authorized orchestrator). Pass a
   * different value to model an unauthorized caller.
   */
  readonly proverSecret?: Uint8Array;
  /**
   * The vault's NYXT balance at the start of this transaction (what the on-chain
   * persistent balance would be after prior deposits). The balance guard reads
   * `kernel.balance` — the runtime does not carry intra-call self-mints into a
   * later call's start balance, so a burn test seeds it explicitly. Defaults to 0.
   */
  readonly vaultNyxtBalance?: bigint;
}

type CircuitStateArg = Parameters<typeof createCircuitContext>[2];
type LedgerStateArg = Parameters<typeof ledger>[0];

/**
 * The NYXT token color, memoized. It is a pure function of the domain separator and
 * the (fixed) contract address, so a single throwaway deposit on a fresh contract
 * discovers it without touching any live test state.
 */
let cachedNyxtColor: string | undefined;
function nyxtColor(): string {
  if (cachedNyxtColor !== undefined) return cachedNyxtColor;
  const contract = new Contract<NyxtVaultPrivateState>(nyxtVaultWitnesses);
  const init = contract.initialState(
    createConstructorContext<NyxtVaultPrivateState>(
      { orchestratorSecretKey: DEFAULT_ORCHESTRATOR_SECRET },
      COIN_PUBLIC_KEY,
    ),
  );
  const context = createCircuitContext<NyxtVaultPrivateState>(
    CONTRACT_ADDRESS,
    COIN_PUBLIC_KEY,
    init.currentContractState,
    { orchestratorSecretKey: DEFAULT_ORCHESTRATOR_SECRET },
  );
  const result = contract.circuits.deposit(context, ref("__color_probe__"), 1n);
  for (const [tokenType] of result.context.currentQueryContext.effects.unshieldedInputs) {
    if (tokenType.tag === "unshielded" && tokenType.raw !== NATIVE_TOKEN_RAW) {
      cachedNyxtColor = tokenType.raw;
    }
  }
  if (cachedNyxtColor === undefined) {
    throw new Error("nyxt-vault-simulator: could not determine the NYXT token color");
  }
  return cachedNyxtColor;
}

/** The NYXT token color for the simulator's fixed contract address (raw 32-byte hex). */
export function nyxtTokenColor(): string {
  return nyxtColor();
}

/**
 * Self-contained, in-process driver for NyxtVault over @midnight-ntwrk/compact-runtime.
 *
 * The OpenZeppelin `contracts-simulator` package is not published to public npm, so
 * this hand-rolled harness plays the same role: it threads the CircuitContext across
 * calls, exposes the decoded ledger, and surfaces the token effects. It is fully
 * deterministic and touches no chain, node, or devnet.
 *
 * Construct a fresh instance per test. The orchestrator secret passed to the
 * constructor is pinned (hashed) into `orchestratorAuthority` at deploy; only a
 * `burn` whose prover supplies that same secret is authorized. A failing `assert`
 * in a circuit throws (message: "failed assert: <text>") and leaves the retained
 * state untouched, so a rejected call does not corrupt subsequent assertions.
 */
export class NyxtVaultSimulator {
  private readonly contract: Contract<NyxtVaultPrivateState>;
  private readonly orchestratorSecret: Uint8Array;
  private state: CircuitStateArg;

  constructor(orchestratorSecret: Uint8Array = DEFAULT_ORCHESTRATOR_SECRET) {
    this.orchestratorSecret = orchestratorSecret;
    this.contract = new Contract<NyxtVaultPrivateState>(nyxtVaultWitnesses);
    const init = this.contract.initialState(
      createConstructorContext<NyxtVaultPrivateState>(
        { orchestratorSecretKey: orchestratorSecret },
        COIN_PUBLIC_KEY,
      ),
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

  private context(privateSecret: Uint8Array, vaultNyxtBalance?: bigint) {
    const context = createCircuitContext<NyxtVaultPrivateState>(
      CONTRACT_ADDRESS,
      COIN_PUBLIC_KEY,
      this.state,
      { orchestratorSecretKey: privateSecret },
    );
    if (vaultNyxtBalance !== undefined) {
      const qc = context.currentQueryContext;
      const balance = new Map<TokenType, bigint>([
        [{ tag: "unshielded", raw: nyxtColor() }, vaultNyxtBalance],
      ]);
      qc.block = { ...qc.block, balance };
    }
    return context;
  }

  /**
   * Run `deposit(depositRef, amount)`. On success the evolved state is retained so
   * the next call chains from it; on a failed assert this throws before the state is
   * updated. `deposit` does not read private state, but a valid secret is threaded
   * for consistency.
   */
  public deposit(depositRef: Uint8Array, amount: bigint): DepositEffects {
    const context = this.context(this.orchestratorSecret);
    const result = this.contract.circuits.deposit(context, depositRef, amount);
    this.state = result.context.currentQueryContext.state;

    const effects = result.context.currentQueryContext.effects;
    let tnightReceived = 0n;
    let nyxtVaultCredited = 0n;
    let color = "";
    // Only unshielded token types (native tNIGHT + NYXT) appear as inputs here;
    // narrow the TokenType union to read the raw color.
    for (const [tokenType, value] of effects.unshieldedInputs) {
      if (tokenType.tag !== "unshielded") continue;
      if (tokenType.raw === NATIVE_TOKEN_RAW) {
        tnightReceived = value;
      } else {
        nyxtVaultCredited = value;
        color = tokenType.raw;
      }
    }

    return {
      nyxtMinted: effects.unshieldedMints.get(NYXT_DOMAIN_SEP_HEX) ?? 0n,
      tnightReceived,
      nyxtVaultCredited,
      nyxtColor: color,
    };
  }

  /**
   * Run `burn(amount, watermark)`. On success the evolved state is retained; on a
   * failed assert (unauthorized, duplicate watermark, zero amount, or over-balance)
   * this throws before the state is updated.
   */
  public burn(amount: bigint, watermark: Uint8Array, options: BurnOptions = {}): BurnEffects {
    const secret = options.proverSecret ?? this.orchestratorSecret;
    const context = this.context(secret, options.vaultNyxtBalance);
    const result = this.contract.circuits.burn(context, amount, watermark);
    this.state = result.context.currentQueryContext.state;

    const color = nyxtColor();
    let nyxtBurned = 0n;
    for (const [tokenType, value] of result.context.currentQueryContext.effects.unshieldedOutputs) {
      if (tokenType.tag === "unshielded" && tokenType.raw === color) {
        nyxtBurned = value;
      }
    }
    return { nyxtBurned, nyxtColor: color };
  }
}

/** A deterministic 32-byte depositRef / watermark derived from a label. */
export function ref(label: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(label, "utf8").copy(buf);
  return new Uint8Array(buf);
}
