/**
 * Deploy pipeline — the US8 prompt-to-DApp deploy state machine (T157, FR-054/055/056).
 *
 * `createDeployPipeline` returns a `runDeploy` that drives ONE explicit deploy through five
 * phases — validate the green build, prove server-side (D37), sign+submit with the deploy key
 * (D50), await finality, and record + announce — emitting a `deploy:status` at each phase and,
 * ONLY on a finalized success, `contract:deployed { address }` EXACTLY ONCE (FR-055/SC-029).
 * Every side effect is injected (the executor, the registry write, the two emit sinks, the
 * clock), so the whole state machine is deterministic with no chain, no prover, and no key.
 *
 * FINALITY-GATED EXACTLY-ONCE (mirrors D45 / `../ledger/deposits.ts` `observeFinalized`).
 * `contract:deployed` and the registry write happen ONLY on a `finalized` finality — never
 * before, and never on a `reorged` / `timeout` / `failed` finality. So a reorg produces NO
 * phantom address (SC-029/EC-42), a timeout is an explicit, retriable pending-then-timeout
 * (EC-39 — never a hanging spinner), and a re-run of an already-TERMINAL `requestId` — `deployed`
 * OR `record-failed` (BUG 2) — is a pure replay that re-drives NOTHING on-chain (no second tx)
 * and neither re-records nor re-emits (the in-process `completed` memo holds both terminal arms,
 * backed by the registry's own idempotency — the deposits belt-and-suspenders shape).
 *
 * NEVER-REJECT BACKSTOP (defect C1, mirrors the turn coordinator's catch-all). The
 * {@link DeployExecutor} seam is documented "failure is DATA, never a throw", but the real
 * (owner-gated) adapter — and a DB fault in the registry write — CAN throw. `runDeploy` wraps
 * the executor-driving + finalize region so ANY unexpected throw becomes a LOUD structured log
 * ({@link DeployPipelineDeps.logError}) + a terminal `deploy:status{failed}` (a wire-safe
 * constant, never the error) + a retriable `failed` result — `runDeploy` RESOLVES on every
 * path, so an exception can NEVER strand the client on a hanging spinner (EC-39). The
 * post-finality registry write is BOUNDED-RETRIED so a transient DB blip does not lose the
 * record of a finalized deploy; if it is ultimately unrecordable the deploy stays a distinct,
 * NON-retriable `record-failed` terminal (the contract EXISTS on-chain, so a blind retry would
 * double-deploy — ops reconcile from the attached address + txRef). `contract:deployed` is
 * NEVER announced without a successful record.
 *
 * ⚠️ CONSTITUTION I — the on-chain deploy is an INJECTABLE SEAM, NOT hand-written from memory.
 * {@link DeployExecutor} is a NARROW, Nyx-INTERNAL seam (prove → signAndSubmit → awaitFinality)
 * — deliberately NOT any `@midnight-ntwrk/*` SDK deploy/proving/finality shape. The REAL
 * executor (Midnight SDK `deployContract` built from the green artifacts, driven through the
 * D37 same-origin prover, SIGNED with the deploy key, SUBMITTED to `config.network.nodeUrl`,
 * and AWAITED to finality against the indexer) is an OWNER-GATED adapter — it needs the local
 * devnet + a funded deploy key and its SDK shapes MUST be mnm/MNE-verified before use. This
 * module builds + tests the state machine over the seam; it never touches the SDK.
 *
 * ⚠️ CONSTITUTION III — the deploy key flows ONLY into the executor (server-side, D50). It is
 * NEVER in scope here and NEVER appears in any emitted `deploy:status` / `contract:deployed`
 * payload: `deploy:status.detail` is sourced only from a fixed, wire-safe classification
 * ({@link DEPLOY_FAILURE_DETAIL}) — an insufficient-tDUST failure (EC-38) is framed as a
 * PLATFORM fault, never a user error — and `contract:deployed` carries the branded on-chain
 * address alone.
 *
 * Two emit seams (mirroring the compile orchestrator's dedicated `emitArtifactsReady`): the
 * `deploy:status` stream (`emit`) and the distinct `contract:deployed` event
 * (`emitContractDeployed`) — one status payload cannot carry the other event, so they are
 * separate sinks.
 */
import { ContractAddressSchema } from "@nyx/protocol";
import type {
  ContractDeployedPayload,
  DeployRegistryRow,
  DeployStatusPayload,
  DeployStatusPhase,
} from "@nyx/protocol";

// --- The green-build precondition (FR-054) ----------------------------------

