/**
 * Cookie parsing for the WS upgrade request (T022).
 *
 * The WebSocket handshake is a plain HTTP GET, so the session cookie arrives in
 * the `Cookie` request header. This module extracts exactly the session cookie
 * value; it does not set cookies (issuance is US5).
 */
import { parseCookie } from "cookie";
import { SESSION_COOKIE_NAME } from "./session.js";

/**
 * Read the session id from a raw `Cookie` header. Returns `undefined` when the
 * header is absent or the session cookie is missing/empty, so the caller can
 * treat "no cookie" and "empty cookie" identically as unauthenticated.
 */
export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader === "") {
    return undefined;
  }
  const jar = parseCookie(cookieHeader);
  const value = jar[SESSION_COOKIE_NAME];
  return value === undefined || value === "" ? undefined : value;
}
