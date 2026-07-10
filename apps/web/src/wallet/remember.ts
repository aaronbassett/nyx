/**
 * US5 wallet-connect layer — remembered wallet choice (EC-26).
 *
 * Persists the rdns of the wallet a multi-wallet user picked, so subsequent
 * visits skip the picker. Storage is best-effort and defensive: private-mode /
 * disabled storage must not throw into the connect flow.
 */

const STORAGE_KEY = "nyx.wallet.rdns";

/** Return the browser's localStorage, or `undefined` where it is unavailable. */
function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Load the remembered wallet rdns, or `undefined` when none is stored. */
export function loadRememberedWalletRdns(): string | undefined {
  const storage = safeStorage();
  if (storage === undefined) {
    return undefined;
  }
  try {
    return storage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remember `rdns` as the user's chosen wallet (best-effort). */
export function rememberWalletRdns(rdns: string): void {
  const storage = safeStorage();
  if (storage === undefined) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, rdns);
  } catch {
    // Ignore quota / privacy-mode failures — remembering is best-effort.
  }
}

/** Forget any remembered wallet choice (best-effort). */
export function forgetRememberedWallet(): void {
  const storage = safeStorage();
  if (storage === undefined) {
    return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore privacy-mode failures — forgetting is best-effort.
  }
}
