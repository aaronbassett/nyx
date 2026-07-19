/**
 * Git materializer for project handoff (US13 / FR-076 / D59 / EC-56/57).
 *
 * A project's authoritative history is a project-wide MONOTONIC version stream
 * ({@link VersionSnapshot}s, each carrying the files CHANGED at that version). To hand
 * the project off as a real git repository we synthesize ONE commit PER version, oldest
 * to newest, where each commit's tree is the CUMULATIVE fold of every changed file up to
 * and including that version (a file added at v1 is still present in the v3 tree). The
 * commits chain by parent so `git log` reads the project's real edit timeline, and every
 * commit message is descriptive (D59) — agent turn vs user edit, the version stamp, and a
 * short summary of the paths it touched.
 *
 * The objects are REAL git objects. We never hand-roll object framing or SHA-1: every
 * blob/tree/commit is written by `isomorphic-git` (`writeBlob`/`writeTree`/`writeCommit`)
 * into a bare repo backed by an injected in-memory filesystem ({@link createInMemoryGitFs}),
 * so no working tree ever touches disk. `isomorphic-git` resolves under Node's `node`
 * export condition to its CJS build; the named exports are consumed via `import * as git`.
 *
 * DETERMINISM IS LOAD-BEARING (SC-041): the same history must always yield the same commit
 * SHAs, so two clones — or a clone and a later re-clone at the same watermark — are
 * byte-identical. Every input to a commit hash is fixed or passed in: author/committer
 * identity is derived from the version's author, timestamps come from the version's
 * `createdAt` (the DB clock, never `Date.now()`), and the timezone offset is pinned to UTC
 * (never the host's `getTimezoneOffset()`). There is no `turn_id` on a version, so the
 * message is derived from author + version + changed paths (flagged: a future schema could
 * carry the originating turn for a richer message).
 *
 * EC-57 — a near-empty project (zero versions) still materializes a VALID repo: a single
 * initial commit carrying a README, never an error.
 *
 * EC-56 — the materialized repo is cached per `clone_materialized_at_version` watermark
 * ({@link RepoCache}). A new commit raises the latest version, misses the cache, and
 * re-materializes; concurrent clones at the same watermark share one consistent snapshot.
 * The in-memory cache is the deterministic default; a real on-disk object cache is
 * owner-gated. The watermark is also persisted to the store column so ops can observe it.
 */
import * as git from "isomorphic-git";
import { assertSafePaths } from "./paths.js";
import { assertNoSecrets } from "./secrets.js";
import type { FileAuthor, VersionSnapshot } from "./store.js";

/**
 * Each build gets a UNIQUE bare-repo path inside its own in-memory fs; never touches disk.
 *
 * The path is deliberately per-build, not a fixed constant: `isomorphic-git` serializes ref
 * and config writes with a MODULE-LEVEL `AsyncLock` keyed by the file PATH, so two concurrent
 * materializations that share a gitdir would contend on the same lock keys (a hang under
 * parallel load). A distinct gitdir per build gives each its own lock namespace. The path is
 * an internal detail — it enters NO git object hash — so output SHAs stay byte-identical and
 * fully deterministic regardless of the counter value (verified: same history, same SHAs).
 */
let gitDirCounter = 0;
function nextGitDir(): string {
  gitDirCounter += 1;
  return `/nyx-repo-${String(gitDirCounter)}.git`;
}

/** The single branch a materialized handoff advertises. */
export const DEFAULT_BRANCH = "main";

/** Deterministic commit identities — fixed strings so a commit SHA never drifts. */
const AGENT_IDENTITY = { name: "Nyx Agent", email: "agent@nyx.local" } as const;
const USER_IDENTITY = { name: "Nyx User", email: "user@nyx.local" } as const;

/** How many changed paths to name in a commit message before summarizing the rest. */
const MESSAGE_PATH_LIMIT = 3;

/** README content for the EC-57 empty-project initial commit — deterministic. */
function emptyRepoReadme(projectId: string): string {
  return `# ${projectId}\n\nThis repository was exported from Nyx.\n`;
}

// ---------------------------------------------------------------------------
// In-memory filesystem seam
// ---------------------------------------------------------------------------

