/**
 * Session cookie construction for the auth layer (T036).
 *
 * The session id travels in a hardened cookie (FR-036): HttpOnly (no JS access),
 * Secure (HTTPS only), SameSite=Lax, Path=/. SameSite=Lax — not Strict — is a
 * deliberate choice: it blocks the cookie on cross-site POST (CSRF defence, and
 * every state-changing auth endpoint is POST) while still sending it on top-level
 * cross-site GET navigations into the app (shareable links, the escape-hatch
 * preview tab). Max-Age carries the 7-day sliding lifetime and is refreshed on each
 * authenticated request so the client cookie slides in step with the server session.
 */
import { stringifySetCookie } from "cookie";
import { SESSION_COOKIE_NAME } from "../protocol/session.js";

/** Build the `Set-Cookie` value that persists a session for `lifetimeMs`. */
export function buildSessionCookie(sessionId: string, lifetimeMs: number): string {
  return stringifySetCookie({
    name: SESSION_COOKIE_NAME,
    value: sessionId,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(lifetimeMs / 1000),
  });
}

/** Build the `Set-Cookie` value that clears the session cookie (Max-Age=0). */
export function clearSessionCookie(): string {
  return stringifySetCookie({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
