/**
 * Live-Postgres integration test for {@link PgProjectStore} (T051/T052/T054/T055).
 *
 * Gated on `DATABASE_URL`: this is the authoritative check that the REAL SQL behaves
 * against a real database clock — batch-commit atomicity + ROLLBACK (SC-026), the
 * project-wide monotonic version, manifest content-hash equality (SC-025), ownership
 * reads, soft-delete/restore/purge (SC-028/D49), retention pruning (D48), and chat
 * seq monotonicity (D23). The deterministic suite covers the same semantics with an
 * in-memory double; this proves the SQL itself. Requires migration 0001 applied.
 *
 * The mid-commit crash is injected by wrapping the real `Db` so the transaction's
 * SECOND `project_file_versions` INSERT rejects — the whole batch must roll back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/index.js";
import type { Db, Queryable } from "../../src/db/index.js";
import { computeContentHash, PgProjectStore } from "../../src/projects/index.js";
import type { ProjectDb } from "../../src/projects/index.js";
import { RestoreWindowExpiredError } from "../../src/projects/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const runLive = DATABASE_URL !== undefined && DATABASE_URL !== "";
const LIVE_URL = DATABASE_URL ?? "";

const OWNER = `pgtest-owner-${String(Date.now())}`;
const OPTIONS = {
  maxFileBytes: 1_048_576,
  maxProjectBytes: 52_428_800,
  projectQuotaPerAccount: 20,
  versionRetentionCount: 2,
  versionRetentionDays: 30,
  deletionRecoveryDays: 30,
};

/** Wrap `db` so the transaction's Nth `project_file_versions` INSERT rejects (crash sim). */
function faultingDb(db: Db, failOnNthVersionInsert: number): ProjectDb {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) =>
      db.transaction((tx) => {
        let versionInserts = 0;
        const proxied: Queryable = {
          query: (text, params) => {
            if (text.includes("INSERT INTO project_file_versions")) {
              versionInserts += 1;
              if (versionInserts === failOnNthVersionInsert) {
                return Promise.reject(new Error("injected mid-commit fault"));
              }
            }
            return tx.query(text, params);
          },
        };
        return fn(proxied);
      }),
  };
}

describe.skipIf(!runLive)("PgProjectStore against live Postgres (US7)", () => {
  let db: Db;
  let store: PgProjectStore;

  beforeAll(async () => {
    db = createDb({ connectionString: LIVE_URL });
    store = new PgProjectStore(db, OPTIONS);
    await db.query(`INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING`, [OWNER]);
  });

  afterAll(async () => {
    // Projects cascade to files/versions/chat on delete.
    await db.query(`DELETE FROM projects WHERE owner_address = $1`, [OWNER]);
    await db.query(`DELETE FROM accounts WHERE address = $1`, [OWNER]);
    await db.end();
  });

  it("commits batches at a monotonic version and serves a hash-stable manifest", async () => {
    const project = await store.createProject(OWNER, "monotonic");
    const first = await store.commit(project.id, {
      author: "agent",
      files: [
        { path: "b.ts", content: "second" },
        { path: "a.ts", content: "first" },
      ],
    });
    expect(first.version).toBe(1);
    const second = await store.commit(project.id, {
      author: "user",
      files: [{ path: "a.ts", content: "first-2" }],
    });
    expect(second.version).toBe(2);

    const manifest = await store.getManifest(project.id);
    expect(manifest.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
    const fileA = await store.getFile(project.id, "a.ts");
    expect(fileA?.content).toBe("first-2");
    const entryA = manifest.find((entry) => entry.path === "a.ts");
    expect(entryA?.contentHash).toBe(computeContentHash("first-2"));
  });

  it("rolls back a batch that crashes mid-commit, leaving the previous version (SC-026)", async () => {
    const project = await store.createProject(OWNER, "atomic");
    await store.commit(project.id, { author: "agent", files: [{ path: "a.ts", content: "one" }] });

    const faultStore = new PgProjectStore(faultingDb(db, 2), OPTIONS);
    await expect(
      faultStore.commit(project.id, {
        author: "agent",
        files: [
          { path: "b.ts", content: "two" },
          { path: "c.ts", content: "three" },
        ],
      }),
    ).rejects.toThrow(/mid-commit fault/);

    // Nothing from the failed batch survived; only a.ts remains, at version 1.
    const manifest = await store.getManifest(project.id);
    expect(manifest.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(await store.getFile(project.id, "b.ts")).toBeNull();

    // The failed batch did not consume version 2.
    const next = await store.commit(project.id, {
      author: "agent",
      files: [{ path: "b.ts", content: "two" }],
    });
    expect(next.version).toBe(2);
  });

  it("gates reads by ownership and lists only the owner's live projects", async () => {
    const project = await store.createProject(OWNER, "owned");
    const fetched = await store.getProject(project.id);
    expect(fetched?.ownerAddress).toBe(OWNER);

    // A malformed (non-uuid) id is treated as not found, never a 500.
    expect(await store.getProject("not-a-uuid")).toBeNull();

    const list = await store.listProjects(OWNER);
    expect(list.map((p) => p.id)).toContain(project.id);
  });

  it("soft-deletes and restores within the window; purges past it", async () => {
    const project = await store.createProject(OWNER, "lifecycle");
    const deleted = await store.softDeleteProject(project.id);
    expect(deleted.deletedAt).toBeGreaterThan(0);
    expect((await store.listProjects(OWNER)).map((p) => p.id)).not.toContain(project.id);

    const restored = await store.restoreProject(project.id);
    expect(restored.deletedAt).toBeUndefined();
    expect((await store.listProjects(OWNER)).map((p) => p.id)).toContain(project.id);

    // A zero-day recovery store treats any soft-delete as expired and purges it.
    const immediate = new PgProjectStore(db, { ...OPTIONS, deletionRecoveryDays: 0 });
    await immediate.softDeleteProject(project.id);
    await expect(immediate.restoreProject(project.id)).rejects.toBeInstanceOf(
      RestoreWindowExpiredError,
    );
    const purged = await immediate.purgeDeletedProjects();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await store.getProject(project.id)).toBeNull();
  });

  it("prunes history beyond the retention count/age but keeps the current version (D48)", async () => {
    const project = await store.createProject(OWNER, "retention");
    for (let i = 1; i <= 5; i += 1) {
      await store.commit(project.id, {
        author: "agent",
        files: [{ path: "a.ts", content: `v${String(i)}` }],
      });
    }
    // Zero-day age filter so every past version is eligible; keep newest 2 + current.
    const pruneStore = new PgProjectStore(db, {
      ...OPTIONS,
      versionRetentionCount: 2,
      versionRetentionDays: 0,
    });
    const removed = await pruneStore.pruneFileVersions();
    expect(removed).toBeGreaterThanOrEqual(1);

    const file = await store.getFile(project.id, "a.ts");
    expect(file?.content).toBe("v5");
    const history = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_file_versions WHERE project_id = $1 AND path = $2`,
      [project.id, "a.ts"],
    );
    expect(Number(history.rows[0]?.count ?? "0")).toBe(2);
  });

  it("persists chat with a monotonic seq and rehydrates in order (D23)", async () => {
    const project = await store.createProject(OWNER, "chat");
    const first = await store.appendChat(project.id, { role: "user", content: "hi" });
    const second = await store.appendChat(project.id, { role: "assistant", content: "hello" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const history = await store.getChat(project.id);
    expect(history.map((m) => m.content)).toEqual(["hi", "hello"]);
  });
});