/**
 * The persisted green build a deploy is built from — the deploy-relevant subset of the compile
 * pipeline's `ready` `CompileOutcome` (`../compile/orchestrator.ts`). `urlPrefix` is the
 * content-hashed R2 prefix the (owner-gated) executor reads the compiled contract + ZK
 * artifacts from; `compilerVersion` is the D6 provenance. The `ready` outcome satisfies this
 * shape structurally, so US1 hands its persisted green build straight in.
 */
export interface DeployArtifacts {
  /** Content-hashed R2 prefix of the compiled artifacts (the `ready` outcome's `urlPrefix`). */
  readonly urlPrefix: string;
  /** The pinned compiler version the build was produced with (D6/FR-012). */
  readonly compilerVersion: string;
}

// --- The DeployExecutor seam (constitution I — NOT an SDK shape) -------------

/**
 * An opaque server-side proof/deploy-tx bundle produced by the D37 prover (constitution I).
 * The pipeline NEVER inspects it — it is a pass-through token from {@link DeployExecutor.prove}
 * to {@link DeployExecutor.signAndSubmit}. The real bundle's shape is an `@midnight-ntwrk/*`
 * detail owned by the owner-gated executor adapter, kept OPAQUE here (like the prover proxy's
 * relayed bytes).
 */
export interface DeployProof {
  /** Opaque proving output, forwarded verbatim to the signing/submit step. */
  readonly bytes: Uint8Array;
}

/** The result of {@link DeployExecutor.prove} — proving failure is DATA, not a throw. */
export type ProveOutcome =
  | { readonly outcome: "proved"; readonly proof: DeployProof }
  | { readonly outcome: "failed"; readonly reason: string };

/**
 * Why a signed deploy submission was rejected by the node. `insufficient-tdust` is EC-38 — a
 * PLATFORM fault (the server deploy wallet is out of tDUST, D52/FR-059), NOT a user error — and
 * is surfaced as such; `unavailable` is a submit-PATH fault (the SDK adapter is not wired, or an
 * unexpected adapter fault) — ALSO a platform issue, distinct from a genuine node rejection so it
 * NEVER impersonates "node rejected the deploy submission" (I2); `rejected` is any real node-side
 * rejection.
 */
export type SubmitRejectionCause = "insufficient-tdust" | "unavailable" | "rejected";

/** The result of {@link DeployExecutor.signAndSubmit} — a node rejection is DATA, not a throw. */
export type SubmitOutcome =
  | { readonly outcome: "submitted"; readonly txRef: string }
  | { readonly outcome: "rejected"; readonly cause: SubmitRejectionCause; readonly reason: string };

/** The txRef + the bounded wait handed to {@link DeployExecutor.awaitFinality}. */
export interface FinalityRequest {
  /** The submitted deploy transaction reference to await finality for. */
  readonly txRef: string;
  /** The bounded max wait (ms) the executor must honour so finality never hangs (EC-39). */
  readonly timeoutMs: number;
}

/**
 * The finality verdict for a submitted deploy (constitution I — a Nyx-internal seam, NOT an
 * SDK/indexer type). ONLY `finalized` yields an address the pipeline may announce; `reorged`
 * (SC-029/EC-42), `timeout` (EC-39), and `failed` each surface a retriable failure with NO
 * address.
 */
export type DeployFinality =
  | { readonly outcome: "finalized"; readonly address: string }
  | { readonly outcome: "reorged" }
  | { readonly outcome: "failed"; readonly reason: string }
  | { readonly outcome: "timeout" }
  /**
   * I1 (money-critical) — the tx is KNOWN-finalized on-chain but the executor could NOT extract
   * the contract address (the SDK adapter's finalized-but-no-address path). It carries NO address,
   * so nothing is announced; and because the tx IS finalized, a retry would double-deploy for
   * CERTAIN — the pipeline maps this to a NON-retriable terminal, never the generic retriable
   * backstop.
   */
  | { readonly outcome: "address-unavailable" };

/**
 * The narrow, Nyx-INTERNAL deploy seam the state machine drives (constitution I). Three
 * distinguishable steps so the pipeline can emit the proving / submitting / awaiting_finality
 * phases and gate on finality. The REAL implementation (Midnight SDK `deployContract` + the
 * D37 prover client + the deploy key + node finality) is an OWNER-GATED adapter whose SDK
 * shapes MUST be mnm/MNE-verified — it is NOT built here; tests inject a fake.
 */
