/**
 * Web network-profile chokepoint (constitution VII) — the single place the web
 * app resolves which Midnight network it targets and the endpoints for it.
 *
 * A build-time `VITE_NYX_NETWORK` selects one of the built-in {@link NETWORK_PROFILES}
 * (default `local-devnet`); everything downstream (the wallet wrong-network gate,
 * future node/indexer/proof-server clients) reads the resolved {@link NETWORK}
 * rather than reaching for `import.meta.env` on its own. Keeping the endpoint set
 * here — not scattered across call sites — is what makes the profile swappable
 * for the public release without touching consumers.
 *
 * The endpoint values mirror the server-side devnet profile so both halves of the
 * platform agree on a single source of truth for each network.
 */

/** A resolved Midnight network target: its id plus the endpoints Nyx talks to. */
export interface NetworkProfile {
  /** Stable profile key, e.g. `"local-devnet"` (also the `VITE_NYX_NETWORK` value). */
  readonly id: string;
  /** Network id the wallet must report to pass the FR-037 wrong-network gate. */
  readonly networkId: string;
  /** Midnight node RPC endpoint. */
  readonly nodeUrl: string;
  /** Indexer endpoint. */
  readonly indexerUrl: string;
  /** Proof-server endpoint. */
  readonly proofServerUrl: string;
}

/**
 * Built-in profiles. `local-devnet` is the default development target; only the
 * node and proof-server URLs are pinned by Lace, so the indexer port is remapped
 * freely (see per-field notes). `preprod` is the public-release target and holds
 * placeholders only — real endpoints are filled in against the live network, not
 * from memory (constitution I).
 */
export const NETWORK_PROFILES = {
  "local-devnet": {
    id: "local-devnet",
    // Owner-confirmed (T273): Lace reports "Undeployed" for the Undeployed network.
    networkId: "Undeployed",
    // Lace-pinned: the local devnet node RPC.
    nodeUrl: "http://localhost:9944",
    // Conventional Undeployed indexer (8088) — Lace syncs against it too, so kept.
    indexerUrl: "http://localhost:8088",
    // Lace-pinned: the local proof server.
    proofServerUrl: "http://localhost:6300",
  },
  preprod: {
    id: "preprod",
    networkId: "preprod", // TODO(verify): real preprod networkId
    nodeUrl: "https://node.preprod.invalid", // TODO(verify): real preprod endpoints
    indexerUrl: "https://indexer.preprod.invalid", // TODO(verify): real preprod endpoints
    proofServerUrl: "https://proof.preprod.invalid", // TODO(verify): real preprod endpoints
  },
} as const satisfies Record<string, NetworkProfile>;

/** The `VITE_NYX_NETWORK` values that map to a built-in profile. */
export type NetworkProfileId = keyof typeof NETWORK_PROFILES;

/** The profile selected when `VITE_NYX_NETWORK` is unset or unrecognised. */
const DEFAULT_PROFILE_ID: NetworkProfileId = "local-devnet";

/**
 * Read `import.meta.env.VITE_NYX_NETWORK` defensively (Vite-injected), mirroring
 * `wallet/config.ts` — `import.meta.env` may be absent outside a Vite build.
 */
function readSelectedNetwork(): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const value = meta.env?.VITE_NYX_NETWORK;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve the configured profile id to a known profile, falling back to the default. */
function resolveProfile(): NetworkProfile {
  const selected = readSelectedNetwork();
  if (selected !== undefined && selected in NETWORK_PROFILES) {
    return NETWORK_PROFILES[selected as NetworkProfileId];
  }
  return NETWORK_PROFILES[DEFAULT_PROFILE_ID];
}

/** The active network profile for this build (constitution VII chokepoint). */
export const NETWORK: NetworkProfile = resolveProfile();
