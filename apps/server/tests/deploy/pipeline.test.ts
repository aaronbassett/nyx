/**
 * Deploy pipeline tests (T156 pipeline portion, US8) — deterministic, in-memory, NO
 * chain, NO prover, NO deploy key. These drive {@link createDeployPipeline} through the
 * narrow {@link DeployExecutor} + {@link DeployRegistrySeam} seams to pin the deploy state
 * machine + finality-gated exactly-once semantics US8 depends on (FR-054/055/056, D50/D37,
 * SC-029/030, EC-38/39/42):
 *
 *  - the HAPPY path streams `deploy:status` phases in order
 *    (validating → proving → submitting → awaiting_finality) and, ONLY on a finalized
 *    finality, records the deploy ONCE and emits `contract:deployed { address }` EXACTLY
 *    once (FR-055/SC-029);
 *  - SC-029 / EC-42 — a REORGED finality emits NO `contract:deployed`, records nothing, and
 *    surfaces a retriable `reorged` (no phantom address); a RE-RUN of an already-deployed
 *    requestId is a pure replay — it does NOT double-emit or double-record;
 *  - FR-054 / scenario 3 — no green build ⇒ `rejected` BEFORE any proving or key use;
 *  - scenario 5 — a proving failure ⇒ a retriable `failed`, no `contract:deployed`;
 *  - EC-38 — an insufficient-tDUST node rejection is surfaced as a PLATFORM fault (never a
 *    user error), with a platform-framed client detail;
 *  - EC-39 — a finality timeout is an EXPLICIT, retriable `timeout` (never a phantom address
 *    or a hanging spinner), its `waitedMs` measured against the INJECTED clock.
 *
 * The executor + registry are Nyx-internal seams (constitution I) — deliberately NOT any
 * `@midnight-ntwrk/*` SDK type. Everything is deterministic: outcomes come from the injected
 * executor, timestamps from the injected clock, and every emission from a recording sink.
 */
import { describe, expect, it } from "vitest";
import { DeployRegistryRowSchema } from "@nyx/protocol";
import type { ContractDeployedPayload, DeployStatusPayload } from "@nyx/protocol";
import {
  createDeployPipeline,
  DEFAULT_FINALITY_TIMEOUT_MS,
  DEPLOY_FAILURE_DETAIL,
} from "../../src/deploy/pipeline.js";
import type {
  DeployArtifacts,
  DeployExecutor,
  DeployFinality,
  DeployInput,
  DeployPipelineDeps,
  DeployProof,
  DeployRecordRetryPolicy,
  DeployRegistrySeam,
  DeployResult,
  FinalityRequest,
  ProveOutcome,
  SubmitOutcome,
} from "../../src/deploy/pipeline.js";

// --- Fixtures ---------------------------------------------------------------

const PROJECT_ID = "proj-1";
const REQUEST_ID = "req-1";
const TX_REF = "tx-ref-1";
const ADDRESS = "contract-addr-1";
const PROOF: DeployProof = { bytes: Uint8Array.of(1, 2, 3) };
const GREEN_BUILD: DeployArtifacts = {
  urlPrefix: "https://r2.nyx.test/proj-1/abc123",
  compilerVersion: "0.24.0",
};

/** A deploy input with the given green build (or `undefined` for the no-build case). */
function inputWith(greenBuild: DeployArtifacts | undefined, requestId = REQUEST_ID): DeployInput {
  return { projectId: PROJECT_ID, requestId, greenBuild };
}

/** A recorded `registry.recordDeploy` call. */
interface RecordedRecordDeploy {
  readonly projectId: string;
  readonly address: string;
  readonly txRef: string;
}

