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
import { WebSocket } from "ws";
import type { ServerToClientEvent } from "@nyx/protocol";
import { buildServer } from "./app.js";
import { createModelRouter } from "./agents/routing.js";
import { createLocalArtifactStore, storeFetchAdapter } from "./artifacts/index.js";
import { createBrowserCompileClient, createCompileResultsInbox } from "./compile/index.js";
import type { BrowserCompileSession } from "./compile/index.js";
import { ConfigValidationError, loadConfig } from "./config/index.js";
import type { Config } from "./config/index.js";
import { providerApiKeys } from "./config/schema.js";
import { getDb } from "./db/index.js";
import { createDevnetBalanceQuery } from "./deploy/balance.js";
import { createDevnetDeployExecutor } from "./deploy/devnet-executor.js";
import { createDeployHandler } from "./deploy/handler.js";
import { createDeployPipeline } from "./deploy/pipeline.js";
import { createDeployRegistry } from "./deploy/registry.js";
import { createDeployWalletMonitor } from "./deploy/wallet.js";
import type { WalletAlert } from "./deploy/wallet.js";
import { createDepositStore, createLedgerStore } from "./ledger/index.js";
import type { CreditOutcome } from "./ledger/index.js";
import {
  createDevnetDepositIndexerQuery,
  createObservationPoller,
  creditOutcomeToPush,
} from "./ledger/indexer-observation.js";
import {
  createReconcileJob,
  createReconcileStore,
  ownerGatedReconcileSeam,
  pgLedgerTotals,
} from "./ledger/reconcile.js";
import type { ReconcileAlarm } from "./ledger/reconcile.js";
import { createReconcileScheduler } from "./ledger/reconcile-scheduler.js";
import { createNyxtVaultStateReader } from "./ledger/vault-state-reader.js";
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
import {
  PgSessionStore,
  createSessionRegistry,
  createWsHandler,
  sendEvent,
} from "./protocol/index.js";
import { createTurnCoordinator } from "./turn/coordinator.js";

/**
 * ⚠️ Owner-gated placeholder (constitution I). The deploy wallet monitors tDUST (D51), which has
 * NO config tunable yet (`lowBalanceThresholdNyxt` is the USER NYXT low-water mark — wrong units).
 * Until a tDUST-denominated threshold is added to config, the low-water warn is DISABLED (`0n` =
 * never "low"); the real operational threshold is owner-gated (never a base-unit magnitude from
 * memory). `assertCanDeploy` still fails closed on an EMPTY wallet via the per-deploy floor.
 */
const DEPLOY_WALLET_LOW_THRESHOLD_TDUST = 0n;

/** Reclaim an abandoned staged (uncommitted) artifact prefix once it is older than this (M1). */
const STAGING_MAX_AGE_MS = 60 * 60_000; // 1 h
/** Cadence of the unref'd boot sweep that reclaims abandoned staged artifact prefixes (M1). */
const STAGING_SWEEP_INTERVAL_MS = 15 * 60_000; // 15 min

/** Unref'd delay so a bounded compile-inbox wait never pins the process (mirrors the coordinator). */
function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

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

/**
 * Structured, bigint-safe stderr sink for the deposit store's LOUD warnings — the EC-28 amount
 * mismatch (chain-vs-expected) and the late-deposit-after-TTL credit. Phase 8 flagged the store's
 * DEFAULT logger is a SILENT no-op; wiring this closes that gap so those money-audit signals
 * actually surface. `warn(context, message)` matches the `DepositLogger` seam (a `request.log`
 * subset). Bigints in `context` → decimal strings so the line itself can never throw.
 */
