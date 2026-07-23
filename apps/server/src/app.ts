/**
 * Fastify application wiring for the Nyx orchestrator (T015).
 *
 * `buildServer` assembles the HTTP + WS surface from injected dependencies (no
 * process side effects, so it is testable). The bootstrap (index.ts) owns
 * config loading, dependency construction, and `listen`.
 */
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createInMemoryArtifactStore, registerArtifactRoutes } from "./artifacts/index.js";
import type { ArtifactStore } from "./artifacts/index.js";
import { createRequireSession, PgSessionAuthStore, registerAuthRoutes } from "./auth/index.js";
import type { AuthDb, SessionAuthStore } from "./auth/index.js";
import type { Config } from "./config/index.js";
import type { Queryable } from "./db/index.js";
import type { DeployHandler } from "./deploy/handler.js";
import type { DeployRegistry } from "./deploy/registry.js";
import { registerDeployRoutes } from "./deploy/routes.js";
import { registerHealthRoutes } from "./http/health.js";
import type { DepositStore, LedgerStore } from "./ledger/index.js";
import { registerLedgerRoutes } from "./ledger/routes.js";
import type { McpClients } from "./mcp/index.js";
import {
  createCloneService,
  createDeletionCascade,
  createInMemoryRepoCache,
  createTokenBucketLimiter,
  PgProjectStore,
  registerGitHttpRoutes,
  registerProjectRoutes,
} from "./projects/index.js";
import type { CloneService, DeletionCascade, ProjectStore } from "./projects/index.js";
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
   * Optional artifact store (P2 browser-compile). When a project store + live session gate
   * exist, the artifact upload (PUT/commit) + public serve (GET) routes register against it.
   * Defaults to an in-memory store so existing fixtures stay green; `index.ts` should inject a
   * durable {@link createLocalArtifactStore} (with size caps + a rootDir) for real deployments.
   */
  readonly artifactStore?: ArtifactStore;
  /**
   * Optional clone/handoff service (US13). When omitted, a default is constructed from the
   * resolved project store + config rate-limit tunables (ONE shared repo cache + limiter for
   * the process). `index.ts` injects one explicitly so the same instance backs both the
   * session-gated handoff routes and the token-gated git-HTTP scope.
   */
  readonly cloneService?: CloneService;
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
  /**
   * Optional deploy registry (US8). When present alongside a resolvable project store + a live
   * session gate, `GET /projects/:id/deploys` registers (behind ownership, SC-027), AND the D49
   * deletion cascade's contract-teardown seam is back-filled from `teardownProject` (T158/FR-052,
   * OFF-CHAIN — T155), replacing the US7 no-op stub.
   */
  readonly deployRegistry?: Pick<DeployRegistry, "listDeploys" | "teardownProject">;
  /**
   * Optional deploy request handler (US8). Its `deploy:request` handler reaches the WS router ONLY
   * through the COMBINED `wsHandler` (`index.ts` merges `coordinator.handlers` +
   * `deployHandler.handlers` into the single `/ws` router — the WS route takes exactly one
   * handler), NOT via a separate registration here. Accepted so the full deploy wiring is
   * expressed in one `buildServer` call; buildServer only sanity-checks it is reachable.
   */
  readonly deployHandler?: DeployHandler;
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

/**
 * Resolve the clone/handoff service: an injected one (index.ts shares a single process-wide
 * instance), else a default built from the project store + config rate-limit tunables. The
 * default's repo cache + token bucket are scoped to this server instance, which is exactly
 * what the deterministic route tests need (they inject their own when they must control it).
 */
function resolveCloneService(deps: ServerDeps, store: ProjectStore): CloneService {
  if (deps.cloneService !== undefined) {
    return deps.cloneService;
  }
  const { tunables } = deps.config;
  return createCloneService({
    store,
    rateLimiter: createTokenBucketLimiter({
      capacity: tunables.cloneRateCapacity,
      refillTokens: tunables.cloneRateRefill,
      intervalMs: tunables.cloneRateIntervalMs,
      clock: () => Date.now(),
    }),
    cache: createInMemoryRepoCache(),
  });
}

/**
 * Mask the clone token in a request URL for logging. A URL of the form /git/TOKEN/info/refs
 * becomes /git/***\/info/refs. The clone token is a BEARER credential carried in the URL PATH
 * (D58), so the default request logger would otherwise write it verbatim on every clone. Only
 * the token segment is masked; all other URLs pass through unchanged.
 */
