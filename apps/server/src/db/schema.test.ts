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

async function migrationById(id: number): Promise<Migration> {
  const migrations = await loadMigrations();
  const found = migrations.find((migration) => migration.id === id);
  if (found === undefined) {
    throw new Error(`migration ${String(id)} not found`);
  }
  return found;
}

describe("migration files (static shape)", () => {
  it("discovers the initial schema, ledger-width, deploy-txref, reconcile-width, and green-builds migrations as up/down pairs", async () => {
    const migrations = await loadMigrations();
    expect(migrations).toHaveLength(5);
    const [first, second, third, fourth, fifth] = migrations;
    expect(first?.id).toBe(1);
    expect(first?.name).toBe("initial_schema");
    expect(second?.id).toBe(2);
    expect(second?.name).toBe("ledger_amount_width_and_credit_unique");
    expect(third?.id).toBe(3);
    expect(third?.name).toBe("deploy_registry_txref_unique");
    expect(fourth?.id).toBe(4);
    expect(fourth?.name).toBe("reconcile_amount_width");
    expect(fifth?.id).toBe(5);
    expect(fifth?.name).toBe("green_builds");
    for (const migration of migrations) {
      expect(migration.upSql.length).toBeGreaterThan(0);
      expect(migration.downSql.length).toBeGreaterThan(0);
    }
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

  it("declares amounts as bigint initially, widened to numeric(40,0) by 0002 (H1)", async () => {
    const { upSql } = await initialMigration();
    // 0001 creates the per-deposit amount columns as bigint (the 2^63-1 ceiling 0002 lifts).
    expect(upSql).toMatch(/\bamount\s+bigint\s+NOT NULL/);
    expect(upSql).toMatch(/\bexpected_amount\s+bigint\s+NOT NULL/);
    // burn accounting is vault-global (not per-deposit) and stays bigint — untouched by 0002.
    expect(upSql).toMatch(/\bburn_amount\s+bigint/);
    expect(upSql).toMatch(/\bdrift\s+bigint/);

    // 0002 widens the three per-deposit amount columns to hold the 2^64-1 mint cap + Σ headroom.
    const { upSql: widenUp } = await migrationById(2);
    expect(widenUp).toMatch(/ALTER TABLE ledger_entries ALTER COLUMN amount TYPE numeric\(40, 0\)/);
    expect(widenUp).toMatch(
      /ALTER TABLE deposit_refs ALTER COLUMN expected_amount TYPE numeric\(40, 0\)/,
    );
    expect(widenUp).toMatch(
      /ALTER TABLE orphan_deposits ALTER COLUMN amount TYPE numeric\(40, 0\)/,
    );
  });

  it("adds a partial unique index for exactly-once deposit credits (H2)", async () => {
    const { upSql, downSql } = await migrationById(2);
    expect(upSql).toContain("CREATE UNIQUE INDEX ledger_entries_deposit_credit_ref_key");
    expect(upSql).toMatch(
      /ledger_entries_deposit_credit_ref_key\s+ON ledger_entries \(ref\)\s+WHERE kind = 'deposit_credit'/,
    );
    expect(downSql).toContain("DROP INDEX ledger_entries_deposit_credit_ref_key");
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

  it("adds the per-project green-build table with a cascading FK (migration 0005)", async () => {
    const { upSql, downSql } = await migrationById(5);
    expect(upSql).toMatch(/CREATE TABLE project_green_builds\b/);
    expect(upSql).toMatch(
      /project_id\s+uuid\s+PRIMARY KEY REFERENCES projects \(id\) ON DELETE CASCADE/,
    );
    expect(upSql).toMatch(/\burl_prefix\s+text\s+NOT NULL/);
    expect(upSql).toMatch(/\bcompiler_version\s+text\s+NOT NULL/);
    expect(downSql).toContain("DROP TABLE project_green_builds;");
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
      // Revert every applied migration newest-first (the amount-width migrations narrow their
      // columns back to bigint — lossless here since the live suite stores only small values).
      // Generic loop rather than a hardcoded sequence so new migrations stay covered; the last
      // revert must be the initial schema, after which no data-model table remains.
      let reverted: string | undefined;
      let last: string | undefined;
      do {
        reverted = await migrateDown(liveUrl());
        if (reverted !== undefined) {
          last = reverted;
        }
      } while (reverted !== undefined);
      expect(last).toBe("0001_initial_schema");
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...EXPECTED_TABLES]],
      );
      expect(rows).toEqual([]);
    });
  },
);
