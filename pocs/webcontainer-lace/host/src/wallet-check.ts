/**
 * Wallet-injection check. Runs identically on the host page (localhost
 * control origin) and inside the WebContainer-served DApp (this exact file
 * is mounted into the container at src/wallet-check.ts).
 */

export interface WalletCheckResult {
  origin: string;
  href: string;
  checkedAt: string;
  midnightPresent: boolean;
  /** window.midnight keys, one level deep: key -> keys of that value. */
  midnightKeys: Record<string, string[]>;
  cardanoPresent: boolean;
  cardanoKeys: Record<string, string[]>;
  /** Other window globals whose names look wallet-related. */
  otherWalletGlobals: string[];
}

const WALLET_NAME_RE =
  /midnight|cardano|wallet|lace|nami|eternl|yoroi|flint|gero|typhon|vespr|begin|ethereum|solana|keplr|phantom|metamask|coinbase/i;

// DOM built-ins that happen to contain wallet-ish substrings, e.g.
// SVGFEDispLACEmentMapElement, DyNAMIcsCompressorNode.
const DOM_BUILTIN_RE = /^(SVG|HTML|WebKit|RTC|CSS|IDB|GPU|XR|MIDI)|(Element|Node|Event|Map|List|Worklet|Context|Observer)$/;

function enumerateOneDeep(obj: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return out;
  }
  for (const key of Object.keys(obj as object)) {
    try {
      const value = (obj as Record<string, unknown>)[key];
      if ((value !== null && typeof value === 'object') || typeof value === 'function') {
        const subKeys = Object.keys(value as object).slice(0, 50);
        out[key] = subKeys.length > 0 ? subKeys : [`(${typeof value}, no enumerable keys)`];
      } else {
        out[key] = [`(${typeof value}: ${String(value).slice(0, 80)})`];
      }
    } catch {
      out[key] = ['(inaccessible)'];
    }
  }
  return out;
}

export function runWalletCheck(): WalletCheckResult {
  const w = window as unknown as Record<string, unknown>;

  const midnightPresent = typeof w.midnight !== 'undefined';
  const cardanoPresent = typeof w.cardano !== 'undefined';

  const others: string[] = [];
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name === 'midnight' || name === 'cardano') continue;
    if (WALLET_NAME_RE.test(name) && !DOM_BUILTIN_RE.test(name)) others.push(name);
  }

  return {
    origin: location.origin,
    href: location.href,
    checkedAt: new Date().toISOString(),
    midnightPresent,
    midnightKeys: midnightPresent ? enumerateOneDeep(w.midnight) : {},
    cardanoPresent,
    cardanoKeys: cardanoPresent ? enumerateOneDeep(w.cardano) : {},
    otherWalletGlobals: others,
  };
}
