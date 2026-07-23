/**
 * Server-side artifact store (P2 — the server now stores compile artifacts itself).
 *
 * P2 retires the Compile Service + R2-write architecture: instead of a glue service
 * holding R2 write creds and uploading content-hashed artifacts, the server STAGES the
 * per-file bytes for a `(projectId, sourceHash)` prefix and then COMMITS an integrity
 * manifest ({@link ArtifactManifest}) LAST. The manifest is the completeness marker —
 * `getManifest` returns `null` until commit lands, so a reader (Task 6's verify-prefix
 * route) can never observe a half-uploaded prefix (mirrors the old R2 "manifest.json
 * uploaded last" invariant, §5).
 *
 * Two impls, one contract (the repo store pattern — interface + real impl + in-memory
 * double): {@link createLocalArtifactStore} on local disk and
 * {@link createInMemoryArtifactStore} for deterministic tests. Every failure is a promise
 * REJECTION carrying a NAMED error (size caps, hash mismatch, incomplete manifest, bad
 * id/hash/path) — never a silent truncation.
 *
 * Prefixes are content-hash-addressed and therefore IMMUTABLE: a second `commit` for the
 * same `(projectId, sourceHash)` is idempotent. Path safety is belt-and-braces — the
 * `projectId` is a strict path segment, the `sourceHash` a lowercase-hex SHA-256, and
 * every stored path passes `isSafePath` AND a resolved-prefix `startsWith` assertion so no
 * traversal (`..`, absolute, `.git/…`, backslash) can escape the artifact root.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ArtifactManifestSchema } from "../compile/schemas.js";
import type { ArtifactManifest } from "../compile/schemas.js";
import { isSafePath } from "../projects/paths.js";
import {
  ArtifactBundleTooLargeError,
  ArtifactFileTooLargeError,
  ArtifactHashMismatchError,
  ArtifactManifestIncompleteError,
  InvalidSourceHashError,
  UnsafePathError,
} from "./errors.js";

/** One committed/staged artifact file: raw bytes plus its declared content type. */
export interface StoredArtifactFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Staged put / manifest-last commit / manifest + file reads for one project's compile
 * prefixes. Every method REJECTS (never throws synchronously) with a named error.
 */
export interface ArtifactStore {
  /** Stage one file's bytes under `(projectId, sourceHash)`; overwrites re-account bytes. */
  putFile(
    projectId: string,
    sourceHash: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  /** Verify every listed file was uploaded + hash-matches, then write the manifest LAST. */
  commit(projectId: string, sourceHash: string, manifest: ArtifactManifest): Promise<void>;
  /** The committed manifest, or `null` before commit (manifest-last completeness marker). */
  getManifest(projectId: string, sourceHash: string): Promise<ArtifactManifest | null>;
  /** One staged/committed file's bytes + content type, or `null` if absent. */
  getFile(projectId: string, sourceHash: string, path: string): Promise<StoredArtifactFile | null>;
}

/** A lowercase-hex SHA-256 — the `sourceHash` shape (`<projectId>/<sourceHash>/` prefix). */
const SOURCE_HASH_RE = /^[a-f0-9]{64}$/u;

/**
 * A safe project-id path segment. `@nyx/protocol` `ProjectIdSchema` is only `.min(1)`, but
 * real ids are uuids; we constrain to `[A-Za-z0-9-]+` so the id can never introduce a `/`,
 * `..`, or `.` traversal component into the on-disk `<rootDir>/<projectId>/…` layout.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9-]+$/u;

/** Sidecar metadata persisted next to each staged file (local-disk impl). */
const FileMetaSchema = z.object({
  contentType: z.string(),
  sha256: z.string(),
  bytes: z.number(),
});
type FileMeta = z.infer<typeof FileMetaSchema>;

/** Deterministic content addressing — same bytes ⇒ same hash (the manifest asserts on this). */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Turn any thrown value into a typed promise rejection (the in-memory-double channel). */
function reject(error: unknown): Promise<never> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

/** Reject a bad project id (as an unsafe path) or a non-hex source hash — the prefix guard. */
function assertValidPrefix(projectId: string, sourceHash: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new UnsafePathError(projectId);
  }
  if (!SOURCE_HASH_RE.test(sourceHash)) {
    throw new InvalidSourceHashError(sourceHash);
  }
}

/** Reject a stored path that could escape the artifact boundary (zip-slip / traversal). */
function assertSafeFilePath(path: string): void {
  if (!isSafePath(path)) {
    throw new UnsafePathError(path);
  }
}

// ── In-memory double ──────────────────────────────────────────────────────────

interface MemFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

