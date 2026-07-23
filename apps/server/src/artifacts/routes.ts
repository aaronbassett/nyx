/**
 * Artifact upload + serve HTTP routes (P2 — browser-compile, Task 6).
 *
 * After the in-browser toolchain produces a green `full` compile, its artifacts are
 * published straight from the browser to the server's content-addressed artifact prefix
 * (see `apps/web/src/compile/upload.ts`): one raw PUT per file, then a single manifest-last
 * POST to `/commit` whose arrival marks the whole set complete (verify-before-announce,
 * mirroring the retired R2 `manifest.json` completeness marker). The WebContainer preview
 * then reads the prefix over the SESSION-LESS public GET (content-hash-addressed, unguessable
 * prefixes; the browser fetches with `credentials:"omit"`).
 *
 * Three routes:
 *   PUT  /projects/:id/artifacts/:sourceHash/files/*  — session + ownership; raw buffer body;
 *        `content-type` header recorded; store size caps → 413, bad hash/path → 400.
 *   POST /projects/:id/artifacts/:sourceHash/commit   — session + ownership; zod-validated
 *        manifest body; a manifest gap / hash mismatch → 422 with the offending `path`; 204.
 *   GET  /artifacts/:projectId/:sourceHash/*          — PUBLIC (no session); serves
 *        `manifest.json` + files with their stored content-type; 404 on anything absent AND
 *        on any un-committed prefix (verify-before-serve — never serve a half-uploaded set).
 *
 * House rules mirrored from the project routes: ownership denies 404 NEVER 403 (existence
 * never leaks, SC-027); named store errors map to statuses in ONE handler; the raw-body PUT
 * lives in an ENCAPSULATED child scope with a `*` buffer parser (the prover-proxy precedent)
 * so sibling JSON routes (incl. `/commit`) keep their default parser.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import type { Project } from "@nyx/protocol";
import type { SessionAuth } from "../auth/index.js";
import { ArtifactManifestSchema } from "../compile/index.js";
import type { ProjectStore } from "../projects/index.js";
import {
  ArtifactBundleTooLargeError,
  ArtifactFileTooLargeError,
  ArtifactHashMismatchError,
  ArtifactManifestIncompleteError,
  ArtifactStagingQuotaError,
  InvalidSourceHashError,
  UnsafePathError,
} from "./errors.js";
import type { ArtifactStore } from "./store.js";

/** The completeness marker served at `<prefix>/manifest.json`. */
const MANIFEST_FILENAME = "manifest.json";
/** Default `content-type` recorded when a PUT carries no header. */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface ArtifactRouteDeps {
  /** Project store — the ownership source for the WRITE routes (SC-027, fail-closed). */
  readonly store: ProjectStore;
  /** The server-side artifact store (staged put / manifest-last commit / reads). */
  readonly artifacts: ArtifactStore;
  /** Built once in `buildServer` from the resolved auth store and shared here. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

/**
 * Resolve the `:id` project the caller is authorized to write, or send the correct rejection
 * and return `null`. 401 when unauthenticated; 404 when missing OR owned by someone else —
 * existence is never leaked (SC-027). A private reimplementation of the projects-route idiom
 * (the original is not exported).
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
  reply.code(404).send({ error: "project not found", projectId: id });
  return null;
}

/**
 * Map a named artifact-store error to its HTTP status + body, or rethrow (→ 500) if unknown:
 *  - size caps (per-file / bundle) + the per-project staging quota → 413; a bad source-hash /
 *    unsafe path → 400; a manifest gap / hash mismatch → 422 carrying the offending `path`.
 */
function handleArtifactStoreError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ArtifactFileTooLargeError) {
    return reply
      .code(413)
      .send({ error: "artifact file too large", path: error.path, limit: error.limit });
  }
  if (error instanceof ArtifactBundleTooLargeError) {
    return reply.code(413).send({ error: "artifact bundle too large", limit: error.limit });
  }
  if (error instanceof ArtifactStagingQuotaError) {
    return reply
      .code(413)
      .send({ error: "artifact staging quota exceeded", kind: error.kind, limit: error.limit });
  }
  if (error instanceof InvalidSourceHashError) {
    return reply.code(400).send({ error: "invalid source hash" });
  }
  if (error instanceof UnsafePathError) {
    return reply.code(400).send({ error: "unsafe artifact path" });
  }
  if (error instanceof ArtifactManifestIncompleteError) {
    return reply.code(422).send({ error: "artifact manifest incomplete", path: error.path });
  }
  if (error instanceof ArtifactHashMismatchError) {
    return reply.code(422).send({ error: "artifact hash mismatch", path: error.path });
  }
  throw error;
}

