/**
 * Migration CLI — invoked via package scripts (`pnpm --filter @nyx/server migrate:up`).
 *
 *   migrate-cli up      apply all pending migrations
 *   migrate-cli down    revert the most recently applied migration
 *   migrate-cli status  list applied/pending migrations
 */
import { resolveDatabaseUrl } from "./client.js";
import { migrateDown, migrateUp, migrationLabel, migrationStatus } from "./migrate.js";

const command = process.argv[2];

switch (command) {
  case "up": {
    const applied = await migrateUp(resolveDatabaseUrl());
    console.log(applied.length === 0 ? "No pending migrations." : `Applied: ${applied.join(", ")}`);
    break;
  }
  case "down": {
    const reverted = await migrateDown(resolveDatabaseUrl());
    console.log(reverted === undefined ? "Nothing to revert." : `Reverted: ${reverted}`);
    break;
  }
  case "status": {
    const statuses = await migrationStatus(resolveDatabaseUrl());
    if (statuses.length === 0) {
      console.log("No migrations found.");
      break;
    }
    for (const status of statuses) {
      const state =
        status.appliedAt === undefined ? "pending" : `applied ${status.appliedAt.toISOString()}`;
      console.log(`${migrationLabel(status)}  ${state}`);
    }
    break;
  }
  default: {
    console.error("Usage: migrate-cli <up|down|status>");
    process.exitCode = 1;
  }
}
