/** Postgres persistence layer (T016): typed client + migration runner. */
export { closeDb, createDb, getDb, resolveDatabaseUrl } from "./client.js";
export type { Db, DbOptions, Queryable } from "./client.js";
export {
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationLabel,
  migrationStatus,
} from "./migrate.js";
export type { Migration, MigrationStatus } from "./migrate.js";
