/**
 * Dev wallet deposit-ceremony TX ADAPTER (P3 Task 5, Step 5) — the SDK boundary.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ VERIFIED TX RECIPE (constitution I — EXECUTED, devnet-accepted; NOT memory)  │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │ Provenance: SPIKE2_REPORT.md (docs/superpowers/plans/retros/), executed      │
 * │ 2026-07-23 against the shared local devnet (node midnight-node:0.22.5, chain │
 * │ `undeployed1`; indexer 4.2.1; proof-server 8.1.0). A NyxtVault               │
 * │ `deposit(ref, amount)` tx built this way was accepted + finalized twice      │
 * │ (blocks 218 / 258, `SucceedEntirely`, `deposits.lookup(ref)` confirmed).     │
 * │                                                                              │
 * │ Pinned matrix (SPIKE-2 verdict / risk 2; the load-bearing constraint):       │
 * │   compact 0.31.1 (ir-source[v2], runtime 0.16.0) · @midnight-ntwrk/ledger-v8 │
 * │   8.1.0 · zkir-v2 2.1.0 · midnight-js-* 4.1.1 · wallet-sdk 1.1.0             │
 * │   (via testkit-js 4.1.1, which declares it EXACT) · node 0.22.5 / proof 8.1.0│
 * │                                                                              │
 * │ 1. NETWORK ID: setNetworkId('undeployed') — LOWERCASE. Capitalized is a node │
 * │    rejection (1010 / Custom 166). This is the TX-ENCODING id and is distinct │
 * │    from the web connector gate's EXPECTED_NETWORK_ID ("Undeployed", the Lace │
 * │    DISPLAY value at config.ts) — the two MUST NOT be conflated. See           │
 * │    {@link DEV_TX_NETWORK_ID}.                                                 │
 * │ 2. ASSEMBLE (unproven): midnight-js-contracts builds a                       │
 * │    Transaction<SignatureEnabled, PreProof, PreBinding> from a                │
 * │    ContractCallPrototype (transcripts + input/output alignments + comm-      │
 * │    commitment randomness) via Transaction.fromPartsRandomized(networkId, …). │
 * │    The call target is the NyxtVault `deposit(depositRef: Bytes<32>,          │
 * │    amount: Uint<128>)` guaranteed-phase circuit (ref = 32-byte hex).         │
 * │ 3. PROVE (contract circuit): tx.prove(provingProvider,                       │
 * │    CostModel.initialCostModel()) — ledger-v8's SUPPORTED seam. The           │
 * │    provingProvider is the Task 4 factory (createWasmCeremonyProver PRIMARY /  │
 * │    createProxyCeremonyProver FALLBACK) over a same-origin key source. There  │
 * │    is NO lower-level "splice proof bytes into a tx" API — the callback IS the │
 * │    interface. ~23–26 s at k=13 (run in a Web Worker; prefetch key material). │
 * │ 4. BALANCE / SIGN / FINALIZE (wallet-sdk facade):                            │
 * │    balanceUnboundTransaction (adds NIGHT inputs for the contract's           │
 * │    receiveUnshielded claim + the DUST fee spend) → signRecipe (BIP-340       │
 * │    Schnorr over the unshielded intents, via the unshielded keystore's        │
 * │    signData callback) → finalizeRecipe (proves the WALLET legs — the DUST    │
 * │    fee proof is produced by the wallet's configured prover, pointed at the   │
 * │    same-origin /prover/* proxy — and binds) → FinalizedTransaction.          │
 * │ 5. SUBMIT: wallet.submitTransaction(finalizedTx). ⚠️ WS-RELAY NECESSITY —    │
 * │    the wallet SDK submits over the NODE WS transport (ws://…:9944), NOT a     │
 * │    plain HTTP POST. Under COOP/COEP the isolated page reaches it same-origin  │
 * │    through the Task 1 WS relay (GET-upgrade on /devnet/node/*), and wallet    │
 * │    sync rides the indexer WS (/devnet/indexer/…/graphql/ws). So a raw HTTP    │
 * │    byte-forward of proven bytes is INSUFFICIENT; the funded wallet must be    │
 * │    constructed against the same-origin WS relay URL. (Task 1 escape-hatch    │
 * │    evidence point — recorded in the Task 5 report.)                          │
 * │ 6. OBSERVE finality: indexer watchForTxData(txId) / contractAction(address)  │
 * │    GraphQL — the txRef this adapter returns; the on-chain credit is observed  │
 * │    LATER by the server's indexer→observation adapter, never here.            │
 * │                                                                              │
 * │ FUNDING PREREQ (SPIKE-2 §Funding / risk 4): the funded wallet must be        │
 * │ NIGHT-funded + DUST-registered BEFORE the first ceremony (transfer NIGHT →   │
 * │ registerNightUtxosForDustGeneration with zero DUST held → ~12 s accrual).     │
 * │ Genesis seeds 0x…01–0x…04 are pre-registered. That is P5's funding phase /    │
 * │ the spike fixture — NOT this adapter's concern. Serialize submissions        │
 * │ per-wallet (risk 7 — see ceremony-select.ts).                                │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ OWNER-GATED (like `createOwnerGatedCeremony`, topup.tsx): the recipe's SDK legs
 * need `@midnight-ntwrk/midnight-js-contracts@4.1.1` + `@midnight-ntwrk/wallet-sdk@1.1.0`,
 * which are NOT installed in `apps/web` (only ledger-v8 / zkir-v2 / wallet-sdk-address-format
 * / dapp-connector-api are). Per constitution I ("read the installed `.d.ts` of every
 * package the recipe names; DO NOT write bodies before that"), the SDK bodies are NOT
 * hand-written from the report — the factories below construct + validate their inputs
 * but THROW a clear owner-gated error at the SDK call, so they can never be mistaken for a
 * working implementation. The `DEVNET_URL`-gated integration test drives the real path
 * once the packages + a funded wallet + a deployed vault are present; every unit test
 * injects fakes for these seams. Wiring the real bodies = add the two packages, read their
 * `.d.ts`, then replace each `notImplemented(...)` with the numbered step above.
 */
