/**
 * US5 wallet-connect layer — container (T038).
 *
 * Binds the {@link useWalletConnect} orchestration to the pure
 * {@link WalletConnectView}. This is where the connect surface is mounted; it
 * stops at "connected + unshielded address classified" and leaves the live api /
 * address on the hook for T039 (nonce→sign→verify→session) to pick up.
 */
import { useCallback } from "react";

import { useWalletConnect } from "./useWalletConnect";
import { WalletConnectView } from "./WalletConnectView";

export interface WalletConnectProps {
  /** Override the expected network id (defaults to the build-configured value). */
  readonly expectedNetworkId?: string;
}

export function WalletConnect({ expectedNetworkId }: WalletConnectProps = {}) {
  const { state, isConnecting, connect, selectWallet, refresh } =
    useWalletConnect(expectedNetworkId);

  const onConnect = useCallback(() => {
    void connect();
  }, [connect]);

  const onRetry = useCallback(() => {
    // For states where a wallet is already chosen, re-attempt the connection;
    // otherwise re-run passive detection (e.g. after installing a wallet).
    if (state.kind === "authorized-but-unavailable" || state.kind === "wrong-network") {
      void connect();
    } else {
      refresh();
    }
  }, [state.kind, connect, refresh]);

  return (
    <WalletConnectView
      state={state}
      isConnecting={isConnecting}
      onConnect={onConnect}
      onSelectWallet={selectWallet}
      onRetry={onRetry}
    />
  );
}
