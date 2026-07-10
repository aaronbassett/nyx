/**
 * US5 wallet-connect layer — shared data shapes (T038).
 *
 * These are plain, serialisable data types. The impure detection/connect layer
 * (`detect.ts`, `connect.ts`) produces a {@link ConnectProbe}; the pure
 * `classifyConnectState` (`classify.ts`) maps it to a {@link ConnectState}. Both
 * the UI and the T034 tests consume the same pure function, mirroring the
 * repo's `isolation-headers` decision-function pattern.
 */

/** Which generation of the DApp Connector an injected wallet entry implements. */
export type WalletGeneration = "v4" | "legacy" | "unknown";

/**
 * A wallet entry discovered under `window.midnight`, reduced to display/decision
 * data. A single physical wallet may inject several entries (e.g. per version).
 */
export interface DiscoveredWallet {
  /** The UUID (v4) or name key the entry is installed under `window.midnight`. */
  readonly key: string;
  /** Human-readable wallet name (must be treated as untrusted — render as text). */
  readonly name: string;
  /** Reverse-DNS wallet id (e.g. `io.lace.wallet`), when advertised. */
  readonly rdns: string | undefined;
  /** Connector API version the entry advertises, when present. */
  readonly apiVersion: string | undefined;
  /** Wallet icon (URL or data URI), when advertised. */
  readonly icon: string | undefined;
  /** `v4` exposes `connect()`; `legacy` only `enable()`; `unknown` neither. */
  readonly generation: WalletGeneration;
}

/**
 * The outcome of attempting to use a selected wallet, once a connection has been
 * attempted. Absent (`undefined` on the probe) means connect() was never called.
 */
export type ConnectionObservation =
  /** connect() was rejected or declined (EC-24) — a clean cancel, no error tone. */
  | { readonly status: "rejected" }
  /**
   * connect() resolved but a follow-up call (getConnectionStatus /
   * getUnshieldedAddress) threw or hung (R8). Authorization succeeded; the
   * wallet itself is unusable, so guidance points at the wallet, not Nyx.
   */
  | { readonly status: "unavailable" }
  /** connect() resolved and the follow-up probe succeeded. */
  | {
      readonly status: "ready";
      readonly networkId: string;
      readonly unshieldedAddress: string;
    };

/**
 * A snapshot of the connect surface — everything `classifyConnectState` needs to
 * decide the state without touching the live wallet or the DOM.
 */
export interface ConnectProbe {
  /** The network id the app expects to be connected to (configurable). */
  readonly expectedNetworkId: string;
  /** Every wallet entry discovered under `window.midnight`. */
  readonly wallets: readonly DiscoveredWallet[];
  /** The wallet the picker resolved to use, if any (single v4 or remembered). */
  readonly selected: DiscoveredWallet | undefined;
  /** The connection attempt outcome, or `undefined` when none has been made. */
  readonly connection: ConnectionObservation | undefined;
}

/**
 * The classified connect state (FR-037 / SC-020). Exactly one named state — the
 * four load-bearing states plus the EC-23/EC-26 edges and the connected seam —
 * never a generic failure.
 */
export type ConnectState =
  /** `window.midnight` is absent or empty — no Midnight wallet installed. */
  | { readonly kind: "no-extension" }
  /** A wallet is present but only speaks a pre-v4 connector (EC-23). */
  | { readonly kind: "unsupported-wallet"; readonly wallets: readonly DiscoveredWallet[] }
  /** Multiple v4 wallets and no chosen one — show a picker (EC-26). */
  | { readonly kind: "needs-selection"; readonly wallets: readonly DiscoveredWallet[] }
  /** A v4 wallet is present but not yet authorized (idle or EC-24 cancel). */
  | { readonly kind: "not-authorized"; readonly wallet: DiscoveredWallet }
  /** Authorized, but the wallet is unusable — wallet-side guidance (R8). */
  | { readonly kind: "authorized-but-unavailable"; readonly wallet: DiscoveredWallet }
  /** Connected, but to the wrong network id. */
  | {
      readonly kind: "wrong-network";
      readonly wallet: DiscoveredWallet;
      readonly expectedNetworkId: string;
      readonly actualNetworkId: string;
    }
  /** Connected on the expected network with an unshielded address — the T039 seam. */
  | {
      readonly kind: "connected";
      readonly wallet: DiscoveredWallet;
      readonly networkId: string;
      readonly unshieldedAddress: string;
    };