import type { CeremonyProver, DepositTxBuilder, TxSubmitter } from "./dev-ceremony";
import type { CeremonyProverFactory, CircuitKeySource } from "./ceremony-prover";
import type { DevSigner } from "./dev-signer";

/**
 * The TX-ENCODING network id (SPIKE-2 step 1) — LOWERCASE `undeployed`. Capitalized is a
 * node rejection (1010 / Custom 166). Deliberately distinct from the connector gate's
 * `EXPECTED_NETWORK_ID` ("Undeployed", the Lace display value) — never conflate them.
 */
export const DEV_TX_NETWORK_ID = "undeployed";

/** The NyxtVault circuit this ceremony calls (`nyxt-vault.compact` `export circuit deposit`). */
export const DEPOSIT_CIRCUIT_ID = "deposit";

/** Message every owner-gated SDK leg rejects with — honest, never a fake success. */
const OWNER_GATED_MESSAGE =
  "dev-ceremony-tx is owner-gated: install @midnight-ntwrk/midnight-js-contracts@4.1.1 + " +
  "@midnight-ntwrk/wallet-sdk@1.1.0, verify their .d.ts, then wire the SPIKE-2 recipe " +
  "(see the recipe comment at the top of dev-ceremony-tx.ts). Inject a real seam meanwhile.";

/** Reject an owner-gated SDK leg by name (mirrors `dev-wallet.ts`'s `notImplemented`). */
function ownerGated(leg: string): Promise<never> {
  return Promise.reject(new Error(`${leg}: ${OWNER_GATED_MESSAGE}`));
}

/** Options for {@link createDepositTxBuilder} — the unproven-tx assembly leg (step 2). */
export interface DepositTxBuilderOptions {
  /**
   * The funded wallet's signer identity. NOTE the two-derivation caveat (SPIKE-2 risk 6):
   * the wallet-sdk keystore that funds + signs the unshielded intents is derived from the
   * FUNDED wallet's seed, which is NOT the same derivation as the {@link DevSigner}'s
   * ledger-v8 sample key unless P5 constructs the keystore from that same key. The deposit
   * is attributed by its `depositRef` regardless (off-chain channel), so a mismatch is
   * safe for crediting but WILL fail balancing if the signer can't sign the funded UTXOs.
   * Recorded in the Task 5 report; execution-confirmed only against a real devnet.
   */
  readonly signer: DevSigner;
  /** TX-encoding network id; defaults to {@link DEV_TX_NETWORK_ID} (lowercase). */
  readonly networkId?: string;
}