export interface DeployExecutor {
  /** Prove the deploy from the green artifacts, server-side over the D37 mesh. */
  prove(artifacts: DeployArtifacts): Promise<ProveOutcome>;
  /** Sign the proven deploy with the deploy key (D50) and submit it to the node. */
  signAndSubmit(proof: DeployProof): Promise<SubmitOutcome>;
  /** Await finality for the submitted tx, bounded by {@link FinalityRequest.timeoutMs}. */
  awaitFinality(request: FinalityRequest): Promise<DeployFinality>;
}

// --- The registry write seam (structurally the concurrent registry's recordDeploy) ---

/**
 * The finalized-deploy write the pipeline calls AFTER finality. This is the `recordDeploy`
 * slice of `apps/server/src/deploy/registry.ts`'s `DeployRegistry` (a concurrently-built
 * module) — declared here as a narrow LOCAL seam, typed with the real `@nyx/protocol`
 * {@link DeployRegistryRow} return, so the pipeline stays decoupled and independently testable
 * (constitution IV). US1 injects `Pick<DeployRegistry, "recordDeploy">`, which satisfies this
 * shape structurally. `recordDeploy` supersedes the prior active row and inserts the new one
 * atomically (exactly-one-active, FR-057/SC-032); the returned row carries the monotonic
 * project `version` (a `bigint`) the pipeline reports in its `deployed` result.
 */
export interface DeployRegistrySeam {
  recordDeploy(projectId: string, address: string, txRef: string): Promise<DeployRegistryRow>;
}

// --- Pipeline deps + I/O ----------------------------------------------------

/**
 * Injectable dependencies for {@link createDeployPipeline} — every side effect is a seam.
 * `emit` streams `deploy:status`; `emitContractDeployed` is the DISTINCT `contract:deployed`
 * event sink (one status payload cannot carry the other event). `now` (default `Date.now`)
 * and `finalityTimeoutMs` (default {@link DEFAULT_FINALITY_TIMEOUT_MS}) drive the bounded,
 * deterministic finality wait. The deploy key is NEVER here — it flows only into `executor`.
 */
export interface DeployPipelineDeps {
  /** The deploy executor seam (real adapter owner-gated; a fake in tests). */
  readonly executor: DeployExecutor;
  /** The finalized-deploy registry write (US1 injects the real `recordDeploy`). */
  readonly registry: DeployRegistrySeam;
  /** The `deploy:status` WS send (S→C), injected so tests assert the streamed phases. */
  readonly emit: (status: DeployStatusPayload) => void;
  /** The `contract:deployed` WS send (S→C) — emitted EXACTLY once, post-finality (FR-055). */
  readonly emitContractDeployed: (payload: ContractDeployedPayload) => void;
  /** Clock for measuring the finality wait; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Bounded finality wait (ms) handed to the executor; defaults to {@link DEFAULT_FINALITY_TIMEOUT_MS}. */
  readonly finalityTimeoutMs?: number;
  /**
   * Structured error sink for the never-reject backstop (defect C1) — an unexpected executor
   * throw, a per-attempt registry-write failure, and an unrecordable-finalized deploy are all
   * logged LOUDLY here (never silently swallowed) before the client is given a terminal status.
   * Defaults to a structured `process.stderr` line (mirrors the turn coordinator); tests inject
   * a spy to assert the loud log fired.
   */
  readonly logError?: (message: string, detail: Record<string, unknown>) => void;
  /**
   * Delay between bounded record-retry attempts (defect C1), injected so tests run without real
   * timers. Defaults to an UNREF'd `setTimeout` so a live wait never pins the process.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Bounded post-finality registry-write retry policy (defect C1); defaults to
   * {@link DEFAULT_RECORD_RETRY}. `recordDeploy` is idempotent by `tx_ref`, so a retry after a
   * partial write never double-records.
   */
  readonly recordRetry?: DeployRecordRetryPolicy;
}

/**
 * Bounded retry for the post-finality registry write (defect C1). `attempts` is the total
 * number of tries (≥ 1); `delayMs` is the injected wait BETWEEN tries (not after the last).
 * A finalized deploy that a transient DB blip could not record must not be silently lost, so
 * we retry a few times before surfacing the non-retriable `record-failed` terminal.
 */
export interface DeployRecordRetryPolicy {
  /** Total record attempts before giving up (≥ 1). */
  readonly attempts: number;
  /** Injected delay (ms) between attempts. */
  readonly delayMs: number;
}

/** One deploy's inputs: the project, the deploy `requestId`, and its persisted green build. */
export interface DeployInput {
  /** The project being deployed (a branded `ProjectId` is accepted; typed as `string`). */
  readonly projectId: string;
  /** The `deploy:status` correlation id (D62); also the exactly-once idempotency key. */
  readonly requestId: string;
  /** The persisted green build, or `undefined` when the project has none (FR-054). */
  readonly greenBuild: DeployArtifacts | undefined;
}

