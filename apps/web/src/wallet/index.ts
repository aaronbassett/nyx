/**
 * US5 wallet-connect layer — public surface (T034 / T038).
 *
 * The four-state classifier (`classifyConnectState`) is the load-bearing export
 * shared by the UI and the tests. Detection, the active connect flow, the
 * remembered-choice helpers, and the React surface round out the module. The
 * seam for T039 is the connected `ConnectedAPI` + unshielded address exposed by
 * `useWalletConnect`.
 */
export { classifyConnectState } from "./classify";
export { EXPECTED_NETWORK_ID } from "./config";
export {
  detectProbe,
  discoverWallets,
  getConnectorEntry,
  isLaceWallet,
  pickWallet,
  sortWalletsForPicker,
} from "./detect";
export { connectWallet, WalletTimeoutError } from "./connect";
export type { ConnectOutcome } from "./connect";
export { forgetRememberedWallet, loadRememberedWalletRdns, rememberWalletRdns } from "./remember";
export { useWalletConnect } from "./useWalletConnect";
export type { UseWalletConnect } from "./useWalletConnect";
export { WalletConnect } from "./WalletConnect";
export type { WalletConnectProps } from "./WalletConnect";
export { WalletConnectView } from "./WalletConnectView";
export type { WalletConnectViewProps } from "./WalletConnectView";
export type {
  ConnectionObservation,
  ConnectProbe,
  ConnectState,
  DiscoveredWallet,
  WalletGeneration,
} from "./types";
