/**
 * US5 wallet-connect layer — detection & selection (T038).
 *
 * Reads the wallets injected under `window.midnight`, tags each by connector
 * generation, and picks one (Lace-preferred, honouring a remembered choice).
 * Entries are read defensively as `unknown` — the connector's global typing
 * asserts every entry is a v4 `InitialAPI`, but legacy wallets inject entries
 * with `enable()` and NO `connect()`, which we must detect and reject (EC-23).
 *
 * Detection is passive: it never calls `connect()` (that is `connect.ts`, driven
 * by an explicit user action), so a discovered-but-unauthorized wallet resolves
 * to the `not-authorized` state rather than silently prompting.
 */
import type { InitialAPI } from "@midnight-ntwrk/dapp-connector-api";

import type { ConnectProbe, DiscoveredWallet, WalletGeneration } from "./types";

/** Read `window.midnight` as an untrusted map, or `undefined` when absent. */
function readMidnightMap(): Record<string, unknown> | undefined {
  const midnight = (globalThis as { midnight?: unknown }).midnight;
  if (typeof midnight !== "object" || midnight === null) {
    return undefined;
  }
  return midnight as Record<string, unknown>;
}

/** True when `value` is an object exposing `key` as a callable function. */
function hasFunction(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[key] === "function";
}

/** Read a string property off an untrusted entry, or `undefined`. */
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === "string" ? prop : undefined;
}

/** Reduce an injected entry to a {@link DiscoveredWallet}, tagging its generation. */
function describeWallet(key: string, entry: unknown): DiscoveredWallet {
  const generation: WalletGeneration = hasFunction(entry, "connect")
    ? "v4"
    : hasFunction(entry, "enable")
      ? "legacy"
      : "unknown";
  return {
    key,
    name: readString(entry, "name") ?? key,
    rdns: readString(entry, "rdns"),
    apiVersion: readString(entry, "apiVersion"),
    icon: readString(entry, "icon"),
    generation,
  };
}

/** Snapshot every wallet entry injected under `window.midnight`. */
export function discoverWallets(): DiscoveredWallet[] {
  const map = readMidnightMap();
  if (map === undefined) {
    return [];
  }
  return Object.keys(map).map((key) => describeWallet(key, map[key]));
}

/**
 * Return the live connector-v4 `InitialAPI` entry for a discovered wallet key,
 * or `undefined` if it is gone or not a v4 connector. The cast is the single
 * point where an untrusted entry becomes a typed connector handle.
 */
export function getConnectorEntry(key: string): InitialAPI | undefined {
  const map = readMidnightMap();
  if (map === undefined) {
    return undefined;
  }
  const entry = map[key];
  if (!hasFunction(entry, "connect")) {
    return undefined;
  }
  return entry as InitialAPI;
}

/** True when a wallet looks like Lace / a Midnight wallet (rdns or name match). */
export function isLaceWallet(wallet: DiscoveredWallet): boolean {
  const rdns = wallet.rdns ?? "";
  return /lace/i.test(wallet.name) || /lace/i.test(rdns) || /midnight/i.test(rdns);
}

/** Order wallets Lace-first for display in the picker (EC-26). */
export function sortWalletsForPicker(wallets: readonly DiscoveredWallet[]): DiscoveredWallet[] {
  return [...wallets].sort((a, b) => Number(isLaceWallet(b)) - Number(isLaceWallet(a)));
}

/**
 * Choose the wallet to connect to among the discovered entries.
 *
 * - only v4 candidates are eligible (legacy/unknown are ignored);
 * - a remembered rdns wins when it matches a candidate (EC-26 persistence);
 * - a single v4 candidate is auto-selected;
 * - multiple candidates with no remembered choice → `undefined` (show a picker).
 */
export function pickWallet(
  wallets: readonly DiscoveredWallet[],
  rememberedRdns?: string,
): DiscoveredWallet | undefined {
  const v4Wallets = wallets.filter((wallet) => wallet.generation === "v4");
  if (v4Wallets.length === 0) {
    return undefined;
  }
  if (rememberedRdns !== undefined) {
    const remembered = v4Wallets.find((wallet) => wallet.rdns === rememberedRdns);
    if (remembered !== undefined) {
      return remembered;
    }
  }
  if (v4Wallets.length === 1) {
    return v4Wallets[0];
  }
  return undefined;
}

/**
 * Build the passive probe (no connection attempt) from the current environment:
 * discover wallets, resolve a selection, leave `connection` unset.
 */
export function detectProbe(options: {
  readonly expectedNetworkId: string;
  readonly rememberedRdns: string | undefined;
}): ConnectProbe {
  const wallets = discoverWallets();
  return {
    expectedNetworkId: options.expectedNetworkId,
    wallets,
    selected: pickWallet(wallets, options.rememberedRdns),
    connection: undefined,
  };
}