/** A recorded `logError` call (the loud defect-C1 backstop log). */
interface LoggedError {
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

/** A wired pipeline + its recording seams (all outcomes injected, all clocks injected). */
interface Harness {
  readonly deps: DeployPipelineDeps;
  readonly statuses: DeployStatusPayload[];
  readonly deployed: ContractDeployedPayload[];
  readonly registryCalls: RecordedRecordDeploy[];
  readonly executorCalls: {
    readonly prove: DeployArtifacts[];
    readonly submit: DeployProof[];
    readonly finality: FinalityRequest[];
  };
  /** Every loud backstop log (defect C1) — asserted in the throw/record-failure tests. */
  readonly logs: LoggedError[];
  /** The ms handed to the injected record-retry delay (immediate in tests; proves retries). */
  readonly delays: number[];
  /** Total `recordDeploy` attempts (success + failed), for the bounded-retry assertions. */
  readonly recordAttempts: () => number;
}

/**
 * Build a fully deterministic harness. Each executor step returns the injected outcome
 * (defaulting to the green happy-path: proved → submitted → finalized) and records its
 * input; the registry stamps a monotonic `version` from the real {@link DeployRegistryRowSchema}
 * parse (so a returned row is byte-for-byte the branded shape the Postgres store maps back).
 */
function makeHarness(
  opts: {
    prove?: ProveOutcome;
    submit?: SubmitOutcome;
    finality?: DeployFinality;
    now?: () => number;
    finalityTimeoutMs?: number;
    /** Make the named executor step REJECT (the seam is documented as DATA, but real adapters throw). */
    throwAt?: "prove" | "signAndSubmit" | "awaitFinality";
    /** The error the `throwAt` step rejects with (default: a recognizable Error). */
    throwError?: Error;
    /** Reject the first N `recordDeploy` attempts, then succeed (a transient DB blip). */
    recordFailFirst?: number;
    /** The error a failing `recordDeploy` attempt rejects with (default: a recognizable Error). */
    recordError?: Error;
    /** Override the bounded record-retry policy (tests keep it small; delay is immediate). */
    recordRetry?: DeployRecordRetryPolicy;
  } = {},
): Harness {
  const statuses: DeployStatusPayload[] = [];
  const deployed: ContractDeployedPayload[] = [];
  const registryCalls: RecordedRecordDeploy[] = [];
  const logs: LoggedError[] = [];
  const delays: number[] = [];
  let recordAttempts = 0;
  const executorCalls = {
    prove: [] as DeployArtifacts[],
    submit: [] as DeployProof[],
    finality: [] as FinalityRequest[],
  };

  const proveOutcome: ProveOutcome = opts.prove ?? { outcome: "proved", proof: PROOF };
  const submitOutcome: SubmitOutcome = opts.submit ?? { outcome: "submitted", txRef: TX_REF };
  const finalityOutcome: DeployFinality = opts.finality ?? {
    outcome: "finalized",
    address: ADDRESS,
  };

  const executor: DeployExecutor = {
    prove(artifacts) {
      executorCalls.prove.push(artifacts);
      return opts.throwAt === "prove"
        ? Promise.reject(opts.throwError ?? new Error("prove threw"))
        : Promise.resolve(proveOutcome);
    },
    signAndSubmit(proof) {
      executorCalls.submit.push(proof);
      return opts.throwAt === "signAndSubmit"
        ? Promise.reject(opts.throwError ?? new Error("signAndSubmit threw"))
        : Promise.resolve(submitOutcome);
    },
    awaitFinality(request) {
      executorCalls.finality.push(request);
      return opts.throwAt === "awaitFinality"
        ? Promise.reject(opts.throwError ?? new Error("awaitFinality threw"))
        : Promise.resolve(finalityOutcome);
    },
  };

  const registry: DeployRegistrySeam = {
    recordDeploy(projectId, address, txRef) {
      recordAttempts += 1;
      if (opts.recordFailFirst !== undefined && recordAttempts <= opts.recordFailFirst) {
        return Promise.reject(opts.recordError ?? new Error("recordDeploy db blip"));
      }
      registryCalls.push({ projectId, address, txRef });
      const version = BigInt(registryCalls.length);
      return Promise.resolve(
        DeployRegistryRowSchema.parse({
          projectId,
          address,
          version: version.toString(),
          status: "active",
          deployedAt: 1_000,
          txRef,
        }),
      );
    },
  };

  const deps: DeployPipelineDeps = {
    executor,
    registry,
    emit: (status) => {
      statuses.push(status);
    },
    emitContractDeployed: (payload) => {
      deployed.push(payload);
    },
    logError: (message, detail) => {
      logs.push({ message, detail });
    },
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.finalityTimeoutMs === undefined ? {} : { finalityTimeoutMs: opts.finalityTimeoutMs }),
    ...(opts.recordRetry === undefined ? {} : { recordRetry: opts.recordRetry }),
  };

  return {
    deps,
    statuses,
    deployed,
    registryCalls,
    executorCalls,
    logs,
    delays,
    recordAttempts: () => recordAttempts,
  };
}

/** The ordered `deploy:status` phases a run streamed. */
function phasesOf(h: Harness): string[] {
  return h.statuses.map((status) => status.phase);
}

// --- Tests ------------------------------------------------------------------

