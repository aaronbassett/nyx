/**
 * Network-profile config for the Nyx orchestrator.
 *
 * A `NetworkProfile` is the PUBLIC (non-secret) bundle of endpoints that both
 * the server and — projected via `publicConfig` — the client need in order to
 * talk to a specific Midnight network. `networkId` is the string the wallet
 * connector reports; it drives the wrong-network gate on the client. These URLs
 * are endpoints, not credentials, so the whole profile is PUBLIC (it flows into
 * `publicConfig`) and it must NEVER live under `secrets`.
 *
 * Two profiles ship built in — `local-devnet` (the default) and `preprod`.
 * `resolveNetworkProfile` selects one by `NYX_NETWORK` and layers OPTIONAL
 * per-field env overrides on top so a single endpoint can be repointed without
 * defining a whole profile.
 */

/** One network's public endpoints + the id the connector reports. */
export interface NetworkProfile {
  /** The profile key (`local-devnet` | `preprod`); survives any field overrides. */
  readonly id: string;
  /** What the wallet connector reports; drives the wrong-network gate. */
  readonly networkId: string;
  readonly nodeUrl: string;
  readonly indexerUrl: string;
  readonly proofServerUrl: string;
}

/** The default network id — a local devnet against Lace "Undeployed". */
export const DEFAULT_NETWORK = "local-devnet";

/**
 * Local devnet, targeting a wallet in Lace "Undeployed" mode. THE DEFAULT.
 *
 * `nodeUrl` (9944) and `proofServerUrl` (6300) are PINNED by Lace "Undeployed" —
 * the connector expects those exact ports, so they are not remapped.
 *
 * `indexerUrl` stays on the conventional Undeployed port 8088: Lace's Undeployed
 * connector reports an indexer URI too (`ServiceUriConfig`) — canonically
 * `http://localhost:8088` across every Midnight example — so remapping it would
 * break the wallet's own balance sync. Nyx's OWN services (Postgres, Vite) are
 * what get remapped for incidental-clash avoidance, not the shared devnet stack.
 */
const LOCAL_DEVNET: NetworkProfile = {
  id: "local-devnet",
  // Owner-confirmed (T273, 2026-07-13): Lace reports "Undeployed" for the Undeployed
  // network. The wrong-network gate compares this exactly, so the case is load-bearing.
  networkId: "Undeployed",
  nodeUrl: "http://localhost:9944",
  indexerUrl: "http://localhost:8088",
  proofServerUrl: "http://localhost:6300",
};

/**
 * Public-release target. The endpoints + networkId below are PLACEHOLDERS — real
 * Midnight preprod values must never be hand-written from memory (constitution
 * I); they are set from the owner's toolchain when the release target is wired.
 */
const PREPROD: NetworkProfile = {
  id: "preprod",
  // TODO(verify): set real preprod node/indexer/proof URLs + networkId
  networkId: "preprod-placeholder",
  // TODO(verify): set real preprod node/indexer/proof URLs + networkId
  nodeUrl: "https://TODO-preprod-node.placeholder.invalid",
  indexerUrl: "https://TODO-preprod-indexer.placeholder.invalid",
  proofServerUrl: "https://TODO-preprod-proof.placeholder.invalid",
};

/** Every built-in profile, keyed by its `id`. */
export const NETWORK_PROFILES: Readonly<Record<string, NetworkProfile>> = {
  "local-devnet": LOCAL_DEVNET,
  preprod: PREPROD,
} as const;

/** The ordered list of valid profile ids (drives the `NYX_NETWORK` enum). */
export const NETWORK_IDS = ["local-devnet", "preprod"] as const;

/**
 * The env fields `resolveNetworkProfile` reads. Kept structural (not a
 * `schema.ts` import) so this module has no dependency back on the flat env
 * schema — the parsed `Env` is assignable to it.
 */
export interface NetworkEnv {
  /** Selected profile id; validated to a known key upstream by `EnvSchema`. */
  readonly NYX_NETWORK: string;
  readonly NYX_NODE_URL?: string | undefined;
  readonly NYX_INDEXER_URL?: string | undefined;
  readonly NYX_PROOF_SERVER_URL?: string | undefined;
  readonly NYX_NETWORK_ID?: string | undefined;
}

/**
 * Resolve the effective {@link NetworkProfile} from `env`: pick the base profile
 * by `NYX_NETWORK` (falling back to the default profile if the key is somehow
 * unknown — `EnvSchema` normally rejects that first), then apply each present
 * per-field override. The `id` always reflects the SELECTED profile, even when
 * individual endpoints are overridden. The result is frozen.
 */
export function resolveNetworkProfile(env: NetworkEnv): NetworkProfile {
  const base = NETWORK_PROFILES[env.NYX_NETWORK] ?? LOCAL_DEVNET;
  return Object.freeze({
    id: base.id,
    networkId: env.NYX_NETWORK_ID ?? base.networkId,
    nodeUrl: env.NYX_NODE_URL ?? base.nodeUrl,
    indexerUrl: env.NYX_INDEXER_URL ?? base.indexerUrl,
    proofServerUrl: env.NYX_PROOF_SERVER_URL ?? base.proofServerUrl,
  });
}
