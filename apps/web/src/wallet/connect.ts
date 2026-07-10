/**
 * US5 wallet-connect layer — the active connect flow (T038).
 *
 * Calls the connector-v4 `connect(networkId)` on a chosen wallet, then probes it
 * with `getConnectionStatus()` + `getUnshieldedAddress()` to obtain the account
 * identity (the unshielded Bech32m address, D43). Every wallet call is bounded by
 * a timeout so a hung wallet (R8) surfaces as `unavailable` rather than hanging
 * the UI.
 *
 * The R8 hard lesson is encoded structurally: once `connect()` resolves we hold a
 * live `ConnectedAPI` even if the follow-up probe throws or times out — so the
 * returned outcome always carries the handle in that case, and classification
 * maps it to `authorized-but-unavailable` (wallet-side guidance), not a Nyx error.
 *
 * This is the SEAM for T039: on a `ready` outcome the caller keeps `outcome.api`
 * (the live `ConnectedAPI`) and `observation.unshieldedAddress` to drive the
 * nonce→sign→verify→session flow. This module deliberately stops here and makes
 * no `/auth/*` calls.
 */
import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";

import type { ConnectionObservation } from "./types";

/** Raised when a wallet call does not settle within the timeout budget. */
export class WalletTimeoutError extends Error {
  constructor(operation: string) {
    super(`Wallet call timed out: ${operation}`);
    this.name = "WalletTimeoutError";
  }
}

/** Default per-call timeout budget for wallet interactions. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The result of an active connect attempt. */
export interface ConnectOutcome {
  /** The classified observation, fed to `classifyConnectState`. */
  readonly observation: ConnectionObservation;
  /**
   * The live wallet handle, held whenever `connect()` resolved — including the
   * R8 `unavailable` case. `undefined` only when `connect()` itself failed. On a
   * `ready` observation this is the seam T039 consumes.
   */
  readonly api: ConnectedAPI | undefined;
}

/** Resolve `promise`, or reject with {@link WalletTimeoutError} after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WalletTimeoutError(operation));
    }, ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new WalletTimeoutError(operation));
      },
    );
  });
}

/**
 * Connect to `entry` on `networkIdHint`, then probe for connection status and the
 * unshielded address. Never throws: every failure mode is reduced to a named
 * {@link ConnectOutcome}.
 */
export async function connectWallet(
  entry: InitialAPI,
  networkIdHint: string,
  options?: { readonly timeoutMs?: number },
): Promise<ConnectOutcome> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let api: ConnectedAPI;
  try {
    api = await withTimeout(entry.connect(networkIdHint), timeoutMs, "connect");
  } catch {
    // connect() rejected (EC-24 user cancel/decline) or timed out before
    // authorizing — we hold no handle. A clean not-authorized, no error tone.
    return { observation: { status: "rejected" }, api: undefined };
  }

  // connect() resolved → authorization succeeded and we hold a (possibly broken)
  // handle. R8: a follow-up call may still throw or hang.
  try {
    const status = await withTimeout(api.getConnectionStatus(), timeoutMs, "getConnectionStatus");
    if (status.status !== "connected") {
      return { observation: { status: "unavailable" }, api };
    }
    const address = await withTimeout(
      api.getUnshieldedAddress(),
      timeoutMs,
      "getUnshieldedAddress",
    );
    return {
      observation: {
        status: "ready",
        networkId: status.networkId,
        unshieldedAddress: address.unshieldedAddress,
      },
      api,
    };
  } catch {
    return { observation: { status: "unavailable" }, api };
  }
}
