/**
 * The SDK boundary for the devnet deploy executor (P4 Task 2) — the ONE module that touches the
 * Midnight SDK, implementing the {@link DeploySdk} seam that `devnet-executor.ts` orchestrates.
 * Every SDK shape here traces to the verified `sdk-recipe.md` (constitution I — retrieval-sourced,
 * never memory); a bracketed `[recipe element N]` cites each.
 *
 * ⚠️ CONSTITUTION I — WHAT IS VERIFIED vs OWNER-GATED (recorded out loud, constitution VIII).
 * The recipe EXECUTED the whole-deploy `deployContract(providers, {...})` path live (element 1,
 * 2026-07-24, seed `…02` → a real contract address + `SucceedEntirely`) and the indexer finality
 * SIGNAL + query (element 4). It did NOT execute the LOWER-LEVEL build→prove→sign→submit SPLIT that
 * this seam's `buildDeploy`/`submit` shape implies — `createUnprovenDeployTxFromVerifierKeys` +
 * `submitDeployTx` are noted-as-existing but UN-executed, and P3's own web ceremony left the
 * equivalent `Transaction.prove` orchestration + the wallet facade (`signRecipe`/`finalizeRecipe`/
 * `submitTransaction`) OWNER-GATED for the same reason. Those two steps ALSO genuinely need a
 * FUNDED, DUST-registered deploy wallet — the P5-provided credential the brief pre-declares as
 * owner-gated. So, mirroring the reviewed `ledger/indexer-observation.ts` precedent (real GraphQL
 * transport + an owner-gated SDK decode seam), this adapter ships:
 *   - `queryFinality`: REAL, production code — the recipe-verified indexer `transactions(offset:
 *     { identifier })` poll [recipe element 4], raw GraphQL with an injectable `fetch`.
 *   - `buildDeploy` / `submit`: OWNER-GATED injectable seams that DEFAULT to throwing
 *     {@link DeploySdkNotWiredError} (an unwired adapter can never be mistaken for a working
 *     deploy). Each seam's contract encodes the exact verified recipe recipe so wiring it is a
 *     body-only change once the funded wallet + a devnet round-trip confirm the split primitives.
 *   The one verified, side-effect-light, wallet-free SDK call the build needs up front —
 *   `setNetworkId("undeployed")` [recipe element 1, LOWERCASE is load-bearing] — runs here.
 *
 * ⚠️ CONSTITUTION III / SC-031 — the `signingKey` reaching `buildDeploy`/`submit` is NEVER logged,
 * NEVER returned, and NEVER folded into an error here. `queryFinality` never receives it.
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { DeploySdk, FinalityQueryResult } from "./devnet-executor.js";

/**
 * Thrown by the OWNER-GATED `buildDeploy` / `submit` seams until the real Midnight-SDK split
 * (unproven-deploy build + wallet-facade sign/submit) is wired against a funded devnet wallet.
 * Deliberately unmistakable so a stubbed adapter can never read as a working deploy. The
 * orchestrator surfaces this as a `prove`/`signAndSubmit` FAILURE (data), never a crash.
 */
export class DeploySdkNotWiredError extends Error {
  constructor(step: string) {
    super(
      `owner-gated: real Midnight-SDK ${step} needs a funded+DUST-registered deploy wallet + a ` +
        "devnet round-trip to confirm the split primitives (createUnprovenDeployTxFromVerifierKeys " +
        "/ submitDeployTx / wallet facade) — see sdk-recipe.md elements 1-3",
    );
    this.name = "DeploySdkNotWiredError";
  }
}

/**
 * The OWNER-GATED unproven-deploy builder [recipe element 1]. Verified recipe to wire the body:
 *   const mod = await import(`${artifactDir}/contract/index.js`);   // materialize DeployFileSet first
 *   let cc = CompiledContract.make("<name>", mod.Contract);
 *   // providers: NodeZkConfigProvider(artifactDir) + wallet(coinPublicKey from signingKey) + …
 *   const unproven = createUnprovenDeployTxFromVerifierKeys(zkConfigProvider, coinPublicKey, options, encPublicKey); // d.ts:1267
 *   return { unprovenDeploy: unproven.serialize() };
 * It needs the funded wallet (coin public key) — hence owner-gated.
 */
