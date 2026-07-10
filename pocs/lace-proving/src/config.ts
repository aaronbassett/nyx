// Network configuration.
//
// Target: Midnight PRE-PROD, indexer/RPC API v4 (per the live docs reference
// https://docs.midnight.network/relnotes/network and every current tutorial,
// which all use `connect('preprod')` + `setNetworkId('preprod')`).
//
// These are only DEFAULTS. After the wallet connects we prefer the URIs the
// wallet itself reports via `getConfiguration()` (connector v4), so the DApp
// always talks to the same network/services the user selected inside Lace.

export interface NetworkConfig {
  id: string; // value passed to setNetworkId() and connect()
  label: string;
  indexerUri: string;
  indexerWsUri: string;
  nodeUri: string;
  /** Conventional LOCAL proof server. Used ONLY by the "proof-server" control path. */
  proofServerUri: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  preprod: {
    id: "preprod",
    label: "Pre-prod",
    indexerUri: "https://indexer.preprod.midnight.network/api/v4/graphql",
    indexerWsUri: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    nodeUri: "https://rpc.preprod.midnight.network",
    proofServerUri: "http://localhost:6300",
  },
  preview: {
    id: "preview",
    label: "Preview",
    indexerUri: "https://indexer.preview.midnight.network/api/v4/graphql",
    indexerWsUri: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
    nodeUri: "https://rpc.preview.midnight.network",
    proofServerUri: "http://localhost:6300",
  },
  undeployed: {
    id: "undeployed",
    label: "Local (undeployed)",
    indexerUri: "http://localhost:8088/api/v4/graphql",
    indexerWsUri: "ws://localhost:8088/api/v4/graphql/ws",
    nodeUri: "http://localhost:9944",
    proofServerUri: "http://localhost:6300",
  },
};

export const DEFAULT_NETWORK = "preprod";

/** Base URL from which the compiled ZK artifacts (keys + zkir) are served. */
export const ZK_CONFIG_BASE_URL = `${window.location.origin}/zk/counter`;

/** The single circuit our counter contract exposes. */
export const CIRCUIT_ID = "increment";

/** Unique tag for the compiled contract binding. */
export const CONTRACT_TAG = "lace-proving-counter";

/**
 * Two proving modalities the PoC can exercise. This is the whole point of the
 * experiment (discovery Q2):
 *  - "wallet"  : dappConnectorProofProvider -> wallet.getProvingProvider().
 *                NO proof server is configured by us. If this succeeds, Lace
 *                proves in-wallet and a fully client-side DApp is viable.
 *  - "server"  : httpClientProofProvider(proofServerUri). Control path that
 *                delegates to a local proof server at localhost:6300.
 */
export type ProvingMode = "wallet" | "server";