export function maskCloneToken(url: string): string {
  return url.replace(/(\/git\/)[^/?#]+/, "$1***");
}

/**
 * Fastify server options (exported so the hardening is unit-testable without capturing logs):
 *  - trustProxy: Nyx runs behind Fly's trusted edge, so request.ip must reflect the real client
 *    via X-Forwarded-For rather than the proxy; otherwise the EC-55 per-IP clone rate-limit
 *    bucket collapses to a single global bucket.
 *  - logger.serializers.req: masks the clone-token path segment (a bearer-in-URL credential) in
 *    every logged request line.
 */
export const serverOptions: FastifyServerOptions = {
  trustProxy: true,
  logger: {
    serializers: {
      req: (request: FastifyRequest) => {
        const remotePort = request.socket.remotePort;
        return {
          method: request.method,
          url: maskCloneToken(request.url),
          host: request.hostname,
          remoteAddress: request.ip,
          // Only when defined: `exactOptionalPropertyTypes` forbids an explicit `undefined`.
          ...(remotePort === undefined ? {} : { remotePort }),
        };
      },
    },
  },
};

/** Build a fully-wired (but not-yet-listening) Fastify instance. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify(serverOptions);

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
      // D49 deletion cascade: an injected cascade wins; otherwise build the default and BACK-FILL
      // the T158/FR-052 contract-teardown seam from the deploy registry (OFF-CHAIN — T155: flip
      // the project's live deploy rows to `torn_down`; the on-chain contracts persist). Replaces
      // the US7 no-op stub. With no registry the teardown stays a no-op (nothing to tear down).
      const deployRegistry = deps.deployRegistry;
      const cascade =
        deps.projectCascade ??
        createDeletionCascade(
          deployRegistry === undefined
            ? {}
            : {
                teardownContracts: async (projectId: string): Promise<void> => {
                  await deployRegistry.teardownProject(projectId);
                },
              },
        );
      // US13 handoff: ONE clone service backs both the session-gated archive/clone-token
      // routes and the token-gated git-HTTP scope, so they share a rate limiter + repo cache.
      const cloneService = resolveCloneService(deps, projectStore);
      registerProjectRoutes(app, { store: projectStore, requireSession, cascade, cloneService });

      // P2 browser-compile artifact routes: session+ownership-gated PUT/commit uploads and the
      // public (session-less) content-addressed GET. Co-registered with the project routes
      // because the write routes resolve ownership through the project store; the GET carries no
      // session gate (unguessable content-hash prefixes are the access control). An in-memory
      // store is the default so existing fixtures need no change (see ServerDeps.artifactStore).
      const artifacts = deps.artifactStore ?? createInMemoryArtifactStore();
      registerArtifactRoutes(app, { store: projectStore, artifacts, requireSession });

      // Token-gated (NOT session-gated) smart-HTTP git surface. Registered as a SEPARATE
      // encapsulated scope (like the prover proxy) because `handleGitHttp` enforces the token +
      // rate limit + soft-delete itself — `requireSession` must NOT gate it (a `git clone`
      // carries no session cookie, only the clone token in the path).
      registerGitHttpRoutes(app, { cloneService });

      // Deploy reads (US8): `GET /projects/:id/deploys`, behind the same session gate + ownership.
      // Registers only when BOTH the registry and a project store are present — ownership resolves
      // through the store (SC-027 fail-closed), so a deploy list is never served unauthorized.
      if (deployRegistry !== undefined) {
        registerDeployRoutes(app, {
          registry: deployRegistry,
          requireSession,
          resolveOwnedProject: async (id, address) => {
            const project = await projectStore.getProject(id);
            return project?.ownerAddress === address;
          },
        });
      }
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

  // The deploy WS handler is only reachable through the COMBINED `wsHandler` (index.ts merges it
  // with the turn coordinator's handlers onto the single `/ws` router). A `deployHandler` supplied
  // WITHOUT a `wsHandler` would mean `deploy:request` is never registered — surface that loudly
  // (never silently) rather than let it be a silent gap.
  if (deps.deployHandler !== undefined && deps.wsHandler === undefined) {
    app.log.warn(
      "deployHandler supplied without a wsHandler; deploy:request will not be registered",
    );
  }

  return app;
}
