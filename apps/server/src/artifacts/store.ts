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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  ArtifactStagingQuotaError,
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
  /**
   * Stage one file's bytes under `(projectId, sourceHash)`; overwrites re-account bytes. REJECTS
   * {@link ArtifactStagingQuotaError} when the project's total UNCOMMITTED footprint (staged bytes
   * across all prefixes, or the count of concurrently-staged prefixes) would exceed its per-project
   * caps — a staging-volume exhaustion guard on the shared disk (M1).
   */
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
  /**
   * GC hook (M1): remove every UNCOMMITTED prefix whose most-recent staging write is older than
   * `olderThanMs` (measured against the store's injected clock), and resolve with the count
   * removed. COMMITTED prefixes and freshly-/actively-staged prefixes ALWAYS survive — only
   * abandoned half-uploads are reclaimed. Idempotent + never throws for an absent root; wired to
   * an unref'd boot interval so a client that PUTs then never commits cannot pin disk forever.
   */
  sweepStaged(olderThanMs: number): Promise<number>;
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
  // Clock value at the time this file was staged — the age input for the M1 sweep. Defaulted so a
  // sidecar written before this field existed parses as epoch-0 (i.e. eligible for GC), never a throw.
  stagedAt: z.number().default(0),
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
  /** Clock value of the most-recent staging write — the age GC compares against (M1 sweep). */
  stagedAt: number;
}

/** Default per-project staged-bytes cap = 4× the (finite) bundle cap; Infinity when uncapped. */
function defaultStagedBytes(maxBundleBytes: number): number {
  return Number.isFinite(maxBundleBytes) ? maxBundleBytes * 4 : Number.POSITIVE_INFINITY;
}

/** Default max count of concurrently-staged (uncommitted) prefixes per project (M1). */
const DEFAULT_STAGED_PREFIXES_PER_PROJECT = 8;

/**
 * In-memory {@link ArtifactStore} double (the repo store pattern). Mirrors the disk layout
 * as a `Map` keyed `projectId/sourceHash`; sha256 via `node:crypto`. Failures are promise
 * REJECTIONS (sync `throw` inside an `async` method), matching the real impl's channel.
 */