function logDepositWarning(context: Record<string, unknown>, message: string): void {
  const line = JSON.stringify(
    { severity: "warn", source: "deposit", event: "store-warning", message, ...context },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  process.stderr.write(`${line}\n`);
}

/**
 * Stderr sink for a deposit-observation poll TICK fault (the indexer is unreachable, or the
 * owner-gated on-chain decode is not wired). Reported, never fatal — the poll loop survives and
 * the next interval still fires (the honest "armed but gated" state, mirrors the reconcile tick).
 */
function logDepositPollError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ severity: "warn", source: "deposit-poller", event: "tick-error", detail })}\n`,
  );
}

/** Stderr sink for a failure to build/route a `ledger:update` push from a credit outcome. */
function logDepositPushError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ severity: "warn", source: "deposit-push", event: "push-error", detail })}\n`,
  );
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
  // ONE shared single-live-session registry (D40) for the whole process: the WS handler claims
  // (account, project) sockets into it, and the boot-level deposit-observation push reads it back
  // to route a finalized deposit's `ledger:update` to the depositor's live connection(s). Sharing
  // the SAME instance is load-bearing — a second, private registry inside `createWsHandler` would
  // hold the live sockets the push could never see.
  const registry = createSessionRegistry<WebSocket>();
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
  // P2 browser-compile wiring: the per-cycle CHECK + the green FULL compile now run in the
  // USER'S browser (the retired server-side Compile Service + R2-write path is gone). The
  // browser uploads its green artifacts to the server's OWN durable {@link ArtifactStore}
  // (content-hash-addressed, size-capped from config); `storeFetchAdapter` gives the
  // orchestrator an IN-PROCESS `fetch` over that same store so verify-before-announce reads the
  // committed prefix without HTTP-ing the server's own artifact route.
  const artifactStore = createLocalArtifactStore({
    rootDir: config.artifacts.rootDir,
    maxFileBytes: config.artifacts.maxFileBytes,
    maxBundleBytes: config.artifacts.maxBundleBytes,
    // M1 — per-project staged (uncommitted) exhaustion caps for the shared disk volume.
    maxStagedBytesPerProject: config.artifacts.maxStagedBytesPerProject,
    maxStagedPrefixesPerProject: config.artifacts.maxStagedPrefixesPerProject,
  });
  // ONE shared rendezvous inbox backs both the per-turn client (which awaits `compile:results`)
  // and the WS handler (which delivers to it, ownership-gated). `config.publicOrigin` builds the
  // artifact URLs the orchestrator resolves through `fetchArtifact` before announcing
  // `artifacts:ready`; the bounded CHECK/FULL waits are config tunables (D42 no-hang backstops).
  const compileInbox = createCompileResultsInbox({ delay: unrefDelay });
  const makeCompileClient = (session: BrowserCompileSession) =>
    createBrowserCompileClient({
      inbox: compileInbox,
      session,
      publicOrigin: config.publicOrigin,
      checkTimeoutMs: config.tunables.compileCheckTimeoutMs,
      fullTimeoutMs: config.tunables.compileFullTimeoutMs,
    });
  const ledgerStore = createLedgerStore(db, { flatReserve: config.tunables.flatReserveNyxt });
  const depositStore = createDepositStore(db, ledgerStore, {
    minimumDeposit: config.tunables.minimumDepositNyxt,
    depositRefTtlMs: config.tunables.depositRefTtlMs,
    // Inject a REAL logger (closes the Phase 8 silent-no-op gap): the store's default is silent,
    // so EC-28 amount-mismatch + late-deposit warnings would otherwise vanish. This surfaces them.
    logger: { warn: logDepositWarning },
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
    makeCompileClient,
    compileInbox,
    ledger: ledgerStore,
    chat,
    // Turn-end file persistence (US7): a settled turn commits its files as one agent
    // batch so the US13 exports + US14 editor read real rows, not a hollow project.
    projectStore,
    mcp,
    flatReserve: config.tunables.flatReserveNyxt,
    // Verify-before-announce reads the browser-uploaded artifacts from the server's OWN store
    // over an in-process `fetch` — with browser compile the urlPrefix points at the server's own
    // artifact route, so a real `fetch` would HTTP itself; the store adapter reads it directly.
    fetchArtifact: storeFetchAdapter(artifactStore),
  });

  // The US8 deploy loop. Pure seam construction, no network at boot: the real devnet executor and
  // balance query open the local devnet + a funded signing credential lazily on first ACTUAL
  // deploy/balance call (their SDK bodies stay owner-gated behind *NotWiredError until P5), so the
  // server still boots green; only a real deploy/balance attempt reaches the gated leg.
  const deployRegistry = createDeployRegistry(db);
  // The real Midnight-SDK deploy adapter (D50/constitution III). The signing credential flows ONLY
  // here (never client-routed); the SDK graph is lazily imported on first deploy, so construction is
  // side-effect-free and the artifact store is the read-only source of the compiled contract.
  const deployExecutor = createDevnetDeployExecutor({
    signingKey: config.secrets.deployKey,
    network: config.network,
    proverClient,
    artifacts: artifactStore,
  });
  const deployWallet = createDeployWalletMonitor({
    // The real deploy-wallet tDUST balance read (Midnight SDK adapter, lazily loaded). A seam
    // rejection propagates (fail-closed) — `assertCanDeploy` fails closed and no false balance is
    // ever reported; the signing credential flows in as a dependency, never onto a client surface.
    queryBalance: createDevnetBalanceQuery({
      network: config.network,
      signingKey: config.secrets.deployKey,
    }),
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
    // Share the one process-wide registry so the deposit-observation push (below) can find the
    // depositor's live sockets — the WS handler claims into this exact instance.
    registry,
  });
  const app = await buildServer({
    config,
    db,
    mcp,
    wsHandler,
    projectStore,
    // The durable, size-capped artifact store the browser publishes green compiles to (P2) —
    // the SAME instance the coordinator reads through `storeFetchAdapter`, so an upload the WS
    // route commits is exactly what verify-before-announce sees. buildServer's in-memory default
    // is only for tests.
    artifactStore,
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

  // M1 — reclaim abandoned staged (uncommitted) artifact prefixes on an UNREF'd interval so a
  // client that PUTs green artifacts then never commits cannot pin the shared disk forever. The
  // timer never keeps the process alive and is cleared on close; a sweep fault is logged, not fatal.
  const stagingSweepTimer = setInterval(() => {
    void artifactStore.sweepStaged(STAGING_MAX_AGE_MS).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ severity: "warn", source: "artifact-sweep", event: "sweep-error", message })}\n`,
      );
    });
  }, STAGING_SWEEP_INTERVAL_MS);
  stagingSweepTimer.unref();
  app.addHook("onClose", () => {
    clearInterval(stagingSweepTimer);
  });

  // P3 — the indexer deposit-OBSERVATION poller: the on-chain→off-chain crediting bridge. Each
  // tick lists the still-open deposit refs, asks the indexer for exactly those, and hands every
  // observation VERBATIM to the store's exactly-once credit CAS (the poller never classifies or
  // credits — `deposits.ts` does). It mirrors the reconcile scheduler's lifecycle: started after
  // listen, stopped on close. The per-deposit on-chain DECODE (`readDepositsState`) is the real
  // NyxtVault state reader — but it needs BOTH a deployed vault address and the compiled vault
  // module (`vaultArtifactsDir`), which only the P5 demo env supplies. When either is absent the
  // reader is omitted, so every tick faults on the honest DepositIndexerNotWiredError, is logged,
  // and the loop survives — the "armed but gated" state (identical to the reconcile job's sources).
  const vaultModuleDir = config.artifacts.vaultArtifactsDir;
  const depositIndexerQuery = createDevnetDepositIndexerQuery({
    indexerUrl: config.network.indexerUrl,
    vaultAddress: config.nyxtVaultAddress,
    // Inject the real decode ONLY when both the deployed vault address and the compiled vault module
    // are configured (P5); otherwise omit it → findDeposits rejects (DepositIndexerNotWiredError).
    ...(vaultModuleDir && config.nyxtVaultAddress
      ? {
          readDepositsState: createNyxtVaultStateReader({
            indexerUrl: config.network.indexerUrl,
            vaultModuleDir,
          }),
        }
      : {}),
  });

  // Route a credit OUTCOME to the depositor's live socket(s) as a RENDER signal (FR-070): the
  // client never computes a balance, it REPLACES it from this server payload. A `credited` outcome
  // → an encoded `ledger:update` (bigint money → decimal strings); a known-ref `failed` → a
  // `deposit:failed` diagnostic; every other outcome (already-credited / orphaned / unfinalized /
  // unregistered failure) → no frame. Best-effort: if the depositor has no live connection the
  // frame is simply dropped (the client re-reads `GET /ledger` on reconnect), and any push fault
  // is logged, never allowed to break the poll loop.
  const pushLedgerOutcome = async (outcome: CreditOutcome): Promise<void> => {
    try {
      const push = await creditOutcomeToPush(outcome, {
        ledger: ledgerStore,
        now: () => Date.now(),
        onInvariantBreak: logDepositWarning,
      });
      if (push === null) {
        return;
      }
      // The event is already WIRE-encoded (decimal-string money); `sendEvent` re-validates it
      // against the server→client schema (whose input IS the wire form) and serializes it.
      const frame = push.event as unknown as ServerToClientEvent;
      for (const socket of registry.socketsForAccount(push.address)) {
        sendEvent(socket, frame);
      }
    } catch (error) {
      logDepositPushError(error);
    }
  };

  const depositPoller = createObservationPoller({
    store: depositStore,
    query: depositIndexerQuery,
    intervalMs: config.tunables.depositPollIntervalMs,
    graceMs: config.tunables.depositRefTtlMs,
    onOutcome: (outcome) => {
      void pushLedgerOutcome(outcome);
    },
    onError: logDepositPollError,
  });
  app.addHook("onClose", () => {
    depositPoller.stop();
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });

  // Arm the poll loop only after the server is listening (mirrors the reconcile scheduler).
  depositPoller.start();
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal: ${detail}\n`);
  process.exit(1);
});
