/**
 * Shared test doubles for the project persistence layer (US7).
 *
 * Two pieces the project tests reuse:
 *  - an in-memory {@link ProjectStore} that models `projects`, `project_files`,
 *    `project_file_versions`, and `chat_messages` with an INJECTED clock, a faithful
 *    transaction/rollback (snapshot-and-restore, mirroring Postgres ROLLBACK), the
 *    project-wide monotonic version counter, and a one-shot MID-COMMIT fault hook so
 *    SC-026 (crash mid-batch) is a real, deterministic test with no external Postgres;
 *  - a `bootProjects` harness that boots the real `buildServer` wiring with an injected
 *    in-memory auth store (to mint a real session cookie) + this store, plus session
 *    seeding — so route tests run through `app.inject()` with no DB and no wallet.
 *
 * Content hashes come from the REAL `computeContentHash`, so a manifest built here is
 * byte-for-byte comparable with one the Postgres store would produce (SC-025).
 */
import {
  ChatMessageSchema,
  ManifestEntrySchema,
  ProjectFileResponseSchema,
  ProjectSchema,
} from "@nyx/protocol";
import type {
  ChatMessage,
  ChatRole,
  ManifestEntry,
  Project,
  ProjectFileResponse,
} from "@nyx/protocol";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createMcpClients } from "../../src/mcp/index.js";
import type { McpSession } from "../../src/mcp/index.js";
import type { Queryable } from "../../src/db/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import { computeContentHash } from "../../src/projects/index.js";
import type {
  ChatWrite,
  CommitRequest,
  CommitResult,
  DeletionCascade,
  FileAuthor,
  ProjectStore,
} from "../../src/projects/index.js";
import {
  FileTooLargeError,
  ProjectCountQuotaExceededError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "../../src/projects/index.js";
import { InMemoryAuthStore } from "../auth/helpers.js";

const DAY_MS = 86_400_000;

const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/nyx_test",
  MCP_TOOLCHAIN_URL: "http://toolchain.test.local/mcp",
  MCP_TOME_URL: "http://tome.test.local/mcp",
  MCP_MNM_URL: "http://mnm.test.local/mcp",
  PROVER_URL: "http://prover.test.local",
  COMPILE_SERVICE_URL: "http://compile.test.local",
  COMPILE_SERVICE_TOKEN: "test-compile-token",
  DEPLOY_KEY: "test-deploy-key",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_ACCOUNT_ID: "test-account-id",
  SESSION_LIFETIME_MS: "604800000",
  MODEL_ROUTING: JSON.stringify({
    supervisor: { provider: "anthropic", model: "claude" },
    scaffolding: { provider: "anthropic", model: "claude" },
    planning: { provider: "anthropic", model: "claude" },
    implementation: { provider: "anthropic", model: "claude" },
    review: { provider: "anthropic", model: "claude" },
  }),
};

const SESSION_LIFETIME_MS = 604_800_000;
const NONCE_TTL_MS = 300_000;

/** Tuning for the in-memory store; tests use tiny caps to exercise cap/quota rejection. */
export interface InMemoryProjectStoreOptions {
  readonly clock: () => number;
  readonly maxFileBytes: number;
  readonly maxProjectBytes: number;
  readonly projectQuotaPerAccount: number;
  readonly versionRetentionCount: number;
  readonly versionRetentionDays: number;
  readonly deletionRecoveryDays: number;
}

interface ProjectRecord {
  id: string;
  ownerAddress: string;
  name: string;
  createdAtMs: number;
  deletedAtMs: number | null;
}

interface FileRecord {
  content: string;
  contentHash: string;
  size: number;
  version: number;
  author: FileAuthor;
}

interface VersionRecord {
  path: string;
  version: number;
  content: string;
  contentHash: string;
  size: number;
  author: FileAuthor;
  createdAtMs: number;
}

interface ChatRecord {
  seq: number;
  role: ChatRole;
  content: string;
  turnId?: string;
  createdAtMs: number;
}

function mapProject(record: ProjectRecord): Project {
  const base = {
    id: record.id,
    ownerAddress: record.ownerAddress,
    name: record.name,
    createdAt: record.createdAtMs,
  };
  return ProjectSchema.parse(
    record.deletedAtMs === null ? base : { ...base, deletedAt: record.deletedAtMs },
  );
}