/** The phase a {@link DeployResult} `failed` occurred in (maps to the emitted phases). */
export type DeployFailurePhase = "proving" | "submitting" | "awaiting_finality";

/**
 * The fault class of a `failed` deploy, so callers can route it: `prover` (D37 proving), `node`
 * (a node-side submit rejection), `platform` (EC-38 insufficient-tDUST — the platform's fee
 * wallet, never the user), or `finality` (a finalized on-chain failure).
 */
export type DeployFault = "prover" | "node" | "platform" | "finality";

/**
 * The terminal result of a deploy — a discriminated union so callers/tests assert EXACTLY what
 * happened. `deployed` is the ONLY success (carries the branded address + the registry version).
 * `failed`, `timeout`, and `reorged` are all `retriable: true` (re-running the same `requestId`
 * re-attempts); `rejected` (no green build) needs a green build first, so it is not retriable.
 */
export type DeployResult =
  /** Finalized + recorded + announced exactly once — the branded address and registry version. */
  | {
      readonly kind: "deployed";
      readonly address: ContractDeployedPayload["address"];
      readonly version: bigint;
    }
  /** FR-054 / scenario 3 — no persisted green build; rejected before any proving or key use. */
  | { readonly kind: "rejected"; readonly reason: "no-green-build" }
  /** A loud, retriable failure at proving / submitting / finality; nothing announced. */
  | {
      readonly kind: "failed";
      readonly phase: DeployFailurePhase;
      readonly fault: DeployFault;
      readonly reason: string;
      readonly retriable: true;
    }
  /** EC-39 — finality did not settle within the bounded wait; retriable, no phantom address. */
  | { readonly kind: "timeout"; readonly waitedMs: number; readonly retriable: true }
  /** SC-029/EC-42 — the deploy reorged before finality; retriable, no address announced. */
  | { readonly kind: "reorged"; readonly retriable: true }
  /**
   * Defect C1 — the deploy FINALIZED on-chain but recording it FAILED after the bounded retry
   * ({@link DeployPipelineDeps.recordRetry}). The contract EXISTS unrecorded, so this is NOT
   * retriable: a blind retry (a fresh `requestId`) would fund a SECOND on-chain deploy (real
   * tDUST double-spend). `contract:deployed` is NOT announced; ops reconcile the on-chain
   * contract into the registry by hand from the attached `address` + `txRef`. It IS memoised
   * (BUG 2), so a re-run with the SAME `requestId` REPLAYS this terminal verbatim (no re-drive,
   * no second on-chain tx); only ops choosing a FRESH `requestId` would deliberately double-deploy.
   */
  | {
      readonly kind: "record-failed";
      readonly address: ContractDeployedPayload["address"];
      readonly txRef: string;
      readonly retriable: false;
    }
  /**
   * I1 (money-critical) — the deploy FINALIZED on-chain but the contract address could not be
   * extracted ({@link DeployFinality} `address-unavailable`). Like `record-failed`, the contract
   * EXISTS on-chain, so this is NOT retriable: a blind retry (a fresh `requestId`) would fund a
   * SECOND on-chain deploy (real tDUST double-spend). `contract:deployed` is NOT announced (there
   * is no address); ops reconcile the on-chain contract into the registry from the `txRef` + the
   * loud server log. Distinct from `record-failed` (which HAS an address) — here the address is
   * the very thing that is missing.
   */
  | {
      readonly kind: "address-unavailable";
      readonly txRef: string;
      readonly retriable: false;
    };

/** The `deployed` arm of {@link DeployResult} — memoised per `requestId` for exactly-once replay. */
type DeployedResult = Extract<DeployResult, { readonly kind: "deployed" }>;

/** The `record-failed` arm of {@link DeployResult} — a finalized-but-unrecordable deploy (C1). */
type RecordFailedResult = Extract<DeployResult, { readonly kind: "record-failed" }>;

/**
 * The TERMINAL, memoised arms of {@link DeployResult} (BUG 2) — `deployed` OR `record-failed`.
 * Both are the FINAL on-chain outcome of a `requestId` (the contract either recorded, or landed
 * on-chain but was unrecordable), so a same-`requestId` re-run REPLAYS the memoised result
 * verbatim — it never re-drives `prove`→`signAndSubmit`→`awaitFinality` (no second on-chain tx /
 * tDUST double-spend). The honestly-retriable arms (`failed`/`timeout`/`reorged`/`rejected`) are
 * deliberately NOT memoised — a same-`requestId` re-run of those genuinely re-attempts.
 */