/**
 * Build the unproven-`deposit(ref, amount)` assembly seam (recipe step 2). Owner-gated:
 * assembling a `ContractCallPrototype` → `Transaction.fromPartsRandomized` needs
 * `midnight-js-contracts@4.1.1` (not installed). The returned builder validates the ref
 * shape (32-byte hex, matching the contract's `Bytes<32>` / `DEPOSIT_REF_BYTES`) so a
 * malformed ref fails loudly BEFORE the SDK boundary, then rejects owner-gated.
 */
export function createDepositTxBuilder(options: DepositTxBuilderOptions): DepositTxBuilder {
  const networkId = options.networkId ?? DEV_TX_NETWORK_ID;
  void networkId; // consumed by the (owner-gated) Transaction.fromPartsRandomized(networkId, …)
  void options.signer;

  return (params) => {
    if (!/^[0-9a-fA-F]{64}$/.test(params.depositRef)) {
      return Promise.reject(
        new Error("dev-ceremony-tx: depositRef must be 32 bytes (64 hex chars) for Bytes<32>"),
      );
    }
    if (params.contractAddress.length === 0) {
      return Promise.reject(new Error("dev-ceremony-tx: NyxtVault contract address is not set"));
    }
    // amount stays a bigint (Uint<128> on-chain); the assembly leg encodes it. Never Number().
    return ownerGated("deposit tx assembly (ContractCallPrototype/fromPartsRandomized)");
  };
}

/** Options for {@link createTxCeremonyProver} — the contract-circuit proving leg (step 3). */
export interface TxCeremonyProverOptions {
  /** The Task 4 proving-provider factory (wasm PRIMARY or proxy FALLBACK). */
  readonly proverFactory: CeremonyProverFactory;
  /** The same-origin circuit key source (`{proverKey, verifierKey, ir}` + SRS per circuit). */
  readonly keySource: CircuitKeySource;
}

/**
 * Build the contract-circuit prover seam (recipe step 3): deserialize the unproven tx,
 * drive `Transaction.prove(proverFactory.makeProvingProvider(keySource), CostModel.initialCostModel())`,
 * reserialize the proven tx. Owner-gated: the `Transaction.prove` orchestration over the
 * real key material + wasm engine is the ~23–26 s live prove exercised only under
 * `DEVNET_URL`. The factory + key source are typed here to pin the intended composition.
 */
export function createTxCeremonyProver(options: TxCeremonyProverOptions): CeremonyProver {
  void options.proverFactory;
  void options.keySource;
  return {
    prove: () => ownerGated("contract-circuit prove (Transaction.prove over the zkir provider)"),
  };
}

/** Options for {@link createDevnetSubmitter} — the balance/sign/finalize/submit leg (steps 4–5). */
export interface DevnetSubmitterOptions {
  /**
   * Same-origin base for the Task 1 forwarding routes; defaults to `""` (relative). The
   * funded wallet is constructed against the WS relay at `<baseUrl>/devnet/node/*` (submit)
   * and `<baseUrl>/devnet/indexer/*` (sync) — NEVER a direct devnet URL from the isolated
   * page. A trailing slash is normalized away.
   */
  readonly baseUrl?: string;
  /** `fetch` implementation; defaults to `globalThis.fetch` (used for the HTTP legs). */
  readonly fetch?: typeof fetch;
}

/**
 * Build the submit seam (recipe steps 4–5): balance → sign → finalize → submit the proven
 * tx over the Task 1 node WS relay, returning its `txRef`. Owner-gated: the wallet-sdk
 * facade (`balanceUnboundTransaction` / `signRecipe` / `finalizeRecipe` / `submitTransaction`)
 * needs `wallet-sdk@1.1.0` (not installed). ⚠️ Submission is a WS transport, not an HTTP
 * POST — this is the Task 1 WS-relay escape-hatch evidence point (see the recipe comment).
 */
export function createDevnetSubmitter(options: DevnetSubmitterOptions = {}): TxSubmitter {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  void baseUrl;
  void fetchImpl;
  return () =>
    ownerGated("deposit submit (wallet-sdk balance/sign/finalize/submit over the node WS relay)");
}
