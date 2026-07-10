/**
 * WS session + protocol layer (T022): public surface.
 *
 * The authenticated, typed WebSocket connection handler and the pieces it (and
 * later stories) compose from — the session store, the takeover registry, and
 * the typed event router.
 */
export { SESSION_COOKIE_NAME, PgSessionStore } from "./session.js";
export type { Session, SessionStore } from "./session.js";
export { readSessionCookie } from "./cookies.js";
export { createSessionRegistry, sessionKey } from "./registry.js";
export type { SessionRegistry } from "./registry.js";
export { createEventRouter, sendEvent, serializeEvent } from "./router.js";
export type {
  ConnectionContext,
  ClientEventHandler,
  DispatchOutcome,
  EventRouter,
  Sendable,
} from "./router.js";
export { createWsHandler, WS_CLOSE } from "./handler.js";
export type { ProjectAuthorizer, WsHandlerOptions } from "./handler.js";
