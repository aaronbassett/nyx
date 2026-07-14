/**
 * Deploy registry contract tests (T156, US8) — deterministic, in-memory, NO Postgres.
 *
 * These drive an {@link InMemoryDeployRegistry} (defined here) through the shared
 * {@link DeployRegistry} interface to pin the finalized-deploy bookkeeping US8 depends
 * on (FR-057, SC-032, D49):
 *  - the FIRST deploy of a project lands as `version` 1, `status` 'active';
 *  - a REDEPLOY flips the prior `active` row to 'superseded' and inserts the new one at
 *    `MAX(version)+1` — the supersede + new-active is ONE atomic step, so there is never
 *    a moment with two 'active' rows (the Postgres partial unique index enforces the same
 *    invariant at the DB layer — see `pg-registry.test.ts`);
 *  - SC-032: EXACTLY one active per project holds across a
 *    deploy → redeploy → redeploy → teardown sequence — one after each deploy, ZERO after
 *    teardown (all rows 'torn_down');
 *  - `teardownProject` is the D49/US7 soft-delete cascade back-fill and is OFF-CHAIN ONLY
 *    (T155): a deployed Midnight contract is PERMANENT — there is no on-chain delete — so
 *    teardown is a registry status flip and nothing more (the contract addresses are never
 *    rewritten), and it is idempotent;
 *  - `listDeploys` returns every version newest-first; `getActive` returns the current
 *    active row or `null`; `assertOneActive` is the SC-032 verification helper;
 *  - a deploy against a project the store does not know rejects with
 *    {@link ProjectNotFoundError} (the Postgres FK backs this — see `pg-registry.test.ts`).
 *
 * The in-memory double models the `deploy_registry` table with an injected clock (so
 * `deployedAt` is deterministic) and an optional known-projects set (so the FK-backed
 * not-found path is testable without Postgres). Every returned row is produced through
 * the REAL {@link DeployRegistryRowSchema} parse, so a row built here is byte-for-byte
 * comparable with the branded row the Postgres store maps back (`version` a `bigint`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DeployRegistryRowSchema, encodeDeployRegistryRow } from "@nyx/protocol";
import type { DeployRegistryRow, DeployRegistryStatus } from "@nyx/protocol";
import { DeployInvariantError } from "../../src/deploy/registry.js";
import type { DeployRegistry } from "../../src/deploy/registry.js";
import { ProjectNotFoundError } from "../../src/projects/errors.js";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

// --- In-memory double -------------------------------------------------------

/** Mutable row modelling the `deploy_registry` table (`version` a `bigint` in code). */
interface RegistryRecord {
  projectId: string;
  address: string;
  version: bigint;
  status: DeployRegistryStatus;
  deployedAt: number;
  txRef: string;
}

/** Newest-first: descending by the monotonic `version`. */
function byVersionDesc(a: RegistryRecord, b: RegistryRecord): number {
  return a.version < b.version ? 1 : a.version > b.version ? -1 : 0;
}

/** Re-brand an internal record into the wire {@link DeployRegistryRow} via the real parse. */
function toRow(record: RegistryRecord): DeployRegistryRow {
  return DeployRegistryRowSchema.parse({
    projectId: record.projectId,
    address: record.address,
    version: record.version.toString(),
    status: record.status,
    deployedAt: record.deployedAt,
    txRef: record.txRef,
  });
}

/**
 * In-memory {@link DeployRegistry} modelling the Postgres semantics. JavaScript is
 * single-threaded, so `recordDeploy`'s supersede + new-active is naturally one atomic
 * step — exactly what the DB's partial unique index guarantees for the real store.
 * `knownProjects` optionally restricts which project ids "exist" so the FK-backed
 * {@link ProjectNotFoundError} path is deterministically testable; omitted, every
 * project id is accepted.
 */
class InMemoryDeployRegistry implements DeployRegistry {
  private records: RegistryRecord[] = [];
  private readonly known: Set<string> | null;

  constructor(
    private readonly clock: () => number,
    knownProjects?: Iterable<string>,
  ) {
    this.known = knownProjects === undefined ? null : new Set(knownProjects);
  }

  private exists(projectId: string): boolean {
    return this.known === null || this.known.has(projectId);
  }

  private nextVersion(projectId: string): bigint {
    let max = 0n;
    for (const record of this.records) {
      if (record.projectId === projectId && record.version > max) {
        max = record.version;
      }
    }
    return max + 1n;
  }

