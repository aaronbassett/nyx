/**
 * Deploy registry: the authoritative record of finalized deploys (T156, US8, FR-057).
 *
 * A deploy is FINALIZED on-chain BEFORE it lands here — the per-request pipeline state is
 * transient and lives elsewhere; only settled deploys are recorded. Each row is
 * `(project_id, address, version, status, deployed_at, tx_ref)`, keyed by the project and
 * a project-wide MONOTONIC `version` (`MAX(version)+1`, starting at 1). At most ONE row per
 * project is `active`, and this is the invariant the whole story turns on (SC-032):
 *
 *   recordDeploy = one transaction that (1) allocates the next version, (2) flips the
 *   current `active` row to `superseded`, then (3) INSERTs the new row as `active`.
 *
 * The supersede MUST precede the new-active INSERT: the DB carries a PARTIAL UNIQUE INDEX
 * `deploy_registry_one_active_per_project ON (project_id) WHERE status = 'active'`, so two
 * `active` rows for one project is a `unique_violation`. Doing both inside ONE transaction
 * makes the swap atomic — a concurrent reader/writer never observes zero or two actives, and
 * a failure mid-swap rolls BOTH back (the previous active survives). The index is the
 * structural backstop: even a racing writer that computed a stale "no active" cannot land a
 * second active — the DB rejects it (proven in `pg-registry.test.ts`).
 *
 * EXACTLY-ONCE PER tx_ref (code-review defect C1, belt-and-suspenders). `recordDeploy` is
 * IDEMPOTENT by `tx_ref` — a globally-unique on-chain transaction reference. Re-recording the
 * SAME finalized tx (the deploy pipeline's post-finality record RETRY, or a fresh-requestId
 * retry of a finalized-but-unrecorded deploy) returns the EXISTING row and inserts nothing —
 * no second row, no version bump. A fast-path SELECT (inside the project lock) catches the
 * serialized case; the `deploy_registry_tx_ref_key` UNIQUE index (migration 0003) is the
 * structural backstop for a stale-snapshot racer, handled as a SAVEPOINT'd 23505 exactly like
 * the ledger's `creditDeposit` deposit-credit index.
 *
 * ⚠️ `teardownProject` is OFF-CHAIN ONLY (T155). A deployed Midnight contract is PERMANENT:
 * there is no on-chain delete, and this store issues no on-chain transaction. Teardown is
 * PURELY registry bookkeeping — it flips a project's live rows to `torn_down` so the app
 * points away from them; the contracts themselves persist harmlessly on-chain forever.
 * It is the D49/US7 soft-delete cascade back-fill (the injectable seam `projects/lifecycle.ts`
 * left as a no-op), and it is idempotent (a second call flips nothing). It runs inside a
 * transaction that takes `projects FOR UPDATE` FIRST — the SAME lock `recordDeploy` uses — so
 * a teardown and a concurrent deploy-finalize SERIALIZE instead of interleaving (defect M1):
 * without the lock, teardown's snapshot could predate a concurrently-inserted active row and
 * miss it, leaving a LIVE `active` row on a torn-down project.
 *
 * `version` is a `bigint` IN CODE and a decimal STRING ON THE WIRE — the ROUTE encodes rows
 * with `encodeDeployRegistryRow`; this store always returns the `bigint` form. All failures
 * are promise REJECTIONS with named error classes (a malformed/absent project id maps to
 * {@link ProjectNotFoundError}, never a 500); the DB clock (`deployed_at DEFAULT now()`)
 * decides the timestamp; every value is a bound parameter — never interpolated into SQL.
 */
import { DeployRegistryRowSchema } from "@nyx/protocol";
import type { DeployRegistryRow, DeployRegistryStatus } from "@nyx/protocol";
import type { Queryable } from "../db/index.js";
import { ProjectNotFoundError } from "../projects/errors.js";

// --- Named errors -----------------------------------------------------------

// `ProjectNotFoundError` is the canonical project-scoped error (the route maps it to 404);
// a deploy against a missing/malformed project reuses it rather than minting a parallel type.
// Re-exported so the deploy module is a single import site for its callers/tests.
export { ProjectNotFoundError };

/**
 * The exactly-one-active invariant (SC-032) failed for a project. Raised by
 * {@link DeployRegistry.assertOneActive} — the verification helper — when the active count
 * is not exactly 1 (zero after a teardown, or, defensively, more than one should the DB's
 * partial unique index ever be missing). A `bigint` id and the observed count are attached.
 */
