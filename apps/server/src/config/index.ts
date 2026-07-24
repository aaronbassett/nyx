/**
 * Boot-config layer for the Nyx orchestrator (T015, DS-003).
 *
 * `loadConfig` is the pure, testable validator; `publicConfig` is the only safe
 * way to project config beyond the server boundary — it drops `secrets`
 * entirely so deploy keys can never be serialized to a client surface
 * (constitution III, D52).
 */
import type { Config, PublicConfig } from "./schema.js";

export { loadConfig } from "./load.js";
export { ConfigValidationError } from "./errors.js";
export type { ConfigIssue } from "./errors.js";
export {
  EnvSchema,
  MODEL_ROLES,
  ModelProviderSchema,
  ModelRouteSchema,
  ModelRoutingTableSchema,
} from "./schema.js";
export type {
  ArtifactStoreConfig,
  Config,
  Env,
  McpConfig,
  ModelProvider,
  ModelRole,
  ModelRoute,
  ModelRoutingTable,
  NetworkConfig,
  NyxtAmount,
  ProverConfig,
  PublicConfig,
  ServerSecrets,
  Tunables,
} from "./schema.js";
export {
  DEFAULT_NETWORK,
  NETWORK_IDS,
  NETWORK_PROFILES,
  resolveNetworkProfile,
} from "./network.js";
export type { NetworkEnv, NetworkProfile } from "./network.js";

/**
 * Project a {@link Config} down to the fields safe to expose beyond the server
 * boundary. Secrets are dropped by construction (they are never read here), so
 * this cannot leak them (constitution III).
 */
export function publicConfig(config: Config): PublicConfig {
  const { port, publicOrigin, network, nyxtVaultAddress, mcp, prover, artifacts, tunables } =
    config;
  const { modelRouting } = config;
  return {
    port,
    publicOrigin,
    network,
    nyxtVaultAddress,
    mcp,
    prover,
    artifacts,
    tunables,
    modelRouting,
  };
}