describe("createDeployPipeline", () => {
  it("streams the four phases in order, records once, and emits contract:deployed exactly once (happy path)", async () => {
    const h = makeHarness();
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(phasesOf(h)).toEqual(["validating", "proving", "submitting", "awaiting_finality"]);
    expect(h.statuses.every((status) => status.requestId === REQUEST_ID)).toBe(true);
    expect(h.deployed).toHaveLength(1);
    expect(h.deployed[0]?.address).toBe(ADDRESS);
    expect(h.registryCalls).toEqual([{ projectId: PROJECT_ID, address: ADDRESS, txRef: TX_REF }]);
    expect(result).toEqual({ kind: "deployed", address: ADDRESS, version: 1n });
    // The executor received the exact green build + the finality bound.
    expect(h.executorCalls.prove).toEqual([GREEN_BUILD]);
    expect(h.executorCalls.submit).toEqual([PROOF]);
    expect(h.executorCalls.finality).toEqual([
      { txRef: TX_REF, timeoutMs: DEFAULT_FINALITY_TIMEOUT_MS },
    ]);
  });

  it("SC-029/EC-42: a reorged finality emits NO contract:deployed and records nothing (retriable)", async () => {
    const h = makeHarness({ finality: { outcome: "reorged" } });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(result).toEqual({ kind: "reorged", retriable: true });
    expect(phasesOf(h)).toEqual([
      "validating",
      "proving",
      "submitting",
      "awaiting_finality",
      "failed",
    ]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.reorged);
  });

  it("SC-029: a re-run for the same requestId after success does not double-emit or double-record", async () => {
    const h = makeHarness();
    const pipeline = createDeployPipeline(h.deps);

    const first = await pipeline.runDeploy(inputWith(GREEN_BUILD));
    const statusesAfterFirst = h.statuses.length;

    const second = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(second).toEqual(first);
    expect(h.deployed).toHaveLength(1); // not 2
    expect(h.registryCalls).toHaveLength(1); // not 2
    expect(h.statuses).toHaveLength(statusesAfterFirst); // a replay streams no new status
  });

  it("rejects with no-green-build before any proving or key use (scenario 3, FR-054)", async () => {
    const h = makeHarness();
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(undefined));

    expect(result).toEqual({ kind: "rejected", reason: "no-green-build" });
    expect(h.executorCalls.prove).toHaveLength(0);
    expect(h.executorCalls.submit).toHaveLength(0);
    expect(h.executorCalls.finality).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(h.deployed).toHaveLength(0);
    expect(phasesOf(h)).toEqual(["validating", "failed"]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.noGreenBuild);
  });

  it("surfaces a proving failure as a retriable failure with no contract:deployed (scenario 5)", async () => {
    const h = makeHarness({ prove: { outcome: "failed", reason: "prover exploded" } });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "proving",
      fault: "prover",
      reason: "prover exploded",
      retriable: true,
    });
    expect(h.executorCalls.submit).toHaveLength(0);
    expect(h.executorCalls.finality).toHaveLength(0);
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(phasesOf(h)).toEqual(["validating", "proving", "failed"]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.proving);
  });

  it("EC-38: an insufficient-tDUST rejection is surfaced as a PLATFORM fault, not a user error", async () => {
    const h = makeHarness({
      submit: { outcome: "rejected", cause: "insufficient-tdust", reason: "deploy wallet dry" },
    });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "submitting",
      fault: "platform",
      reason: "deploy wallet dry",
      retriable: true,
    });
    expect(h.executorCalls.finality).toHaveLength(0);
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    // The client-facing detail frames it as platform-side (EC-38), never "you are out of funds".
    expect(h.statuses.at(-1)).toMatchObject({
      phase: "failed",
      detail: DEPLOY_FAILURE_DETAIL.platform,
    });
  });

  it("surfaces a generic node rejection as a retriable node fault", async () => {
    const h = makeHarness({
      submit: { outcome: "rejected", cause: "rejected", reason: "bad nonce" },
    });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "submitting",
      fault: "node",
      reason: "bad nonce",
      retriable: true,
    });
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.node);
  });

  it("EC-39: a finality timeout is explicit, retriable, and never a phantom address", async () => {
    const times = [1_000, 4_500];
    const now = (): number => times.shift() ?? 4_500;
    const h = makeHarness({ finality: { outcome: "timeout" }, now, finalityTimeoutMs: 5_000 });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({ kind: "timeout", waitedMs: 3_500, retriable: true });
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(h.executorCalls.finality).toEqual([{ txRef: TX_REF, timeoutMs: 5_000 }]);
    expect(phasesOf(h)).toEqual([
      "validating",
      "proving",
      "submitting",
      "awaiting_finality",
      "failed",
    ]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.timeout);
  });

  it("surfaces a finalized FAILURE as a loud retriable failure with no contract:deployed", async () => {
    const h = makeHarness({ finality: { outcome: "failed", reason: "execution reverted" } });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "awaiting_finality",
      fault: "finality",
      reason: "execution reverted",
      retriable: true,
    });
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.finality);
  });

  it("constitution III: emitted payloads carry only wire-safe fields (no deploy key)", async () => {
    const h = makeHarness();
    const pipeline = createDeployPipeline(h.deps);

    await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(Object.keys(h.deployed[0] ?? {})).toEqual(["address"]);
    for (const status of h.statuses) {
      expect(Object.keys(status).sort()).toEqual(
        status.detail === undefined ? ["phase", "requestId"] : ["detail", "phase", "requestId"],
      );
    }
  });

  it("deploys distinct requestIds independently, stamping the registry version from recordDeploy", async () => {
    const h = makeHarness();
    const pipeline = createDeployPipeline(h.deps);

    const a = await pipeline.runDeploy(inputWith(GREEN_BUILD, "req-a"));
    const b = await pipeline.runDeploy(inputWith(GREEN_BUILD, "req-b"));

    expect(a).toMatchObject({ kind: "deployed", version: 1n });
    expect(b).toMatchObject({ kind: "deployed", version: 2n });
    expect(h.deployed).toHaveLength(2);
    expect(h.registryCalls).toHaveLength(2);
  });

  // --- Defect C1: never-reject backstop + record resilience -------------------

  it("C1: a THROWING prove resolves to a terminal failed (never rejects), announces nothing, logs loudly", async () => {
    const boom = new Error("prover process crashed");
    const h = makeHarness({ throwAt: "prove", throwError: boom });
    const pipeline = createDeployPipeline(h.deps);

    // runDeploy RESOLVES (never rejects) even though the executor threw.
    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "proving",
      fault: "prover",
      reason: "unexpected deploy fault",
      retriable: true,
    });
    expect(h.deployed).toHaveLength(0); // nothing announced
    expect(h.registryCalls).toHaveLength(0); // nothing recorded
    expect(phasesOf(h)).toEqual(["validating", "proving", "failed"]);
    // Wire-safe terminal detail; the raw error is logged LOUDLY but NEVER leaks onto the wire.
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.unexpected);
    expect(h.statuses.every((status) => status.detail !== boom.message)).toBe(true);
    expect(h.logs.some((entry) => entry.detail.error === boom)).toBe(true);
  });

  it("C1: a THROWING signAndSubmit resolves to a terminal failed (never rejects), announces nothing", async () => {
    const boom = new Error("node RPC exploded");
    const h = makeHarness({ throwAt: "signAndSubmit", throwError: boom });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "submitting",
      fault: "node",
      reason: "unexpected deploy fault",
      retriable: true,
    });
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(phasesOf(h)).toEqual(["validating", "proving", "submitting", "failed"]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.unexpected);
    expect(h.logs.some((entry) => entry.detail.error === boom)).toBe(true);
  });

  it("C1: a THROWING awaitFinality resolves to a terminal failed (never rejects), announces nothing", async () => {
    const boom = new Error("indexer stream died");
    const h = makeHarness({ throwAt: "awaitFinality", throwError: boom });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "awaiting_finality",
      fault: "finality",
      reason: "unexpected deploy fault",
      retriable: true,
    });
    expect(h.deployed).toHaveLength(0);
    expect(h.registryCalls).toHaveLength(0);
    expect(phasesOf(h)).toEqual([
      "validating",
      "proving",
      "submitting",
      "awaiting_finality",
      "failed",
    ]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.unexpected);
    expect(h.logs.some((entry) => entry.detail.error === boom)).toBe(true);
  });

  it("C1: bounded-retries a THROWING recordDeploy after finality, then records + announces exactly once", async () => {
    // The DB blips on the first two attempts; the third succeeds. recordDeploy is idempotent by
    // tx_ref, so a retry after a partial write is safe — the finalized deploy still lands.
    const h = makeHarness({ recordFailFirst: 2, recordRetry: { attempts: 3, delayMs: 250 } });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({ kind: "deployed", address: ADDRESS, version: 1n });
    expect(h.recordAttempts()).toBe(3); // 2 failed + 1 success
    expect(h.delays).toEqual([250, 250]); // one wait between each retry, none after the success
    expect(h.registryCalls).toHaveLength(1); // exactly one successful record
    expect(h.deployed).toHaveLength(1); // announced exactly once
    expect(h.deployed[0]?.address).toBe(ADDRESS);
    // Each failed attempt is logged LOUDLY (the deploy is finalized on-chain).
    expect(h.logs.length).toBeGreaterThanOrEqual(2);
  });

  it("C1: an ALWAYS-throwing recordDeploy after finality surfaces a NON-retriable record-failed, announces nothing, logs loudly, never rejects", async () => {
    const h = makeHarness({ recordFailFirst: 99, recordRetry: { attempts: 3, delayMs: 250 } });
    const pipeline = createDeployPipeline(h.deps);

    // runDeploy RESOLVES (no unhandled rejection) even though recordDeploy keeps throwing.
    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "record-failed",
      address: ADDRESS,
      txRef: TX_REF,
      retriable: false,
    });
    expect(h.recordAttempts()).toBe(3); // exhausted the bounded retry
    expect(h.deployed).toHaveLength(0); // NEVER announced without a successful record
    expect(h.registryCalls).toHaveLength(0); // no successful record
    // Terminal failed status with the wire-safe "landed on-chain but recording failed" detail.
    expect(h.statuses.at(-1)).toMatchObject({
      phase: "failed",
      detail: DEPLOY_FAILURE_DETAIL.recordingFailed,
    });
    // Loud log naming the unrecordable-but-finalized deploy (address + txRef → ops reconcile).
    expect(
      h.logs.some((entry) => entry.detail.address === ADDRESS && entry.detail.txRef === TX_REF),
    ).toBe(true);
  });

  it("C1 fix-part-3: sets the completed memo BEFORE emitting contract:deployed (a re-entrant same-request retry replays, never re-submits)", async () => {
    const h = makeHarness();
    let reentrant: Promise<DeployResult> | undefined;
    // Re-enter runDeploy for the SAME requestId from INSIDE the emit sink. With the memo set
    // BEFORE the emit (the fix), the re-entrant call replays the memoised result and does NOT
    // re-record/re-announce; were it set AFTER, the re-entrant call would run a SECOND deploy.
    const pipeline = createDeployPipeline({
      ...h.deps,
      emitContractDeployed: (payload) => {
        h.deployed.push(payload);
        reentrant ??= pipeline.runDeploy(inputWith(GREEN_BUILD));
      },
    });

    const first = await pipeline.runDeploy(inputWith(GREEN_BUILD));
    expect(reentrant).toBeDefined();
    const replay = await reentrant;

    expect(first).toEqual({ kind: "deployed", address: ADDRESS, version: 1n });
    expect(replay).toEqual(first); // replayed the memo, not a fresh deploy
    expect(h.registryCalls).toHaveLength(1); // NOT re-recorded
    expect(h.deployed).toHaveLength(1); // NOT re-announced
  });

  // --- BUG 2: record-failed is memoised (a same-requestId re-run replays, never re-drives) ------

  it("BUG 2: a same-requestId re-run after record-failed REPLAYS record-failed — the executor is NOT re-driven (no second on-chain tx)", async () => {
    // recordDeploy always throws ⇒ the first run FINALIZES on-chain but exhausts the record retry,
    // reaching the non-retriable `record-failed` terminal.
    const h = makeHarness({ recordFailFirst: 99, recordRetry: { attempts: 3, delayMs: 250 } });
    const pipeline = createDeployPipeline(h.deps);

    const first = await pipeline.runDeploy(inputWith(GREEN_BUILD));
    expect(first).toEqual({
      kind: "record-failed",
      address: ADDRESS,
      txRef: TX_REF,
      retriable: false,
    });
    // The first run drove the executor EXACTLY once through prove → submit → finality.
    expect(h.executorCalls.prove).toHaveLength(1);
    expect(h.executorCalls.submit).toHaveLength(1);
    expect(h.executorCalls.finality).toHaveLength(1);
    const statusesAfterFirst = h.statuses.length;
    const recordAttemptsAfterFirst = h.recordAttempts();

    // A re-run with the SAME requestId REPLAYS the memoised record-failed: the executor call counts
    // do NOT increase (no second prove/submit/finality → no second on-chain tx), no new record
    // attempt, nothing announced, and no new status is streamed.
    const replay = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(replay).toEqual(first);
    expect(h.executorCalls.prove).toHaveLength(1); // NOT re-driven
    expect(h.executorCalls.submit).toHaveLength(1); // NOT re-driven
    expect(h.executorCalls.finality).toHaveLength(1); // NOT re-driven
    expect(h.recordAttempts()).toBe(recordAttemptsAfterFirst); // no re-record
    expect(h.deployed).toHaveLength(0); // still nothing announced
    expect(h.statuses).toHaveLength(statusesAfterFirst); // a replay streams no new status
  });

  // --- BUG 3: a throwing emit sink can never turn a deploy into an unhandled rejection ----------

  it("BUG 3: a THROWING deploy:status emit never rejects runDeploy — it is logged and swallowed", async () => {
    const h = makeHarness();
    const boom = new Error("dead socket on deploy:status emit");
    // Every `deploy:status` emit throws — but the SEPARATE contract:deployed sink is healthy.
    const pipeline = createDeployPipeline({
      ...h.deps,
      emit: () => {
        throw boom;
      },
    });

    // runDeploy RESOLVES to the happy `deployed` (recorded + announced) despite every status emit
    // throwing; each throw is logged, never propagated.
    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({ kind: "deployed", address: ADDRESS, version: 1n });
    expect(h.deployed).toHaveLength(1); // contract:deployed still announced
    expect(h.registryCalls).toHaveLength(1); // still recorded exactly once
    expect(h.logs.some((entry) => entry.detail.error === boom)).toBe(true);
  });

  it("BUG 3: a THROWING emit on the no-green-build path still resolves (rejected), logged not propagated", async () => {
    const h = makeHarness();
    const boom = new Error("dead socket on emit");
    const pipeline = createDeployPipeline({
      ...h.deps,
      emit: () => {
        throw boom;
      },
    });

    // Both the `validating` emit AND the no-green-build `failed` emit throw, yet runDeploy resolves
    // to the DESIGNED `rejected` result rather than rejecting — the pipeline's never-reject
    // guarantee does not depend on the sink being throw-safe.
    const result = await pipeline.runDeploy(inputWith(undefined));

    expect(result).toEqual({ kind: "rejected", reason: "no-green-build" });
    expect(h.executorCalls.prove).toHaveLength(0);
    expect(h.logs.some((entry) => entry.detail.error === boom)).toBe(true);
  });

  // --- I1: a finalized-but-no-address finality is a NON-retriable terminal ----------------------

  it("I1: an address-unavailable finality surfaces a NON-retriable address-unavailable, announces nothing, logs loudly, never rejects", async () => {
    const h = makeHarness({ finality: { outcome: "address-unavailable" } });
    const pipeline = createDeployPipeline(h.deps);

    // runDeploy RESOLVES (never rejects) — the tx is finalized on-chain but the address is missing.
    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({ kind: "address-unavailable", txRef: TX_REF, retriable: false });
    expect(h.deployed).toHaveLength(0); // no address → nothing announced
    expect(h.registryCalls).toHaveLength(0); // nothing recorded
    expect(phasesOf(h)).toEqual([
      "validating",
      "proving",
      "submitting",
      "awaiting_finality",
      "failed",
    ]);
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.addressUnavailable);
    // Loud log naming the finalized-but-unrecordable deploy by txRef (ops reconcile).
    expect(h.logs.some((entry) => entry.detail.txRef === TX_REF)).toBe(true);
  });

  // --- I2: a submit `unavailable` cause is a PLATFORM fault, never a node rejection --------------

  it("I2: a submit `unavailable` (adapter-not-wired) rejection is a PLATFORM fault, never impersonating a node rejection", async () => {
    const h = makeHarness({
      submit: { outcome: "rejected", cause: "unavailable", reason: "adapter not wired" },
    });
    const pipeline = createDeployPipeline(h.deps);

    const result = await pipeline.runDeploy(inputWith(GREEN_BUILD));

    expect(result).toEqual({
      kind: "failed",
      phase: "submitting",
      fault: "platform",
      reason: "adapter not wired",
      retriable: true,
    });
    expect(h.executorCalls.finality).toHaveLength(0);
    expect(h.deployed).toHaveLength(0);
    // The wire detail is the platform frame — NOT "deploy submission rejected" (no node impersonation).
    expect(h.statuses.at(-1)?.detail).toBe(DEPLOY_FAILURE_DETAIL.platform);
    expect(h.statuses.at(-1)?.detail).not.toBe(DEPLOY_FAILURE_DETAIL.node);
  });
});