function mapChat(record: ChatRecord): ChatMessage {
  const base = {
    seq: record.seq,
    role: record.role,
    content: record.content,
    createdAt: record.createdAtMs,
  };
  return ChatMessageSchema.parse(
    record.turnId === undefined ? base : { ...base, turnId: record.turnId },
  );
}

/**
 * In-memory {@link ProjectStore} modelling the Postgres semantics with an injected
 * clock. Mutations that must be all-or-nothing run inside {@link transaction}, which
 * snapshots and restores on throw — so the injected mid-commit fault leaves the
 * previous consistent version intact (SC-026).
 */
export class InMemoryProjectStore implements ProjectStore {
  private projects = new Map<string, ProjectRecord>();
  private files = new Map<string, Map<string, FileRecord>>();
  private versions = new Map<string, VersionRecord[]>();
  private chat = new Map<string, ChatRecord[]>();

  private seq = 0;
  private faultAfterWrites: number | undefined;

  constructor(private readonly opts: InMemoryProjectStoreOptions) {}

  /** Arm a one-shot fault that throws after `writes` file rows are applied (SC-026). */
  failNextCommitAfter(writes: number): void {
    this.faultAfterWrites = writes;
  }

  private now(): number {
    return this.opts.clock();
  }

  private transaction<T>(fn: () => T): T {
    const snapshot = {
      projects: structuredClone(this.projects),
      files: structuredClone(this.files),
      versions: structuredClone(this.versions),
      chat: structuredClone(this.chat),
    };
    try {
      return fn();
    } catch (error) {
      this.projects = snapshot.projects;
      this.files = snapshot.files;
      this.versions = snapshot.versions;
      this.chat = snapshot.chat;
      throw error;
    }
  }

  listProjects(ownerAddress: string): Promise<Project[]> {
    const live = [...this.projects.values()]
      .filter((p) => p.ownerAddress === ownerAddress && p.deletedAtMs === null)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
      .map(mapProject);
    return Promise.resolve(live);
  }

  // `async` throughout so validation throws surface as REJECTIONS, matching how the
  // Postgres store fails (a single uniform failure channel for callers/tests).
  createProject(ownerAddress: string, name: string): Promise<Project> {
    const liveCount = [...this.projects.values()].filter(
      (p) => p.ownerAddress === ownerAddress && p.deletedAtMs === null,
    ).length;
    if (liveCount >= this.opts.projectQuotaPerAccount) {
      return Promise.reject(
        new ProjectCountQuotaExceededError(ownerAddress, this.opts.projectQuotaPerAccount),
      );
    }
    this.seq += 1;
    const id = `proj-${String(this.seq)}`;
    const record: ProjectRecord = {
      id,
      ownerAddress,
      name,
      createdAtMs: this.now(),
      deletedAtMs: null,
    };
    this.projects.set(id, record);
    this.files.set(id, new Map());
    this.versions.set(id, []);
    this.chat.set(id, []);
    return Promise.resolve(mapProject(record));
  }

  getProject(id: string): Promise<Project | null> {
    const record = this.projects.get(id);
    return Promise.resolve(record === undefined ? null : mapProject(record));
  }

  renameProject(id: string, name: string): Promise<Project> {
    const record = this.projects.get(id);
    if (record === undefined) {
      return Promise.reject(new ProjectNotFoundError(id));
    }
    if (record.deletedAtMs !== null) {
      return Promise.reject(new ProjectNotFoundError(id));
    }
    record.name = name;
    return Promise.resolve(mapProject(record));
  }

  softDeleteProject(id: string): Promise<Project> {
    const record = this.projects.get(id);
    if (record === undefined) {
      return Promise.reject(new ProjectNotFoundError(id));
    }
    if (record.deletedAtMs !== null) {
      return Promise.reject(new ProjectNotFoundError(id));
    }
    record.deletedAtMs = this.now();
    return Promise.resolve(mapProject(record));
  }

  restoreProject(id: string): Promise<Project> {
    const record = this.projects.get(id);
    if (record === undefined) {
      return Promise.reject(new ProjectNotFoundError(id));
    }
    if (record.deletedAtMs === null) {
      return Promise.resolve(mapProject(record)); // Idempotent: already live.
    }
    if (this.now() - record.deletedAtMs > this.opts.deletionRecoveryDays * DAY_MS) {
      return Promise.reject(new RestoreWindowExpiredError(id));
    }
    record.deletedAtMs = null;
    return Promise.resolve(mapProject(record));
  }