interface MemPrefix {
  readonly files: Map<string, MemFile>;
  manifest: ArtifactManifest | null;
  totalBytes: number;
}

/**
 * In-memory {@link ArtifactStore} double (the repo store pattern). Mirrors the disk layout
 * as a `Map` keyed `projectId/sourceHash`; sha256 via `node:crypto`. Failures are promise
 * REJECTIONS (sync `throw` inside an `async` method), matching the real impl's channel.
 */
export function createInMemoryArtifactStore(deps?: {
  maxFileBytes?: number;
  maxBundleBytes?: number;
}): ArtifactStore {
  const maxFileBytes = deps?.maxFileBytes ?? Number.POSITIVE_INFINITY;
  const maxBundleBytes = deps?.maxBundleBytes ?? Number.POSITIVE_INFINITY;
  const prefixes = new Map<string, MemPrefix>();
  const keyOf = (projectId: string, sourceHash: string): string => `${projectId}/${sourceHash}`;

  const getOrCreate = (key: string): MemPrefix => {
    let prefix = prefixes.get(key);
    if (prefix === undefined) {
      prefix = { files: new Map(), manifest: null, totalBytes: 0 };
      prefixes.set(key, prefix);
    }
    return prefix;
  };

  // Non-`async` methods that build the result synchronously and surface every failure as a
  // promise REJECTION (the repo in-memory-double channel) — a sync `throw` becomes a reject.
  return {
    putFile(projectId, sourceHash, path, bytes, contentType) {
      try {
        assertValidPrefix(projectId, sourceHash);
        assertSafeFilePath(path);
        if (bytes.length > maxFileBytes) {
          throw new ArtifactFileTooLargeError(path, maxFileBytes);
        }
        const prefix = getOrCreate(keyOf(projectId, sourceHash));
        const priorBytes = prefix.files.get(path)?.bytes.length ?? 0;
        const projectedTotal = prefix.totalBytes - priorBytes + bytes.length;
        if (projectedTotal > maxBundleBytes) {
          throw new ArtifactBundleTooLargeError(maxBundleBytes);
        }
        prefix.files.set(path, { bytes: bytes.slice(), contentType, sha256: sha256Hex(bytes) });
        prefix.totalBytes = projectedTotal;
        return Promise.resolve();
      } catch (error) {
        return reject(error);
      }
    },

    commit(projectId, sourceHash, manifest) {
      try {
        assertValidPrefix(projectId, sourceHash);
        const key = keyOf(projectId, sourceHash);
        const existing = prefixes.get(key);
        // Content-addressed prefixes are immutable: a re-commit is a no-op (idempotent).
        if (existing?.manifest != null) {
          return Promise.resolve();
        }
        for (const entry of manifest.files) {
          assertSafeFilePath(entry.path);
          const stored = existing?.files.get(entry.path);
          if (stored === undefined) {
            throw new ArtifactManifestIncompleteError(entry.path);
          }
          if (stored.sha256 !== entry.sha256) {
            throw new ArtifactHashMismatchError(entry.path);
          }
        }
        // Manifest written LAST — only now is the prefix observable as committed.
        getOrCreate(key).manifest = manifest;
        return Promise.resolve();
      } catch (error) {
        return reject(error);
      }
    },

    getManifest(projectId, sourceHash) {
      try {
        assertValidPrefix(projectId, sourceHash);
        return Promise.resolve(prefixes.get(keyOf(projectId, sourceHash))?.manifest ?? null);
      } catch (error) {
        return reject(error);
      }
    },

    getFile(projectId, sourceHash, path) {
      try {
        assertValidPrefix(projectId, sourceHash);
        assertSafeFilePath(path);
        const stored = prefixes.get(keyOf(projectId, sourceHash))?.files.get(path);
        return Promise.resolve(
          stored === undefined
            ? null
            : { bytes: stored.bytes.slice(), contentType: stored.contentType },
        );
      } catch (error) {
        return reject(error);
      }
    },
  };
}

// ── Local-disk impl ─────────────────────────────────────────────────────────

/** True for a `NodeJS.ErrnoException` carrying `code` — used to treat "missing" as `null`. */
function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** True when a file exists on disk (a missing path is `false`, never an error). */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/**
 * Resolve `relPath` under `baseDir` and REJECT (as unsafe) anything that escapes it. Belt
 * to `isSafePath`'s braces — even if a guard were bypassed, the resolved absolute path must
 * stay within the prefix directory.
 */
function safeJoin(baseDir: string, relPath: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new UnsafePathError(relPath);
  }
  return target;
}

