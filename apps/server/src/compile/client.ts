/**
 * The {@link CompileClient} interface + the {@link runCompileJob} submit→poll loop
 * (US2 — compile pipeline, T066).
 *
 * P2 retired the HTTP Compile Service: the concrete client is now
 * {@link createBrowserCompileClient} (`./browser-client.ts`), which delegates the compile
 * to the user's browser toolchain (`@nyx/compact-wasm`). This module keeps only the
 * TRANSPORT-AGNOSTIC contract every compile client satisfies — the {@link CompileClient}
 * interface the orchestrator/supervisor drive — plus {@link runCompileJob}, the submit→poll
 * loop the orchestrator wraps a full compile in.
 *
 * {@link runCompileJob} is the submit→poll loop (§4.2→§4.3): it surfaces
 * queued/running `progress` and enforces a BOUNDED max wait with an INJECTABLE
 * delay + clock, so FR-016 ("explicit queued/progress, never a silent timeout") is
 * deterministically testable and a hung job raises {@link CompileJobTimeoutError}
 * rather than looping forever.
 */
import { CompileJobTimeoutError } from "./errors.js";
import type {
  CheckRequest,
  CheckResponse,
  CompileJob,
  CompileProgress,
  CompileRequest,
  CompileSubmitResponse,
  CompilerVersions,
  JobStatus,
} from "./schemas.js";

/** The four endpoint methods Nyx consumes (§4). Terminal outcomes are read by polling. */
export interface CompileClient {
  /** §4.1 — fast static validity (no keygen, no upload). A failure is `ok:false`. */
  check(req: CheckRequest): Promise<CheckResponse>;
  /** §4.2 — submit a full compile+publish job; returns the job handle. */
  compile(req: CompileRequest): Promise<CompileSubmitResponse>;
  /** §4.3 — poll one job. A `failed` status is DATA; a 404 (unknown job) throws. */
  pollCompile(jobId: string): Promise<CompileJob>;
  /** §4.4 — the pinned toolchain versions (D6). */
  version(): Promise<CompilerVersions>;
}

/** Default poll cadence between job GETs (production; tests inject their own). */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Default bounded max wait for a job to reach terminal (FR-016 — never infinite). */
export const DEFAULT_MAX_WAIT_MS = 300_000;

/** One queued/running heartbeat surfaced by {@link runCompileJob} (FR-016). */
export interface CompileProgressUpdate {
  /** The non-terminal status observed on this poll (queued | running). */
  readonly status: JobStatus;
  /** The honest progress heartbeat, when the service reported one. */
  readonly progress: CompileProgress | undefined;
}

/** Options for {@link runCompileJob}; the delay + clock are injectable for tests. */
export interface RunCompileJobOptions {
  /** Monotonic clock for the bounded-wait math; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sleep between polls; defaults to a real `setTimeout`. Tests bump a clock. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Poll cadence; defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** Bounded max wait before a {@link CompileJobTimeoutError}; defaults to {@link DEFAULT_MAX_WAIT_MS}. */
  readonly maxWaitMs?: number;
  /** Called on every non-terminal poll so callers can surface progress. */
  readonly onProgress?: (update: CompileProgressUpdate) => void;
}

/** The real inter-poll delay; the abandoned timer never keeps the process alive. */
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Submit a compile job and poll it to a terminal state (§4.2→§4.3).
 *
 * Always polls at least once — the submit response carries no result body, so even
 * a terminal submit (reuse / fast failure) needs one GET to read the outcome. A
 * `succeeded`/`failed` job is RETURNED (data). While queued/running, `onProgress`
 * fires and the bounded max wait is enforced against the injected clock: a hung job
 * raises {@link CompileJobTimeoutError} rather than looping forever (FR-016).
 */
export async function runCompileJob(
  client: Pick<CompileClient, "compile" | "pollCompile">,
  req: CompileRequest,
  options: RunCompileJobOptions = {},
): Promise<CompileJob> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? realDelay;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = now();

  const submit = await client.compile(req);
  const jobId = submit.jobId;

  for (;;) {
    const job = await client.pollCompile(jobId);
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    options.onProgress?.({ status: job.status, progress: job.progress });
    if (now() - startedAt >= maxWaitMs) {
      throw new CompileJobTimeoutError(jobId, maxWaitMs, job.status);
    }
    await delay(pollIntervalMs);
  }
}