  commit(projectId: string, request: CommitRequest): Promise<CommitResult> {
    // Convert every synchronous validation/rollback throw into a rejection so tests
    // and callers see one uniform failure channel (mirrors the Postgres store).
    try {
      for (const file of request.files) {
        const bytes = Buffer.byteLength(file.content, "utf8");
        if (bytes > this.opts.maxFileBytes) {
          throw new FileTooLargeError(file.path, bytes, this.opts.maxFileBytes);
        }
      }
      const fault = this.faultAfterWrites;
      this.faultAfterWrites = undefined;

      const result = this.transaction<CommitResult>(() => {
        const project = this.projects.get(projectId);
        if (project === undefined) {
          throw new ProjectNotFoundError(projectId);
        }
        if (project.deletedAtMs !== null) {
          throw new ProjectNotFoundError(projectId);
        }
        const history = this.versions.get(projectId) ?? [];
        const version = history.reduce((max, v) => Math.max(max, v.version), 0) + 1;
        const fileMap = this.files.get(projectId) ?? new Map<string, FileRecord>();

        let currentTotal = 0;
        for (const record of fileMap.values()) {
          currentTotal += record.size;
        }
        let overwritten = 0;
        for (const file of request.files) {
          overwritten += fileMap.get(file.path)?.size ?? 0;
        }
        const incoming = request.files.reduce(
          (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
          0,
        );
        const projected = currentTotal - overwritten + incoming;
        if (projected > this.opts.maxProjectBytes) {
          throw new ProjectQuotaExceededError(projectId, projected, this.opts.maxProjectBytes);
        }

        let applied = 0;
        for (const file of request.files) {
          const bytes = Buffer.byteLength(file.content, "utf8");
          const hash = computeContentHash(file.content);
          fileMap.set(file.path, {
            content: file.content,
            contentHash: hash,
            size: bytes,
            version,
            author: request.author,
          });
          history.push({
            path: file.path,
            version,
            content: file.content,
            contentHash: hash,
            size: bytes,
            author: request.author,
            createdAtMs: this.now(),
          });
          applied += 1;
          if (fault !== undefined && applied >= fault) {
            // Simulate a crash mid-batch: the transaction rolls back to the prior version.
            throw new Error("injected mid-commit fault");
          }
        }
        this.files.set(projectId, fileMap);
        this.versions.set(projectId, history);
        return { version };
      });
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getManifest(projectId: string): Promise<ManifestEntry[]> {
    const fileMap = this.files.get(projectId) ?? new Map<string, FileRecord>();
    const manifest = [...fileMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, record]) =>
        ManifestEntrySchema.parse({ path, contentHash: record.contentHash }),
      );
    return Promise.resolve(manifest);
  }

  getFile(projectId: string, path: string): Promise<ProjectFileResponse | null> {
    const record = this.files.get(projectId)?.get(path);
    return Promise.resolve(
      record === undefined
        ? null
        : ProjectFileResponseSchema.parse({ path, content: record.content }),
    );
  }

  purgeDeletedProjects(): Promise<number> {
    let purged = 0;
    for (const [id, record] of this.projects) {
      if (
        record.deletedAtMs !== null &&
        this.now() - record.deletedAtMs > this.opts.deletionRecoveryDays * DAY_MS
      ) {
        this.projects.delete(id);
        this.files.delete(id);
        this.versions.delete(id);
        this.chat.delete(id);
        purged += 1;
      }
    }
    return Promise.resolve(purged);
  }

  pruneFileVersions(): Promise<number> {
    let removed = 0;
    for (const [projectId, history] of this.versions) {
      const fileMap = this.files.get(projectId) ?? new Map<string, FileRecord>();
      const byPath = new Map<string, VersionRecord[]>();
      for (const version of history) {
        const bucket = byPath.get(version.path) ?? [];
        bucket.push(version);
        byPath.set(version.path, bucket);
      }
      const kept: VersionRecord[] = [];
      for (const [path, versionsForPath] of byPath) {
        const currentVersion = fileMap.get(path)?.version;
        const newest = new Set(
          [...versionsForPath]
            .sort((a, b) => b.version - a.version)
            .slice(0, this.opts.versionRetentionCount)
            .map((v) => v.version),
        );
        for (const version of versionsForPath) {
          const tooOld = this.now() - version.createdAtMs > this.opts.versionRetentionDays * DAY_MS;
          const isCurrent = version.version === currentVersion;
          if (tooOld && !newest.has(version.version) && !isCurrent) {
            removed += 1;
          } else {
            kept.push(version);
          }
        }
      }
      this.versions.set(projectId, kept);
    }
    return Promise.resolve(removed);
  }

  appendChat(projectId: string, message: ChatWrite): Promise<ChatMessage> {
    const project = this.projects.get(projectId);
    if (project === undefined) {
      return Promise.reject(new ProjectNotFoundError(projectId));
    }
    const messages = this.chat.get(projectId) ?? [];
    const seq = messages.reduce((max, m) => Math.max(max, m.seq), 0) + 1;
    const record: ChatRecord = {
      seq,
      role: message.role,
      content: message.content,
      createdAtMs: this.now(),
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    };
    messages.push(record);
    this.chat.set(projectId, messages);
    return Promise.resolve(mapChat(record));
  }

  getChat(projectId: string): Promise<ChatMessage[]> {
    const messages = this.chat.get(projectId) ?? [];
    return Promise.resolve([...messages].sort((a, b) => a.seq - b.seq).map(mapChat));
  }
}

/** A mutable clock the in-memory stores read, so tests can advance time. */
export interface Clock {
  now: number;
}

/** Defaults are tiny so cap/quota rejection is cheap to trigger; override per test. */
const DEFAULT_STORE_OPTIONS: Omit<InMemoryProjectStoreOptions, "clock"> = {
  maxFileBytes: 64,
  maxProjectBytes: 256,
  projectQuotaPerAccount: 3,
  versionRetentionCount: 2,
  versionRetentionDays: 30,
  deletionRecoveryDays: 30,
};

/** Construct a bare in-memory store bound to `clock`, with per-test option overrides. */
export function makeInMemoryStore(
  clock: Clock,
  overrides: Partial<Omit<InMemoryProjectStoreOptions, "clock">> = {},
): InMemoryProjectStore {
  return new InMemoryProjectStore({
    clock: () => clock.now,
    ...DEFAULT_STORE_OPTIONS,
    ...overrides,
  });
}

/** A cascade that records the project ids it was fired for (scenario-7 assertion). */
export interface RecordingCascade extends DeletionCascade {
  readonly fired: string[];
}

/** Build a cascade double that records each `run(projectId)` call. */
export function recordingCascade(): RecordingCascade {
  const fired: string[] = [];
  return {
    fired,
    run(projectId: string): Promise<void> {
      fired.push(projectId);
      return Promise.resolve();
    },
  };
}

const inertMcpSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: () => Promise.resolve(null),
  close: () => Promise.resolve(),
};