/**
 * Local-disk {@link ArtifactStore}. Layout per prefix:
 *  - `<rootDir>/<projectId>/<sourceHash>/files/<path>` — the raw bytes;
 *  - `<rootDir>/<projectId>/<sourceHash>/meta/<path>.json` — `{ contentType, sha256, bytes }`;
 *  - `<rootDir>/<projectId>/<sourceHash>/manifest.json` — written LAST on commit.
 */
export function createLocalArtifactStore(deps: {
  rootDir: string;
  maxFileBytes: number;
  maxBundleBytes: number;
}): ArtifactStore {
  const { rootDir, maxFileBytes, maxBundleBytes } = deps;

  const prefixDir = (projectId: string, sourceHash: string): string =>
    join(rootDir, projectId, sourceHash);

  const readMeta = async (metaPath: string): Promise<FileMeta | null> => {
    let raw: string;
    try {
      raw = await readFile(metaPath, "utf8");
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    return FileMetaSchema.parse(JSON.parse(raw));
  };

  /** Sum uploaded bytes across the prefix's meta sidecars, keyed by original file path. */
  const readMetaBytes = async (metaDir: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    let dirents: Dirent[];
    try {
      dirents = await readdir(metaDir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return out;
      }
      throw error;
    }
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) {
        continue;
      }
      const full = join(dirent.parentPath, dirent.name);
      const meta = await readMeta(full);
      if (meta === null) {
        continue;
      }
      const rel = relative(metaDir, full);
      const origPath = rel.slice(0, -".json".length).split(sep).join("/");
      out.set(origPath, meta.bytes);
    }
    return out;
  };

  return {
    async putFile(projectId, sourceHash, path, bytes, contentType) {
      assertValidPrefix(projectId, sourceHash);
      assertSafeFilePath(path);
      if (bytes.length > maxFileBytes) {
        throw new ArtifactFileTooLargeError(path, maxFileBytes);
      }
      const dir = prefixDir(projectId, sourceHash);
      const filesDir = join(dir, "files");
      const metaDir = join(dir, "meta");
      const fileTarget = safeJoin(filesDir, path);
      const metaTarget = safeJoin(metaDir, `${path}.json`);

      const priorBytesByPath = await readMetaBytes(metaDir);
      const currentTotal = [...priorBytesByPath.values()].reduce((sum, n) => sum + n, 0);
      const priorForPath = priorBytesByPath.get(path) ?? 0;
      const projectedTotal = currentTotal - priorForPath + bytes.length;
      if (projectedTotal > maxBundleBytes) {
        throw new ArtifactBundleTooLargeError(maxBundleBytes);
      }

      await mkdir(dirname(fileTarget), { recursive: true });
      await mkdir(dirname(metaTarget), { recursive: true });
      await writeFile(fileTarget, bytes);
      const meta: FileMeta = { contentType, sha256: sha256Hex(bytes), bytes: bytes.length };
      await writeFile(metaTarget, JSON.stringify(meta));
    },

    async commit(projectId, sourceHash, manifest) {
      assertValidPrefix(projectId, sourceHash);
      const dir = prefixDir(projectId, sourceHash);
      const manifestPath = join(dir, "manifest.json");

      // Content-addressed prefixes are immutable: a re-commit is a no-op (idempotent).
      if (await pathExists(manifestPath)) {
        return;
      }

      const metaDir = join(dir, "meta");
      for (const entry of manifest.files) {
        assertSafeFilePath(entry.path);
        const meta = await readMeta(safeJoin(metaDir, `${entry.path}.json`));
        if (meta === null) {
          throw new ArtifactManifestIncompleteError(entry.path);
        }
        if (meta.sha256 !== entry.sha256) {
          throw new ArtifactHashMismatchError(entry.path);
        }
      }

      await mkdir(dir, { recursive: true });
      // Manifest written LAST — its presence is the completeness marker.
      await writeFile(manifestPath, JSON.stringify(manifest));
    },

    async getManifest(projectId, sourceHash) {
      assertValidPrefix(projectId, sourceHash);
      const manifestPath = join(prefixDir(projectId, sourceHash), "manifest.json");
      let raw: string;
      try {
        raw = await readFile(manifestPath, "utf8");
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      }
      return ArtifactManifestSchema.parse(JSON.parse(raw));
    },

    async getFile(projectId, sourceHash, path) {
      assertValidPrefix(projectId, sourceHash);
      assertSafeFilePath(path);
      const dir = prefixDir(projectId, sourceHash);
      const meta = await readMeta(safeJoin(join(dir, "meta"), `${path}.json`));
      if (meta === null) {
        return null;
      }
      let buffer: Buffer;
      try {
        buffer = await readFile(safeJoin(join(dir, "files"), path));
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      }
      return { bytes: new Uint8Array(buffer), contentType: meta.contentType };
    },
  };
}
