/**
 * Schema tests for the initial migration (T016).
 *
 * Two layers:
 *  1. Static shape checks — always run; validate the migration files against
 *     the data-model.md expectations without needing a database.
 *  2. Live checks — run only when DATABASE_URL is set. Point it at a
 *     DISPOSABLE database: the suite applies the migration, probes the
 *     constraints, then reverts everything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import type { Db } from "./client.js";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.js";
import type { Migration } from "./migrate.js";

/** Every table in specs/001-nyx-platform/data-model.md. */
const EXPECTED_TABLES = [
  "accounts",
  "sessions",
  "auth_nonces",
  "proving_tokens",
  "projects",
  "project_files",
  "project_file_versions",
  "chat_messages",
  "turns",
  "ledger_entries",
  "deposit_refs",
  "orphan_deposits",
  "reconcile_runs",
  "deploy_registry",
] as const;

async function initialMigration(): Promise<Migration> {
  const migrations = await loadMigrations();
  const first = migrations[0];
  if (first === undefined) {
    throw new Error("no migrations found");
  }
  return first;
}

describe("migration files (static shape)", () => {
  it("discovers exactly the initial migration with an up/down pair", async () => {
    const migrations = await loadMigrations();
    expect(migrations).toHaveLength(1);
    const migration = await initialMigration();
    expect(migration.id).toBe(1);
    expect(migration.name).toBe("initial_schema");
    expect(migration.upSql.length).toBeGreaterThan(0);
    expect(migration.downSql.length).toBeGreaterThan(0);
  });

  it("creates every data-model table and drops each one on the way down", async () => {
    const { upSql, downSql } = await initialMigration();
    for (const table of EXPECTED_TABLES) {
      expect(upSql).toMatch(new RegExp(String.raw`CREATE TABLE ${table}\b`));
      expect(downSql).toMatch(new RegExp(String.raw`DROP TABLE ${table};`));
    }
    expect(upSql.match(/CREATE TABLE /g)).toHaveLength(EXPECTED_TABLES.length);
    expect(downSql.match(/DROP TABLE /g)).toHaveLength(EXPECTED_TABLES.length);
  });

  it("restricts ledger kinds to the four data-model values (burn lives in reconcile_runs)", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toContain(
      "CHECK (kind IN ('deposit_credit', 'reserve', 'reserve_release', 'settlement'))",
    );
    expect(upSql).not.toMatch(/kind IN \([^)]*'burn'/);
  });

  it("enforces append-only intent on ledger_entries", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toContain("CREATE TRIGGER ledger_entries_append_only");
    expect(upSql).toContain("BEFORE UPDATE OR DELETE ON ledger_entries");
    expect(upSql).toContain("BEFORE TRUNCATE ON ledger_entries");
  });

  it("stores monetary amounts as bigint", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toMatch(/\bamount\s+bigint\s+NOT NULL/);
    expect(upSql).toMatch(/\bexpected_amount\s+bigint\s+NOT NULL/);
    expect(upSql).toMatch(/\bburn_amount\s+bigint/);
    expect(upSql).toMatch(/\bdrift\s+bigint/);
  });

  it("enforces exactly one active deploy per project via a partial unique index", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toContain("CREATE UNIQUE INDEX deploy_registry_one_active_per_project");
    expect(upSql).toMatch(
      /deploy_registry_one_active_per_project\s+ON deploy_registry \(project_id\)\s+WHERE status = 'active'/,
    );
  });

  it("constrains status-like fields with CHECKs", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toContain(
      "CHECK (status IN ('classifying', 'reserved', 'running', 'settled', 'declined'))",
    );
    expect(upSql).toContain("CHECK (status IN ('preregistered', 'seen', 'credited', 'expired'))");
    expect(upSql).toContain("CHECK (status IN ('active', 'superseded', 'torn_down'))");
    expect(upSql).toContain("CHECK (outcome IN ('reconciled', 'drift', 'error'))");
    expect(upSql.match(/CHECK \(author IN \('agent', 'user'\)\)/g)).toHaveLength(2);
  });

  it("encodes the turn charging invariants and cycle cap", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toMatch(/cycles_used >= 0 AND cycles_used <= 3/);
    expect(upSql).toContain("CONSTRAINT turns_declined_never_charged");
    expect(upSql).toContain("CONSTRAINT turns_settled_has_settlement");
  });

  it("carries the projects soft-delete and clone columns", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toMatch(/\bdeleted_at\s+timestamptz/);
    expect(upSql).toMatch(/\bclone_token\s+text/);
    expect(upSql).toMatch(/\bclone_materialized_at_version\s+bigint/);
    expect(upSql).toContain("CREATE UNIQUE INDEX projects_clone_token_key");
  });

  it("keys deposit refs and reconcile watermarks for exactly-once semantics", async () => {
    const { upSql } = await initialMigration();
    expect(upSql).toMatch(/\bref\s+text\s+PRIMARY KEY/);
    expect(upSql).toMatch(/\bwatermark\s+text\s+NOT NULL UNIQUE/);
  });
});

