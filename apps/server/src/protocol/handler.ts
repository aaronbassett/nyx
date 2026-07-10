/**
 * Authenticated, typed WebSocket connection handler (T022).
 *
 * This is the real handler that replaces the bare-accept seam in `../ws`. Per
 * connection it:
 *   1. reads the session cookie from the upgrade request and validates it via an
 *      injected {@link SessionStore} — invalid/missing/expired/revoked closes the
 *      socket with a clear reason (it is never accepted as authenticated);
 *   2. takes the target `projectId` from the `?projectId=` query — absent closes;
 *   3. enforces single-live-session takeover (D40): a new connection for an
 *      (account, project) that already has a live socket sends the prior one
 *      `session:takeover` and closes it, then becomes the live socket;
 *   4. routes every inbound frame through the typed {@link EventRouter}.
 *
 * SEAM (US7): project OWNERSHIP authorization — does this account own this
 * project — is out of scope here. {@link WsHandlerOptions.authorizeProject}
 * defaults to allow-all; US7 supplies the real check without touching this file.
 */
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { FastifyRequest } from "fastify";
import type { ServerToClientEvent } from "@nyx/protocol";
import type { Config } from "../config/index.js";
import type { WsConnectionHandler } from "../ws/index.js";
import { readSessionCookie } from "./cookies.js";
import { createSessionRegistry, sessionKey } from "./registry.js";
import type { SessionRegistry } from "./registry.js";
import { createEventRouter, sendEvent } from "./router.js";
import type { ConnectionContext, EventRouter } from "./router.js";
import type { Session, SessionStore } from "./session.js";

/**
 * Application WebSocket close codes (4000–4999 is the private-use range). A
 * closed socket's reason names why, so the client can render the right banner.
 */
export const WS_CLOSE = {
  /** No/invalid/expired/revoked session cookie. */
  UNAUTHENTICATED: 4401,
  /** Malformed connect request (e.g. missing `projectId`). */
  BAD_REQUEST: 4400,
  /** Authenticated, but not authorized for the project (US7). */
  FORBIDDEN: 4403,
  /** Displaced by a newer live session for the same (account, project) (D40). */
  SESSION_TAKEOVER: 4409,
  /** Unexpected socket-level fault. */
  INTERNAL: 4500,
} as const;

/**
 * Project-ownership authorization seam (US7). Return `false` to reject an
 * otherwise-authenticated connection for `projectId`.
 */
export type ProjectAuthorizer = (session: Session, projectId: string) => boolean | Promise<boolean>;

export interface WsHandlerOptions {
  /** Resolves + validates the session cookie (injectable for tests). */
  readonly sessionStore: SessionStore;
  /** Boot config (reserved for later stories; the handler reads none of it yet). */
  readonly config: Config;
  /** Register per-type client → server handlers on the router (T024 + later stories). */
  readonly handlers?: (router: EventRouter) => void;
  /** Takeover registry; injectable for tests (default: a fresh in-memory one). */
  readonly registry?: SessionRegistry<WebSocket>;
  /** US7 project-ownership check; default allow-all. */
  readonly authorizeProject?: ProjectAuthorizer;
  /** Clock seam for the takeover event timestamp (determinism in tests). */
  readonly now?: () => number;
}

/** Read `projectId` from the upgrade request's query string. */
function readProjectId(url: string): string | undefined {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return undefined;
  }
  const projectId = new URLSearchParams(url.slice(queryStart + 1)).get("projectId");
  return projectId === null || projectId === "" ? undefined : projectId;
}

/** Decode a `ws` frame to UTF-8 text (frames are JSON; binary is unexpected). */
function frameToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

/** Close a socket, tolerating the case where it is already closing/closed. */
function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Closing an already-terminal socket can throw; the outcome is the same.
  }
}

/** Build the `session:takeover` server → client event. */
function takeoverEvent(ts: number): ServerToClientEvent {
  return { type: "session:takeover", payload: {}, ts };
}

/**
 * Build the authenticated, typed WS connection handler. The returned function is
 * the {@link WsConnectionHandler} `buildServer` registers on `/ws`.
 */
export function createWsHandler(options: WsHandlerOptions): WsConnectionHandler {
  const { sessionStore } = options;
  const registry = options.registry ?? createSessionRegistry<WebSocket>();
  const authorizeProject: ProjectAuthorizer = options.authorizeProject ?? (() => true);
  const now = options.now ?? ((): number => Date.now());

  const router = createEventRouter();
  options.handlers?.(router);

  async function onConnection(socket: WebSocket, request: FastifyRequest): Promise<void> {
    // 1. Cookie → session.
    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId === undefined) {
      closeSocket(socket, WS_CLOSE.UNAUTHENTICATED, "no session cookie");
      return;
    }

    let session: Session | null;
    try {
      session = await sessionStore.get(sessionId);
    } catch (error) {
      request.log.warn({ err: error }, "ws: session lookup failed");
      closeSocket(socket, WS_CLOSE.UNAUTHENTICATED, "session lookup failed");
      return;
    }
    if (session === null) {
      closeSocket(socket, WS_CLOSE.UNAUTHENTICATED, "invalid session");
      return;
    }

    // 2. Target project.
    const projectId = readProjectId(request.url);
    if (projectId === undefined) {
      closeSocket(socket, WS_CLOSE.BAD_REQUEST, "missing projectId");
      return;
    }

    // 3. US7 ownership seam (default allow-all).
    const allowed = await Promise.resolve(authorizeProject(session, projectId));
    if (!allowed) {
      closeSocket(socket, WS_CLOSE.FORBIDDEN, "project not authorized");
      return;
    }

    // The client may have gone away while auth was in flight.
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // 4. Single-live-session takeover (D40, last-tab-wins).
    const key = sessionKey(session.accountAddress, projectId);
    const prior = registry.claim(key, socket);
    if (prior !== undefined && prior !== socket) {
      sendEvent(prior, takeoverEvent(now()));
      closeSocket(prior, WS_CLOSE.SESSION_TAKEOVER, "session superseded (D40)");
    }

    // 5. Wire the typed router + lifecycle.
    const ctx: ConnectionContext = {
      session,
      projectId,
      send: (event) => {
        sendEvent(socket, event);
      },
      close: (code, reason) => {
        closeSocket(socket, code, reason);
      },
    };

    socket.on("message", (data: RawData) => {
      const outcome = router.dispatch(frameToText(data), ctx);
      if (outcome.status !== "dispatched") {
        request.log.warn({ outcome }, "ws: inbound frame not dispatched");
      }
    });
    socket.on("error", (error) => {
      request.log.warn({ err: error }, "ws: socket error");
      closeSocket(socket, WS_CLOSE.INTERNAL, "socket error");
    });
    socket.on("close", () => {
      registry.release(key, socket);
    });
  }

  return (socket, request) => {
    void onConnection(socket, request);
  };
}