export class DeployInvariantError extends Error {
  constructor(
    readonly projectId: string,
    readonly activeCount: number,
  ) {
    super(
      `deploy invariant violated: project ${projectId} has ${String(activeCount)} active deploys, expected exactly 1`,
    );
    this.name = "DeployInvariantError";
  }
}

// --- Public surface ---------------------------------------------------------

/**
 * The read + write surface US8 depends on. Every method rejects (never throws
 * synchronously) so callers see one uniform failure channel. `projectId`/`address`/`txRef`
 * are plain strings in; the returned {@link DeployRegistryRow} carries branded fields and a
 * `bigint` `version` (the route encodes it to a wire string with `encodeDeployRegistryRow`).
 */
export interface DeployRegistry {
  /**
   * Record a finalized deploy, atomically superseding the project's current active row and
   * inserting the new one as `active` at the next monotonic version. Returns the new row.
   * IDEMPOTENT by `tx_ref`: re-recording an already-recorded on-chain tx returns the EXISTING
   * row unchanged (no second row, no version bump), so the pipeline's post-finality record
   * retry (defect C1) never double-records. Rejects {@link ProjectNotFoundError} if the
   * project does not exist (FK-backed).
   */
  recordDeploy(projectId: string, address: string, txRef: string): Promise<DeployRegistryRow>;
  /** The project's current `active` deploy, or `null` if none (SC-032: at most one). */
  getActive(projectId: string): Promise<DeployRegistryRow | null>;
  /** Every deploy for the project, newest-first by `version` (`GET /projects/:id/deploys`). */
  listDeploys(projectId: string): Promise<DeployRegistryRow[]>;
  /**
   * OFF-CHAIN teardown (T155): flip the project's `active` + `superseded` rows to
   * `torn_down`. Returns the number of rows flipped (0 when there is nothing live — the
   * call is idempotent). Issues NO on-chain transaction; the deployed contracts persist.
   */
  teardownProject(projectId: string): Promise<number>;
  /** The project's `superseded` + `torn_down` rows, newest-first (the cleanup-job feed). */
  listInactive(projectId: string): Promise<DeployRegistryRow[]>;
  /**
   * SC-032 verification helper: resolve iff the project has EXACTLY one active deploy;
   * otherwise reject {@link DeployInvariantError} carrying the observed count.
   */
  assertOneActive(projectId: string): Promise<void>;
}

/** A pooled DB handle that can also open a transaction (a real `Db` satisfies this). */
export type DeployRegistryDb = Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

// --- Row mapping ------------------------------------------------------------

/**
 * Standard projection so every registry SELECT returns {@link RegistryRow} columns:
 * `version` as text (survives int53), `deployed_at` as epoch-ms.
 */
const REGISTRY_COLUMNS = `project_id, address, version::text AS version, status, tx_ref,
  (extract(epoch from deployed_at) * 1000)::bigint AS deployed_at_ms`;

/** Columns projected by {@link REGISTRY_COLUMNS} (bigints/timestamps arrive as strings). */
interface RegistryRow {
  readonly project_id: string;
  readonly address: string;
  readonly version: string;
  readonly status: DeployRegistryStatus;
  readonly tx_ref: string;
  readonly deployed_at_ms: string;
}

/**
 * Re-brand a DB row into the wire {@link DeployRegistryRow} at the store boundary. The
 * schema parse transforms the decimal-string `version` into a `bigint` and brands the
 * `projectId`/`address` — identical to the shape the in-memory double produces (SC-032
 * tests compare rows across the two stores).
 */
function mapRow(row: RegistryRow): DeployRegistryRow {
  return DeployRegistryRowSchema.parse({
    projectId: row.project_id,
    address: row.address,
    version: row.version,
    status: row.status,
    deployedAt: Number(row.deployed_at_ms),
    txRef: row.tx_ref,
  });
}

/** Postgres `invalid_text_representation` — a malformed (non-uuid) project id from a route. */
function isInvalidUuidError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "22P02";
}

/**
 * Postgres `unique_violation` (23505) specifically on `deploy_registry_tx_ref_key` (migration
 * 0003) — a re-record of an already-recorded on-chain tx, i.e. the exactly-once backstop for a
 * stale-snapshot racer the fast-path SELECT missed. Gated on the CONSTRAINT name so a 23505 on
 * any OTHER index (the one-active-per-project partial index, or the `(project_id, version)`
 * constraint) is a GENUINE invariant breach and is NOT swallowed — it propagates.
 */
function isTxRefUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "deploy_registry_tx_ref_key"
  );
}

