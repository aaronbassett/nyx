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
import { randomUUID } from "node:crypto";
import { buildServer } from "./app.js";
import { createModelRouter } from "./agents/routing.js";
import { HttpCompileClient } from "./compile/index.js";
import { ConfigValidationError, loadConfig } from "./config/index.js";
import type { Config } from "./config/index.js";
import { providerApiKeys } from "./config/schema.js";
import { getDb } from "./db/index.js";
import { createOwnerGatedDeployExecutor } from "./deploy/executor.js";
import { createDeployHandler } from "./deploy/handler.js";
import { createDeployPipeline } from "./deploy/pipeline.js";
import { createDeployRegistry } from "./deploy/registry.js";
import { createDeployWalletMonitor } from "./deploy/wallet.js";
import type { WalletAlert } from "./deploy/wallet.js";
import { createDepositStore, createLedgerStore } from "./ledger/index.js";
import {
  createReconcileJob,
  createReconcileStore,
  ownerGatedReconcileSeam,
  pgLedgerTotals,
} from "./ledger/reconcile.js";
import type { ReconcileAlarm } from "./ledger/reconcile.js";
import { createReconcileScheduler } from "./ledger/reconcile-scheduler.js";
import { createMcpClients } from "./mcp/index.js";
import { createProjectAuthorizer } from "./projects/authorize.js";
import {
  createCloneService,
  createInMemoryRepoCache,
  createTokenBucketLimiter,
  PgChatStore,
  PgProjectStore,
} from "./projects/index.js";
import { createProverClient } from "./prover/index.js";
import { PgSessionStore, createWsHandler } from "./protocol/index.js";
import { createTurnCoordinator } from "./turn/coordinator.js";

/**
 * ⚠️ Owner-gated placeholder (constitution I). The deploy wallet monitors tDUST (D51), which has
 * NO config tunable yet (`lowBalanceThresholdNyxt` is the USER NYXT low-water mark — wrong units).
 * Until a tDUST-denominated threshold is added to config, the low-water warn is DISABLED (`0n` =
 * never "low"); the real operational threshold is owner-gated (never a base-unit magnitude from
 * memory). `assertCanDeploy` still fails closed on an EMPTY wallet via the per-deploy floor.
 */
const DEPLOY_WALLET_LOW_THRESHOLD_TDUST = 0n;

