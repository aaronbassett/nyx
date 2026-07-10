/**
 * US5 wallet-connect layer — presentational surface (T038).
 *
 * A pure view over a {@link ConnectState}: every FR-037 state (plus the EC-23 /
 * EC-26 edges and the connected seam) renders its own named, state-specific
 * guidance — never a generic failure. All side effects arrive as callbacks, so
 * the view is trivially testable (T034) and reusable by the container.
 *
 * Wallet-supplied strings (name) are rendered as JSX text nodes, which React
 * escapes — the connector docs flag name/icon as untrusted (XSS) surfaces.
 */
import {
  CircleCheck,
  Download,
  LoaderCircle,
  Network,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { sortWalletsForPicker } from "./detect";
import type { ConnectState, DiscoveredWallet } from "./types";

export interface WalletConnectViewProps {
  /** The classified connect state to render. */
  readonly state: ConnectState;
  /** Whether an active connect attempt is in flight (disables the action). */
  readonly isConnecting: boolean;
  /** Authorize the selected wallet. */
  readonly onConnect: () => void;
  /** Choose a wallet from the multi-wallet picker (EC-26). */
  readonly onSelectWallet: (wallet: DiscoveredWallet) => void;
  /** Retry after an unavailable / wrong-network state. */
  readonly onRetry: () => void;
}

/** Shorten a Bech32m address for display (keeps the readable head and tail). */
function truncateAddress(address: string): string {
  if (address.length <= 18) {
    return address;
  }
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

/** Shared panel chrome so every state reads as one system. */
function StatePanel(props: {
  readonly testId: string;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <Card data-testid={props.testId} className="max-w-md">
      <CardHeader>
        <div className="flex items-center gap-3">
          {props.icon}
          <CardTitle>{props.title}</CardTitle>
        </div>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      {props.children !== undefined ? (
        <CardContent className="space-y-3">{props.children}</CardContent>
      ) : null}
    </Card>
  );
}

/** A single connect action button, showing an in-flight spinner. */
function ConnectButton(props: { readonly isConnecting: boolean; readonly onConnect: () => void }) {
  return (
    <Button onClick={props.onConnect} disabled={props.isConnecting}>
      {props.isConnecting ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Wallet className="size-4" aria-hidden="true" />
      )}
      {props.isConnecting ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}

/**
 * Render the connect surface for a given state. Exhaustive over
 * {@link ConnectState} — adding a state without a branch is a type error.
 */
export function WalletConnectView({
  state,
  isConnecting,
  onConnect,
  onSelectWallet,
  onRetry,
}: WalletConnectViewProps) {
  switch (state.kind) {
    case "no-extension":
      return (
        <StatePanel
          testId="wallet-state-no-extension"
          icon={<Download className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title="No Midnight wallet detected"
          description="Nyx needs a Midnight wallet browser extension to connect. Install Lace for Midnight, then reload this page."
        >
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Check again
          </Button>
        </StatePanel>
      );

    case "unsupported-wallet":
      return (
        <StatePanel
          testId="wallet-state-unsupported-wallet"
          icon={<ShieldAlert className="size-6 shrink-0 text-destructive" aria-hidden="true" />}
          title="Wallet connector is out of date"
          description="This wallet only exposes an older Midnight connector. Nyx requires DApp Connector API v4 (a wallet that exposes connect()). Update Lace / your Midnight wallet to a v4 build and reload."
        >
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Check again
          </Button>
        </StatePanel>
      );

    case "needs-selection":
      return (
        <StatePanel
          testId="wallet-state-needs-selection"
          icon={<Wallet className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title="Choose a wallet"
          description="More than one Midnight wallet is installed. Pick which one to connect — Nyx will remember your choice on this browser."
        >
          <ul className="space-y-2">
            {sortWalletsForPicker(state.wallets).map((wallet) => (
              <li key={wallet.key}>
                <Button
                  data-testid="wallet-picker-option"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => {
                    onSelectWallet(wallet);
                  }}
                >
                  <Wallet className="size-4" aria-hidden="true" />
                  <span>{wallet.name}</span>
                  {wallet.rdns !== undefined ? (
                    <span className="text-muted-foreground ml-auto font-mono text-xs">
                      {wallet.rdns}
                    </span>
                  ) : null}
                </Button>
              </li>
            ))}
          </ul>
        </StatePanel>
      );

    case "not-authorized":
      return (
        <StatePanel
          testId="wallet-state-not-authorized"
          icon={<Wallet className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title={`Connect ${state.wallet.name}`}
          description="Authorize Nyx in your wallet to continue. Nyx only reads your unshielded address — it never sees your keys."
        >
          <ConnectButton isConnecting={isConnecting} onConnect={onConnect} />
        </StatePanel>
      );

    case "authorized-but-unavailable":
      return (
        <StatePanel
          testId="wallet-state-authorized-but-unavailable"
          icon={<TriangleAlert className="size-6 shrink-0 text-destructive" aria-hidden="true" />}
          title="Wallet is not responding"
          description="Your wallet authorized Nyx, but it is not responding to requests. Open your wallet extension, make sure it is unlocked and finished syncing, then try again."
        >
          <Button variant="outline" onClick={onRetry} disabled={isConnecting}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </Button>
        </StatePanel>
      );

    case "wrong-network":
      return (
        <StatePanel
          testId="wallet-state-wrong-network"
          icon={<Network className="size-6 shrink-0 text-destructive" aria-hidden="true" />}
          title="Wrong network"
          description={
            <>
              Nyx expects the <code className="font-mono">{state.expectedNetworkId}</code> network,
              but your wallet is connected to{" "}
              <code className="font-mono">{state.actualNetworkId}</code>. Switch networks in your
              wallet and try again.
            </>
          }
        >
          <Button variant="outline" onClick={onRetry} disabled={isConnecting}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </Button>
        </StatePanel>
      );

    case "connected":
      return (
        <StatePanel
          testId="wallet-state-connected"
          icon={<CircleCheck className="size-6 shrink-0 text-primary" aria-hidden="true" />}
          title={`${state.wallet.name} connected`}
          description={`Connected on ${state.networkId}.`}
        >
          <div className={cn("flex items-center gap-2 text-sm")}>
            <span className="text-muted-foreground">Address</span>
            <code className="font-mono" title={state.unshieldedAddress}>
              {truncateAddress(state.unshieldedAddress)}
            </code>
          </div>
        </StatePanel>
      );
  }
}