/** Read the (post-`requireSession`) session identity off the request, or `null`. */
function authOf(request: FastifyRequest): SessionAuth | null {
  return request.auth;
}

/**
 * Register the artifact upload + serve routes. The WRITE routes (PUT/commit) sit behind
 * `requireSession` + ownership; the public GET has NO session gate (content-hash-addressed
 * prefixes are the access control). Side-effect-free.
 */
export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): void {
  const { store, artifacts, requireSession } = deps;

  // --- WRITE: raw-body PUT in an encapsulated scope (prover-proxy precedent) ------------
  // The `*` buffer parser is confined to this child scope so `/commit`'s JSON body — and
  // every sibling route — keeps the app's default JSON parser.
  app.register((scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, onDone) => {
      onDone(null, body);
    });

    scope.put<{ Params: { id: string; sourceHash: string; "*": string } }>(
      "/projects/:id/artifacts/:sourceHash/files/*",
      { preHandler: requireSession },
      async (request, reply) => {
        const project = await loadOwned(store, authOf(request), request.params.id, reply);
        if (project === null) {
          return reply;
        }
        // The buffer parser guarantees a Buffer body (or none for an empty PUT).
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const contentType = request.headers["content-type"] ?? DEFAULT_CONTENT_TYPE;
        try {
          await artifacts.putFile(
            project.id,
            request.params.sourceHash,
            request.params["*"],
            new Uint8Array(body),
            contentType,
          );
        } catch (error) {
          return handleArtifactStoreError(reply, error);
        }
        return reply.code(204).send();
      },
    );

    done();
  });

  // --- WRITE: manifest-last commit (JSON body) ------------------------------------------
  app.post<{ Params: { id: string; sourceHash: string } }>(
    "/projects/:id/artifacts/:sourceHash/commit",
    { preHandler: requireSession },
    async (request, reply) => {
      const project = await loadOwned(store, authOf(request), request.params.id, reply);
      if (project === null) {
        return reply;
      }
      const parsed = ArtifactManifestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid manifest" });
      }
      try {
        await artifacts.commit(project.id, request.params.sourceHash, parsed.data);
      } catch (error) {
        return handleArtifactStoreError(reply, error);
      }
      return reply.code(204).send();
    },
  );

  // --- READ: public, session-less serve (mirrors the old public R2 read) ----------------
  app.get<{ Params: { projectId: string; sourceHash: string; "*": string } }>(
    "/artifacts/:projectId/:sourceHash/*",
    async (request, reply) => {
      const { projectId, sourceHash } = request.params;
      const path = request.params["*"];

      // Verify-before-serve: a prefix is only observable once the manifest-last commit
      // lands (a bad id/hash rejects → treat as absent). Never serve a half-uploaded set.
      let manifest;
      try {
        manifest = await artifacts.getManifest(projectId, sourceHash);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (manifest === null) {
        return reply.code(404).send({ error: "not found" });
      }

      if (path === MANIFEST_FILENAME) {
        return reply.code(200).header("content-type", "application/json").send(manifest);
      }

      let file;
      try {
        file = await artifacts.getFile(projectId, sourceHash, path);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (file === null) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.code(200).header("content-type", file.contentType).send(Buffer.from(file.bytes));
    },
  );
}
