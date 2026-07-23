/**
 * Devnet forwarding-proxy public surface (P3 Task 1).
 *
 * Same-origin forwarding of the local devnet node/indexer to the isolated
 * (COOP/COEP) browser: HTTP byte forwarders + session-gated WebSocket relays,
 * behind the shared session gate. See `./proxy.ts` for the constitution I/III
 * rationale (transparent relay; auth precedes every forward).
 */
export {
  createDevnetForwarder,
  createDevnetWsRelay,
  DEVNET_INDEXER_PREFIX,
  DEVNET_NODE_PREFIX,
  DevnetUnavailableError,
  httpToWs,
  INDEXER_WS_SUBPATH,
  registerDevnetRoutes,
} from "./proxy.js";
export type {
  DevnetForwarder,
  DevnetForwarderDeps,
  DevnetRouteDeps,
  DevnetWsRelay,
  DevnetWsRelayDeps,
  ForwardRequest,
  ForwardResult,
} from "./proxy.js";
