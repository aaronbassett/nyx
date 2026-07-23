/**
 * Project + file persistence: the authoritative Postgres store (T051/T052/T054).
 *
 * Postgres rows are the authoritative copy (D26). Files live as
 * `(project_id, path, content, version)` with a project-wide MONOTONIC version
 * counter: a commit — a turn-scoped BATCH of writes, or one immediate user edit —
 * is a single `db.transaction` that allocates the next version N and, for each
 * changed path, UPSERTs `project_files` (current state) and INSERTs
 * `project_file_versions` (history) at N. Atomicity is the point (US7 SC-026): a
 * failure mid-batch rolls the whole transaction back and leaves the PREVIOUS
 * consistent version intact — rehydration can never observe half an edit.
 *
 * The manifest (D38) is `project_files` projected to `(path, contentHash)` ordered
 * by path, so a reopen's manifest is a stable set/hash comparison (SC-025).
 * `content_hash` is computed server-side (SHA-256 hex) so identical content always
 * yields an identical hash. Size caps and quotas raise NAMED errors, never a silent
 * truncation (SC-026 scenario 6). All time decisions use the DB clock (`now()`);
 * every value is a bound parameter.
 *
 * `node_modules` and build artifacts are NEVER persisted (D26); that exclusion is
 * enforced at the write origin (the agent/editor layer), not here — this store
 * persists exactly the paths it is handed.
 */
