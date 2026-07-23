/**
 * `runCompileJob` submit→poll loop tests (T066) — deterministic, injected clock/delay.
 *
 * P2 retired the HTTP Compile Service client (`HttpCompileClient`); the concrete client is
 * now the browser-delegating one (see `browser-client.test.ts`). What remains transport-
 * agnostic — and still tested here — is {@link runCompileJob}, the submit→poll loop the
 * orchestrator wraps a full compile in:
 *  - it surfaces queued→running progress and returns `succeeded`; and
 *  - a hung job raises {@link CompileJobTimeoutError} — bounded, never infinite (FR-016).
 */
import { describe, expect, it } from "vitest";
import { CompileJobTimeoutError, runCompileJob } from "../../src/compile/index.js";
import type { CompileProgressUpdate } from "../../src/compile/index.js";
import {
  advancingDelay,
  FakeCompileClient,
  PROJECT_ID,
  runningPoll,
  SOURCE_FILES,
  SUBMIT_QUEUED,
  succeededJob,
} from "./helpers.js";
import type { Clock } from "./helpers.js";

describe("runCompileJob — submit → poll to terminal (FR-016)", () => {
  it("surfaces queued/running progress and returns the succeeded job", async () => {
    const client = new FakeCompileClient({
      submit: SUBMIT_QUEUED,
      polls: [runningPoll(1), runningPoll(2), succeededJob()],
    });
    const clock: Clock = { now: 0 };
    const progress: CompileProgressUpdate[] = [];

    const job = await runCompileJob(
      client,
      { projectId: PROJECT_ID, files: [...SOURCE_FILES] },
      {
        now: () => clock.now,
        delay: advancingDelay(clock),
        pollIntervalMs: 1_000,
        maxWaitMs: 60_000,
        onProgress: (update) => progress.push(update),
      },
    );

    expect(job.status).toBe("succeeded");
    expect(progress.map((p) => p.status)).toEqual(["running", "running"]);
    expect(progress[0]?.progress?.message).toContain("compiling");
    expect(client.compileCalls).toHaveLength(1);
  });

  it("raises CompileJobTimeoutError for a hung job — bounded, never infinite", async () => {
    const client = new FakeCompileClient({
      submit: SUBMIT_QUEUED,
      polls: [],
      pollDefault: runningPoll(99), // always running — the job never settles
    });
    const clock: Clock = { now: 0 };

    const error = await runCompileJob(
      client,
      { projectId: PROJECT_ID, files: [...SOURCE_FILES] },
      {
        now: () => clock.now,
        delay: advancingDelay(clock),
        pollIntervalMs: 1_000,
        maxWaitMs: 5_000,
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompileJobTimeoutError);
    const timeout = error as CompileJobTimeoutError;
    expect(timeout.maxWaitMs).toBe(5_000);
    expect(timeout.lastStatus).toBe("running");
    // The bounded wait terminated the loop rather than polling forever.
    expect(client.pollCalls.length).toBeGreaterThan(0);
    expect(client.pollCalls.length).toBeLessThan(1_000);
  });
});