export function createInMemoryArtifactStore(deps?: {
  maxFileBytes?: number;
  maxBundleBytes?: number;
  /** Per-project cap on total UNCOMMITTED staged bytes (M1); default 4× {@link maxBundleBytes}. */
  maxStagedBytesPerProject?: number;
  /** Per-project cap on the count of concurrently-staged prefixes (M1); default 8. */
  maxStagedPrefixesPerProject?: number;
  /** Injectable clock for the M1 staging sweep; defaults to `Date.now`. */
  clock?: () => number;
}): ArtifactStore {
  const maxFileBytes = deps?.maxFileBytes ?? Number.POSITIVE_INFINITY;
  const maxBundleBytes = deps?.maxBundleBytes ?? Number.POSITIVE_INFINITY;
  const maxStagedBytesPerProject =
    deps?.maxStagedBytesPerProject ?? defaultStagedBytes(maxBundleBytes);
  const maxStagedPrefixesPerProject =
    deps?.maxStagedPrefixesPerProject ?? DEFAULT_STAGED_PREFIXES_PER_PROJECT;
  const clock = deps?.clock ?? Date.now;
  const prefixes = new Map<string, MemPrefix>();
  const keyOf = (projectId: string, sourceHash: string): string => `${projectId}/${sourceHash}`;
  /** A prefix key belongs to `projectId` iff it is `<projectId>/<hex>` (ids carry no `/`). */
  const isProjectKey = (key: string, projectId: string): boolean => key.startsWith(`${projectId}/`);

  const getOrCreate = (key: string): MemPrefix => {
    let prefix = prefixes.get(key);
    if (prefix === undefined) {
      prefix = { files: new Map(), manifest: null, totalBytes: 0, stagedAt: clock() };
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
        const key = keyOf(projectId, sourceHash);
        const existing = prefixes.get(key);
        const priorBytes = existing?.files.get(path)?.bytes.length ?? 0;
        const projectedTotal = (existing?.totalBytes ?? 0) - priorBytes + bytes.length;
        if (projectedTotal > maxBundleBytes) {
          throw new ArtifactBundleTooLargeError(maxBundleBytes);
        }
        // M1 — per-project staged (UNCOMMITTED) exhaustion guard. Committed prefixes are durable
        // and don't count; sum the project's other uncommitted prefixes, then add THIS prefix's
        // projected total (unless it is already committed). Enforced BEFORE any mutation so a
        // rejected PUT leaves no phantom prefix behind.
        const currentUncommitted = (existing?.manifest ?? null) === null;
        let stagedPrefixCount = currentUncommitted ? 1 : 0;
        let stagedBytes = currentUncommitted ? projectedTotal : 0;
        for (const [otherKey, otherPrefix] of prefixes) {
          if (
            otherKey === key ||
            !isProjectKey(otherKey, projectId) ||
            otherPrefix.manifest !== null
          ) {
            continue;
          }
          stagedPrefixCount += 1;
          stagedBytes += otherPrefix.totalBytes;
        }
        if (stagedPrefixCount > maxStagedPrefixesPerProject) {
          throw new ArtifactStagingQuotaError("prefixes", maxStagedPrefixesPerProject);
        }
        if (stagedBytes > maxStagedBytesPerProject) {
          throw new ArtifactStagingQuotaError("bytes", maxStagedBytesPerProject);
        }
        const prefix = getOrCreate(key);
        prefix.files.set(path, { bytes: bytes.slice(), contentType, sha256: sha256Hex(bytes) });
        prefix.totalBytes = projectedTotal;
        prefix.stagedAt = clock();
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

    sweepStaged(olderThanMs) {
      // Remove every UNCOMMITTED prefix last staged before the cutoff; committed + fresh survive.
      const cutoff = clock() - olderThanMs;
      let removed = 0;
      for (const [key, prefix] of prefixes) {
        if (prefix.manifest === null && prefix.stagedAt <= cutoff) {
          prefixes.delete(key);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
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
  /** Per-project cap on total UNCOMMITTED staged bytes (M1); default 4× {@link maxBundleBytes}. */
  maxStagedBytesPerProject?: number;
  /** Per-project cap on the count of concurrently-staged prefixes (M1); default 8. */
  maxStagedPrefixesPerProject?: number;
  /** Injectable clock for the M1 staging sweep + sidecar timestamps; defaults to `Date.now`. */
  clock?: () => number;
}): ArtifactStore {
  const { rootDir, maxFileBytes, maxBundleBytes } = deps;
  const maxStagedBytesPerProject =
    deps.maxStagedBytesPerProject ?? defaultStagedBytes(maxBundleBytes);
  const maxStagedPrefixesPerProject =
    deps.maxStagedPrefixesPerProject ?? DEFAULT_STAGED_PREFIXES_PER_PROJECT;
  const clock = deps.clock ?? Date.now;

  const prefixDir = (projectId: string, sourceHash: string): string =>
    join(rootDir, projectId, sourceHash);

  // L2 — a lightweight per-prefix promise-chain mutex. The disk `putFile` does a read-modify-write
  // (sum staged bytes → check caps → write), so two concurrent PUTs to ONE prefix could both read
  // stale totals and both pass the bundle cap (a TOCTOU). Serializing per prefix key closes that:
  // each PUT for a key awaits the prior one, so the second sees the first's bytes. The tail entry
  // is cleaned when it settles (bounded by CONCURRENTLY-writing prefixes, never by total prefixes).
  const prefixLocks = new Map<string, Promise<unknown>>();
  const withPrefixLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = prefixLocks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    prefixLocks.set(key, tail);
    void tail.finally(() => {
      if (prefixLocks.get(key) === tail) {
        prefixLocks.delete(key);
      }
    });
    return run;
  };

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

  /** Aggregate a prefix's staged footprint from its meta sidecars: total bytes + newest `stagedAt`. */
  const readPrefixStaged = async (
    metaDir: string,
  ): Promise<{ totalBytes: number; latestStagedAt: number }> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(metaDir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return { totalBytes: 0, latestStagedAt: 0 };
      }
      throw error;
    }
    let totalBytes = 0;
    let latestStagedAt = 0;
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".json")) {
        continue;
      }
      const meta = await readMeta(join(dirent.parentPath, dirent.name));
      if (meta === null) {
        continue;
      }
      totalBytes += meta.bytes;
      if (meta.stagedAt > latestStagedAt) {
        latestStagedAt = meta.stagedAt;
      }
    }
    return { totalBytes, latestStagedAt };
  };

  /** True when a prefix has landed its manifest-last commit (its bytes are durable, not staged). */
  const isCommitted = (dir: string): Promise<boolean> => pathExists(join(dir, "manifest.json"));

  /**
   * Sum the project's OTHER (sibling) uncommitted prefixes: count + staged bytes, excluding
   * `currentHash` (the caller accounts that prefix's projected total itself). Committed prefixes are
   * durable and excluded. The M1 per-project staging guard reads this on every `putFile`.
   */
  const projectStagedSiblings = async (
    projectId: string,
    currentHash: string,
  ): Promise<{ count: number; bytes: number }> => {
    const projectDir = join(rootDir, projectId);
    let dirents: Dirent[];
    try {
      dirents = await readdir(projectDir, { withFileTypes: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return { count: 0, bytes: 0 };
      }
      throw error;
    }
    let count = 0;
    let bytes = 0;
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name === currentHash) {
        continue;
      }
      const dir = join(projectDir, dirent.name);
      if (await isCommitted(dir)) {
        continue;
      }
      const { totalBytes } = await readPrefixStaged(join(dir, "meta"));
      count += 1;
      bytes += totalBytes;
    }
    return { count, bytes };
  };

  return {
    async putFile(projectId, sourceHash, path, bytes, contentType) {
      assertValidPrefix(projectId, sourceHash);
      assertSafeFilePath(path);
      if (bytes.length > maxFileBytes) {
        throw new ArtifactFileTooLargeError(path, maxFileBytes);
      }
      // L2 — serialize per-prefix so the read-modify-write below is atomic against a concurrent
      // PUT to the SAME prefix (two racers can't both pass the bundle cap on stale totals).
      return withPrefixLock(prefixDir(projectId, sourceHash), async () => {
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

        // M1 — per-project staged (UNCOMMITTED) exhaustion guard. A committed prefix is durable
        // and does not count; sum the project's other uncommitted prefixes and add THIS prefix's
        // projected total unless it is already committed. Enforced BEFORE any write.
        const committed = await isCommitted(dir);
        const siblings = await projectStagedSiblings(projectId, sourceHash);
        const stagedPrefixCount = siblings.count + (committed ? 0 : 1);
        const stagedBytes = siblings.bytes + (committed ? 0 : projectedTotal);
        if (stagedPrefixCount > maxStagedPrefixesPerProject) {
          throw new ArtifactStagingQuotaError("prefixes", maxStagedPrefixesPerProject);
        }
        if (stagedBytes > maxStagedBytesPerProject) {
          throw new ArtifactStagingQuotaError("bytes", maxStagedBytesPerProject);
        }

        await mkdir(dirname(fileTarget), { recursive: true });
        await mkdir(dirname(metaTarget), { recursive: true });
        await writeFile(fileTarget, bytes);
        const meta: FileMeta = {
          contentType,
          sha256: sha256Hex(bytes),
          bytes: bytes.length,
          stagedAt: clock(),
        };
        await writeFile(metaTarget, JSON.stringify(meta));
      });
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

    async sweepStaged(olderThanMs) {
      // Walk `<rootDir>/<projectId>/<sourceHash>/`; drop every UNCOMMITTED prefix whose newest
      // staging write is older than the cutoff. Committed prefixes (a `manifest.json` is present)
      // and freshly-staged ones survive. An absent root is a clean no-op (nothing staged yet).
      const cutoff = clock() - olderThanMs;
      let projectDirs: Dirent[];
      try {
        projectDirs = await readdir(rootDir, { withFileTypes: true });
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) {
          return 0;
        }
        throw error;
      }
      let removed = 0;
      for (const projectDirent of projectDirs) {
        if (!projectDirent.isDirectory()) {
          continue;
        }
        const projectDir = join(rootDir, projectDirent.name);
        let prefixDirents: Dirent[];
        try {
          prefixDirents = await readdir(projectDir, { withFileTypes: true });
        } catch (error) {
          if (hasErrnoCode(error, "ENOENT")) {
            continue;
          }
          throw error;
        }
        for (const prefixDirent of prefixDirents) {
          if (!prefixDirent.isDirectory()) {
            continue;
          }
          const dir = join(projectDir, prefixDirent.name);
          if (await isCommitted(dir)) {
            continue; // committed prefixes are durable — never swept
          }
          const { latestStagedAt } = await readPrefixStaged(join(dir, "meta"));
          if (latestStagedAt <= cutoff) {
            await rm(dir, { recursive: true, force: true });
            removed += 1;
          }
        }
      }
      return removed;
    },
  };
}