const LIVE_URL = process.env.DATABASE_URL;
const hasLiveDatabase = LIVE_URL !== undefined && LIVE_URL !== "";

function liveUrl(): string {
  if (LIVE_URL === undefined || LIVE_URL === "") {
    throw new Error("unreachable: live suite is skipped when DATABASE_URL is unset");
  }
  return LIVE_URL;
}

// Skipped unless DATABASE_URL points at a disposable Postgres database.
describe.skipIf(!hasLiveDatabase)(
  "schema against live Postgres (skipped: set DATABASE_URL to a disposable database to enable)",
  () => {
    let db: Db;

    beforeAll(async () => {
      db = createDb({ connectionString: liveUrl(), maxConnections: 2 });
      await migrateUp(liveUrl());
    });

    afterAll(async () => {
      try {
        let reverted: string | undefined;
        do {
          reverted = await migrateDown(liveUrl());
        } while (reverted !== undefined);
        await db.query("DROP TABLE IF EXISTS schema_migrations");
      } finally {
        await db.end();
      }
    });

    it("creates all data-model tables", async () => {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...EXPECTED_TABLES]],
      );
      expect(rows.map((row) => row.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
    });

    it("is idempotent: a second up run applies nothing", async () => {
      await expect(migrateUp(liveUrl())).resolves.toEqual([]);
    });

    it("rejects UPDATE and DELETE on ledger_entries", async () => {
      await db.query("INSERT INTO accounts (address) VALUES ($1)", ["addr_ledger_test"]);
      await db.query(
        "INSERT INTO ledger_entries (account_address, kind, amount) VALUES ($1, $2, $3)",
        ["addr_ledger_test", "deposit_credit", "1000"],
      );
      await expect(
        db.query("UPDATE ledger_entries SET amount = 1 WHERE account_address = $1", [
          "addr_ledger_test",
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query("DELETE FROM ledger_entries WHERE account_address = $1", ["addr_ledger_test"]),
      ).rejects.toThrow(/append-only/);
    });

    it("rejects ledger kinds outside the data-model enum", async () => {
      await expect(
        db.query("INSERT INTO ledger_entries (account_address, kind, amount) VALUES ($1, $2, $3)", [
          "addr_ledger_test",
          "burn",
          "1",
        ]),
      ).rejects.toThrow(/ledger_entries_kind_check/);
    });

    it("allows at most one active deploy per project", async () => {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO projects (owner_address, name) VALUES ($1, $2) RETURNING id",
        ["addr_ledger_test", "deploy-test"],
      );
      const project = rows[0];
      if (project === undefined) {
        throw new Error("project insert returned no row");
      }
      await db.query(
        "INSERT INTO deploy_registry (project_id, address, version, status, tx_ref) VALUES ($1, $2, $3, $4, $5)",
        [project.id, "0xdeploy1", "1", "active", "tx1"],
      );
      await expect(
        db.query(
          "INSERT INTO deploy_registry (project_id, address, version, status, tx_ref) VALUES ($1, $2, $3, $4, $5)",
          [project.id, "0xdeploy2", "2", "active", "tx2"],
        ),
      ).rejects.toThrow(/deploy_registry_one_active_per_project/);
      // A superseded row alongside the active one is fine.
      await db.query(
        "INSERT INTO deploy_registry (project_id, address, version, status, tx_ref) VALUES ($1, $2, $3, $4, $5)",
        [project.id, "0xdeploy2", "2", "superseded", "tx2"],
      );
    });

    it("rejects a declined turn that carries a reserve entry", async () => {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO projects (owner_address, name) VALUES ($1, $2) RETURNING id",
        ["addr_ledger_test", "turn-test"],
      );
      const project = rows[0];
      if (project === undefined) {
        throw new Error("project insert returned no row");
      }
      const { rows: entryRows } = await db.query<{ id: string }>(
        "INSERT INTO ledger_entries (account_address, kind, amount) VALUES ($1, $2, $3) RETURNING id",
        ["addr_ledger_test", "reserve", "10"],
      );
      const entry = entryRows[0];
      if (entry === undefined) {
        throw new Error("ledger insert returned no row");
      }
      await expect(
        db.query("INSERT INTO turns (project_id, status, reserve_entry) VALUES ($1, $2, $3)", [
          project.id,
          "declined",
          entry.id,
        ]),
      ).rejects.toThrow(/turns_declined_never_charged/);
    });

    it("reverts cleanly all the way down", async () => {
      await expect(migrateDown(liveUrl())).resolves.toBe("0001_initial_schema");
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...EXPECTED_TABLES]],
      );
      expect(rows).toEqual([]);
    });
  },
);
