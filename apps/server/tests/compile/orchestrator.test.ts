/**
 * Artifact orchestrator tests (T066) — deterministic, mocked client + R2 fetch, NO
 * real Compile Service and NO real R2.
 *
 * These drive {@link ArtifactOrchestrator} directly (no HTTP) to pin the US2
 * pipeline decisions Nyx owns:
 *  - EC-11 / scenario 9 — a frontend-only turn skips the service and never announces;
 *  - scenario 1 — a failed check feeds the verify loop, never surfaces as done work;
 *  - FR-014 — verify-before-announce: an incomplete/stale prefix does NOT emit
 *    `artifacts:ready`; it maps to reopen guidance;
 *  - SC-006 — a `reused:true` result announces ONCE and triggers no second build;
 *  - FR-016 — queued/running progress is surfaced, and a hung job is an explicit
 *    timeout outcome (never infinite);
 *  - FR-050/D36 — reopen re-submits a full compile to repopulate a fresh prefix;
 *  - D6/FR-012 — the compiler version flows into every outcome; SC-008 — check
 *    latency is captured against the injected clock.
 */
import { describe, expect, it } from "vitest";
import type { Mock } from "vitest";
import type { ArtifactsReadyPayload } from "@nyx/protocol";
import {
  ArtifactOrchestrator,
  hasCompactChange,
  REOPEN_GUIDANCE,
} from "../../src/compile/index.js";
import {
  advancingDelay,
  CHECK_FAILED,
  CHECK_OK,
  COMPILER_VERSION,
  failedJob,
  FakeCompileClient,
  FRONTEND_FILE,
  makeArtifactFetch,
  PROJECT_ID,
  queuedPoll,
  runningPoll,
  SOURCE_FILES,
  succeededJob,
  URL_PREFIX,
} from "./helpers.js";
import type { ArtifactFetchConfig, Clock, FakeCompileConfig } from "./helpers.js";

const FRESH_PREFIX = "https://r2.nyx.test/proj-1/ff99aa";
const COMPACT_CHANGE: readonly string[] = ["src/counter.compact"];

/** A wired orchestrator + its recording seams, sharing one injected clock. */
interface Harness {
  readonly orchestrator: ArtifactOrchestrator;
  readonly client: FakeCompileClient;
  readonly emitted: ArtifactsReadyPayload[];
  readonly artifactFetch: Mock<typeof fetch>;
  readonly clock: Clock;
}

/** Build a harness whose client + R2 fetch + clock/delay are all deterministic. */
function makeHarness(
  opts: {
    clientConfig?: FakeCompileConfig;
    artifact?: ArtifactFetchConfig;
    maxWaitMs?: number;
  } = {},
): Harness {
  const clock: Clock = { now: 0 };
  const client = new FakeCompileClient(opts.clientConfig ?? {}, clock);
  const emitted: ArtifactsReadyPayload[] = [];
  const artifactFetch = makeArtifactFetch(opts.artifact ?? {});
  const orchestrator = new ArtifactOrchestrator({
    client,
    emitArtifactsReady: (payload) => {
      emitted.push(payload);
    },
    fetchArtifact: artifactFetch,
    now: () => clock.now,
    delay: advancingDelay(clock),
    pollIntervalMs: 1_000,
    maxWaitMs: opts.maxWaitMs ?? 60_000,
  });
  return { orchestrator, client, emitted, artifactFetch, clock };
}

describe("hasCompactChange — the EC-11 frontend-only gate", () => {
  it("is true only when a changed path is a .compact file", () => {
    expect(hasCompactChange(["src/App.tsx", "src/counter.compact"])).toBe(true);
    expect(hasCompactChange(["src/App.tsx", "styles.css"])).toBe(false);
    expect(hasCompactChange([])).toBe(false);
  });
});

