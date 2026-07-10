/**
 * US5 wallet-connect layer — the pure four-state classifier (T038 core; FR-037 /
 * SC-020).
 *
 * `classifyConnectState` is a single, dependency-free decision function over a
 * {@link ConnectProbe}, mirroring the repo's `isolationHeadersFor` pattern. It
 * always resolves to exactly one named {@link ConnectState}, never a generic
 * failure — this is the load-bearing guarantee the UI and the T034 tests share.
 */
import type { ConnectProbe, ConnectState, DiscoveredWallet } from "./types";

/**
 * Map a connect probe to its named state.
 *
 * Decision order:
 * 1. no wallets → `no-extension`
 * 2. no v4 wallet among them → `unsupported-wallet` (EC-23)
 * 3. no wallet resolved and several v4 candidates → `needs-selection` (EC-26)
 * 4. resolved wallet, no connection attempt / rejected → `not-authorized` (EC-24)
 * 5. connect resolved but wallet unusable → `authorized-but-unavailable` (R8)
 * 6. connected, network mismatch → `wrong-network`
 * 7. connected, network match → `connected` (the T039 seam)
 */
export function classifyConnectState(probe: ConnectProbe): ConnectState {
  const { wallets, selected, connection, expectedNetworkId } = probe;

  if (wallets.length === 0) {
    return { kind: "no-extension" };
  }

  const v4Wallets = wallets.filter((wallet) => wallet.generation === "v4");
  if (v4Wallets.length === 0) {
    return { kind: "unsupported-wallet", wallets }; // EC-23
  }

  // Resolve the wallet to reason about: an explicit selection, or — when only a
  // single v4 wallet exists — that one. Otherwise the user must pick (EC-26).
  const effective: DiscoveredWallet | undefined =
    selected ?? (v4Wallets.length === 1 ? v4Wallets[0] : undefined);
  if (effective === undefined) {
    return { kind: "needs-selection", wallets: v4Wallets }; // EC-26
  }
  if (effective.generation !== "v4") {
    // Defensive: a caller-selected legacy/unknown wallet cannot be connected.
    return { kind: "unsupported-wallet", wallets };
  }

  if (connection === undefined) {
    return { kind: "not-authorized", wallet: effective };
  }

  switch (connection.status) {
    case "rejected":
      return { kind: "not-authorized", wallet: effective }; // EC-24
    case "unavailable":
      return { kind: "authorized-but-unavailable", wallet: effective }; // R8
    case "ready":
      if (connection.networkId !== expectedNetworkId) {
        return {
          kind: "wrong-network",
          wallet: effective,
          expectedNetworkId,
          actualNetworkId: connection.networkId,
        };
      }
      return {
        kind: "connected",
        wallet: effective,
        networkId: connection.networkId,
        unshieldedAddress: connection.unshieldedAddress,
      };
  }
}
