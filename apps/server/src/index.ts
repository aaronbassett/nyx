/**
 * Nyx orchestrator entry point (T015).
 *
 * Fail-fast boot (DS-003): validate config first, and on any invalid/missing
 * variable print the complete named error and `process.exit(1)` — this is the
 * ONLY place that exits, keeping `loadConfig` pure and testable.
 *
 * On success: construct the DB handle and MCP clients, wire the Fastify HTTP+WS
 * server, and listen on the validated port.
 */
import { buildServer } from "./app.js";
import { ConfigValidationError, loadConfig } from "./config/index.js";
import type { Config } from "./config/index.js";
import { getDb } from "./db/index.js";
import { createMcpClients } from "./mcp/index.js";

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed to load configuration: ${detail}\n`);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();

  const db = getDb();
  const mcp = createMcpClients(config.mcp);
  const app = await buildServer({ config, db, mcp });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal: ${detail}\n`);
  process.exit(1);
});
