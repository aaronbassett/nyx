// DApp Connector detection + connection.
//
// The connector v4 injects `window.midnight` as a map of UUID -> InitialAPI,
// where InitialAPI = { rdns, name, icon, apiVersion, connect(networkId) }.
// (Older generations injected a map of name -> { enable(), isEnabled(),
// serviceUriConfig(), ... } with no `connect`. We detect and report which
// generation is present, because that is itself evidence for discovery Q2.)

import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { log } from "@/lib/logger";

const SCOPE = "connector";

export interface DiscoveredWallet {
  key: string; // the UUID (v4) or name (legacy) key under window.midnight
  rdns?: string;
  name: string;
  apiVersion?: string;
  icon?: string;
  generation: "v4" | "legacy" | "unknown";
  raw: unknown;
}

/** Snapshot every wallet injected under window.midnight, with its shape. */
export function discoverWallets(): DiscoveredWallet[] {
  const mid = (window as unknown as { midnight?: Record<string, unknown> }).midnight;
  if (!mid || typeof mid !== "object") {
    log.warn(SCOPE, "window.midnight is not present. Is a Midnight wallet (Lace) installed and enabled?");
    return [];
  }
  const keys = Object.keys(mid);
  log.info(SCOPE, `window.midnight present with ${keys.length} injected entr${keys.length === 1 ? "y" : "ies"}`, keys);

  const wallets: DiscoveredWallet[] = [];
  for (const key of keys) {
    const entry = mid[key] as Record<string, unknown>;
    const hasConnect = typeof entry?.connect === "function";
    const hasEnable = typeof entry?.enable === "function";
    const generation: DiscoveredWallet["generation"] = hasConnect ? "v4" : hasEnable ? "legacy" : "unknown";
    const w: DiscoveredWallet = {
      key,
      rdns: typeof entry?.rdns === "string" ? (entry.rdns as string) : undefined,
      name: typeof entry?.name === "string" ? (entry.name as string) : key,
      apiVersion: typeof entry?.apiVersion === "string" ? (entry.apiVersion as string) : undefined,
      icon: typeof entry?.icon === "string" ? (entry.icon as string) : undefined,
      generation,
      raw: {
        keysOnEntry: Object.keys(entry ?? {}),
        hasConnect,
        hasEnable,
      },
    };
    wallets.push(w);
    log.info(
      SCOPE,
      `wallet [${w.name}] rdns=${w.rdns ?? "?"} apiVersion=${w.apiVersion ?? "?"} generation=${generation}`,
      w.raw,
    );
  }
  return wallets;
}

/** Choose the Lace/Midnight wallet, preferring one that looks like Lace. */
export function pickWallet(wallets: DiscoveredWallet[]): DiscoveredWallet | undefined {
  if (wallets.length === 0) return undefined;
  const laceish = wallets.find(
    (w) =>
      /lace/i.test(w.name) ||
      /lace/i.test(w.rdns ?? "") ||
      /midnight/i.test(w.rdns ?? ""),
  );
  const chosen = laceish ?? wallets[0];
  log.info(SCOPE, `selected wallet: ${chosen.name} (${chosen.generation})`);
  return chosen;
}

export interface ConnectResult {
  wallet: DiscoveredWallet;
  api: ConnectedAPI;
  /** THE Q2 capability probe: does the connected API expose in-wallet proving? */
  supportsInWalletProving: boolean;
}

/**
 * Connect to the chosen wallet on the given network and probe capabilities.
 * Throws (with a logged reason) if the wallet is legacy / cannot connect.
 */
export async function connect(wallet: DiscoveredWallet, networkId: string): Promise<ConnectResult> {
  const mid = (window as unknown as { midnight?: Record<string, unknown> }).midnight!;
  const entry = mid[wallet.key] as unknown as InitialAPI;

  if (typeof entry.connect !== "function") {
    log.error(
      SCOPE,
      `wallet "${wallet.name}" does not expose connect(networkId) — it is a ${wallet.generation} connector. ` +
        `The v4 in-wallet proving API (getProvingProvider) is only available on v4 connectors.`,
    );
    throw new Error(`Wallet "${wallet.name}" is not a connector-v4 wallet (no connect()).`);
  }

  log.call(SCOPE, `connect('${networkId}') — requesting authorization from the wallet…`);
  const api = await entry.connect(networkId);
  log.success(SCOPE, `authorized by ${wallet.name}`);

  const supportsInWalletProving = typeof (api as { getProvingProvider?: unknown }).getProvingProvider === "function";
  if (supportsInWalletProving) {
    log.success(
      SCOPE,
      "capability probe: getProvingProvider() IS present → wallet advertises IN-WALLET proving (connector v4).",
    );
  } else {
    log.warn(
      SCOPE,
      "capability probe: getProvingProvider() is ABSENT → this wallet does NOT advertise in-wallet proving; " +
        "proving would fall back to a proof server.",
    );
  }

  return { wallet, api, supportsInWalletProving };
}
