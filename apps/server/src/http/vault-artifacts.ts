/**
 * NyxtVault key-material serve route (P3 Task 4 — `GET /vault-artifacts/*`).
 *
 * The browser ceremony prover (both the in-browser wasm route and the proof-server
 * fallback) needs the vault's per-circuit `{proverKey, verifierKey, ir}` client-side
 * (SPIKE-2 §C/§D — the proof server holds only built-in zswap/dust keys). Those come
 * from the native compact 0.31.1 toolchain compile at platform-setup time (SPIKE-2 §B:
 * `keys/<circuit>.prover|.verifier` + `zkir/<circuit>.bzkir`); P5's vault phase produces
 * them and points `VAULT_ARTIFACTS_DIR` at the build dir. The vault is NOT a user project,
 * so the `/artifacts/:projectId/:sourceHash/*` store prefix does not apply — this clones
 * the `GET /srs/*` static-serve pattern instead ({@link registerSrsRoutes}).
 *
 * SESSION-LESS (like the SRS + public artifact GET) — the vault verifier key and IR are
 * public reference data, and the prover key is public proving material (not a credential).
 * Path safety is belt-and-braces: the request path must pass {@link isSafePath} AND its
 * resolved absolute path must stay within the artifacts root, so no `..`/absolute/`.git`
 * traversal can escape. A traversal is 400, a missing file 404.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { isSafePath } from "../projects/paths.js";

/** Key material + IR are opaque binary; serve them as a generic octet stream. */
const VAULT_ARTIFACT_CONTENT_TYPE = "application/octet-stream";

export interface VaultArtifactsRouteDeps {
  /** Absolute (or process-relative) directory the vault `keys/` + `zkir/` blobs live under. */
  readonly dir: string;
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
 * Register the read-only `GET /vault-artifacts/*` static serve over `dir`. Side-effect-free;
 * `app.ts`/`buildServer` call it only when `config.artifacts.vaultArtifactsDir` is set.
 */
export function registerVaultArtifactsRoutes(
  app: FastifyInstance,
  deps: VaultArtifactsRouteDeps,
): void {
  const base = resolve(deps.dir);

  app.get<{ Params: { "*": string } }>("/vault-artifacts/*", async (request, reply) => {
    const relPath = request.params["*"];
    if (!isSafePath(relPath)) {
      return reply.code(400).send({ error: "unsafe vault-artifacts path" });
    }
    const target = resolve(base, relPath);
    // Belt to isSafePath's braces: the resolved absolute path must stay within the root.
    if (target !== base && !target.startsWith(base + sep)) {
      return reply.code(400).send({ error: "unsafe vault-artifacts path" });
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
    return reply.code(200).header("content-type", VAULT_ARTIFACT_CONTENT_TYPE).send(bytes);
  });
}
