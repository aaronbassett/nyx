// Assembles the midnight-js provider suite and drives deploy / call / query.
//
// Provider suite (verified to exist as the PRD named them, at 4.1.1):
//   - FetchZkConfigProvider ....... @midnight-ntwrk/midnight-js-fetch-zk-config-provider
//   - levelPrivateStateProvider ... @midnight-ntwrk/midnight-js-level-private-state-provider
//   - dappConnectorProofProvider .. @midnight-ntwrk/midnight-js-dapp-connector-proof-provider
//                                   (the IN-WALLET proving path — discovery Q2)
//   - httpClientProofProvider ..... @midnight-ntwrk/midnight-js-http-client-proof-provider
//                                   (proof-server control path)

import type { WalletConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { dappConnectorProofProvider } from "@midnight-ntwrk/midnight-js-dapp-connector-proof-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { MidnightProviders, ProofProvider } from "@midnight-ntwrk/midnight-js-types";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { CostModel } from "@midnight-ntwrk/ledger-v8";

import { Contract as CounterContract, ledger as counterLedger } from "../../contract/managed/counter/contract/index.js";
import { CIRCUIT_ID, CONTRACT_TAG, ZK_CONFIG_BASE_URL, type ProvingMode } from "@/config";
import { log, traced } from "@/lib/logger";
import { makeConnectorWalletProvider } from "./walletAdapter";

const SCOPE = "providers";

// Strong constant password for the (browser IndexedDB) private-state store.
// The counter has no private state, but the provider is still required.
const PRIVATE_STATE_PASSWORD = "Nyx-PoC-Lace-Prov1ng!";

export type CircuitId = typeof CIRCUIT_ID;
export type CounterProviders = MidnightProviders<CircuitId, string, unknown>;

/** The compiled counter contract, bound with its (vacant) witnesses.
 *
 * `withCompiledFileAssets` discharges the compiled-assets context so the type is
 * fully resolved (deployContract requires R = never). midnight-js sources the
 * actual ZK artifacts from `zkConfigProvider` (a FetchZkConfigProvider over
 * HTTP), so this path value is inert in the browser deploy/call flow — it just
 * satisfies the compact-js context. */
export function buildCompiledContract() {
  log.debug(SCOPE, `CompiledContract.make('${CONTRACT_TAG}', CounterContract).withVacantWitnesses.withCompiledFileAssets`);
  return CompiledContract.make(CONTRACT_TAG, CounterContract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(ZK_CONFIG_BASE_URL),
  );
}

export function buildZkConfigProvider(): FetchZkConfigProvider<CircuitId> {
  log.info(SCOPE, `FetchZkConfigProvider(baseURL=${ZK_CONFIG_BASE_URL})`);
  return new FetchZkConfigProvider<CircuitId>(ZK_CONFIG_BASE_URL, fetch);
}

/**
 * Build the ProofProvider for the selected modality. This is the crux of the
 * experiment: "wallet" configures NO proof server at all.
 */
export async function buildProofProvider(
  mode: ProvingMode,
  api: WalletConnectedAPI,
  zkConfig: FetchZkConfigProvider<CircuitId>,
  proofServerUri: string,
): Promise<ProofProvider> {
  if (mode === "wallet") {
    log.info(
      SCOPE,
      "PROOF PATH = IN-WALLET. dappConnectorProofProvider(wallet, zkConfig, CostModel.initialCostModel()). " +
        "No proof server URL is provided anywhere.",
    );
    return traced(SCOPE, "dappConnectorProofProvider() [obtains wallet.getProvingProvider]", () =>
      dappConnectorProofProvider<CircuitId>(api, zkConfig, CostModel.initialCostModel()),
    );
  }
  log.info(SCOPE, `PROOF PATH = PROOF SERVER (control). httpClientProofProvider(${proofServerUri}).`);
  return httpClientProofProvider<CircuitId>(proofServerUri, zkConfig);
}

/** Assemble the full provider suite required by deployContract / callTx. */
export async function buildProviders(params: {
  mode: ProvingMode;
  api: WalletConnectedAPI;
  networkId: string;
  indexerUri: string;
  indexerWsUri: string;
  proofServerUri: string;
  accountId: string;
}): Promise<CounterProviders> {
  const { mode, api, networkId, indexerUri, indexerWsUri, proofServerUri, accountId } = params;

  log.info(SCOPE, `setNetworkId('${networkId}')`);
  setNetworkId(networkId);

  const zkConfigProvider = buildZkConfigProvider();

  log.info(SCOPE, `indexerPublicDataProvider(${indexerUri}, ${indexerWsUri})`);
  // Pass the browser's global WebSocket explicitly: isomorphic-ws does not
  // re-export a named `WebSocket` in the browser build, and deployContract uses
  // WS subscriptions (watchForDeployTxData / watchForTxData) to await finality.
  const publicDataProvider = indexerPublicDataProvider(
    indexerUri,
    indexerWsUri,
    WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2],
  );

  log.info(SCOPE, "levelPrivateStateProvider({ accountId, privateStoragePasswordProvider })");
  const privateStateProvider = levelPrivateStateProvider<string, unknown>({
    privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
    accountId,
  });

  const proofProvider = await buildProofProvider(mode, api, zkConfigProvider, proofServerUri);

  const walletAndMidnight = await makeConnectorWalletProvider(api, networkId);

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider: walletAndMidnight,
    midnightProvider: walletAndMidnight,
  };
}

/** Deploy a fresh counter. Proving happens INSIDE this call (before balancing). */
export async function deployCounter(providers: CounterProviders) {
  const compiledContract = buildCompiledContract();
  return traced(
    SCOPE,
    "deployContract(counter) [builds unproven tx -> proves -> balances -> submits]",
    () => deployContract(providers, { compiledContract }),
    {
      onResult: (d) => ({
        contractAddress: d.deployTxData.public.contractAddress,
        txHash: d.deployTxData.public.txHash,
        blockHeight: d.deployTxData.public.blockHeight,
        status: d.deployTxData.public.status,
      }),
    },
  );
}

export type DeployedCounter = Awaited<ReturnType<typeof deployCounter>>;

/** Call increment(). This is the second (and cleanest) in-wallet proving event. */
export async function incrementCounter(deployed: DeployedCounter) {
  return traced(
    SCOPE,
    "callTx.increment() [proves via chosen ProofProvider -> balances -> submits]",
    () => deployed.callTx.increment(),
    {
      onResult: (r) => ({
        txHash: r.public.txHash,
        blockHeight: r.public.blockHeight,
        status: r.public.status,
      }),
    },
  );
}

/** Read the on-chain counter value from the indexer. */
export async function readCounterRound(
  providers: CounterProviders,
  contractAddress: string,
): Promise<bigint | null> {
  return traced(SCOPE, `publicDataProvider.queryContractState(${contractAddress})`, async () => {
    const state = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!state) {
      log.warn(SCOPE, "contract state not found on indexer yet");
      return null;
    }
    const ledgerState = counterLedger(state.data);
    log.success(SCOPE, `on-chain round = ${ledgerState.round.toString()}`);
    return ledgerState.round;
  });
}