  recordDeploy(projectId: string, address: string, txRef: string): Promise<DeployRegistryRow> {
    if (!this.exists(projectId)) {
      return Promise.reject(new ProjectNotFoundError(projectId));
    }
    // Idempotent by tx_ref (a globally-unique on-chain reference): re-recording the SAME
    // finalized tx returns the EXISTING row — no supersede, no version bump. Mirrors the
    // Postgres tx_ref unique index + SAVEPOINT'd 23505 handling (defect C1).
    const existing = this.records.find((record) => record.txRef === txRef);
    if (existing !== undefined) {
      return Promise.resolve(toRow(existing));
    }
    // Atomic: supersede the current active BEFORE inserting the new one, so there is
    // never a window with two active rows (the DB's partial unique index, in memory).
    for (const record of this.records) {
      if (record.projectId === projectId && record.status === "active") {
        record.status = "superseded";
      }
    }
    const record: RegistryRecord = {
      projectId,
      address,
      version: this.nextVersion(projectId),
      status: "active",
      deployedAt: this.clock(),
      txRef,
    };
    this.records.push(record);
    return Promise.resolve(toRow(record));
  }

  getActive(projectId: string): Promise<DeployRegistryRow | null> {
    const active = this.records.find(
      (record) => record.projectId === projectId && record.status === "active",
    );
    return Promise.resolve(active === undefined ? null : toRow(active));
  }

  listDeploys(projectId: string): Promise<DeployRegistryRow[]> {
    const rows = this.records
      .filter((record) => record.projectId === projectId)
      .sort(byVersionDesc)
      .map(toRow);
    return Promise.resolve(rows);
  }

  listInactive(projectId: string): Promise<DeployRegistryRow[]> {
    const rows = this.records
      .filter(
        (record) =>
          record.projectId === projectId &&
          (record.status === "superseded" || record.status === "torn_down"),
      )
      .sort(byVersionDesc)
      .map(toRow);
    return Promise.resolve(rows);
  }

  teardownProject(projectId: string): Promise<number> {
    let flipped = 0;
    for (const record of this.records) {
      if (
        record.projectId === projectId &&
        (record.status === "active" || record.status === "superseded")
      ) {
        record.status = "torn_down";
        flipped += 1;
      }
    }
    return Promise.resolve(flipped);
  }

  assertOneActive(projectId: string): Promise<void> {
    const count = this.records.filter(
      (record) => record.projectId === projectId && record.status === "active",
    ).length;
    return count === 1
      ? Promise.resolve()
      : Promise.reject(new DeployInvariantError(projectId, count));
  }
}

