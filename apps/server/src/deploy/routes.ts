/**
 * Deploy read routes (T156/US8, FR-057) — `GET /projects/:id/deploys`.
 *
 * Deploy *requests* travel over WS (`deploy:request`, `deploy/handler.ts`); this HTTP route is the
 * AUTHORITATIVE read side: the registry's full deploy history for a project, newest-first, exactly
 * one row `active` (SC-032). It is the canonical source of a deploy's outcome even when a live
 * `deploy:status`/`contract:deployed` frame was dropped (e.g. a mid-deploy D40 takeover routed the
 * later frames to a now-dead socket) — the deploy still completed + recorded server-side, and this
 * route surfaces it.
 *
 * Behind the SAME session gate as every identity-scoped route (`requireSession`) AND an OWNERSHIP
 * check on the unshielded address (D43): a project the caller does not own — or that does not
 * exist — answers 404, so ownership never leaks a project's existence (SC-027, mirroring
 * `projects/routes.ts`). Ownership is resolved through the injected {@link OwnedProjectResolver}
 * seam; it FAILS CLOSED — with no resolver the route can't verify ownership, so it denies (a deploy
 * read must never bypass the gate).
 *
 * `version` is a `bigint` in code and a decimal STRING on the wire: the rows are encoded with
 * `encodeDeployRegistryRow` so the response is JSON-safe ({@link ListDeploysResponse}).
 */
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { encodeDeployRegistryRow } from "@nyx/protocol";
import type { DeployRegistry } from "./registry.js";

/**
 * Ownership seam (SC-027): resolve whether `address` owns the EXISTING project `id`. A missing
 * AND a not-owned project both resolve `false` so the route 404s either way (existence never
 * leaks). `buildServer` builds this from the resolved project store.
 */
export type OwnedProjectResolver = (projectId: string, address: string) => Promise<boolean>;

export interface DeployRouteDeps {
  /** The deploy registry read surface — only `listDeploys` is used by this route. */
  readonly registry: Pick<DeployRegistry, "listDeploys">;
  /** Built once in `buildServer` from the resolved auth store and shared here. */
  readonly requireSession: preHandlerAsyncHookHandler;
  /**
   * Ownership resolver (SC-027). Optional so `buildServer`'s optional-DI keeps compiling; when
   * ABSENT the route fails closed (every read 404s) — it never serves a deploy list it cannot
   * ownership-check. `buildServer` always injects it when the route is registered.
   */
  readonly resolveOwnedProject?: OwnedProjectResolver;
}

/** Register `GET /projects/:id/deploys`. Side-effect-free. */
export function registerDeployRoutes(app: FastifyInstance, deps: DeployRouteDeps): void {
  const { registry, requireSession, resolveOwnedProject } = deps;

  app.get<{ Params: { id: string } }>(
    "/projects/:id/deploys",
    { preHandler: requireSession },
    async (request, reply) => {
      // `requireSession` already 401s + halts an anonymous request; this is the defensive
      // narrowing (mirrors `projects/routes.ts`) — `request.auth` is non-null past the gate.
      const auth = request.auth;
      if (auth === null) {
        reply.code(401);
        return { error: "unauthenticated" };
      }
      const id = request.params.id;
      // Ownership (SC-027): missing OR not-owned both 404 so existence never leaks. Fail closed
      // when no resolver is wired — a deploy read must never bypass the ownership gate.
      const owned =
        resolveOwnedProject !== undefined && (await resolveOwnedProject(id, auth.address));
      if (!owned) {
        reply.code(404);
        return { error: "project not found", projectId: id };
      }
      const rows = await registry.listDeploys(id);
      // Encode each row to its JSON-safe wire form (bigint `version` → decimal string).
      return rows.map(encodeDeployRegistryRow);
    },
  );
}