/** A `fs.Stats`-shaped result — only the members `isomorphic-git` reads over a bare repo. */
export interface GitStats {
  readonly mode: number;
  readonly size: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly dev: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mtime: Date;
  readonly ctime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The subset of a Node `fs.promises` client `isomorphic-git` binds (its `commands` list:
 * readFile/writeFile/mkdir/rmdir/unlink/stat/lstat/readdir/readlink/symlink, plus the `rm`
 * special case). Every method returns a promise (never throws synchronously) so the library's
 * promise-fs detection (it probes `readFile()` for a thenable) classifies this correctly and
 * does not wrap it in `pify`. This is structurally assignable to `isomorphic-git`'s `FsClient`.
 */
export interface GitFs {
  readFile(
    path: string,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<Buffer | string>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<GitStats>;
  lstat(path: string): Promise<GitStats>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

type FsNode =
  | { type: "file"; content: Buffer; mode: number; mtimeMs: number }
  | { type: "dir"; mode: number; mtimeMs: number };

function fsError(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * A minimal, self-contained in-memory POSIX filesystem implementing exactly the surface
 * `isomorphic-git` binds. `memfs` is not a dependency, and a bare repo never needs symlinks
 * or a working tree, so this stays small: a flat `Map<canonicalPath, node>`. Directories are
 * auto-created on write (the library also tolerates its own mkdirp), and the error `code`s
 * (`ENOENT`/`ENOTDIR`/`EISDIR`/`ENOTEMPTY`) match what the library's wrappers branch on.
 */
export function createInMemoryGitFs(): GitFs {
  const nodes = new Map<string, FsNode>();
  nodes.set("/", { type: "dir", mode: 0o40000, mtimeMs: 0 });

  const normalize = (path: string): string => {
    const out: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        out.pop();
        continue;
      }
      out.push(part);
    }
    return `/${out.join("/")}`;
  };

  const parentOf = (canonical: string): string => {
    const index = canonical.lastIndexOf("/");
    return index <= 0 ? "/" : canonical.slice(0, index);
  };

  const ensureDir = (canonical: string): void => {
    if (canonical === "/") return;
    const existing = nodes.get(canonical);
    if (existing !== undefined) {
      if (existing.type !== "dir") throw fsError("ENOTDIR", canonical);
      return;
    }
    ensureDir(parentOf(canonical));
    nodes.set(canonical, { type: "dir", mode: 0o40000, mtimeMs: 0 });
  };

  const toStats = (node: FsNode): GitStats => ({
    mode: node.mode,
    size: node.type === "file" ? node.content.length : 0,
    ino: 0,
    uid: 1,
    gid: 1,
    dev: 1,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.mtimeMs,
    mtime: new Date(node.mtimeMs),
    ctime: new Date(node.mtimeMs),
    isFile: () => node.type === "file",
    isDirectory: () => node.type === "dir",
    isSymbolicLink: () => false,
  });

  const encodingOf = (
    options: { encoding?: BufferEncoding } | BufferEncoding | undefined,
  ): BufferEncoding | undefined => (typeof options === "string" ? options : options?.encoding);

  const removeSubtree = (canonical: string): void => {
    const prefix = canonical === "/" ? "/" : `${canonical}/`;
    for (const key of [...nodes.keys()]) {
      if (key === canonical || key.startsWith(prefix)) nodes.delete(key);
    }
  };

  // Run synchronous fs logic and convert ANY throw into a rejected promise. This is
  // load-bearing: `isomorphic-git` classifies a fs as promise- vs callback-style by probing
  // `readFile()` with NO args and checking the return is a thenable (it wraps callback-style
  // clients in `pify`, which then hangs on a promise-returning method). `readFile()` with an
  // undefined path throws inside `normalize`; `settle` turns that into a rejection so the
  // probe always sees a promise and never mis-wraps us in `pify`.
  const settle = <T>(compute: () => T): Promise<T> => {
    try {
      return Promise.resolve(compute());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return {
    readFile: (path, options) =>
      settle(() => {
        const canonical = normalize(path);
        const node = nodes.get(canonical);
        if (node === undefined) throw fsError("ENOENT", canonical);
        if (node.type !== "file") throw fsError("EISDIR", canonical);
        const encoding = encodingOf(options);
        return encoding ? node.content.toString(encoding) : Buffer.from(node.content);
      }),
    writeFile: (path, data, options) =>
      settle(() => {
        const canonical = normalize(path);
        ensureDir(parentOf(canonical));
        const encoding = encodingOf(options) ?? "utf8";
        const content = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data);
        nodes.set(canonical, { type: "file", content, mode: 0o100644, mtimeMs: 0 });
      }),
    mkdir: (path) =>
      settle(() => {
        ensureDir(normalize(path));
      }),
    rmdir: (path) =>
      settle(() => {
        const canonical = normalize(path);
        const node = nodes.get(canonical);
        if (node === undefined) throw fsError("ENOENT", canonical);
        if (node.type !== "dir") throw fsError("ENOTDIR", canonical);
        const prefix = `${canonical}/`;
        for (const key of nodes.keys()) {
          if (key !== canonical && key.startsWith(prefix)) throw fsError("ENOTEMPTY", canonical);
        }
        nodes.delete(canonical);
      }),
    unlink: (path) =>
      settle(() => {
        const canonical = normalize(path);
        const node = nodes.get(canonical);
        if (node === undefined) throw fsError("ENOENT", canonical);
        if (node.type === "dir") throw fsError("EISDIR", canonical);
        nodes.delete(canonical);
      }),
    rm: (path, options) =>
      settle(() => {
        const canonical = normalize(path);
        if (nodes.get(canonical) === undefined) {
          if (options?.force === true) return;
          throw fsError("ENOENT", canonical);
        }
        removeSubtree(canonical);
      }),
    stat: (path) =>
      settle(() => {
        const node = nodes.get(normalize(path));
        if (node === undefined) throw fsError("ENOENT", path);
        return toStats(node);
      }),
    lstat: (path) =>
      settle(() => {
        const node = nodes.get(normalize(path));
        if (node === undefined) throw fsError("ENOENT", path);
        return toStats(node);
      }),
    readdir: (path) =>
      settle(() => {
        const canonical = normalize(path);
        const node = nodes.get(canonical);
        if (node === undefined) throw fsError("ENOENT", canonical);
        if (node.type !== "dir") throw fsError("ENOTDIR", canonical);
        const prefix = canonical === "/" ? "/" : `${canonical}/`;
        const names = new Set<string>();
        for (const key of nodes.keys()) {
          if (key === canonical || !key.startsWith(prefix)) continue;
          const segment = key.slice(prefix.length).split("/")[0];
          if (segment !== undefined && segment !== "") names.add(segment);
        }
        return [...names];
      }),
    // No symlinks in a synthesized bare repo; the library treats ENOENT as "not a link".
    readlink: (path) =>
      settle(() => {
        throw fsError("ENOENT", path);
      }),
    symlink: (_target, path) =>
      settle(() => {
        throw fsError("ENOSYS", path);
      }),
  };
}

// ---------------------------------------------------------------------------
// Materialized repo + cache seams
// ---------------------------------------------------------------------------

/** A fully-built bare git repository for one project, ready for a git-HTTP handler to serve. */
export interface MaterializedRepo {
  /** The in-memory fs holding the bare repo's objects and refs. */
  readonly fs: GitFs;
  /** The bare repo's git directory inside {@link fs}. */
  readonly gitdir: string;
  /** The SHA-1 of the tip commit (HEAD → `refs/heads/main`). */
  readonly headOid: string;
  /** The single advertised branch. */
  readonly defaultBranch: string;
  /** How many commits were synthesized (one per version, or one for an empty project). */
  readonly commitCount: number;
  /** Every object SHA written (blobs + trees + commits), deduped — the packfile source. */
  readonly objectOids: readonly string[];
  /** The version this repo was materialized at (the cache watermark; 0 for an empty project). */
  readonly watermark: number;
}

/** One cache slot: a materialized repo tagged with the watermark it was built at (EC-56). */
export interface CachedRepo {
  readonly watermark: number;
  readonly repo: MaterializedRepo;
}

/**
 * The materialization cache seam. Keyed by project id; the entry carries the watermark so a
 * new commit (higher latest version) is a miss. The in-memory default is deterministic; a
 * real shared/on-disk object cache is owner-gated.
 */
export interface RepoCache {
  get(projectId: string): CachedRepo | undefined;
  set(projectId: string, entry: CachedRepo): void;
}

/** A `Map`-backed {@link RepoCache} — the deterministic default. */
export function createInMemoryRepoCache(): RepoCache {
  const entries = new Map<string, CachedRepo>();
  return {
    get: (projectId) => entries.get(projectId),
    set: (projectId, entry) => {
      entries.set(projectId, entry);
    },
  };
}

/** The store surface the materializer needs — a structural subset of `ProjectStore`. */
export interface MaterializeStore {
  getVersionHistory(projectId: string): Promise<VersionSnapshot[]>;
  setCloneMaterializedVersion(projectId: string, version: number): Promise<void>;
}

/** Knobs for {@link materializeRepo}; all optional and deterministic. */
export interface MaterializeOptions {
  /** Reuse/populate this cache across clones (EC-56). Omit to always build fresh. */
  readonly cache?: RepoCache;
  /** Override the fs backing (tests may inspect it). Defaults to a fresh in-memory fs. */
  readonly fsFactory?: () => GitFs;
  /** Epoch-ms for the EC-57 empty-project initial commit (deterministic; default 0). */
  readonly emptyRepoTimestampMs?: number;
  /** Persist the watermark to `clone_materialized_at_version` after building (default true). */
  readonly persistWatermark?: boolean;
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/** Summarize the paths a commit touched into a compact, deterministic phrase (D59). */
function summarizeChangedPaths(paths: readonly string[]): string {
  if (paths.length === 0) return "no file changes";
  const named = paths.slice(0, MESSAGE_PATH_LIMIT).join(", ");
  const remaining = paths.length - MESSAGE_PATH_LIMIT;
  return remaining > 0 ? `${named} (+${String(remaining)} more)` : named;
}

/** Build a descriptive commit message from author + version + changed paths (D59). */
function commitMessage(version: number, author: FileAuthor, paths: readonly string[]): string {
  const actor = author === "agent" ? "Agent turn" : "User edit";
  return `${actor} v${String(version)}: ${summarizeChangedPaths(paths)}\n`;
}

interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

interface PlannedCommit {
  readonly version: number;
  readonly author: FileAuthor;
  readonly createdAt: number;
  readonly files: readonly PlannedFile[];
}

/** Normalize the version history into a commit plan, synthesizing EC-57's initial commit. */
function planCommits(
  projectId: string,
  history: readonly VersionSnapshot[],
  emptyRepoTimestampMs: number,
): PlannedCommit[] {
  if (history.length > 0) {
    return history
      .map((snapshot) => ({
        version: snapshot.version,
        author: snapshot.author,
        createdAt: snapshot.createdAt,
        files: snapshot.files.map((file) => ({ path: file.path, content: file.content })),
      }))
      .sort((a, b) => a.version - b.version);
  }
  // EC-57: a near-empty project still yields a valid repo with a single README commit.
  return [
    {
      version: 1,
      author: "agent",
      createdAt: emptyRepoTimestampMs,
      files: [{ path: "README.md", content: emptyRepoReadme(projectId) }],
    },
  ];
}

interface TreeDir {
  readonly dirs: Map<string, TreeDir>;
  readonly files: Map<string, string>;
}

function newTreeDir(): TreeDir {
  return { dirs: new Map(), files: new Map() };
}

/**
 * Write a full nested git tree from a flat `path → blobOid` map and return the root tree
 * OID. Directory hierarchy is reconstructed from the path segments; `isomorphic-git`'s
 * `writeTree` handles canonical entry ordering, so we never sort or frame trees ourselves.
 * Every tree OID written is collected for the packfile.
 */
async function writeTreeFromFiles(
  fs: GitFs,
  gitdir: string,
  files: ReadonlyMap<string, string>,
  oids: Set<string>,
): Promise<string> {
  const root = newTreeDir();
  for (const [path, oid] of files) {
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (segment === undefined) continue;
      let next = cursor.dirs.get(segment);
      if (next === undefined) {
        next = newTreeDir();
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    const leaf = segments[segments.length - 1];
    if (leaf !== undefined) cursor.files.set(leaf, oid);
  }

  const writeDir = async (dir: TreeDir): Promise<string> => {
    const entries: git.TreeObject = [];
    for (const [name, oid] of dir.files) {
      entries.push({ mode: "100644", path: name, oid, type: "blob" });
    }
    for (const [name, sub] of dir.dirs) {
      const subOid = await writeDir(sub);
      entries.push({ mode: "040000", path: name, oid: subOid, type: "tree" });
    }
    const treeOid = await git.writeTree({ fs, gitdir, tree: entries });
    oids.add(treeOid);
    return treeOid;
  };

  return writeDir(root);
}

/** Build the bare repo: one commit per planned version, cumulative trees, chained parents. */
async function buildRepo(
  fs: GitFs,
  gitdir: string,
  plan: readonly PlannedCommit[],
  watermark: number,
): Promise<MaterializedRepo> {
  await git.init({ fs, gitdir, bare: true, defaultBranch: DEFAULT_BRANCH });

  const oids = new Set<string>();
  const blobByContent = new Map<string, string>();
  const cumulative = new Map<string, string>();
  let parents: string[] = [];
  let headOid = "";

  for (const commit of plan) {
    for (const file of commit.files) {
      let blobOid = blobByContent.get(file.content);
      if (blobOid === undefined) {
        blobOid = await git.writeBlob({
          fs,
          gitdir,
          blob: Buffer.from(file.content, "utf8"),
        });
        blobByContent.set(file.content, blobOid);
      }
      oids.add(blobOid);
      cumulative.set(file.path, blobOid);
    }

    const treeOid = await writeTreeFromFiles(fs, gitdir, cumulative, oids);
    const identity = commit.author === "agent" ? AGENT_IDENTITY : USER_IDENTITY;
    // Epoch SECONDS; timezoneOffset pinned to UTC so the SHA never depends on the host.
    const stamp = {
      ...identity,
      timestamp: Math.floor(commit.createdAt / 1000),
      timezoneOffset: 0,
    };
    const commitOid = await git.writeCommit({
      fs,
      gitdir,
      commit: {
        message: commitMessage(
          commit.version,
          commit.author,
          commit.files.map((file) => file.path),
        ),
        tree: treeOid,
        parent: parents,
        author: stamp,
        committer: stamp,
      },
    });
    oids.add(commitOid);
    parents = [commitOid];
    headOid = commitOid;
  }

  // HEAD is symbolic (set by init → refs/heads/main); point the branch at the tip.
  await git.writeRef({
    fs,
    gitdir,
    ref: `refs/heads/${DEFAULT_BRANCH}`,
    value: headOid,
    force: true,
  });

  return {
    fs,
    gitdir,
    headOid,
    defaultBranch: DEFAULT_BRANCH,
    commitCount: plan.length,
    objectOids: [...oids],
    watermark,
  };
}

/**
 * Materialize a project's version history into a bare git repository (FR-076 / D59).
 *
 * Reads {@link MaterializeStore.getVersionHistory}, synthesizes one commit per version with
 * cumulative trees, and returns a {@link MaterializedRepo}. Caching is keyed by the latest
 * version (the watermark): a cache hit returns the existing snapshot (EC-56); a miss builds,
 * caches, and — unless disabled — persists the watermark to the store column. An empty
 * project yields a valid one-commit repo (EC-57). Deterministic: identical history in ⇒
 * identical SHAs out.
 */
export async function materializeRepo(
  store: MaterializeStore,
  projectId: string,
  options: MaterializeOptions = {},
): Promise<MaterializedRepo> {
  const history = await store.getVersionHistory(projectId);
  const watermark = history.reduce((max, snapshot) => Math.max(max, snapshot.version), 0);

  const cache = options.cache;
  const cached = cache?.get(projectId);
  if (cached?.watermark === watermark) {
    return cached.repo;
  }

  const fs = (options.fsFactory ?? createInMemoryGitFs)();
  const plan = planCommits(projectId, history, options.emptyRepoTimestampMs ?? 0);

  // Reject an unsafe stored path (zip-slip / tree traversal) before writing ANY git object —
  // over every path in the plan (all versions + the EC-57 synthesized README).
  assertSafePaths(plan.flatMap((commit) => commit.files.map((file) => file.path)));

  // SC-044/FR-077: a git clone exposes the FULL version history, so scan EVERY file across ALL
  // versions — not just the latest tree (that is the archive's job). A secret committed then
  // overwritten later still survives in `git log`, so it must block the clone here. The archive
  // path (buildArchive) only sees the current tree, so this scan is the clone-side equivalent.
  assertNoSecrets(
    history.flatMap((snapshot) =>
      snapshot.files.map((file) => ({ path: file.path, content: file.content })),
    ),
  );

  const repo = await buildRepo(fs, nextGitDir(), plan, watermark);

  cache?.set(projectId, { watermark, repo });
  if (options.persistWatermark !== false) {
    await store.setCloneMaterializedVersion(projectId, watermark);
  }
  return repo;
}