describe("DeployRegistry (in-memory contract)", () => {
  let clock: { now: number };
  let store: InMemoryDeployRegistry;

  beforeEach(() => {
    clock = { now: 1_000 };
    store = new InMemoryDeployRegistry(() => clock.now);
  });

  it("records the first deploy as version 1, active (FR-057)", async () => {
    const row = await store.recordDeploy(PROJECT, "addr-1", "tx-1");
    expect(row.projectId).toBe(PROJECT);
    expect(row.address).toBe("addr-1");
    expect(row.version).toBe(1n);
    expect(row.status).toBe("active");
    expect(row.txRef).toBe("tx-1");
    expect(row.deployedAt).toBe(1_000);
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();
    expect(await store.getActive(PROJECT)).toEqual(row);
  });

  it("supersedes the prior active and increments the version on redeploy (SC-032)", async () => {
    await store.recordDeploy(PROJECT, "addr-1", "tx-1");
    clock.now = 2_000;
    const v2 = await store.recordDeploy(PROJECT, "addr-2", "tx-2");

    expect(v2.version).toBe(2n);
    expect(v2.status).toBe("active");
    const all = await store.listDeploys(PROJECT);
    expect(all.map((row) => [row.version, row.status])).toEqual([
      [2n, "active"],
      [1n, "superseded"],
    ]);
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();
    expect((await store.getActive(PROJECT))?.version).toBe(2n);
  });

  it("holds exactly-one-active across deploy → redeploy → redeploy → teardown (SC-032)", async () => {
    await store.recordDeploy(PROJECT, "a1", "t1");
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();

    await store.recordDeploy(PROJECT, "a2", "t2");
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();

    await store.recordDeploy(PROJECT, "a3", "t3");
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();
    expect((await store.getActive(PROJECT))?.version).toBe(3n);

    // Teardown is OFF-CHAIN ONLY (T155): flip all live rows to 'torn_down'.
    const flipped = await store.teardownProject(PROJECT);
    expect(flipped).toBe(3); // 1 active + 2 superseded.
    expect(await store.getActive(PROJECT)).toBeNull();
    const all = await store.listDeploys(PROJECT);
    expect(all.every((row) => row.status === "torn_down")).toBe(true);
    await expect(store.assertOneActive(PROJECT)).rejects.toBeInstanceOf(DeployInvariantError);
  });

  it("is idempotent by tx_ref — re-recording the SAME tx returns the existing row (no 2nd row, no version bump) (defect C1)", async () => {
    const first = await store.recordDeploy(PROJECT, "addr-1", "tx-1");
    // A re-record of the SAME finalized tx (the pipeline's post-finality record retry) is a
    // no-op that returns the existing row — not a second row, not a version bump.
    const again = await store.recordDeploy(PROJECT, "addr-1", "tx-1");

    expect(again).toEqual(first);
    expect(again.version).toBe(1n);
    expect(await store.listDeploys(PROJECT)).toHaveLength(1); // no 2nd row
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();
  });

  it("re-recording a SUPERSEDED tx_ref returns the existing (superseded) row without reactivating it (defect C1)", async () => {
    await store.recordDeploy(PROJECT, "addr-1", "tx-1"); // v1 active
    await store.recordDeploy(PROJECT, "addr-2", "tx-2"); // v2 active, v1 superseded

    const replay = await store.recordDeploy(PROJECT, "addr-1", "tx-1"); // idempotent re-record

    expect(replay.version).toBe(1n);
    expect(replay.status).toBe("superseded"); // returned as-is, NOT reactivated
    expect((await store.getActive(PROJECT))?.version).toBe(2n); // active untouched
    expect(await store.listDeploys(PROJECT)).toHaveLength(2); // still just two rows
    await expect(store.assertOneActive(PROJECT)).resolves.toBeUndefined();
  });

  it("keeps the supersede + new-active atomic — never two active rows", async () => {
    await store.recordDeploy(PROJECT, "a1", "t1");
    await store.recordDeploy(PROJECT, "a2", "t2");
    const active = (await store.listDeploys(PROJECT)).filter((row) => row.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2n);
  });

  it("lists every version newest-first", async () => {
    await store.recordDeploy(PROJECT, "a1", "t1");
    await store.recordDeploy(PROJECT, "a2", "t2");
    await store.recordDeploy(PROJECT, "a3", "t3");
    expect((await store.listDeploys(PROJECT)).map((row) => row.version)).toEqual([3n, 2n, 1n]);
  });

  it("returns null from getActive before any deploy and after teardown", async () => {
    expect(await store.getActive(PROJECT)).toBeNull();
    await store.recordDeploy(PROJECT, "a1", "t1");
    expect(await store.getActive(PROJECT)).not.toBeNull();
    await store.teardownProject(PROJECT);
    expect(await store.getActive(PROJECT)).toBeNull();
  });

  it("teardownProject flips active + superseded off-chain, idempotently, never rewriting addresses (T155)", async () => {
    await store.recordDeploy(PROJECT, "a1", "t1");
    await store.recordDeploy(PROJECT, "a2", "t2");

    const first = await store.teardownProject(PROJECT);
    expect(first).toBe(2);
    const inactive = await store.listInactive(PROJECT);
    expect(inactive).toHaveLength(2);
    expect(inactive.every((row) => row.status === "torn_down")).toBe(true);

    // Idempotent: nothing left to flip. The on-chain contracts persist harmlessly;
    // teardown is registry bookkeeping ONLY, so the addresses are unchanged.
    const second = await store.teardownProject(PROJECT);
    expect(second).toBe(0);
    expect(inactive.map((row) => row.address).sort()).toEqual(["a1", "a2"]);
  });

  it("isolates each project's registry", async () => {
    await store.recordDeploy(PROJECT, "a1", "t1");
    await store.recordDeploy(OTHER, "b1", "u1");
    await store.recordDeploy(PROJECT, "a2", "t2");

    expect((await store.listDeploys(PROJECT)).map((row) => row.version)).toEqual([2n, 1n]);
    expect((await store.listDeploys(OTHER)).map((row) => row.version)).toEqual([1n]);
    expect((await store.getActive(OTHER))?.address).toBe("b1");

    await store.teardownProject(PROJECT);
    // OTHER's active is untouched by PROJECT's teardown.
    expect((await store.getActive(OTHER))?.version).toBe(1n);
  });

  it("rejects assertOneActive when there is no active deploy (SC-032 helper)", async () => {
    await expect(store.assertOneActive(PROJECT)).rejects.toBeInstanceOf(DeployInvariantError);
  });

  it("rejects a deploy against an unknown project (ProjectNotFoundError)", async () => {
    const restricted = new InMemoryDeployRegistry(() => 1_000, [PROJECT]);
    await expect(restricted.recordDeploy(OTHER, "x", "y")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(restricted.recordDeploy(PROJECT, "x", "y")).resolves.toMatchObject({
      version: 1n,
    });
  });

  it("returns a bigint version in code that encodes to a decimal string on the wire", async () => {
    await store.recordDeploy(PROJECT, "a1", "t1");
    const v2 = await store.recordDeploy(PROJECT, "a2", "t2");
    expect(typeof v2.version).toBe("bigint");
    expect(encodeDeployRegistryRow(v2).version).toBe("2");
  });
});
