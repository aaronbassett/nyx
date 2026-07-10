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
import { createRequireSession, PgSessionAuthStore, registerAuthRoutes } from "./auth/index.js";
import type { AuthDb, SessionAuthStore } from "./auth/index.js";
import type { Config } from "./config/index.js";
import type { Queryable } from "./db/index.js";
import { registerHealthRoutes } from "./http/health.js";
import type { McpClients } from "./mcp/index.js";
import { createDeletionCascade, PgProjectStore, registerProjectRoutes } from "./projects/index.js";
import type { DeletionCascade, ProjectStore } from "./projects/index.js";
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
  /**
   * Optional project persistence store (US7). Resolved exactly like `authStore`: an
   * injected store, else a Postgres-backed one when `db` is transactional. Project
   * routes register only alongside a live session gate (they reuse `requireSession`).
   */
  readonly projectStore?: ProjectStore;
  /** Optional soft-delete cascade (US7); defaults to the no-op seams for now (D49). */
  readonly projectCascade?: DeletionCascade;
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

/** Resolve the project store: an injected one, else a Postgres store if `db` supports it. */
function resolveProjectStore(deps: ServerDeps): ProjectStore | undefined {
  if (deps.projectStore !== undefined) {
    return deps.projectStore;
  }
  const { tunables } = deps.config;
  return isTransactional(deps.db)
    ? new PgProjectStore(deps.db, {
        maxFileBytes: tunables.maxFileBytes,
        maxProjectBytes: tunables.maxProjectBytes,
        projectQuotaPerAccount: tunables.projectQuotaPerAccount,
        versionRetentionCount: tunables.versionRetentionCount,
        versionRetentionDays: tunables.versionRetentionDays,
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

    // Project routes reuse the session gate; build it once from the resolved auth store
    // and share it. Without a session store there is no way to enforce ownership, so —
    // exactly like auth — project routes register only when the auth store exists.
    const projectStore = resolveProjectStore(deps);
    if (projectStore !== undefined) {
      const requireSession = createRequireSession({ store: authStore, config: deps.config });
      registerProjectRoutes(app, {
        store: projectStore,
        requireSession,
        cascade: deps.projectCascade ?? createDeletionCascade(),
      });
    }
  }

  if (deps.wsHandler === undefined) {
    registerWs(app, "/ws");
  } else {
    registerWs(app, "/ws", deps.wsHandler);
  }

  return app;
}
