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
import { createModelRouter } from "./agents/routing.js";
import { HttpCompileClient } from "./compile/index.js";
import { ConfigValidationError, loadConfig } from "./config/index.js";
import type { Config } from "./config/index.js";
import { providerApiKeys } from "./config/schema.js";
import { getDb } from "./db/index.js";
import { createDepositStore, createLedgerStore } from "./ledger/index.js";
import { createMcpClients } from "./mcp/index.js";
import { createProjectAuthorizer } from "./projects/authorize.js";
import { PgChatStore, PgProjectStore } from "./projects/index.js";
import { createProverClient } from "./prover/index.js";
import { PgSessionStore, createWsHandler } from "./protocol/index.js";
import { createTurnCoordinator } from "./turn/coordinator.js";

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
  const sessionStore = new PgSessionStore(db);
  // The authoritative project store (US7): built ONCE here and shared by the WS
  // connect-time ownership check (Defense 1) and `buildServer`'s project routes, so a
  // connection can only OPEN for a project the session's account owns.
  const projectStore = new PgProjectStore(db, {
    maxFileBytes: config.tunables.maxFileBytes,
    maxProjectBytes: config.tunables.maxProjectBytes,
    projectQuotaPerAccount: config.tunables.projectQuotaPerAccount,
    versionRetentionCount: config.tunables.versionRetentionCount,
    versionRetentionDays: config.tunables.versionRetentionDays,
  });

  // US1/US6 services, all constructed from config — pure object construction, no network:
  // the real Compile Service / interim prover / indexer / LLM providers are OWNER-GATED,
  // so `main()` only WIRES them from URLs+secrets and never eagerly calls them here.
  const modelRouter = createModelRouter({
    routing: config.modelRouting,
    apiKeys: providerApiKeys(config.secrets),
  });
  const compileClient = new HttpCompileClient({
    token: config.secrets.compileServiceToken,
    baseUrl: config.compileService.url,
  });
  const ledgerStore = createLedgerStore(db, { flatReserve: config.tunables.flatReserveNyxt });
  const depositStore = createDepositStore(db, ledgerStore, {
    minimumDeposit: config.tunables.minimumDepositNyxt,
    depositRefTtlMs: config.tunables.depositRefTtlMs,
  });
  const proverClient = createProverClient({ baseUrl: config.prover.url });
  const chat = new PgChatStore(db);

  // The supervisor turn loop (D34): its `handlers` drive one turn per `prompt:submit`.
  const coordinator = createTurnCoordinator({
    modelRouter,
    compileClient,
    ledger: ledgerStore,
    chat,
    mcp,
    flatReserve: config.tunables.flatReserveNyxt,
  });

  // Defense 1 (cross-account project-hijack): gate the WS connection on project
  // ownership so a session can only OPEN a socket for a project its account owns (D43).
  const wsHandler = createWsHandler({
    sessionStore,
    config,
    handlers: coordinator.handlers,
    authorizeProject: createProjectAuthorizer(projectStore),
  });
  const app = await buildServer({
    config,
    db,
    mcp,
    wsHandler,
    projectStore,
    ledgerStore,
    depositStore,
    proverClient,
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal: ${detail}\n`);
  process.exit(1);
});
