/**
 * Session middleware — 7-day sliding resume (T036).
 *
 * {@link createRequireSession} is a Fastify `preHandler` that resolves the session
 * cookie to an account and REFRESHES it: on every authenticated request it slides
 * the server-side expiry forward (D44) and re-sends the cookie with a fresh Max-Age
 * so the client cookie slides in step. This is the session-RESUME path — it touches
 * only the session store and never any signing/wallet code (SC-019: resuming a valid
 * session requires zero wallet interactions; there is no wallet on the server).
 *
 * Missing, invalid, expired, or revoked cookies are rejected 401 and the stale
 * cookie is cleared. A store failure (e.g. a malformed cookie that is not a valid
 * session id) is treated as unauthenticated, mirroring the WS layer's posture.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../config/index.js";
import { readSessionCookie } from "../protocol/cookies.js";
import type { Session } from "../protocol/session.js";
import { buildSessionCookie, clearSessionCookie } from "./cookie.js";
import type { SessionAuthStore } from "./store.js";

/** The authenticated identity a resumed request carries. */
export interface SessionAuth {
  readonly sessionId: string;
  readonly address: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by {@link createRequireSession} on a resumed request; `null` otherwise. */
    auth: SessionAuth | null;
  }
}

export interface RequireSessionDeps {
  readonly store: SessionAuthStore;
  readonly config: Config;
}

function rejectUnauthenticated(reply: FastifyReply): void {
  reply.header("set-cookie", clearSessionCookie());
  reply.code(401).send({ error: "unauthenticated" });
}

/**
 * Build a `preHandler` that requires — and slides — a valid session. On success it
 * sets `request.auth` and refreshes the cookie; otherwise it responds 401 and clears
 * the cookie, halting the request.
 */
export function createRequireSession(deps: RequireSessionDeps): preHandlerAsyncHookHandler {
  const lifetimeMs = deps.config.tunables.sessionLifetimeMs;

  return async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId === undefined) {
      rejectUnauthenticated(reply);
      return;
    }

    let session: Session | null;
    try {
      session = await deps.store.slide(sessionId);
    } catch (error) {
      request.log.warn({ err: error }, "auth: session slide failed");
      rejectUnauthenticated(reply);
      return;
    }

    if (session === null) {
      rejectUnauthenticated(reply);
      return;
    }

    request.auth = { sessionId, address: session.accountAddress };
    reply.header("set-cookie", buildSessionCookie(sessionId, lifetimeMs));
  };
}
