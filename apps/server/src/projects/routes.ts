/**
 * Project persistence + rehydration HTTP routes (T052/T054/T055).
 *
 * Contract (contracts/http-api.md, "Projects & files"):
 *   GET    /projects                    → the caller's live projects
 *   POST   /projects { name }           → create (per-account count quota, D49)
 *   PATCH  /projects/:id { name }       → rename
 *   DELETE /projects/:id                → soft-delete + immediate ephemeral cascade (D49)
 *   POST   /projects/:id/restore        → restore within the 30-day window (D49)
 *   GET    /projects/:id/manifest       → (path, contentHash)[] convergence surface (D38)
 *   GET    /projects/:id/files/*        → current content at the latest version
 *   GET    /projects/:id/chat           → chat history for rehydration (D23)
 *
 * Every route requires a live session (the injected `requireSession` preHandler) AND
 * ownership on the unshielded address (D43): a project the caller does not own — or
 * that does not exist — answers 404, so ownership never leaks a project's existence
 * (SC-027). File WRITES are NOT here: agent turns and user edits commit through the
 * store from the turn/editor layer; US7 exposes only reads + lifecycle.
 */
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { CreateProjectRequestSchema, UpdateProjectRequestSchema } from "@nyx/protocol";
import type { Project } from "@nyx/protocol";
import type { SessionAuth } from "../auth/index.js";
import {
  FileTooLargeError,
  ProjectCountQuotaExceededError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "./errors.js";
import type { DeletionCascade } from "./lifecycle.js";
import type { ProjectStore } from "./store.js";

export interface ProjectRouteDeps {
  readonly store: ProjectStore;
  /** Built once in `buildServer` from the resolved auth store and shared here. */
  readonly requireSession: preHandlerAsyncHookHandler;
  /** The immediate ephemeral teardown fired on soft-delete (D49). */
  readonly cascade: DeletionCascade;
}

/**
 * Resolve the `:id` project the caller is authorized to touch, or send the correct
 * rejection and return `null`. 401 when unauthenticated; 404 when missing OR owned by
 * someone else (existence is never leaked, SC-027).
 */
async function loadOwned(
  store: ProjectStore,
  auth: SessionAuth | null,
  id: string,
  reply: FastifyReply,
): Promise<Project | null> {
  if (auth === null) {
    reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  const project = await store.getProject(id);
  if (project?.ownerAddress === auth.address) {
    return project;
  }
  // 404 (not 403) for both missing AND not-owned, so existence never leaks (SC-027).
  reply.code(404).send({ error: "project not found", projectId: id });
  return null;
}

/** Map a named store error to its HTTP status + body, or rethrow (→ 500) if unknown. */
function handleStoreError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ProjectNotFoundError) {
    reply.code(404).send({ error: "project not found", projectId: error.projectId });
    return;
  }
  if (error instanceof ProjectCountQuotaExceededError) {
    reply.code(409).send({ error: "project quota exceeded", limit: error.limit });
    return;
  }
  if (error instanceof RestoreWindowExpiredError) {
    reply.code(410).send({ error: "restore window expired", projectId: error.projectId });
    return;
  }
  if (error instanceof FileTooLargeError) {
    reply.code(413).send({ error: "file too large", path: error.path, limit: error.limit });
    return;
  }
  if (error instanceof ProjectQuotaExceededError) {
    reply.code(413).send({
      error: "project size quota exceeded",
      projectId: error.projectId,
      limit: error.limit,
    });
    return;
  }
  throw error;
}

/** Register the project persistence + rehydration endpoints. Side-effect-free. */
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const { store, requireSession, cascade } = deps;

  app.get("/projects", { preHandler: requireSession }, async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    return store.listProjects(auth.address);
  });

  app.post("/projects", { preHandler: requireSession }, async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    const parsed = CreateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request" };
    }
    try {
      const project = await store.createProject(auth.address, parsed.data.name);
      reply.code(201);
      return project;
    } catch (error) {
      handleStoreError(reply, error);
      return reply;
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      const parsed = UpdateProjectRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid request" };
      }
      // A no-op PATCH (no name) returns the current project unchanged.
      if (parsed.data.name === undefined) {
        return project;
      }
      try {
        return await store.renameProject(project.id, parsed.data.name);
      } catch (error) {
        handleStoreError(reply, error);
        return reply;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      try {
        const deleted = await store.softDeleteProject(project.id);
        // Ephemeral cascade runs immediately while the row stays recoverable (D49).
        await cascade.run(deleted.id);
        return deleted;
      } catch (error) {
        handleStoreError(reply, error);
        return reply;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/projects/:id/restore",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      try {
        return await store.restoreProject(project.id);
      } catch (error) {
        handleStoreError(reply, error);
        return reply;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/projects/:id/manifest",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      return store.getManifest(project.id);
    },
  );

  app.get<{ Params: { id: string; "*": string } }>(
    "/projects/:id/files/*",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      const path = request.params["*"];
      const file = await store.getFile(project.id, path);
      if (file === null) {
        // Fail loudly naming the project + path — never a silent empty read (EC-34).
        reply.code(404);
        return { error: "file not found", projectId: project.id, path };
      }
      return file;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/projects/:id/chat",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      return store.getChat(project.id);
    },
  );
}
