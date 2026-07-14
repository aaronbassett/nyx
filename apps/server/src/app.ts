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
import type { DepositStore, LedgerStore } from "./ledger/index.js";
import { registerLedgerRoutes } from "./ledger/routes.js";
import type { McpClients } from "./mcp/index.js";
import { createDeletionCascade, PgProjectStore, registerProjectRoutes } from "./projects/index.js";
import type { DeletionCascade, ProjectStore } from "./projects/index.js";
import { registerProverRoutes } from "./prover/index.js";
import type { ProverClient } from "./prover/index.js";
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
  /**
   * Optional NYXT ledger store (US1/US6). When present alongside {@link ServerDeps.depositStore}
   * and a live session gate, the `GET /ledger` + `POST /deposits` + `GET /deposits/:ref`
   * routes register — otherwise they simply do not, exactly like `projectStore` today.
   */
  readonly ledgerStore?: LedgerStore;
  /** Optional deposit-flow store (US1/US6); pairs with {@link ServerDeps.ledgerStore}. */
  readonly depositStore?: DepositStore;
  /**
   * Optional interim-prover forwarding client (US1/US6, D37). When present alongside a live
   * session gate, the same-origin `POST /prover/prove` proxy registers behind `requireSession`.
   */
  readonly proverClient?: ProverClient;
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

    // Every identity/ownership-scoped route group reuses the SAME session gate; build it
    // once from the resolved auth store and share it. Without a session store there is no
    // way to enforce ownership/identity, so — exactly like auth — these groups register
    // only when the auth store exists (and only when their own store/client is injected).
    const requireSession = createRequireSession({ store: authStore, config: deps.config });

    const projectStore = resolveProjectStore(deps);
    if (projectStore !== undefined) {
      registerProjectRoutes(app, {
        store: projectStore,
        requireSession,
        cascade: deps.projectCascade ?? createDeletionCascade(),
      });
    }

    // Ledger + deposit routes need BOTH stores; register only when both are injected
    // (US1 wires them from `config.tunables`; the readiness-only test double omits them).
    if (deps.ledgerStore !== undefined && deps.depositStore !== undefined) {
      registerLedgerRoutes(app, {
        ledger: deps.ledgerStore,
        deposits: deps.depositStore,
        requireSession,
      });
    }

    // Same-origin prover proxy (D37): cookie-gated, no proving tokens (S9/D52 gate those).
    if (deps.proverClient !== undefined) {
      registerProverRoutes(app, { proverClient: deps.proverClient, requireSession });
    }
  }

  if (deps.wsHandler === undefined) {
    registerWs(app, "/ws");
  } else {
    registerWs(app, "/ws", deps.wsHandler);
  }

  return app;
}