type TerminalDeployResult = DeployedResult | RecordFailedResult;

/** The public pipeline surface. */
export interface DeployPipeline {
  /** Run one explicit deploy to a terminal {@link DeployResult}. */
  runDeploy(input: DeployInput): Promise<DeployResult>;
}

/**
 * Wire-safe, client-facing `deploy:status.detail` messages (constitution III — no internals,
 * no secrets). The `platform` message frames an EC-38 insufficient-tDUST outage as platform-
 * side ("temporarily unavailable"), NEVER "you are out of funds" (a user-blaming frame). The
 * executor's raw `reason` (a server diagnostic) is carried on the {@link DeployResult}, not
 * onto the wire.
 */
export const DEPLOY_FAILURE_DETAIL = {
  /** FR-054 — no persisted green build to deploy. */
  noGreenBuild: "no green build to deploy — compile the project first",
  /** D37 proving failed. */
  proving: "proving failed — retry",
  /** EC-38 — the platform deploy wallet could not fund the deploy (platform-side, not the user). */
  platform: "deploy temporarily unavailable (platform issue) — retry shortly",
  /** A node-side rejection of the submitted deploy. */
  node: "deploy submission rejected — retry",
  /** A finalized on-chain failure. */
  finality: "deploy failed during finality — retry",
  /** SC-029/EC-42 — reorged before finality. */
  reorged: "deploy reorged before finality — retry",
  /** EC-39 — finality did not settle within the bounded wait. */
  timeout: "finality timed out — retry",
  /**
   * Defect C1 backstop — an UNEXPECTED executor/finalize throw. A wire-safe constant, NEVER the
   * error's raw message or any key (constitution III); the raw fault goes only to the loud log.
   */
  unexpected: "deploy failed unexpectedly — retry",
  /**
   * Defect C1 — the deploy landed on-chain but recording it failed. Framed as a platform issue
   * with a DO-NOT-RETRY steer (a retry double-deploys); the diagnostic details go only to the
   * loud log + the `record-failed` result, never onto the wire.
   */
  recordingFailed:
    "deploy landed on-chain but recording it failed — support is on it; do not retry",
  /**
   * I1 — the deploy finalized on-chain but the contract address was unavailable. Framed as a
   * platform issue with a DO-NOT-RETRY steer (a retry double-deploys); the txRef + diagnostics go
   * only to the loud log + the `address-unavailable` result, never onto the wire.
   */
  addressUnavailable:
    "deploy finalized but the contract address is unavailable — support is investigating; do not retry",
} as const;

/**
 * Default bounded finality wait (ms). A PLACEHOLDER pending a real config tunable — US1 should
 * wire this from config (like the compile pipeline's `maxWaitMs`); until then the pipeline's
 * fallback keeps finality bounded so a stuck deploy always resolves to an explicit `timeout`
 * (EC-39), never a hanging spinner.
 */
export const DEFAULT_FINALITY_TIMEOUT_MS = 120_000;

/**
 * Default bounded post-finality record-retry (defect C1): 3 attempts, 250 ms apart. A few
 * quick tries ride out a transient DB blip without losing the record of a finalized deploy;
 * beyond that we stop and surface the non-retriable `record-failed` terminal (a blind retry
 * would double-deploy). US1 may wire this from config; this backs a pipeline built without it.
 */
export const DEFAULT_RECORD_RETRY: DeployRecordRetryPolicy = { attempts: 3, delayMs: 250 };

/**
 * The server-side `reason` carried on a backstop `failed` result (defect C1). A fixed
 * constant, NOT the raw error — the raw fault is logged LOUDLY (server-side) and never travels
 * on the {@link DeployResult} nor the wire (constitution III).
 */
const UNEXPECTED_REASON = "unexpected deploy fault";

/** Phase → {@link DeployFault} for the never-reject backstop (an unexpected throw in that phase). */
const FAULT_BY_PHASE: Record<DeployFailurePhase, DeployFault> = {
  proving: "prover",
  submitting: "node",
  awaiting_finality: "finality",
};

/** Exhaustiveness guard — a compile error here means a {@link DeployFinality} arm went unhandled. */
function assertNever(value: never): never {
  throw new Error(`unreachable deploy finality outcome: ${JSON.stringify(value)}`);
}

/**
 * The default structured error sink (defect C1 backstop): a single JSON line to
 * `process.stderr` (mirrors the turn coordinator + `index.ts`). `Error` values render to
 * `{ name, message, stack }` and any stray `bigint` to a decimal string, so the log line
 * itself can NEVER throw and block the client's terminal status.
 */