/** Structured, bigint-safe stderr sink for the deploy-wallet balance alerts (FR-059). */
function logWalletAlert(alert: WalletAlert): void {
  // `alert` carries its own `level` (`low`/`exhausted`); the log severity is `warn` under a
  // distinct key so the spread never clobbers it. Bigints (available/threshold) → decimal strings.
  const line = JSON.stringify(
    { severity: "warn", source: "deploy-wallet", event: "balance-alert", ...alert },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  process.stderr.write(`${line}\n`);
}

/** Structured, bigint-safe stderr sink for the LOUD reconcile drift/skip alarms (FR-067). */
function logReconcileAlarm(alarm: ReconcileAlarm): void {
  // Reconcile drift can only mean a bug or tampering (never auto-corrected) — logged at `error`.
  const line = JSON.stringify(
    { severity: "error", source: "reconcile", event: "alarm", ...alarm },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  process.stderr.write(`${line}\n`);
}

/** Stderr sink for a reconcile TICK fault (owner-gated source/seam not wired, or a store error). */
function logReconcileTickError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const line = JSON.stringify({
    severity: "warn",
    source: "reconcile",
    event: "tick-error",
    detail,
  });
  process.stderr.write(`${line}\n`);
}

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

  // US13 handoff: ONE clone service for the whole process — a single shared repo-materialization
  // cache (EC-56) + a single token/IP rate-limit bucket (EC-55) back BOTH the session-gated
  // archive/clone-token routes and the token-gated git-HTTP scope. Pure construction, no network.
  const cloneService = createCloneService({
    store: projectStore,
    rateLimiter: createTokenBucketLimiter({
      capacity: config.tunables.cloneRateCapacity,
      refillTokens: config.tunables.cloneRateRefill,
      intervalMs: config.tunables.cloneRateIntervalMs,
      clock: () => Date.now(),
    }),
    cache: createInMemoryRepoCache(),
  });

  // The supervisor turn loop (D34): its `handlers` drive one turn per `prompt:submit`.
  const coordinator = createTurnCoordinator({
    modelRouter,
    compileClient,
    ledger: ledgerStore,
    chat,
    // Turn-end file persistence (US7): a settled turn commits its files as one agent
    // batch so the US13 exports + US14 editor read real rows, not a hollow project.
    projectStore,
    mcp,
    flatReserve: config.tunables.flatReserveNyxt,
  });

  // The US8 deploy loop. All seam construction, no network: the executor, the wallet balance
  // query, and the latest-green-build lookup are OWNER-GATED / open wiring gaps (flagged below).
  const deployRegistry = createDeployRegistry(db);
  // OWNER-GATED (constitution I): the real Midnight-SDK deploy adapter is a stub whose every
  // method throws — it needs the local devnet + a funded signing credential + mnm-verified SDK
  // shapes. The signing credential flows ONLY here (D50/constitution III), never client-routed.
  const deployExecutor = createOwnerGatedDeployExecutor({
    signingKey: config.secrets.deployKey,
    network: config.network,
    proverClient,
  });
  const deployWallet = createDeployWalletMonitor({
    // OWNER-GATED (constitution I): the real tDUST balance read (Midnight SDK/indexer adapter) is
    // not wired. A rejected query is the loudest "not wired" — `assertCanDeploy` fails closed and
    // no false balance is ever reported. (Unreached today: `getLatestGreenBuild` rejects first.)
    queryBalance: () =>
      Promise.reject(
        new Error(
          "owner-gated: deploy-wallet tDUST balance query not wired (needs the SDK/indexer adapter + a funded deploy wallet)",
        ),
      ),
    lowThreshold: DEPLOY_WALLET_LOW_THRESHOLD_TDUST,
    alert: logWalletAlert,
  });
  const deployHandler = createDeployHandler({
    // Per-request pipeline factory (§2): bind the pipeline's emit sinks to the requesting
    // connection so its `deploy:status`/`contract:deployed` reach the client that asked to deploy.
    makePipeline: (sinks) =>
      createDeployPipeline({
        executor: deployExecutor,
        registry: deployRegistry,
        emit: sinks.emit,
        emitContractDeployed: sinks.emitContractDeployed,
      }),
    // The turn coordinator persists every `ready` full compile as the project's latest green
    // build (FR-054); the deploy handler reads it here AT DEPLOY TIME (the US8 stale-build
    // lesson) so the greenness gate reflects the newest green artifacts, not an enqueue-time
    // snapshot. `null` (no green build yet) honestly fails the gate — never a phantom deploy.
    getLatestGreenBuild: (projectId) => projectStore.getLatestGreenBuild(projectId),
    wallet: deployWallet,
    // The turn coordinator's turn-observation seam wires straight in (EC-40 / FR-058).
    turnGate: coordinator.turnGate,
    newRequestId: () => randomUUID(),
  });

  // Defense 1 (cross-account project-hijack): gate the WS connection on project
  // ownership so a session can only OPEN a socket for a project its account owns (D43).
  // Both `prompt:submit` (coordinator) and `deploy:request` (deploy handler) register on the ONE
  // `/ws` router — the WS route takes exactly one handler, so they are combined here.
  const wsHandler = createWsHandler({
    sessionStore,
    config,
    handlers: (router) => {
      coordinator.handlers(router);
      deployHandler.handlers(router);
    },
    authorizeProject: createProjectAuthorizer(projectStore),
  });
  const app = await buildServer({
    config,
    db,
    mcp,
    wsHandler,
    projectStore,
    cloneService,
    ledgerStore,
    depositStore,
    proverClient,
    deployRegistry,
    deployHandler,
  });

  // US10 reconcile — the LAZY on-chain leg (D13/D55/D56), a background daily job that NEVER
  // touches a user path (SC-039; it is wired here at the composition root, not in any handler).
  // Source 1 (ledger totals) is real Postgres; Sources 2/3 + the burn executor + the CANONICAL
  // watermark source are OWNER-GATED (constitution I — the real indexer/vault-balance/burn/chain
  // adapters need the local devnet + the deployed vault + the orchestrator burn key). It IS
  // started here; until the seams are wired every daily tick faults on the gated watermark
  // source and logs a `tick-error` (the honest "armed but gated" state). NOTE: an in-process
  // timer cannot guarantee a daily run under scale-to-zero (constitution VI); the `lastRunAt`
  // catch-up makes a warm instance run as soon as it is overdue, but a hard guarantee needs an
  // external scheduled trigger (owner-gated deployment wiring).
  const reconcileStore = createReconcileStore(db);
  const reconcileJob = createReconcileJob({
    ledgerTotals: pgLedgerTotals(db),
    onchainDepositTotal: ownerGatedReconcileSeam("finalized on-chain deposit total"),
    vaultBalance: ownerGatedReconcileSeam("vault NYXT balance"),
    executeBurn: ownerGatedReconcileSeam("batched burn executor"),
    store: reconcileStore,
    alert: logReconcileAlarm,
  });
  const reconcileScheduler = createReconcileScheduler({
    job: reconcileJob,
    cadenceMs: config.tunables.reconcileCadenceMs,
    watermarkSource: ownerGatedReconcileSeam("canonical watermark source"),
    // Liveness catch-up (scale-to-zero): schedule the first tick from the last reconciled run's
    // timestamp, so a restart before a full cadence doesn't reset the daily countdown.
    lastRunAt: async () => (await reconcileStore.lastReconciled())?.ranAt ?? null,
    onError: logReconcileTickError,
  });
  reconcileScheduler.start();
  app.addHook("onClose", () => {
    reconcileScheduler.stop();
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal: ${detail}\n`);
  process.exit(1);
});