// --- Postgres store ---------------------------------------------------------

/**
 * Postgres-backed {@link DeployRegistry}. The exactly-one-active invariant (SC-032) is
 * enforced at the DB layer by the `deploy_registry_one_active_per_project` partial unique
 * index, so {@link recordDeploy} only has to order its writes (supersede BEFORE new-active)
 * and run them in one transaction; the index is the structural backstop against a racing
 * writer. Exactly-once PER on-chain tx (defect C1) is enforced by the
 * `deploy_registry_tx_ref_key` unique index (migration 0003) — a fast-path SELECT plus a
 * SAVEPOINT'd 23505 make a re-record idempotent. {@link teardownProject} takes the same
 * `projects FOR UPDATE` lock so it serializes with a concurrent deploy (defect M1). Reads
 * that take an untrusted project id map a malformed (non-uuid) value to the
 * empty/`null`/`ProjectNotFoundError` result rather than a 500.
 */
export class PgDeployRegistry implements DeployRegistry {
  constructor(private readonly db: DeployRegistryDb) {}

  recordDeploy(projectId: string, address: string, txRef: string): Promise<DeployRegistryRow> {
    return this.db.transaction(async (tx) => {
      // Lock the project row so per-project version allocation + the active-swap serialize
      // against a concurrent deploy AND a concurrent teardown (M1); a missing/malformed id is
      // ProjectNotFoundError.
      await this.lockProject(tx, projectId);

      // Fast path (belt): this finalized tx is already recorded → return the EXISTING row,
      // idempotently — no supersede, no version bump. This is the pipeline's post-finality
      // record RETRY (defect C1) re-running after a transient blip: recordDeploy is
      // exactly-once per tx_ref, so a retry never double-records. tx_ref is a globally-unique
      // on-chain reference, so the lookup is unambiguous. Under the READ COMMITTED transaction
      // this store uses, a serialized concurrent same-tx writer is caught here (it re-reads the
      // winner's committed row); the SAVEPOINT'd 23505 below covers a stale-snapshot racer.
      const existing = await this.selectByTxRef(tx, txRef);
      if (existing !== null) {
        return existing;
      }

      const versionResult = await tx.query<{ next: string }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next
           FROM deploy_registry
          WHERE project_id = $1`,
        [projectId],
      );
      const version = versionResult.rows[0]?.next ?? "1";

      // Structural backstop (suspenders): supersede + insert inside a SAVEPOINT. The
      // `deploy_registry_tx_ref_key` unique index makes recording a given tx EXACTLY-ONCE even
      // under a stale snapshot the fast path missed; a 23505 on THAT index rolls BOTH writes
      // back — so the prior active is never left superseded-with-nothing-active — and returns
      // the already-recorded row. A 23505 on any OTHER index (two actives, dup version) is a
      // real invariant breach and propagates. Mirrors the ledger creditDeposit 23505 handling.
      await tx.query(`SAVEPOINT deploy_record_insert`);
      try {
        // Supersede the current active BEFORE inserting the new one — the partial unique index
        // forbids two 'active' rows, so this ordering is load-bearing (and atomic in this tx).
        await tx.query(
          `UPDATE deploy_registry SET status = 'superseded'
            WHERE project_id = $1 AND status = 'active'`,
          [projectId],
        );
        // Insert the new active row; `deployed_at` defaults to now() (DB clock decides, SC-003).
        const inserted = await tx.query<RegistryRow>(
          `INSERT INTO deploy_registry (project_id, address, version, status, tx_ref)
           VALUES ($1, $2, $3::bigint, 'active', $4)
           RETURNING ${REGISTRY_COLUMNS}`,
          [projectId, address, version, txRef],
        );
        await tx.query(`RELEASE SAVEPOINT deploy_record_insert`);
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new Error("deploy insert returned no row");
        }
        return mapRow(row);
      } catch (error) {
        if (!isTxRefUniqueViolation(error)) {
          throw error;
        }
        // A concurrent writer recorded this exact tx first (stale-snapshot race): undo BOTH
        // the supersede and the failed insert, then return the already-recorded row.
        await tx.query(`ROLLBACK TO SAVEPOINT deploy_record_insert`);
        const recorded = await this.selectByTxRef(tx, txRef);
        if (recorded === null) {
          throw error; // Can't-happen: the 23505 proves the tx_ref row exists.
        }
        return recorded;
      }
    });
  }

  /**
   * The registry row for a given on-chain `tx_ref`, or `null`. `tx_ref` is globally unique
   * (the `deploy_registry_tx_ref_key` index), so at most one row matches — this is the
   * exactly-once fast path + the 23505-backstop re-read.
   */
  private async selectByTxRef(tx: Queryable, txRef: string): Promise<DeployRegistryRow | null> {
    const { rows } = await tx.query<RegistryRow>(
      `SELECT ${REGISTRY_COLUMNS} FROM deploy_registry WHERE tx_ref = $1`,
      [txRef],
    );
    const row = rows[0];
    return row === undefined ? null : mapRow(row);
  }

  async getActive(projectId: string): Promise<DeployRegistryRow | null> {
    try {
      const { rows } = await this.db.query<RegistryRow>(
        `SELECT ${REGISTRY_COLUMNS} FROM deploy_registry
          WHERE project_id = $1 AND status = 'active'`,
        [projectId],
      );
      const row = rows[0];
      return row === undefined ? null : mapRow(row);
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listDeploys(projectId: string): Promise<DeployRegistryRow[]> {
    try {
      const { rows } = await this.db.query<RegistryRow>(
        `SELECT ${REGISTRY_COLUMNS} FROM deploy_registry
          WHERE project_id = $1
          ORDER BY version DESC`,
        [projectId],
      );
      return rows.map(mapRow);
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return [];
      }
      throw error;
    }
  }

  async listInactive(projectId: string): Promise<DeployRegistryRow[]> {
    try {
      const { rows } = await this.db.query<RegistryRow>(
        `SELECT ${REGISTRY_COLUMNS} FROM deploy_registry
          WHERE project_id = $1 AND status IN ('superseded', 'torn_down')
          ORDER BY version DESC`,
        [projectId],
      );
      return rows.map(mapRow);
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return [];
      }
      throw error;
    }
  }

  async teardownProject(projectId: string): Promise<number> {
    try {
      // M1: run inside a transaction that takes `projects FOR UPDATE` FIRST — the SAME lock
      // recordDeploy takes — so a delete-cascade teardown and a concurrent deploy-finalize
      // SERIALIZE instead of interleaving. Without the lock, teardown's snapshot could predate
      // a concurrently-inserted active row and miss it, leaving a LIVE 'active' row on a
      // torn-down project.
      return await this.db.transaction(async (tx) => {
        const locked = await tx.query(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [
          projectId,
        ]);
        if (locked.rows.length === 0) {
          // Unknown project — nothing to tear down. Idempotent (mirrors the no-live-rows case).
          return 0;
        }
        // OFF-CHAIN ONLY (T155): a single UPDATE flips this project's live rows to torn_down.
        // No on-chain call — the deployed contracts remain on-chain, we just stop pointing at
        // them. Idempotent: a re-run matches no active/superseded rows and flips nothing.
        const result = await tx.query(
          `UPDATE deploy_registry SET status = 'torn_down'
            WHERE project_id = $1 AND status IN ('active', 'superseded')`,
          [projectId],
        );
        return result.rowCount ?? 0;
      });
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return 0;
      }
      throw error;
    }
  }

  async assertOneActive(projectId: string): Promise<void> {
    const count = await this.countActive(projectId);
    if (count !== 1) {
      throw new DeployInvariantError(projectId, count);
    }
  }

  /** Count the project's `active` rows (a malformed id counts as zero, never a 500). */
  private async countActive(projectId: string): Promise<number> {
    try {
      const { rows } = await this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM deploy_registry
          WHERE project_id = $1 AND status = 'active'`,
        [projectId],
      );
      return Number(rows[0]?.count ?? "0");
    } catch (error) {
      if (isInvalidUuidError(error)) {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Lock + verify the project row `FOR UPDATE`, serializing concurrent deploys and mapping a
   * missing/malformed id to {@link ProjectNotFoundError}. Soft-deleted projects are NOT
   * excluded — a teardown-time back-fill may still record against a project being deleted.
   */
  private async lockProject(tx: Queryable, projectId: string): Promise<void> {
    let rowCount: number;
    try {
      const { rows } = await tx.query(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [
        projectId,
      ]);
      rowCount = rows.length;
    } catch (error) {
      if (isInvalidUuidError(error)) {
        throw new ProjectNotFoundError(projectId);
      }
      throw error;
    }
    if (rowCount === 0) {
      throw new ProjectNotFoundError(projectId);
    }
  }
}

/** Construct the Postgres-backed deploy registry (US1/US7 wire this from the pooled `Db`). */
export function createDeployRegistry(db: DeployRegistryDb): DeployRegistry {
  return new PgDeployRegistry(db);
}