function defaultLogError(message: string, detail: Record<string, unknown>): void {
  const rendered: Record<string, unknown> = { level: "error", source: "deploy-pipeline", message };
  for (const [key, value] of Object.entries(detail)) {
    rendered[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  const line = JSON.stringify(rendered, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  process.stderr.write(`${line}\n`);
}

/** The default inter-attempt delay — an UNREF'd timer so a live wait never pins the process. */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Build the deploy pipeline over its injected seams. The returned `runDeploy` closes over an
 * in-process `completed` memo (keyed by `requestId`) holding BOTH terminal on-chain arms
 * ({@link TerminalDeployResult} — `deployed` OR `record-failed`, BUG 2), so a re-run of an
 * already-terminal request is a pure replay — it never re-drives the executor (no second on-chain
 * tx), never re-records, and never re-emits `contract:deployed` (exactly-once, SC-029). Durable
 * exactly-once rests on the registry's own idempotency; the memo is the fast in-process guard,
 * mirroring the deposits credit-first / flip-second belt-and-suspenders.
 */
export function createDeployPipeline(deps: DeployPipelineDeps): DeployPipeline {
  const now = deps.now ?? Date.now;
  const finalityTimeoutMs = deps.finalityTimeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS;
  const logError = deps.logError ?? defaultLogError;
  const delay = deps.delay ?? defaultDelay;
  const recordRetry = deps.recordRetry ?? DEFAULT_RECORD_RETRY;
  const completed = new Map<string, TerminalDeployResult>();

  /**
   * Emit one `deploy:status` through the sink, omitting `detail` when absent
   * (exactOptionalPropertyTypes). BUG 3: the sink is GUARDED — a THROWING `deps.emit` (a dead /
   * misbehaving socket) is swallowed + logged LOUDLY, NEVER propagated, so the pipeline's
   * never-reject guarantee never depends on the caller's sink being throw-safe (a thrown emit
   * must not turn a deploy — recorded or not — into an unhandled rejection).
   */
  function emitStatus(requestId: string, phase: DeployStatusPhase, detail?: string): void {
    const payload: DeployStatusPayload =
      detail === undefined ? { requestId, phase } : { requestId, phase, detail };
    try {
      deps.emit(payload);
    } catch (error) {
      logError(
        "deploy:status emit failed (dead/throwing sink) — swallowed so runDeploy never rejects",
        { requestId, phase, error },
      );
    }
  }

  /**
   * Emit `contract:deployed` through the sink, GUARDED (BUG 3) — the last remaining raw
   * `deps.emitContractDeployed` call, routed through the same swallow-and-log discipline as
   * {@link emitStatus}. A dead / throwing sink must NOT turn a RECORDED + memoised deploy into a
   * failure: the deploy is done, so we log LOUDLY and move on (mirrors the coordinator's guarded
   * outbound emit). No emit can reject `runDeploy`.
   */
  function safeEmitContractDeployed(
    input: DeployInput,
    address: ContractDeployedPayload["address"],
  ): void {
    try {
      deps.emitContractDeployed({ address });
    } catch (error) {
      logError("contract:deployed emit failed (dead socket?) — the deploy IS recorded + memoised", {
        projectId: input.projectId,
        requestId: input.requestId,
        address,
        error,
      });
    }
  }

  /**
   * Record the finalized deploy with a BOUNDED retry (defect C1) so a transient DB blip does
   * not lose the record of a deploy that already landed on-chain. `recordDeploy` is idempotent
   * by `tx_ref`, so a retry after a partial write returns the already-recorded row rather than
   * double-recording. Each failed attempt is logged LOUDLY. Returns the row on success, or
   * `null` when every attempt failed (the caller surfaces the non-retriable `record-failed`).
   */
  async function recordWithRetry(
    input: DeployInput,
    address: ContractDeployedPayload["address"],
    txRef: string,
  ): Promise<DeployRegistryRow | null> {
    for (let attempt = 1; attempt <= recordRetry.attempts; attempt += 1) {
      try {
        return await deps.registry.recordDeploy(input.projectId, address, txRef);
      } catch (error) {
        logError(
          "recordDeploy failed after finality — the deploy is FINALIZED on-chain; retrying (idempotent by tx_ref)",
          { projectId: input.projectId, requestId: input.requestId, txRef, attempt, error },
        );
        if (attempt < recordRetry.attempts) {
          await delay(recordRetry.delayMs);
        }
      }
    }
    return null;
  }

  /**
   * The finalized path: brand + validate the address (so a malformed one never becomes a
   * phantom `contract:deployed`), record the deploy under a bounded retry, set the replay memo
   * BEFORE announcing (so a re-entrant same-request retry replays instead of double-submitting,
   * defect C1), THEN emit `contract:deployed` exactly once. If the record is ultimately
   * unrecordable, announce NOTHING and surface the non-retriable `record-failed` — which is ALSO
   * memoised (BUG 2), so a same-`requestId` re-run replays it instead of re-driving a SECOND
   * on-chain deploy (the contract exists on-chain — only a fresh `requestId` double-deploys; ops
   * reconcile).
   */
  async function finalize(
    input: DeployInput,
    address: string,
    txRef: string,
  ): Promise<TerminalDeployResult> {
    const branded = ContractAddressSchema.parse(address);
    const row = await recordWithRetry(input, branded, txRef);
    if (row === null) {
      // Finalized on-chain but unrecordable after the bounded retry (defect C1). Do NOT retry
      // (a blind retry double-deploys). Announce nothing; log LOUDLY; give a terminal status.
      logError(
        "deploy FINALIZED on-chain but recording FAILED after the bounded retry — ops must reconcile (do NOT retry: a retry would double-deploy)",
        { projectId: input.projectId, requestId: input.requestId, address: branded, txRef },
      );
      emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.recordingFailed);
      // BUG 2: memoise the `record-failed` terminal too. `requestId` is the exactly-once
      // idempotency key, so a same-`requestId` re-run must REPLAY this terminal — NOT re-drive
      // prove→signAndSubmit→awaitFinality (which would fund a SECOND on-chain tx). Only a fresh
      // `requestId` deliberately double-deploys (ops' explicit reconcile choice).
      const recordFailed: RecordFailedResult = {
        kind: "record-failed",
        address: branded,
        txRef,
        retriable: false,
      };
      completed.set(input.requestId, recordFailed);
      return recordFailed;
    }
    // Memo BEFORE announce (defect C1, fix-part-3): a re-entrant retry for the same requestId
    // now replays this result instead of re-submitting. The registry's own tx_ref idempotency
    // is the durable belt; the memo is the fast in-process guard.
    const result: DeployedResult = { kind: "deployed", address: branded, version: row.version };
    completed.set(input.requestId, result);
    // Announce exactly once, through the guarded sink (BUG 3): a dead-socket emit must NOT turn a
    // RECORDED deploy into a failure — the deploy is done + memoised.
    safeEmitContractDeployed(input, branded);
    return result;
  }

  /**
   * The never-reject backstop (defect C1): an UNEXPECTED throw from the executor seam or from
   * `finalize` (the executor is documented to return DATA, but the real adapter can throw) is
   * logged LOUDLY, given a terminal wire-safe `failed` status, and resolved to a retriable
   * `failed` result — so `runDeploy` never rejects and the client never hangs (EC-39). The raw
   * error goes ONLY to the log, never onto the wire nor the result (constitution III).
   */
  function unexpectedFailure(
    input: DeployInput,
    phase: DeployFailurePhase,
    error: unknown,
  ): DeployResult {
    logError(
      "deploy failed UNEXPECTEDLY (executor/finalize threw) — emitting a terminal failed status so the client never hangs (EC-39)",
      { projectId: input.projectId, requestId: input.requestId, phase, error },
    );
    emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.unexpected);
    return {
      kind: "failed",
      phase,
      fault: FAULT_BY_PHASE[phase],
      reason: UNEXPECTED_REASON,
      retriable: true,
    };
  }

  async function runDeploy(input: DeployInput): Promise<DeployResult> {
    // Exactly-once replay (SC-029 + BUG 2): a `requestId` that already reached a TERMINAL on-chain
    // outcome — `deployed` OR `record-failed` — returns its memoised result with NO re-drive of the
    // executor (no second on-chain tx), NO re-record, and NO re-emit, even if runDeploy is
    // re-entered. Only the retriable arms are not memoised, so those genuinely re-attempt.
    const prior = completed.get(input.requestId);
    if (prior !== undefined) {
      return prior;
    }

    // 1. validating — a persisted green build is the deploy precondition (FR-054). No key,
    // no proving yet: a missing build rejects here, before the executor is ever touched.
    emitStatus(input.requestId, "validating");
    const greenBuild = input.greenBuild;
    if (greenBuild === undefined) {
      emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.noGreenBuild);
      return { kind: "rejected", reason: "no-green-build" };
    }

    // The executor-driving + finalize region is wrapped in the never-reject backstop (defect
    // C1): the executor is DOCUMENTED to return DATA, but the real (owner-gated) adapter and a
    // registry-write fault CAN throw — a throw here becomes a loud log + terminal failed status
    // + retriable failed result via `unexpectedFailure`, so `runDeploy` RESOLVES on every path
    // (never a hanging spinner, EC-39). `phase` tracks where we are so the backstop tags the
    // fault; the designed DATA failures below still return their specific results directly.
    let phase: DeployFailurePhase = "proving";
    try {
      // 2. proving — server-side over the D37 mesh. A proving failure is loud + retriable and
      // announces nothing (scenario 5).
      emitStatus(input.requestId, "proving");
      const proveOutcome = await deps.executor.prove(greenBuild);
      if (proveOutcome.outcome === "failed") {
        emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.proving);
        return {
          kind: "failed",
          phase: "proving",
          fault: "prover",
          reason: proveOutcome.reason,
          retriable: true,
        };
      }

      // 3. submitting — orchestrator-direct sign with the deploy key (D50) + node submit. An
      // insufficient-tDUST rejection is a PLATFORM fault (EC-38), surfaced as such; any other
      // node rejection is a node fault. Both are loud + retriable and announce nothing.
      phase = "submitting";
      emitStatus(input.requestId, "submitting");
      const submitOutcome = await deps.executor.signAndSubmit(proveOutcome.proof);
      if (submitOutcome.outcome === "rejected") {
        // Both EC-38 (insufficient-tDUST) and a submit-PATH `unavailable` fault (I2 — an unwired
        // adapter or an unexpected adapter fault) are PLATFORM issues framed as such; only a real
        // node `rejected` cause is a node fault. So `unavailable` never impersonates a node
        // rejection on the wire.
        const platform =
          submitOutcome.cause === "insufficient-tdust" || submitOutcome.cause === "unavailable";
        emitStatus(
          input.requestId,
          "failed",
          platform ? DEPLOY_FAILURE_DETAIL.platform : DEPLOY_FAILURE_DETAIL.node,
        );
        return {
          kind: "failed",
          phase: "submitting",
          fault: platform ? "platform" : "node",
          reason: submitOutcome.reason,
          retriable: true,
        };
      }

      // 4. awaiting_finality — gate contract:deployed on finality (FR-055/SC-029). ONLY a
      // `finalized` outcome records + announces; everything else is a retriable failure with no
      // address. The wait is bounded so it always resolves (EC-39).
      phase = "awaiting_finality";
      emitStatus(input.requestId, "awaiting_finality");
      const startedAt = now();
      const finality = await deps.executor.awaitFinality({
        txRef: submitOutcome.txRef,
        timeoutMs: finalityTimeoutMs,
      });
      switch (finality.outcome) {
        case "finalized":
          return await finalize(input, finality.address, submitOutcome.txRef);
        case "reorged":
          // SC-029/EC-42 — NO address emitted, nothing recorded; retriable.
          emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.reorged);
          return { kind: "reorged", retriable: true };
        case "timeout": {
          // EC-39 — explicit pending-then-timeout; never a phantom address or a hanging spinner.
          const waitedMs = now() - startedAt;
          emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.timeout);
          return { kind: "timeout", waitedMs, retriable: true };
        }
        case "failed":
          // A finalized on-chain failure — loud + retriable, nothing announced.
          emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.finality);
          return {
            kind: "failed",
            phase: "awaiting_finality",
            fault: "finality",
            reason: finality.reason,
            retriable: true,
          };
        case "address-unavailable":
          // I1 (money-critical) — the tx FINALIZED on-chain but the executor could not extract the
          // contract address. Do NOT retry (a retry double-deploys — the tx is finalized). Announce
          // nothing (there is no address); log LOUDLY (ops reconcile from the txRef); give a
          // terminal, NON-retriable status.
          logError(
            "deploy FINALIZED on-chain but the contract address was UNAVAILABLE — ops must reconcile (do NOT retry: a retry would double-deploy)",
            {
              projectId: input.projectId,
              requestId: input.requestId,
              txRef: submitOutcome.txRef,
            },
          );
          emitStatus(input.requestId, "failed", DEPLOY_FAILURE_DETAIL.addressUnavailable);
          return { kind: "address-unavailable", txRef: submitOutcome.txRef, retriable: false };
        default:
          return assertNever(finality);
      }
    } catch (error) {
      // Never-reject backstop: an UNEXPECTED executor/finalize throw (NOT a designed DATA
      // failure, and NOT the recordDeploy exhaustion — `finalize` returns `record-failed` for
      // that without throwing). Resolve to a terminal failed result.
      return unexpectedFailure(input, phase, error);
    }
  }

  return { runDeploy };
}