describe("runTurn — EC-11 / scenario 9: frontend-only skip", () => {
  it("does not call the service and does not announce when no .compact changed", async () => {
    const { orchestrator, client, emitted } = makeHarness({ clientConfig: { check: CHECK_OK } });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [FRONTEND_FILE],
      turnId: "turn-1",
      changedPaths: ["src/App.tsx"],
    });

    expect(outcome.kind).toBe("skipped");
    expect(client.checkCalls).toHaveLength(0);
    expect(client.compileCalls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — scenario 1: a failed check feeds the verify loop", () => {
  it("returns structured diagnostics, runs no full compile, and never announces", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { check: CHECK_FAILED },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "check-failed") {
      throw new Error(`expected check-failed, got ${outcome.kind}`);
    }
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.severity).toBe("error");
    expect(outcome.compilerVersion).toBe(COMPILER_VERSION); // FR-012
    expect(client.compileCalls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — scenario 2 / FR-014: verify-before-announce on green", () => {
  it("verifies the prefix then emits artifacts:ready exactly once", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.urlPrefix).toBe(URL_PREFIX);
    expect(outcome.reused).toBe(false);
    expect(outcome.compilerVersion).toBe(COMPILER_VERSION); // FR-012
    expect(outcome.circuits).toHaveLength(1);
    expect(client.compileCalls).toHaveLength(1);
    expect(emitted).toEqual([{ urlPrefix: URL_PREFIX }]);
  });

  it("does NOT announce when a manifest-listed artifact is unfetchable (incomplete prefix)", async () => {
    const { orchestrator, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
      artifact: { missingFiles: ["keys/increment.verifier"] },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "verification-failed") {
      throw new Error(`expected verification-failed, got ${outcome.kind}`);
    }
    expect(outcome.reason).toBe("incomplete");
    expect(outcome.missingPath).toBe("keys/increment.verifier");
    expect(outcome.guidance).toBe(REOPEN_GUIDANCE);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — scenario 8 / D36: a stale prefix maps to reopen guidance", () => {
  it("returns verification-failed with reopen guidance when the manifest is gone", async () => {
    const { orchestrator, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
      artifact: { manifest: "missing" },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "verification-failed") {
      throw new Error(`expected verification-failed, got ${outcome.kind}`);
    }
    expect(outcome.reason).toBe("manifest-missing");
    expect(outcome.guidance).toBe(REOPEN_GUIDANCE);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — SC-006: content-hash reuse announces once, no second build", () => {
  it("announces the reused prefix once and requests no re-keygen", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob({ reused: true })] },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.reused).toBe(true);
    expect(emitted).toHaveLength(1);
    // Reuse is the service's job: Nyx submits ONE compile and never re-requests.
    expect(client.compileCalls).toHaveLength(1);
    expect(client.pollCalls).toHaveLength(1);
  });
});

describe("runTurn — FR-016: progress surfaced + hung job → explicit timeout", () => {
  it("surfaces queued→running progress and reaches ready", async () => {
    const { orchestrator, emitted } = makeHarness({
      clientConfig: {
        check: CHECK_OK,
        polls: [queuedPoll(0), runningPoll(1), succeededJob()],
      },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.telemetry.progress.map((update) => update.status)).toEqual([
      "queued",
      "running",
    ]);
    expect(emitted).toHaveLength(1);
  });

  it("returns a timeout outcome for a hung job (bounded, never infinite) and never announces", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [], pollDefault: runningPoll(99) },
      maxWaitMs: 5_000,
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "timeout") {
      throw new Error(`expected timeout, got ${outcome.kind}`);
    }
    expect(outcome.waitedMs).toBe(5_000);
    expect(outcome.lastStatus).toBe("running");
    expect(emitted).toHaveLength(0);
    expect(client.pollCalls.length).toBeLessThan(1_000);
  });
});

describe("runTurn — a full-stage compile failure is data, not an announce", () => {
  it("returns compile-failed with diagnostics + compiler version, never announcing", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: {
        check: CHECK_OK,
        polls: [
          failedJob({
            kind: "compile",
            compilerVersion: COMPILER_VERSION,
            diagnostics: [
              { severity: "error", source: "compactc", message: "type error", raw: false },
            ],
          }),
        ],
      },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "compile-failed") {
      throw new Error(`expected compile-failed, got ${outcome.kind}`);
    }
    expect(outcome.error.kind).toBe("compile");
    expect(outcome.error.diagnostics).toHaveLength(1);
    expect(outcome.telemetry.compilerVersion).toBe(COMPILER_VERSION); // FR-012
    expect(client.compileCalls).toHaveLength(1);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — SC-008: check latency is captured against the injected clock", () => {
  it("records the Nyx-measured check latency alongside the server duration", async () => {
    const { orchestrator } = makeHarness({
      clientConfig: { check: CHECK_OK, checkAdvanceMs: 12, polls: [succeededJob()] },
    });

    const outcome = await orchestrator.runTurn({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
      turnId: "turn-1",
      changedPaths: [...COMPACT_CHANGE],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.telemetry.checkLatencyMs).toBe(12);
    expect(outcome.telemetry.checkDurationMs).toBe(CHECK_OK.durationMs);
  });
});

describe("reopen — FR-050 / D36: full recompile repopulates a fresh prefix", () => {
  it("submits a full compile (no check) and announces the fresh prefix once", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { polls: [succeededJob({ urlPrefix: FRESH_PREFIX })] },
    });

    const outcome = await orchestrator.reopen({
      projectId: PROJECT_ID,
      files: [...SOURCE_FILES],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.urlPrefix).toBe(FRESH_PREFIX);
    // Repopulation: a full compile was submitted; reopen never runs a check.
    expect(client.compileCalls).toHaveLength(1);
    expect(client.checkCalls).toHaveLength(0);
    expect(emitted).toEqual([{ urlPrefix: FRESH_PREFIX }]);
  });
});