export type BuildUnprovenDeploy = (input: {
  readonly files: Parameters<DeploySdk["buildDeploy"]>[0]["files"];
  readonly signingKey: string;
  readonly network: Parameters<DeploySdk["buildDeploy"]>[0]["network"];
}) => Promise<{ readonly unprovenDeploy: Uint8Array }>;

/**
 * The OWNER-GATED proven-deploy sign+submit [recipe element 3]. Verified recipe to wire the body:
 *   const signed    = await wallet.signRecipe(recipe, (p) => keystore.signData(p)); // BIP-340 Schnorr
 *   const finalized = await wallet.finalizeRecipe(signed);
 *   const txId      = await wallet.submitTransaction(finalized);   // node WS ws://…:9944 (NOT raw HTTP)
 *   return { txRef: txId };
 * A fee-wallet shortfall throws the EC-38 `Wallet.InsufficientFunds` FiberFailure — RE-THROW it
 * verbatim so the orchestrator's `isInsufficientTdust` classifies it. Needs the funded wallet.
 */
export type SubmitProvenDeploy = (input: {
  readonly provenDeploy: Uint8Array;
  readonly signingKey: string;
  readonly network: Parameters<DeploySdk["submit"]>[0]["network"];
}) => Promise<{ readonly txRef: string }>;

/** Options for {@link createDeploySdkAdapter}. All owner-gated seams default to throwing. */
export interface DeploySdkAdapterDeps {
  /** Injectable `fetch` for the finality GraphQL transport; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** OWNER-GATED unproven-deploy build; omitted → {@link DeploySdkNotWiredError}. */
  readonly buildUnprovenDeploy?: BuildUnprovenDeploy;
  /** OWNER-GATED proven-deploy sign+submit; omitted → {@link DeploySdkNotWiredError}. */
  readonly submitProvenDeploy?: SubmitProvenDeploy;
}

/** The indexer GraphQL path on the devnet indexer (`:8088`) [recipe verified: `/api/v4/graphql`]. */
export const INDEXER_GRAPHQL_PATH = "/api/v4/graphql";

/** Resolve a base indexer URL to its GraphQL endpoint (append the path when absent). */
function graphqlEndpoint(indexerUrl: string): string {
  const trimmed = indexerUrl.replace(/\/+$/, "");
  return trimmed.endsWith(INDEXER_GRAPHQL_PATH) ? trimmed : `${trimmed}${INDEXER_GRAPHQL_PATH}`;
}

/**
 * The finality GraphQL query [recipe element 4]. `watchForTxData(txId)` polls
 * `transactions(offset: { identifier: $id })` and maps `transactionResult` → `status` plus the
 * block fields; for a DEPLOY the created contract address is the deploy's `contractAction.address`.
 * A tx VISIBLE via the indexer is in a GRANDPA-finalized block (element 4 — the indexer never
 * ingests a non-finalized block), so "present" IS "finalized past reorg depth" (SC-029).
 *
 * SCHEMA VERIFIED LIVE (P4 Task 2, indexer `4.2.1`, `/api/v4/graphql`, introspected 2026-07-24 —
 * NOT from memory): `Transaction` is an INTERFACE (`RegularTransaction` | `SystemTransaction`), so
 * `transactionResult` — present only on `RegularTransaction` — needs an inline fragment; the
 * `TransactionResultStatus` enum is {@link TX_STATUS} `SUCCESS`/`PARTIAL_SUCCESS`/`FAILURE` (the raw
 * indexer enum — the SDK's `TxStatus` `SucceedEntirely`/… is its OWN mapped layer, not the wire
 * value). `TransactionOffset` accepts `identifier` (the submitted tx id) or `hash`; `contractActions`
 * is on the interface, each action carrying `address`.
 */
const TX_FINALITY_QUERY = `
  query TxFinality($id: HexEncoded!) {
    transactions(offset: { identifier: $id }) {
      hash
      block { height hash }
      contractActions { address }
      ... on RegularTransaction {
        transactionResult { status }
      }
    }
  }
`;

/** The raw indexer `TransactionResultStatus` enum values (introspected live, not memory). */
const TX_STATUS = {
  success: "SUCCESS",
  partialSuccess: "PARTIAL_SUCCESS",
  failure: "FAILURE",
} as const;

