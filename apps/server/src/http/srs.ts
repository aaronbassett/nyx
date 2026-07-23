/**
 * SRS pre-fetch cache serve route (P2 demo — `GET /srs/*`).
 *
 * The in-browser prover needs a common reference string (SRS) to prove; downloading it
 * mid-demo stalls the first prove. The demo stack pre-fetches the SRS into a local cache
 * directory (`config.artifacts.srsCacheDir`) and serves it read-only from here, so the
 * browser fetches it from the same origin with no cold-download.
 *
 * SESSION-LESS (like the public artifact GET) — the SRS is public reference data, not a
 * credential. Path safety is belt-and-braces: the request path must pass {@link isSafePath}
 * AND its resolved absolute path must stay within the cache root (a resolved-prefix
 * `startsWith` assertion), so no `..`/absolute/`.git` traversal can escape the cache dir.
 * A traversal is 400, a missing file 404 — nothing outside the cache is ever readable.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { isSafePath } from "../projects/paths.js";

/** SRS blobs are opaque binary; serve them as a generic octet stream. */
const SRS_CONTENT_TYPE = "application/octet-stream";

export interface SrsRouteDeps {
  /** Absolute (or process-relative) directory the pre-fetched SRS blobs live under. */
  readonly cacheDir: string;
}

/** True for a `NodeJS.ErrnoException` carrying `code` — used to treat "missing" as 404. */
function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Register the read-only `GET /srs/*` static serve over `cacheDir`. Side-effect-free;
 * `index.ts`/`buildServer` call it only when `config.artifacts.srsCacheDir` is set.
 */
export function registerSrsRoutes(app: FastifyInstance, deps: SrsRouteDeps): void {
  const base = resolve(deps.cacheDir);

  app.get<{ Params: { "*": string } }>("/srs/*", async (request, reply) => {
    const relPath = request.params["*"];
    if (!isSafePath(relPath)) {
      return reply.code(400).send({ error: "unsafe srs path" });
    }
    const target = resolve(base, relPath);
    // Belt to isSafePath's braces: the resolved absolute path must stay within the cache root.
    if (target !== base && !target.startsWith(base + sep)) {
      return reply.code(400).send({ error: "unsafe srs path" });
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "EISDIR")) {
        return reply.code(404).send({ error: "not found" });
      }
      throw error;
    }
    return reply.code(200).header("content-type", SRS_CONTENT_TYPE).send(bytes);
  });
}