function stubDb(): Queryable {
  return {
    query: <R extends QueryResultRow>(): Promise<QueryResult<R>> =>
      Promise.resolve({ command: "SELECT", rowCount: 1, oid: 0, rows: [], fields: [] }),
  };
}

export interface ProjectHarness {
  readonly app: FastifyInstance;
  readonly store: InMemoryProjectStore;
  readonly authStore: InMemoryAuthStore;
  readonly cascade: RecordingCascade;
  readonly clock: Clock;
  /** Mint a real session for `address` and return the `Cookie` header value. */
  readonly seedSession: (address: string) => Promise<string>;
}

/** Boot the real server wiring with in-memory auth + project stores (no DB, no wallet). */
export async function bootProjects(
  overrides: Partial<Omit<InMemoryProjectStoreOptions, "clock">> = {},
): Promise<ProjectHarness> {
  const config = loadConfig(TEST_ENV);
  const mcp = createMcpClients(config.mcp, () => Promise.resolve(inertMcpSession));
  const clock: Clock = { now: 1_000_000 };
  const authStore = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: NONCE_TTL_MS,
  });
  const store = new InMemoryProjectStore({
    clock: () => clock.now,
    ...DEFAULT_STORE_OPTIONS,
    ...overrides,
  });
  const cascade = recordingCascade();
  const app = await buildServer({
    config,
    db: stubDb(),
    mcp,
    authStore,
    projectStore: store,
    projectCascade: cascade,
  });
  await app.ready();

  const seedSession = async (address: string): Promise<string> => {
    const { nonce } = await authStore.issueNonce();
    const result = await authStore.issue({ nonce, accountAddress: address, verify: () => true });
    if (!result.ok) {
      throw new Error("failed to seed session");
    }
    return `${SESSION_COOKIE_NAME}=${result.sessionId}`;
  };

  return { app, store, authStore, cascade, clock, seedSession };
}
