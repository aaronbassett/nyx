/**
 * Auth nonce + verify + logout endpoints (T035).
 *
 * Contract (contracts/http-api.md, Auth):
 *   POST /auth/nonce  → { nonce, expiresAt }         — single-use, short expiry, no auth
 *   POST /auth/verify { address, signature, message, verifyingKey }
 *                     → sets the session cookie; auto-creates the account (D43);
 *                       burns the nonce on ANY attempt (FR-034/039; SC-017/018)
 *   POST /auth/logout → immediate server-side invalidation (requires a live session)
 *
 * Verify order (FR-039): parse/validate → extract nonce → atomically burn it →
 * verify signature → verify key↔address binding → account auto-create → issue
 * session. The burn + verify + account-create + session-issue run in one store
 * transaction so the nonce is spent even when verification fails, while the account
 * and session commit only on success.
 */
import type { FastifyInstance } from "fastify";
import { AuthVerifyRequestSchema } from "@nyx/protocol";
import type { AuthLogoutResponse, AuthNonceResponse, AuthVerifyResponse } from "@nyx/protocol";
import type { Config } from "../config/index.js";
import { buildSessionCookie, clearSessionCookie } from "./cookie.js";
import { createRequireSession } from "./middleware.js";
import type { SessionAuthStore } from "./store.js";
import { extractNonce, verifyKeyAddressBinding, verifyMessageSignature } from "./verify.js";

export interface AuthRouteDeps {
  readonly store: SessionAuthStore;
  readonly config: Config;
}

/** Register the auth endpoints on `app`. Side-effect-free; wired from `buildServer`. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const lifetimeMs = deps.config.tunables.sessionLifetimeMs;
  const requireSession = createRequireSession(deps);
  app.decorateRequest("auth", null);

  app.post("/auth/nonce", async (): Promise<AuthNonceResponse> => {
    const nonce = await deps.store.issueNonce();
    return { nonce: nonce.nonce, expiresAt: nonce.expiresAt };
  });

  app.post("/auth/verify", async (request, reply) => {
    const parsed = AuthVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request" };
    }
    const { address, message, signature, verifyingKey } = parsed.data;

    // The nonce is embedded in the signed message; it is the value we burn.
    const nonce = extractNonce(message);
    if (nonce === undefined) {
      reply.code(401);
      return { error: "unauthenticated" };
    }

    const result = await deps.store.issue({
      nonce,
      accountAddress: address,
      // Runs AFTER the atomic burn (FR-039). Both checks must pass: the signature is
      // valid for the key, AND the key hashes to the claimed address (anti-substitution).
      verify: () =>
        verifyMessageSignature({ verifyingKey, message, signature }) &&
        verifyKeyAddressBinding({ verifyingKey, address }),
    });

    if (!result.ok) {
      reply.code(401);
      return { error: "unauthenticated" };
    }

    reply.header("set-cookie", buildSessionCookie(result.sessionId, lifetimeMs));
    const body: AuthVerifyResponse = { address };
    return body;
  });

  app.post(
    "/auth/logout",
    { preHandler: requireSession },
    async (request, reply): Promise<AuthLogoutResponse> => {
      const auth = request.auth;
      if (auth !== null) {
        await deps.store.revoke(auth.sessionId);
      }
      reply.header("set-cookie", clearSessionCookie());
      return {};
    },
  );
}
