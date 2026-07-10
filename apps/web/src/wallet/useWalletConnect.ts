/**
 * US5 wallet-connect layer — orchestration hook (T038).
 *
 * Wires the passive detection + pure classification + active connect pieces into
 * a stateful surface for the UI. It holds the live `ConnectedAPI` handle and the
 * unshielded address once connected — the SEAM T039 consumes to run the
 * nonce→sign→verify→session flow. This hook stops at "connected + address
 * classified" and makes no `/auth/*` calls.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";

import { classifyConnectState } from "./classify";
import { EXPECTED_NETWORK_ID } from "./config";
import { connectWallet } from "./connect";
import { detectProbe, getConnectorEntry } from "./detect";
import { loadRememberedWalletRdns, rememberWalletRdns } from "./remember";
import type { ConnectionObservation, ConnectState, DiscoveredWallet } from "./types";

/** The connect surface exposed to components. */
export interface UseWalletConnect {
  /** The classified connect state (FR-037). Drives the entire UI. */
  readonly state: ConnectState;
  /** All discovered wallets (for diagnostics / picker rendering). */
  readonly wallets: readonly DiscoveredWallet[];
  /** Whether an active connect attempt is in flight. */
  readonly isConnecting: boolean;
  /**
   * The live wallet handle — present once connect() resolves. Valid to use for
   * the T039 sign flow only when `state.kind === "connected"`.
   */
  readonly api: ConnectedAPI | undefined;
  /** The connected unshielded address (D43), when `state.kind === "connected"`. */
  readonly unshieldedAddress: string | undefined;
  /** Re-run passive detection (e.g. after installing/unlocking a wallet). */
  readonly refresh: () => void;
  /** Choose a wallet from the picker; remembers the choice (EC-26). */
  readonly selectWallet: (wallet: DiscoveredWallet) => void;
  /** Authorize the selected wallet and probe it (the active connect action). */
  readonly connect: () => Promise<void>;
}

/**
 * Manage the wallet connect lifecycle for the given expected network id
 * (defaults to the build-configured {@link EXPECTED_NETWORK_ID}).
 */
export function useWalletConnect(
  expectedNetworkId: string = EXPECTED_NETWORK_ID,
): UseWalletConnect {
  const [wallets, setWallets] = useState<readonly DiscoveredWallet[]>([]);
  const [selected, setSelected] = useState<DiscoveredWallet | undefined>(undefined);
  const [connection, setConnection] = useState<ConnectionObservation | undefined>(undefined);
  const [api, setApi] = useState<ConnectedAPI | undefined>(undefined);
  const [isConnecting, setIsConnecting] = useState(false);

  const refresh = useCallback(() => {
    const probe = detectProbe({
      expectedNetworkId,
      rememberedRdns: loadRememberedWalletRdns(),
    });
    setWallets(probe.wallets);
    setSelected(probe.selected);
    setConnection(undefined);
    setApi(undefined);
  }, [expectedNetworkId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectWallet = useCallback((wallet: DiscoveredWallet) => {
    if (wallet.rdns !== undefined) {
      rememberWalletRdns(wallet.rdns);
    }
    setSelected(wallet);
    setConnection(undefined);
    setApi(undefined);
  }, []);

  const connect = useCallback(async () => {
    if (selected === undefined) {
      return;
    }
    const entry = getConnectorEntry(selected.key);
    if (entry === undefined) {
      // The entry vanished (wallet disabled between detection and connect).
      setConnection({ status: "unavailable" });
      setApi(undefined);
      return;
    }
    setIsConnecting(true);
    try {
      const outcome = await connectWallet(entry, expectedNetworkId);
      setConnection(outcome.observation);
      setApi(outcome.api);
    } finally {
      setIsConnecting(false);
    }
  }, [selected, expectedNetworkId]);

  const state = useMemo(
    () => classifyConnectState({ expectedNetworkId, wallets, selected, connection }),
    [expectedNetworkId, wallets, selected, connection],
  );

  const unshieldedAddress =
    connection?.status === "ready" ? connection.unshieldedAddress : undefined;

  return {
    state,
    wallets,
    isConnecting,
    api,
    unshieldedAddress,
    refresh,
    selectWallet,
    connect,
  };
}
