/**
 * Typed Postgres client for the Nyx orchestrator (T016).
 *
 * Connection configuration comes from `DATABASE_URL`, which is validated at
 * boot by the config layer (DS-003) — this module only consumes it. All access
 * goes through parameterized queries; never interpolate values into SQL text.
 */
import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

/** Anything that can run a parameterized query (a pool or an open transaction). */
export interface Queryable {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** Pooled database handle with transaction support. */
export interface Db extends Queryable {
  /**
   * Run `fn` inside a single transaction. Commits on resolve, rolls back on
   * reject. Every mutation that pairs ledger + domain state must use this
   * (FR-043, FR-047).
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Drain and close the pool. */
  end(): Promise<void>;
}

export interface DbOptions {
  /** Overrides `process.env.DATABASE_URL` (used by tests and the migration CLI). */
  connectionString?: string;
  /** Max pooled connections (default 10). */
  maxConnections?: number;
}

/** Resolve the connection string from options or the environment. */
export function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    // Boot-time config validation (DS-003) should make this unreachable in the app.
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

function asQueryable(client: PoolClient): Queryable {
  return {
    query: <R extends QueryResultRow>(text: string, params?: unknown[]) =>
      client.query<R>(text, params),
  };
}

/** Create a pooled database handle. */
export function createDb(options: DbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString: resolveDatabaseUrl(options.connectionString),
    max: options.maxConnections ?? 10,
  });

  return {
    query: <R extends QueryResultRow>(text: string, params?: unknown[]) =>
      pool.query<R>(text, params),

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(asQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Connection-level failure; the original error is the actionable one.
        }
        throw error;
      } finally {
        client.release();
      }
    },

    end: () => pool.end(),
  };
}

let defaultDb: Db | undefined;

/** Lazily-created process-wide pool (uses `DATABASE_URL`). */
export function getDb(): Db {
  defaultDb ??= createDb();
  return defaultDb;
}

/** Close the process-wide pool (graceful shutdown, test teardown). */
export async function closeDb(): Promise<void> {
  if (defaultDb !== undefined) {
    const db = defaultDb;
    defaultDb = undefined;
    await db.end();
  }
}
