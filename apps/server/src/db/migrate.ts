/**
 * Minimal SQL migration runner (T016).
 *
 * Migrations are plain SQL file pairs in `./migrations/`:
 *   NNNN_name.up.sql / NNNN_name.down.sql
 *
 * Each migration runs in its own transaction; applied ids are recorded in
 * `schema_migrations`. A session-scoped advisory lock serializes concurrent
 * runners (e.g. two deploying instances racing at boot). Chosen over a
 * migration framework per constitution V: the schema spec is literal SQL,
 * and this runner is the entire moving part.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Client } from "pg";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Advisory lock key pair ("nyx", "mig") — arbitrary but stable. */
const LOCK_NAMESPACE = 0x6e_79_78;
const LOCK_KEY = 0x6d_69_67;

const UP_FILE_PATTERN = /^(?<id>\d{4})_(?<name>[a-z0-9_]+)\.up\.sql$/;

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
}

export interface MigrationStatus {
  readonly id: number;
  readonly name: string;
  readonly appliedAt: Date | undefined;
}

/** `0001_initial_schema`-style label for logs and results. */
export function migrationLabel(migration: Pick<Migration, "id" | "name">): string {
  return `${String(migration.id).padStart(4, "0")}_${migration.name}`;
}

/** Discover and load migration file pairs, sorted by id. */
export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const migrations: Migration[] = [];

  for (const entry of entries) {
    const groups = UP_FILE_PATTERN.exec(entry)?.groups;
    const idText = groups?.id;
    const name = groups?.name;
    if (idText === undefined || name === undefined) {
      continue;
    }

    const downFile = `${idText}_${name}.down.sql`;
    let downSql: string;
    try {
      downSql = await readFile(join(dir, downFile), "utf8");
    } catch (error) {
      throw new Error(`migration ${entry} is missing its down file (${downFile})`, {
        cause: error,
      });
    }

    migrations.push({
      id: Number.parseInt(idText, 10),
      name,
      upSql: await readFile(join(dir, entry), "utf8"),
      downSql,
    });
  }

  migrations.sort((a, b) => a.id - b.id);

  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id ${String(migration.id)}`);
    }
    seen.add(migration.id);
  }

  return migrations;
}

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Connection-level failure; the original migration error is the actionable one.
  }
}

/**
 * Connect, take the migration advisory lock, ensure the bookkeeping table
 * exists, run `fn`, then disconnect (which releases the lock).
 */
async function withMigrationLock<T>(
  databaseUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [LOCK_NAMESPACE, LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id         integer     PRIMARY KEY,
         name       text        NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Apply all pending migrations. Returns the labels applied, in order. */
export async function migrateUp(databaseUrl: string, dir?: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);

  return withMigrationLock(databaseUrl, async (client) => {
    const { rows } = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
    const appliedIds = new Set(rows.map((row) => row.id));
    const applied: string[] = [];

    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) {
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.upSql);
        await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
          migration.id,
          migration.name,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw new Error(`migration ${migrationLabel(migration)} failed to apply`, {
          cause: error,
        });
      }
      applied.push(migrationLabel(migration));
    }

    return applied;
  });
}

/**
 * Revert the most recently applied migration. Returns its label, or
 * `undefined` when nothing is applied.
 */
export async function migrateDown(databaseUrl: string, dir?: string): Promise<string | undefined> {
  const migrations = await loadMigrations(dir);
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));

  return withMigrationLock(databaseUrl, async (client) => {
    const { rows } = await client.query<{ id: number }>(
      "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
    );
    const latest = rows[0];
    if (latest === undefined) {
      return undefined;
    }

    const migration = byId.get(latest.id);
    if (migration === undefined) {
      throw new Error(`applied migration ${String(latest.id)} has no local files; cannot revert`);
    }

    await client.query("BEGIN");
    try {
      await client.query(migration.downSql);
      await client.query("DELETE FROM schema_migrations WHERE id = $1", [migration.id]);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw new Error(`migration ${migrationLabel(migration)} failed to revert`, {
        cause: error,
      });
    }

    return migrationLabel(migration);
  });
}

/** Applied/pending status for every known migration, in id order. */
export async function migrationStatus(
  databaseUrl: string,
  dir?: string,
): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);

  return withMigrationLock(databaseUrl, async (client) => {
    const { rows } = await client.query<{ id: number; applied_at: Date }>(
      "SELECT id, applied_at FROM schema_migrations",
    );
    const appliedAt = new Map(rows.map((row) => [row.id, row.applied_at]));

    return migrations.map((migration) => ({
      id: migration.id,
      name: migration.name,
      appliedAt: appliedAt.get(migration.id),
    }));
  });
}