/** The subset of the `transactions` response the adapter reads [recipe element 4 mapped fields]. */
interface TxFinalityEnvelope {
  readonly data?: {
    readonly transactions?: readonly {
      readonly hash?: string;
      readonly transactionResult?: { readonly status?: string } | null;
      readonly block?: { readonly height?: number } | null;
      readonly contractActions?: readonly { readonly address?: string }[] | null;
    }[];
  };
  readonly errors?: readonly { readonly message?: string }[];
}

/** The indexer was unreachable or returned a malformed / error GraphQL response. */
export class DeployIndexerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeployIndexerUnavailableError";
  }
}

/**
 * Build the real {@link DeploySdk} adapter. `queryFinality` is production code (verified indexer
 * transport); `buildDeploy`/`submit` are owner-gated seams (default-throw). Constructed with no
 * args by `devnet-executor.ts`'s lazy default; the owner injects the two seams + real deps once the
 * funded wallet lands.
 */
export function createDeploySdkAdapter(deps: DeploySdkAdapterDeps = {}): DeploySdk {
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  async function queryFinality(input: {
    readonly txRef: string;
    readonly network: Parameters<DeploySdk["queryFinality"]>[0]["network"];
  }): Promise<FinalityQueryResult> {
    const endpoint = graphqlEndpoint(input.network.indexerUrl);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: TX_FINALITY_QUERY, variables: { id: input.txRef } }),
      });
    } catch (error) {
      throw new DeployIndexerUnavailableError(`indexer unreachable: ${endpoint}`, { cause: error });
    }
    if (!response.ok) {
      throw new DeployIndexerUnavailableError(`indexer returned HTTP ${String(response.status)}`);
    }
    let envelope: TxFinalityEnvelope;
    try {
      envelope = (await response.json()) as TxFinalityEnvelope;
    } catch (error) {
      throw new DeployIndexerUnavailableError("indexer returned a non-JSON response", {
        cause: error,
      });
    }
    if (envelope.errors !== undefined && envelope.errors.length > 0) {
      const message = envelope.errors.map((e) => e.message ?? "unknown").join("; ");
      throw new DeployIndexerUnavailableError(`indexer GraphQL error: ${message}`);
    }

    const rows = envelope.data?.transactions ?? [];
    const tx = rows[0];
    if (tx === undefined) {
      // Not yet visible via the indexer → not yet finalized. Keep polling (the orchestrator bounds it).
      return { status: "pending" };
    }
    const status = tx.transactionResult?.status;
    if (status !== TX_STATUS.success) {
      // PARTIAL_SUCCESS / FAILURE (or a SystemTransaction with no result) — a finalized on-chain
      // NON-success; only full SUCCESS yields a contract address (finality-exactly-once).
      return { status: "failed", reason: status ?? "unknown-tx-status" };
    }
    // A DEPLOY's created contract address is its `contractAction.address` (recipe element 4). The
    // exact subfield selection is confirmed by the owner-gated devnet round-trip; if a finalized
    // deploy tx surfaces without it, surface owner-gated rather than a phantom empty address.
    const address = tx.contractActions?.find((a) => a.address !== undefined)?.address;
    if (address === undefined || address === "") {
      throw new DeploySdkNotWiredError(
        "finalized-deploy address extraction (confirm the transactions.contractActions.address " +
          "subfield against the live indexer schema)",
      );
    }
    return { status: "finalized", address };
  }

  return {
    buildDeploy: (input) => {
      // [recipe element 1] setNetworkId FIRST, LOWERCASE — a capitalized id → node reject
      // 1010/Custom 166 (SPIKE-1 risk 7). Verified, wallet-free, side-effect-light.
      setNetworkId("undeployed");
      if (deps.buildUnprovenDeploy === undefined) {
        return Promise.reject(new DeploySdkNotWiredError("unproven-deploy build"));
      }
      return deps.buildUnprovenDeploy(input);
    },
    submit: (input) => {
      if (deps.submitProvenDeploy === undefined) {
        return Promise.reject(new DeploySdkNotWiredError("proven-deploy sign+submit"));
      }
      return deps.submitProvenDeploy(input);
    },
    queryFinality,
  };
}
