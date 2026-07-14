/**
 * Live-Postgres integration test for {@link PgDeployRegistry} (T156, US8).
 *
 * Gated on `DATABASE_URL`: the authoritative check that the REAL SQL behaves against a
 * real database — the atomic supersede + new-active INSERT under the
 * `deploy_registry_one_active_per_project` PARTIAL UNIQUE INDEX (SC-032/FR-057), the
 * monotonic `MAX(version)+1` allocation, `getActive`/`listDeploys`, the OFF-CHAIN
 * `teardownProject` status flip (T155), and the FK-backed {@link ProjectNotFoundError}.
 * The deterministic suite covers the same semantics with an in-memory double; this proves
 * the SQL — most sharply that the DB itself rejects a second 'active' row (23505), so the
 * exactly-one-active invariant is guaranteed even under a racing writer.
 *
 * It ALSO proves the defect-C1/M1 hardening under real Postgres: the
 * `deploy_registry_tx_ref_key` UNIQUE index rejects a duplicate tx_ref (23505), `recordDeploy`
 * is idempotent by tx_ref via the fast-path + SAVEPOINT'd 23505 (a re-record returns the
 * existing row, one active, no version bump), two concurrent same-tx `recordDeploy`s settle to
 * EXACTLY one active row (M4), and `teardownProject` serializes behind the `projects FOR UPDATE`
 * lock (M1). Requires migrations 0001–0003 applied (spin up a throwaway PG and apply them, e.g.
 * via the migrate CLI, before running with `DATABASE_URL`).
 *
 * Each test gets a FRESH project row (its own `deploy_registry`), so the tests are
 * mutually isolated; `afterAll` deletes the account's projects — the ON DELETE CASCADE
 * FK removes their `deploy_registry` rows — then the account.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb } from "../../src/db/index.js";
import type { Db } from "../../src/db/index.js";
import { PgDeployRegistry } from "../../src/deploy/registry.js";
import { ProjectNotFoundError } from "../../src/projects/errors.js";

/** Small real-timer delay for the M1 lock-blocking assertion. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DATABASE_URL = process.env.DATABASE_URL;
const runLive = DATABASE_URL !== undefined && DATABASE_URL !== "";
const LIVE_URL = DATABASE_URL ?? "";

const OWNER = `pgdeploy-owner-${String(Date.now())}`;
const MISSING_PROJECT = "00000000-0000-0000-0000-000000000000";

interface CountRow {
  readonly count: string;
}

async function activeCount(db: Db, projectId: string): Promise<string> {
  const { rows } = await db.query<CountRow>(
    `SELECT count(*)::text AS count FROM deploy_registry WHERE project_id = $1 AND status = 'active'`,
    [projectId],
  );
  return rows[0]?.count ?? "0";
}

async function statusCount(db: Db, projectId: string, status: string): Promise<string> {
  const { rows } = await db.query<CountRow>(
    `SELECT count(*)::text AS count FROM deploy_registry WHERE project_id = $1 AND status = $2`,
    [projectId, status],
  );
  return rows[0]?.count ?? "0";
}

describe.skipIf(!runLive)("PgDeployRegistry against live Postgres (US8)", () => {
  let db: Db;
  let registry: PgDeployRegistry;
  let projectId: string;

  beforeAll(async () => {
    db = createDb({ connectionString: LIVE_URL });
    registry = new PgDeployRegistry(db);
    await db.query(`INSERT INTO accounts (address) VALUES ($1) ON CONFLICT DO NOTHING`, [OWNER]);
  });

  beforeEach(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO projects (owner_address, name) VALUES ($1, $2) RETURNING id`,
      [OWNER, `deploy-registry-pg-${String(Date.now())}`],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error("failed to create test project");
    }
    projectId = id;
  });

  afterAll(async () => {
    // Deleting the project cascades its deploy_registry rows (ON DELETE CASCADE).
    await db.query(`DELETE FROM projects WHERE owner_address = $1`, [OWNER]);
    await db.query(`DELETE FROM accounts WHERE address = $1`, [OWNER]);
    await db.end();
  });

  it("records sequential deploys at a monotonic version, one active (FR-057)", async () => {
    const v1 = await registry.recordDeploy(projectId, "addr-1", "tx-1");
    expect(v1.version).toBe(1n);
    expect(v1.status).toBe("active");
    expect(v1.deployedAt).toBeGreaterThan(0);

    const v2 = await registry.recordDeploy(projectId, "addr-2", "tx-2");
    expect(v2.version).toBe(2n);
    expect(v2.status).toBe("active");

    expect(await activeCount(db, projectId)).toBe("1");
    expect(await statusCount(db, projectId, "superseded")).toBe("1");
    expect((await registry.getActive(projectId))?.version).toBe(2n);
    await expect(registry.assertOneActive(projectId)).resolves.toBeUndefined();
  });

  it("has the partial unique index reject a second active row (SC-032)", async () => {
    await registry.recordDeploy(projectId, "addr-1", "tx-1");
    // A raw INSERT of a SECOND 'active' row for the same project violates
    // deploy_registry_one_active_per_project → unique_violation (23505).
    await expect(
      db.query(
        `INSERT INTO deploy_registry (project_id, address, version, status, tx_ref)
         VALUES ($1, 'rogue', 999, 'active', 'tx-rogue')`,
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // The single legitimate active row survives.
    expect(await activeCount(db, projectId)).toBe("1");
  });

  it("C1: the tx_ref unique index rejects a duplicate tx_ref (23505 on deploy_registry_tx_ref_key)", async () => {
    await registry.recordDeploy(projectId, "addr-1", "tx-dup");
    // A raw INSERT of a SECOND row carrying the SAME tx_ref violates the migration-0003 unique
    // index. A 'superseded' status + a distinct version isolate the failure to the tx_ref index
    // (not the one-active partial index, not the (project_id, version) constraint).
    await expect(
      db.query(
        `INSERT INTO deploy_registry (project_id, address, version, status, tx_ref)
         VALUES ($1, 'addr-2', 999, 'superseded', 'tx-dup')`,
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "deploy_registry_tx_ref_key" });
  });

  it("C1: recordDeploy is idempotent by tx_ref — a re-record returns the existing row, one active, no version bump", async () => {
    const first = await registry.recordDeploy(projectId, "addr-1", "tx-1");
    // The pipeline's post-finality record RETRY re-runs with the SAME tx_ref: the fast-path
    // SELECT returns the already-recorded row — no supersede, no version bump, no second row.
    const again = await registry.recordDeploy(projectId, "addr-1", "tx-1");

    expect(again).toEqual(first);
    expect(again.version).toBe(1n);
    expect(await activeCount(db, projectId)).toBe("1");
    expect(await registry.listDeploys(projectId)).toHaveLength(1); // no 2nd row
    await expect(registry.assertOneActive(projectId)).resolves.toBeUndefined();
  });

  it("M4: two concurrent recordDeploys of the SAME tx settle to exactly one active row (no double-record)", async () => {
    // The two serialize on the projects FOR UPDATE lock; the winner inserts, the loser is
    // idempotent by tx_ref (fast-path post-commit, or the SAVEPOINT'd 23505 under a stale
    // snapshot). Either way: one row, one active, both return the SAME row.
    const [a, b] = await Promise.all([
      registry.recordDeploy(projectId, "addr-1", "tx-race"),
      registry.recordDeploy(projectId, "addr-1", "tx-race"),
    ]);

    expect(a).toEqual(b);
    expect(a.version).toBe(1n);
    expect(await activeCount(db, projectId)).toBe("1");
    expect(await registry.listDeploys(projectId)).toHaveLength(1);
    await expect(registry.assertOneActive(projectId)).resolves.toBeUndefined();
  });

  it("M1: teardownProject serializes behind the projects FOR UPDATE lock (no interleave with a concurrent deploy)", async () => {
    await registry.recordDeploy(projectId, "a1", "tx-1"); // seed one active

    const pool = new pg.Pool({ connectionString: LIVE_URL, max: 4 });
    const holder = await pool.connect();
    try {
      // Hold the project row lock on a SEPARATE connection.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);

      // teardownProject must now BLOCK on the same lock — proving it takes projects FOR UPDATE,
      // so a teardown and a concurrent deploy-finalize SERIALIZE instead of interleaving (M1).
      let settled = false;
      const teardown = registry.teardownProject(projectId).then((flipped) => {
        settled = true;
        return flipped;
      });
      await delay(200);
      expect(settled).toBe(false); // still blocked on the held lock

      await holder.query("COMMIT"); // release the lock
      expect(await teardown).toBe(1); // now teardown proceeds and flips the one active row
      expect(await registry.getActive(projectId)).toBeNull();
    } finally {
      holder.release();
      await pool.end();
    }
  });

  it("holds the invariant under a real redeploy chain (atomic supersede)", async () => {
    await registry.recordDeploy(projectId, "a1", "t1");
    await registry.recordDeploy(projectId, "a2", "t2");
    await registry.recordDeploy(projectId, "a3", "t3");

    expect(await activeCount(db, projectId)).toBe("1");
    expect(await statusCount(db, projectId, "superseded")).toBe("2");
    expect((await registry.getActive(projectId))?.version).toBe(3n);
  });

  it("lists every version newest-first", async () => {
    await registry.recordDeploy(projectId, "a1", "t1");
    await registry.recordDeploy(projectId, "a2", "t2");
    expect((await registry.listDeploys(projectId)).map((row) => row.version)).toEqual([2n, 1n]);
  });

  it("tears down off-chain — flips active + superseded to torn_down, idempotently (T155)", async () => {
    await registry.recordDeploy(projectId, "a1", "t1");
    await registry.recordDeploy(projectId, "a2", "t2");

    const flipped = await registry.teardownProject(projectId);
    expect(flipped).toBe(2);
    expect(await registry.getActive(projectId)).toBeNull();
    expect(await statusCount(db, projectId, "torn_down")).toBe("2");
    const inactive = await registry.listInactive(projectId);
    expect(inactive.every((row) => row.status === "torn_down")).toBe(true);

    // The on-chain contracts persist; a second teardown flips nothing.
    expect(await registry.teardownProject(projectId)).toBe(0);
  });

  it("rejects a deploy against a missing project via the FK (ProjectNotFoundError)", async () => {
    await expect(registry.recordDeploy(MISSING_PROJECT, "x", "y")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it("treats a malformed project id as absent, never a 500", async () => {
    expect(await registry.getActive("not-a-uuid")).toBeNull();
    expect(await registry.listDeploys("not-a-uuid")).toEqual([]);
    expect(await registry.listInactive("not-a-uuid")).toEqual([]);
    expect(await registry.teardownProject("not-a-uuid")).toBe(0);
    await expect(registry.recordDeploy("not-a-uuid", "x", "y")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