import { createHash, randomBytes } from "node:crypto";
import { ManifestEntrySchema, ProjectFileResponseSchema, ProjectSchema } from "@nyx/protocol";
import type { ChatMessage, ManifestEntry, Project, ProjectFileResponse } from "@nyx/protocol";
import type { Queryable } from "../db/index.js";
import type { DeployArtifacts } from "../deploy/pipeline.js";
import { PgChatStore } from "./chat.js";
import type { ChatStore, ChatWrite } from "./chat.js";
import {
  FileTooLargeError,
  ProjectCountQuotaExceededError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "./errors.js";

/** A pooled DB handle that can also open a transaction (a real `Db` satisfies this). */
export type ProjectDb = Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

/** Who authored a write; drives the read-only-during-turn cadence (D26, S14). */
export type FileAuthor = "agent" | "user";

/** One file to write in a commit. Content is verbatim; the hash is computed here. */
export interface FileWrite {
  readonly path: string;
  readonly content: string;
}

/**
 * A batch of writes committed atomically at one version. An agent turn commits many
 * files as one batch; a user edit commits a single file — both are one transaction.
 */
export interface CommitRequest {
  readonly author: FileAuthor;
  readonly files: readonly FileWrite[];
}

/** The version stamp allocated to a successful commit. */
export interface CommitResult {
  readonly version: number;
}

/** One current file with its content + server-computed hash — the handoff read shape (US13). */
export interface HandoffFile {
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
}

/**
 * One turn/user-edit COMMIT version (D48) carrying the files CHANGED at that version — the
 * source the git materializer folds cumulatively into one synthesized commit each (D59/FR-076).
 */
export interface VersionSnapshot {
  readonly version: number;
  readonly author: FileAuthor;
  /** Epoch-ms of the commit (the DB clock). */
  readonly createdAt: number;
  /** Files changed at this version (a git commit's tree accretes these across versions). */
  readonly files: readonly HandoffFile[];
}

/** The write + read surface US7 depends on; extends the chat surface (T055). */
export interface ProjectStore extends ChatStore {
  /** The owner's live (non-deleted) projects, oldest first. */
  listProjects(ownerAddress: string): Promise<Project[]>;
  /** Create a project, rejecting past the per-account count quota (D49). */
  createProject(ownerAddress: string, name: string): Promise<Project>;
  /** Load a project by id regardless of soft-delete state, or `null` if absent. */
  getProject(id: string): Promise<Project | null>;
  /** Rename a live project. */
  renameProject(id: string, name: string): Promise<Project>;
  /** Soft-delete a live project (sets `deleted_at`); the cascade runs at the route. */
  softDeleteProject(id: string): Promise<Project>;
  /** Restore a soft-deleted project within the 30-day window (D49). */
  restoreProject(id: string): Promise<Project>;
  /** Atomically commit a batch at the next project-wide version (SC-026). */
  commit(projectId: string, request: CommitRequest): Promise<CommitResult>;
  /** `(path, contentHash)[]` at the last committed version, ordered by path (D38). */
  getManifest(projectId: string): Promise<ManifestEntry[]>;
  /** Current content for one path, or `null` if it does not exist. */
  getFile(projectId: string, path: string): Promise<ProjectFileResponse | null>;
  /** All current files with content + hash, ordered by path — the archive source (FR-074). */
  getFiles(projectId: string): Promise<HandoffFile[]>;
  /** Turn/user-edit versions oldest-first, files changed per version — git-synthesis source (D48/D59). */
  getVersionHistory(projectId: string): Promise<VersionSnapshot[]>;
  /**
   * Record the latest green build for a project (FR-054). Upserted at every `ready`
   * CompileOutcome — the LATEST build wins (one row per project). The deploy handler
   * reads it AT DEPLOY TIME (the US8 stale-build lesson), so overwriting is intentional.
   */
  recordGreenBuild(projectId: string, build: DeployArtifacts): Promise<void>;
  /** The latest recorded green build for a project (the deploy greenness gate), or `null`. */
  getLatestGreenBuild(projectId: string): Promise<DeployArtifacts | null>;
  /** Mint + persist a fresh clone token for a project, replacing any prior one (D58). */
  mintCloneToken(projectId: string): Promise<string>;
  /** Null the clone token — revocation takes effect immediately (SC-043). */
  revokeCloneToken(projectId: string): Promise<void>;
  /** Resolve a clone token to its project (incl. soft-deleted), or `null` if unknown/revoked. */
  getProjectByCloneToken(token: string): Promise<Project | null>;
  /** Read the repo materialization watermark, or `null` if never materialized (EC-56). */
  getCloneMaterializedVersion(projectId: string): Promise<number | null>;
  /** Persist the repo materialization watermark (the version last materialized) (EC-56). */
  setCloneMaterializedVersion(projectId: string, version: number): Promise<void>;
  /** Hard-delete projects whose recovery window has lapsed; returns the count. */
  purgeDeletedProjects(): Promise<number>;
  /** Prune history beyond the retention count AND age, keeping current; returns count. */
  pruneFileVersions(): Promise<number>;
}

/** Retention + cap knobs (from `config.tunables`), plus the D49 recovery window. */
export interface PgProjectStoreOptions {
  /** Reject any single file exceeding this many bytes (D49). */
  readonly maxFileBytes: number;
  /** Reject a commit whose resulting project total exceeds this many bytes (D49). */
  readonly maxProjectBytes: number;
  /** Cap the number of live projects per account (D49). */
  readonly projectQuotaPerAccount: number;
  /** Keep at least this many versions per path when pruning (D48). */
  readonly versionRetentionCount: number;
  /** Keep versions younger than this many days when pruning (D48). */
  readonly versionRetentionDays: number;
  /** Soft-deleted projects are recoverable for this many days (D49). Default 30. */
  readonly deletionRecoveryDays?: number;
  /** Clone-token generator (D58); injectable for determinism. Default: 32 random bytes. */
  readonly tokenGenerator?: () => string;
}

/** Default soft-delete recovery window — 30 days (D49). No config tunable owns this. */
export const DEFAULT_DELETION_RECOVERY_DAYS = 30;

/** Default clone-token generator — 32 unguessable bytes as url-safe base64 (D58). */
export function defaultCloneTokenGenerator(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic server-side content hash — same content ⇒ same hash (D38). */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Columns projected by the project queries (bigints arrive as strings). */
interface ProjectRow {
  readonly id: string;
  readonly owner_address: string;
  readonly name: string;
  readonly created_at_ms: string;
  readonly deleted_at_ms: string | null;
}

/** Re-brand a DB row into the wire {@link Project} at the store boundary. */
function mapProject(row: ProjectRow): Project {
  const base = {
    id: row.id,
    ownerAddress: row.owner_address,
    name: row.name,
    createdAt: Number(row.created_at_ms),
  };
  return ProjectSchema.parse(
    row.deleted_at_ms === null ? base : { ...base, deletedAt: Number(row.deleted_at_ms) },
  );
}

/** Standard projection so every project SELECT returns {@link ProjectRow} columns. */
const PROJECT_COLUMNS = `id, owner_address, name,
  (extract(epoch from created_at) * 1000)::bigint AS created_at_ms,
  (extract(epoch from deleted_at) * 1000)::bigint AS deleted_at_ms`;

/** Postgres `invalid_text_representation` — a malformed uuid id from an untrusted route. */
function isInvalidUuidError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "22P02";
}

/**
 * Postgres-backed {@link ProjectStore}. Every mutation that must be all-or-nothing
 * (a batch commit, seq allocation, restore) runs inside `db.transaction`; reads are
 * single parameterized queries. Chat is delegated to a {@link PgChatStore}.
 */
export class PgProjectStore implements ProjectStore {
  private readonly chat: PgChatStore;
  private readonly maxFileBytes: number;
  private readonly maxProjectBytes: number;
  private readonly projectQuotaPerAccount: number;
  private readonly versionRetentionCount: number;
  private readonly versionRetentionDays: number;
  private readonly deletionRecoveryDays: number;
  private readonly tokenGenerator: () => string;

  constructor(
    private readonly db: ProjectDb,
    options: PgProjectStoreOptions,
  ) {
    this.chat = new PgChatStore(db);
    this.maxFileBytes = options.maxFileBytes;
    this.maxProjectBytes = options.maxProjectBytes;
    this.projectQuotaPerAccount = options.projectQuotaPerAccount;
    this.versionRetentionCount = options.versionRetentionCount;
    this.versionRetentionDays = options.versionRetentionDays;
    this.deletionRecoveryDays = options.deletionRecoveryDays ?? DEFAULT_DELETION_RECOVERY_DAYS;
    this.tokenGenerator = options.tokenGenerator ?? defaultCloneTokenGenerator;
  }

  appendChat(projectId: string, message: ChatWrite): Promise<ChatMessage> {
    return this.chat.appendChat(projectId, message);
  }

  getChat(projectId: string): Promise<ChatMessage[]> {
    return this.chat.getChat(projectId);
  }

  async listProjects(ownerAddress: string): Promise<Project[]> {
    const { rows } = await this.db.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM projects
        WHERE owner_address = $1 AND deleted_at IS NULL
        ORDER BY created_at, id`,
      [ownerAddress],
    );
    return rows.map(mapProject);
  }

  async createProject(ownerAddress: string, name: string): Promise<Project> {
    // Atomic count-guarded insert: the row lands only while the account is under quota.
    const { rows } = await this.db.query<ProjectRow>(
      `INSERT INTO projects (owner_address, name)
       SELECT $1, $2
        WHERE (SELECT count(*) FROM projects WHERE owner_address = $1 AND deleted_at IS NULL) < $3
       RETURNING ${PROJECT_COLUMNS}`,
      [ownerAddress, name, this.projectQuotaPerAccount],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ProjectCountQuotaExceededError(ownerAddress, this.projectQuotaPerAccount);
    }
    return mapProject(row);
  }

  async getProject(id: string): Promise<Project | null> {
    try {
      const { rows } = await this.db.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? null : mapProject(row);
    } catch (error) {
      // A malformed (non-uuid) id from an untrusted route is "not found", not a 500.
      if (isInvalidUuidError(error)) {
        return null;
      }
      throw error;
    }
  }

  async renameProject(id: string, name: string): Promise<Project> {
    const { rows } = await this.db.query<ProjectRow>(
      `UPDATE projects SET name = $2
        WHERE id = $1 AND deleted_at IS NULL
      RETURNING ${PROJECT_COLUMNS}`,
      [id, name],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ProjectNotFoundError(id);
    }
    return mapProject(row);
  }

  async softDeleteProject(id: string): Promise<Project> {
    const { rows } = await this.db.query<ProjectRow>(
      `UPDATE projects SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL
      RETURNING ${PROJECT_COLUMNS}`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ProjectNotFoundError(id);
    }
    return mapProject(row);
  }

  restoreProject(id: string): Promise<Project> {
    return this.db.transaction(async (tx) => {
      // Read + lock the row and compute recovery against the DB clock, not the process.
      const current = await tx.query<{ deleted_at_ms: string | null; expired: boolean }>(
        `SELECT (extract(epoch from deleted_at) * 1000)::bigint AS deleted_at_ms,
                (deleted_at < now() - ($2::text || ' days')::interval) AS expired
           FROM projects
          WHERE id = $1
          FOR UPDATE`,
        [id, this.deletionRecoveryDays],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new ProjectNotFoundError(id);
      }
      if (row.deleted_at_ms === null) {
        // Already live — restore is idempotent; return the current row unchanged.
        const live = await tx.query<ProjectRow>(
          `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`,
          [id],
        );
        const liveRow = live.rows[0];
        if (liveRow === undefined) {
          throw new ProjectNotFoundError(id);
        }
        return mapProject(liveRow);
      }
      if (row.expired) {
        throw new RestoreWindowExpiredError(id);
      }
      const restored = await tx.query<ProjectRow>(
        `UPDATE projects SET deleted_at = NULL WHERE id = $1 RETURNING ${PROJECT_COLUMNS}`,
        [id],
      );
      const restoredRow = restored.rows[0];
      if (restoredRow === undefined) {
        throw new ProjectNotFoundError(id);
      }
      return mapProject(restoredRow);
    });
  }

  // `async` so the up-front size-cap check REJECTS (never throws synchronously),
  // giving callers a single uniform failure channel (SC-026 scenario 6).
  async commit(projectId: string, request: CommitRequest): Promise<CommitResult> {
    // Per-file byte cap: reject up-front by BYTE length, never truncate.
    for (const file of request.files) {
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > this.maxFileBytes) {
        throw new FileTooLargeError(file.path, bytes, this.maxFileBytes);
      }
    }

    return this.db.transaction(async (tx) => {
      // Lock the project row so per-project version allocation is serialized (D40 belt).
      const project = await tx.query(
        `SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [projectId],
      );
      if (project.rows.length === 0) {
        throw new ProjectNotFoundError(projectId);
      }

      const versionResult = await tx.query<{ next: string }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next
           FROM project_file_versions
          WHERE project_id = $1`,
        [projectId],
      );
      const version = Number(versionResult.rows[0]?.next ?? "1");

      // Project-total quota = current total − sizes of overwritten paths + new sizes.
      const paths = request.files.map((file) => file.path);
      const totals = await tx.query<{ current_total: string; overwritten: string }>(
        `SELECT COALESCE(SUM(size), 0) AS current_total,
                COALESCE(SUM(size) FILTER (WHERE path = ANY($2::text[])), 0) AS overwritten
           FROM project_files
          WHERE project_id = $1`,
        [projectId, paths],
      );
      const totalsRow = totals.rows[0];
      const currentTotal = Number(totalsRow?.current_total ?? "0");
      const overwritten = Number(totalsRow?.overwritten ?? "0");
      const incoming = request.files.reduce(
        (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
        0,
      );
      const projectedTotal = currentTotal - overwritten + incoming;
      if (projectedTotal > this.maxProjectBytes) {
        throw new ProjectQuotaExceededError(projectId, projectedTotal, this.maxProjectBytes);
      }

      for (const file of request.files) {
        const bytes = Buffer.byteLength(file.content, "utf8");
        const hash = computeContentHash(file.content);
        // Current state: one row per path (PK project_id, path) — UPSERT to the new version.
        await tx.query(
          `INSERT INTO project_files (project_id, path, content, content_hash, size, version, author)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, path)
           DO UPDATE SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                         size = EXCLUDED.size, version = EXCLUDED.version, author = EXCLUDED.author`,
          [projectId, file.path, file.content, hash, bytes, version, request.author],
        );
        // History: append-only per (project, path, version).
        await tx.query(
          `INSERT INTO project_file_versions
                (project_id, path, version, content, content_hash, size, author)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [projectId, file.path, version, file.content, hash, bytes, request.author],
        );
      }

      return { version };
    });
  }

  async getManifest(projectId: string): Promise<ManifestEntry[]> {
    const { rows } = await this.db.query<{ path: string; content_hash: string }>(
      `SELECT path, content_hash FROM project_files WHERE project_id = $1 ORDER BY path`,
      [projectId],
    );
    return rows.map((row) =>
      ManifestEntrySchema.parse({ path: row.path, contentHash: row.content_hash }),
    );
  }

  async getFile(projectId: string, path: string): Promise<ProjectFileResponse | null> {
    const { rows } = await this.db.query<{ path: string; content: string }>(
      `SELECT path, content FROM project_files WHERE project_id = $1 AND path = $2`,
      [projectId, path],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : ProjectFileResponseSchema.parse({ path: row.path, content: row.content });
  }

  async getFiles(projectId: string): Promise<HandoffFile[]> {
    const { rows } = await this.db.query<{ path: string; content: string; content_hash: string }>(
      `SELECT path, content, content_hash FROM project_files WHERE project_id = $1 ORDER BY path`,
      [projectId],
    );
    return rows.map((row) => ({
      path: row.path,
      content: row.content,
      contentHash: row.content_hash,
    }));
  }

  async getVersionHistory(projectId: string): Promise<VersionSnapshot[]> {
    // Each row is one path's content at the version it CHANGED; group by version (oldest-first)
    // so the git materializer folds them into one synthesized commit each (D48/D59).
    const { rows } = await this.db.query<{
      version: number;
      path: string;
      content: string;
      content_hash: string;
      author: FileAuthor;
      created_at_ms: string;
    }>(
      `SELECT version::int AS version, path, content, content_hash, author,
              (extract(epoch from created_at) * 1000)::bigint AS created_at_ms
         FROM project_file_versions
        WHERE project_id = $1
        ORDER BY version, path`,
      [projectId],
    );
    const byVersion = new Map<
      number,
      { author: FileAuthor; createdAt: number; files: HandoffFile[] }
    >();
    for (const row of rows) {
      let bucket = byVersion.get(row.version);
      if (bucket === undefined) {
        bucket = { author: row.author, createdAt: Number(row.created_at_ms), files: [] };
        byVersion.set(row.version, bucket);
      }
      bucket.files.push({ path: row.path, content: row.content, contentHash: row.content_hash });
    }
    return [...byVersion.entries()]
      .sort(([a], [b]) => a - b)
      .map(([version, bucket]) => ({
        version,
        author: bucket.author,
        createdAt: bucket.createdAt,
        files: bucket.files,
      }));
  }

  async recordGreenBuild(projectId: string, build: DeployArtifacts): Promise<void> {
    // Upsert: one row per project, latest build wins (the deploy handler reads it at
    // deploy time). No amounts — plain provenance columns (url prefix + compiler version).
    await this.db.query(
      `INSERT INTO project_green_builds (project_id, url_prefix, compiler_version)
            VALUES ($1, $2, $3)
       ON CONFLICT (project_id)
       DO UPDATE SET url_prefix = EXCLUDED.url_prefix,
                     compiler_version = EXCLUDED.compiler_version,
                     recorded_at = now()`,
      [projectId, build.urlPrefix, build.compilerVersion],
    );
  }

  async getLatestGreenBuild(projectId: string): Promise<DeployArtifacts | null> {
    const { rows } = await this.db.query<{ url_prefix: string; compiler_version: string }>(
      `SELECT url_prefix, compiler_version FROM project_green_builds WHERE project_id = $1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { urlPrefix: row.url_prefix, compilerVersion: row.compiler_version };
  }

  async mintCloneToken(projectId: string): Promise<string> {
    const token = this.tokenGenerator();
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE projects SET clone_token = $2 WHERE id = $1 RETURNING id`,
        [projectId, token],
      );
      if (rows[0] === undefined) {
        throw new ProjectNotFoundError(projectId);
      }
      return token;
    } catch (error) {
      // A malformed (non-uuid) id is "not found", not a 500 (mirrors getProject).
      if (isInvalidUuidError(error)) {
        throw new ProjectNotFoundError(projectId);
      }
      throw error;
    }
  }

  async revokeCloneToken(projectId: string): Promise<void> {
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE projects SET clone_token = NULL WHERE id = $1 RETURNING id`,
        [projectId],
      );
      if (rows[0] === undefined) {
        throw new ProjectNotFoundError(projectId);
      }
    } catch (error) {
      if (isInvalidUuidError(error)) {
        throw new ProjectNotFoundError(projectId);
      }
      throw error;
    }
  }

  async getProjectByCloneToken(token: string): Promise<Project | null> {
    // The partial-unique index makes this at most one row; soft-deleted rows still resolve
    // so the service can raise a DISABLED signal rather than leak the project's existence.
    const { rows } = await this.db.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE clone_token = $1`,
      [token],
    );
    const row = rows[0];
    return row === undefined ? null : mapProject(row);
  }

  async getCloneMaterializedVersion(projectId: string): Promise<number | null> {
    try {
      const { rows } = await this.db.query<{ watermark: string | null }>(
        `SELECT clone_materialized_at_version AS watermark FROM projects WHERE id = $1`,
        [projectId],
      );
      const watermark = rows[0]?.watermark ?? null;
      return watermark === null ? null : Number(watermark);
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return null;
      }
      throw error;
    }
  }

  async setCloneMaterializedVersion(projectId: string, version: number): Promise<void> {
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE projects SET clone_materialized_at_version = $2 WHERE id = $1 RETURNING id`,
        [projectId, version],
      );
      if (rows[0] === undefined) {
        throw new ProjectNotFoundError(projectId);
      }
    } catch (error) {
      if (isInvalidUuidError(error)) {
        throw new ProjectNotFoundError(projectId);
      }
      throw error;
    }
  }

  async purgeDeletedProjects(): Promise<number> {
    // Hard-delete past the recovery window; files/versions/chat cascade via FK (D49).
    const result = await this.db.query(
      `DELETE FROM projects
        WHERE deleted_at IS NOT NULL
          AND deleted_at < now() - ($1::text || ' days')::interval`,
      [this.deletionRecoveryDays],
    );
    return result.rowCount ?? 0;
  }

  async pruneFileVersions(): Promise<number> {
    // Prune history rows that are BOTH older than the retention age AND outside the
    // newest-N-per-path window, but NEVER the version the current file points at (D48).
    const result = await this.db.query(
      `DELETE FROM project_file_versions v
        WHERE v.created_at < now() - ($1::text || ' days')::interval
          AND v.version NOT IN (
                SELECT vv.version
                  FROM project_file_versions vv
                 WHERE vv.project_id = v.project_id AND vv.path = v.path
                 ORDER BY vv.version DESC
                 LIMIT $2
              )
          AND NOT EXISTS (
                SELECT 1 FROM project_files cf
                 WHERE cf.project_id = v.project_id
                   AND cf.path = v.path
                   AND cf.version = v.version
              )`,
      [this.versionRetentionDays, this.versionRetentionCount],
    );
    return result.rowCount ?? 0;
  }
}
