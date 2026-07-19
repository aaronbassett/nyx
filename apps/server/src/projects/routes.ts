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
import { ArchiveManifestMismatchError, ArchiveReservedPathError, buildArchive } from "./archive.js";
import type { CloneService, GitHttpRequest, GitHttpResponse } from "./clone.js";
import {
  FileTooLargeError,
  ProjectCountQuotaExceededError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "./errors.js";
import type { DeletionCascade } from "./lifecycle.js";
import { UnsafePathError } from "./paths.js";
import { SecretsFoundError } from "./secrets.js";
import type { ProjectStore } from "./store.js";

export interface ProjectRouteDeps {
  readonly store: ProjectStore;
  /** Built once in `buildServer` from the resolved auth store and shared here. */
  readonly requireSession: preHandlerAsyncHookHandler;
  /** The immediate ephemeral teardown fired on soft-delete (D49). */
  readonly cascade: DeletionCascade;
  /**
   * The clone/handoff service (US13). The archive routes read the store directly (archive is a
   * pure function of the store), but clone-token mint/revoke delegate here so ONE process-wide
   * rate limiter + repo cache is shared with the token-gated git-HTTP scope (EC-55/EC-56).
   */
  readonly cloneService: CloneService;
}

/** Dependencies for {@link registerGitHttpRoutes}. */
export interface GitHttpRouteDeps {
  /** The same clone service the session-gated handoff routes use — shares its cache + limiter. */
  readonly cloneService: CloneService;
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

/**
 * Like {@link loadOwned}, but ALSO gates the handoff routes on soft-delete (FR-077/D49): a
 * deleted project pauses its handoff, so archive/clone-token answer 410 `handoff disabled`
 * (distinct from the 404 an unowned/missing project gets — the owner is told their handoff
 * paused WITH the project rather than that it vanished).
 */
async function loadOwnedForHandoff(
  store: ProjectStore,
  auth: SessionAuth | null,
  id: string,
  reply: FastifyReply,
): Promise<Project | null> {
  const project = await loadOwned(store, auth, id, reply);
  if (project === null) {
    return null;
  }
  if (project.deletedAt !== undefined) {
    reply.code(410).send({ error: "handoff disabled" });
    return null;
  }
  return project;
}

/**
 * Sanitize a project name into a safe `Content-Disposition` filename stem: strip anything
 * outside `[A-Za-z0-9._-]` (so CR/LF/quote header-injection is impossible), trim separators,
 * bound the length, and fall back to a constant when nothing usable remains.
 */
function safeArchiveName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : "project";
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
  const { store, requireSession, cascade, cloneService } = deps;

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

  // --- Handoff (US13 — D58/D59) --------------------------------------------------
  // Session + ownership gated, PLUS a soft-delete gate (410) on every route (FR-077).
  // The token-gated git-HTTP surface is a SEPARATE scope (see `registerGitHttpRoutes`).

  app.get<{ Params: { id: string } }>(
    "/projects/:id/archive",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwnedForHandoff(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      let zip: Uint8Array;
      try {
        // Archive is a pure function of the store (latest committed tree + generated README);
        // it runs `assertNoSecrets` internally (SC-044) before producing a single byte.
        ({ zip } = await buildArchive(store, project.id, { projectName: project.name }));
      } catch (error) {
        // Refuse LOUDLY and NEVER leak the finding (the redacted detail stays server-side; the
        // response says nothing beyond "blocked"). By design (D10) a secret never reaches a file
        // and the store never emits an unsafe/reserved/divergent path, so none of these should
        // fire — but each maps to a clear, actionable, non-leaking message rather than a bare 500.
        if (error instanceof SecretsFoundError) {
          reply.code(500);
          return { error: "archive blocked: secrets detected" };
        }
        if (error instanceof UnsafePathError) {
          reply.code(500);
          return { error: "archive blocked: unsafe file path" };
        }
        if (error instanceof ArchiveReservedPathError) {
          reply.code(500);
          return { error: "archive blocked: reserved path collision" };
        }
        if (error instanceof ArchiveManifestMismatchError) {
          reply.code(500);
          return { error: "archive blocked: project state inconsistent" };
        }
        throw error;
      }
      return reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="${safeArchiveName(project.name)}.zip"`,
        )
        .send(Buffer.from(zip));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/projects/:id/clone-token",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwnedForHandoff(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      try {
        // `mint` replaces any prior token (regenerate = POST again), so the previous token
        // stops resolving immediately — same immediacy guarantee as revoke (SC-043).
        const cloneToken = await cloneService.mint(project.id);
        return { cloneToken };
      } catch (error) {
        handleStoreError(reply, error);
        return reply;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/projects/:id/clone-token",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwnedForHandoff(store, request.auth, request.params.id, reply);
      if (project === null) {
        return reply;
      }
      try {
        // Revocation nulls the token column; the very next git-HTTP request 404s (SC-043).
        await cloneService.revoke(project.id);
        return {};
      } catch (error) {
        handleStoreError(reply, error);
        return reply;
      }
    },
  );
}

/**
 * Register the TOKEN-gated (NOT session-gated) smart-HTTP git handoff surface (US13/FR-076).
 *
 * Registered in an ENCAPSULATED child scope (mirroring the prover proxy) with a catch-all
 * `*` buffer body parser, so the raw `git-upload-pack` POST body is read as bytes and this
 * scope never clobbers JSON parsing on sibling routes. Ownership/session are DELIBERATELY
 * absent here: {@link CloneService.handleGitHttp} enforces the clone token, the rate limit
 * (EC-55, keyed by client IP), and the soft-delete gate internally, and NEVER throws — it
 * returns a framework-agnostic `{ status, headers, body }` that this scope serializes verbatim.
 */
export function registerGitHttpRoutes(app: FastifyInstance, deps: GitHttpRouteDeps): void {
  const { cloneService } = deps;

  app.register((scope, _opts, done) => {
    // Encapsulated to this scope: read EVERY content-type as raw bytes so the upload-pack
    // negotiation body reaches the handler untouched (never parsed as JSON).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, onDone) => {
      onDone(null, body);
    });

    const serve = (reply: FastifyReply, result: GitHttpResponse): FastifyReply => {
      reply.code(result.status);
      for (const [key, value] of Object.entries(result.headers)) {
        reply.header(key, value);
      }
      return reply.send(Buffer.from(result.body));
    };

    scope.get<{ Params: { cloneToken: string }; Querystring: Record<string, string> }>(
      "/git/:cloneToken/info/refs",
      async (request, reply) => {
        // Only the `service` param is meaningful to the smart-HTTP handshake; pass it through
        // as a clean `Record<string,string>` (never the raw, possibly-array-valued query).
        const query: Record<string, string> = {};
        const service = request.query.service;
        if (typeof service === "string") {
          query.service = service;
        }
        const gitRequest: GitHttpRequest = {
          token: request.params.cloneToken,
          path: "/info/refs",
          query,
          clientKey: request.ip,
        };
        return serve(reply, await cloneService.handleGitHttp(gitRequest));
      },
    );

    scope.post<{ Params: { cloneToken: string } }>(
      "/git/:cloneToken/git-upload-pack",
      async (request, reply) => {
        // The buffer parser guarantees a Buffer body (or none for an empty POST).
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const gitRequest: GitHttpRequest = {
          token: request.params.cloneToken,
          path: "/git-upload-pack",
          body: new Uint8Array(body),
          clientKey: request.ip,
        };
        return serve(reply, await cloneService.handleGitHttp(gitRequest));
      },
    );

    done();
  });
}
