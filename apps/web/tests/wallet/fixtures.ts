/**
 * Shared test fixtures for the US5 wallet-connect layer (T034).
 *
 * `makeWallet` / `makeProbe` build the plain-data inputs the pure
 * `classifyConnectState` decision function consumes, so every test drives the
 * FR-037 / SC-020 state matrix from data rather than a live wallet.
 */
import type { ConnectProbe, DiscoveredWallet } from "@/wallet/types";

/** Build a discovered-wallet fixture, defaulting to a healthy Lace v4 entry. */
export function makeWallet(overrides: Partial<DiscoveredWallet> = {}): DiscoveredWallet {
  return {
    key: "uuid-lace",
    name: "Lace",
    rdns: "io.lace.wallet",
    apiVersion: "4.0.1",
    icon: undefined,
    generation: "v4",
    ...overrides,
  };
}

/** Build a connect-probe fixture, defaulting to the empty / no-extension case. */
export function makeProbe(overrides: Partial<ConnectProbe> = {}): ConnectProbe {
  return {
    expectedNetworkId: "preprod",
    wallets: [],
    selected: undefined,
    connection: undefined,
    ...overrides,
  };
}
