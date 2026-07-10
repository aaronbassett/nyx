/**
 * Fastify application wiring for the Nyx orchestrator (T015).
 *
 * `buildServer` assembles the HTTP + WS surface from injected dependencies (no
 * process side effects, so it is testable). The bootstrap (index.ts) owns
 * config loading, dependency construction, and `listen`.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { PgSessionAuthStore, registerAuthRoutes } from "./auth/index.js";
import type { AuthDb, SessionAuthStore } from "./auth/index.js";
import type { Config } from "./config/index.js";
import type { Queryable } from "./db/index.js";
import { registerHealthRoutes } from "./http/health.js";
import type { McpClients } from "./mcp/index.js";
import { registerWs } from "./ws/index.js";
import type { WsConnectionHandler } from "./ws/index.js";

export interface ServerDeps {
  readonly config: Config;
  /** DB handle for readiness checks (the db layer owns the pool). */
  readonly db: Queryable;
  readonly mcp: McpClients;
  /** Optional WS handler; T022 supplies the authenticated router. */
  readonly wsHandler?: WsConnectionHandler;
  /**
   * Optional session/nonce store (US5). When omitted, a Postgres-backed store is
   * built from `db` if it supports transactions; a transaction-less stub `db` (the
   * readiness-only test double) simply skips auth-route registration.
   */
  readonly authStore?: SessionAuthStore;
}

/** True when `db` can open a transaction (a real `Db`; not the readiness-only stub). */
function isTransactional(db: Queryable): db is AuthDb {
  return typeof (db as { transaction?: unknown }).transaction === "function";
}

/** Resolve the auth store: an injected one, else a Postgres store if `db` supports it. */
function resolveAuthStore(deps: ServerDeps): SessionAuthStore | undefined {
  if (deps.authStore !== undefined) {
    return deps.authStore;
  }
  return isTransactional(deps.db)
    ? new PgSessionAuthStore(deps.db, {
        sessionLifetimeMs: deps.config.tunables.sessionLifetimeMs,
      })
    : undefined;
}

/** Build a fully-wired (but not-yet-listening) Fastify instance. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(fastifyWebsocket);

  registerHealthRoutes(app, { db: deps.db, mcp: deps.mcp });

  const authStore = resolveAuthStore(deps);
  if (authStore !== undefined) {
    registerAuthRoutes(app, { store: authStore, config: deps.config });
  }

  if (deps.wsHandler === undefined) {
    registerWs(app, "/ws");
  } else {
    registerWs(app, "/ws", deps.wsHandler);
  }

  return app;
}
