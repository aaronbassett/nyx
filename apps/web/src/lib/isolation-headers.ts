/**
 * Cross-origin isolation headers (FR-021 / R6).
 *
 * The Nyx web app runs an in-browser WebContainer, which needs
 * `SharedArrayBuffer` and therefore a cross-origin-isolated browsing context.
 * Every response must advertise the strict COOP/COEP pair EXCEPT the
 * escape-hatch bridge route (`/webcontainer/connect/*`, consumed by Story 9),
 * which must be served WITHOUT isolation so the bridged window can talk to a
 * non-isolated opener.
 *
 * This module is intentionally dependency-free and runtime-agnostic so it can
 * be imported by both the Vite middleware (dev + preview) and unit tests. The
 * decision lives in the single pure function `isolationHeadersFor`.
 */

/** The COOP/COEP pair a single response must carry. */
export interface IsolationHeaders {
  readonly "Cross-Origin-Embedder-Policy": "require-corp" | "unsafe-none";
  readonly "Cross-Origin-Opener-Policy": "same-origin" | "unsafe-none";
}

/**
 * Path prefix for the escape-hatch bridge route. The exact path, and anything
 * strictly nested under it, is served without cross-origin isolation.
 */
const CONNECT_BRIDGE_PREFIX = "/webcontainer/connect";

/**
 * True when `pathname` is the connect-bridge route or a descendant of it.
 *
 * Matches `/webcontainer/connect` exactly and any path under
 * `/webcontainer/connect/…`, but NOT sibling paths that merely share the prefix
 * as a substring (e.g. `/webcontainer/connection`).
 */
function isConnectBridgePath(pathname: string): boolean {
  return pathname === CONNECT_BRIDGE_PREFIX || pathname.startsWith(`${CONNECT_BRIDGE_PREFIX}/`);
}

/**
 * Pure decision function: given a request pathname, return the COOP/COEP pair
 * that response must carry.
 *
 * - `/webcontainer/connect` and anything under it → `unsafe-none` / `unsafe-none`
 * - everything else → `require-corp` / `same-origin`
 */
export function isolationHeadersFor(pathname: string): IsolationHeaders {
  if (isConnectBridgePath(pathname)) {
    return {
      "Cross-Origin-Embedder-Policy": "unsafe-none",
      "Cross-Origin-Opener-Policy": "unsafe-none",
    };
  }
  return {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
