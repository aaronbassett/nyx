/**
 * Artifact orchestrator — the US2 compile pipeline (T066).
 *
 * Drives one turn's compile against the {@link CompileClient} and decides whether
 * to announce artifacts. Nyx owns these decisions; the service just compiles what
 * it is handed (`infra/compile-service/API.md` §6/§7). All I/O is injected — the
 * client, the `emitArtifactsReady` WS seam, an artifact-read `fetch` (R2 public
 * read), and a clock/delay — so the whole pipeline is deterministic with no real
 * service or R2.
 *
 * Pipeline (`runTurn`):
 *  - EC-11 / scenario 9 — no `.compact` changed ⇒ SKIP: no service call, no announce.
 *  - D35 check per iteration ⇒ structured diagnostics for the verify loop; a failed
 *    check never surfaces as done work (scenario 1). Check latency is captured (SC-008).
 *  - Full on green ⇒ submit + poll to terminal, surfacing queued/running progress
 *    with a bounded max wait (FR-016; a hung job ⇒ an explicit `timeout` outcome).
 *  - Verify-before-announce (FR-014, scenario 2) ⇒ on `succeeded`, fetch
 *    `<urlPrefix>/manifest.json` and confirm every listed file is fetchable BEFORE
 *    emitting `artifacts:ready { urlPrefix }` — at most once per green turn. An
 *    incomplete/unfetchable prefix does NOT announce; it maps to reopen guidance.
 *  - Reuse (SC-006, scenario 4) ⇒ a `reused:true` result still announces (once)
 *    and triggers NO second build (one `compile` call — reuse is the service's job).
 *  - `compilerVersion` (D6/FR-012, scenario 6) flows into every outcome's telemetry.
 *
 * `reopen` (FR-050/D36, scenario 8) re-submits a full compile to repopulate a fresh
 * prefix; a stale-prefix verify failure becomes a clear reopen-guidance outcome, not
 * a silent hang.
 */
import type { ArtifactsReadyPayload } from "@nyx/protocol";
import { runCompileJob } from "./client.js";
import type { CompileClient, CompileProgressUpdate, RunCompileJobOptions } from "./client.js";
import { CompileJobTimeoutError, CompileServiceProtocolError } from "./errors.js";
import { ArtifactManifestSchema } from "./schemas.js";
import type {
  ArtifactManifest,
  CheckRequest,
  CompileCircuit,
  CompileJob,
  CompileJobError,
  CompileRequest,
  Diagnostic,
  JobStatus,
  SourceFile,
} from "./schemas.js";

/** The `.compact` suffix whose presence in a turn's changed paths gates compilation. */
const COMPACT_EXTENSION = ".compact";

/** The integrity manifest object, uploaded LAST — its presence marks a complete prefix. */
export const MANIFEST_FILENAME = "manifest.json";

/** Actionable guidance attached to a verify/stale-prefix failure (D36/FR-050). */
export const REOPEN_GUIDANCE =
  "reopen the project to recompile — the artifact prefix is incomplete or expired (D36)";

/** True if any changed path is a `.compact` file — the EC-11 frontend-only gate. */
export function hasCompactChange(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => path.endsWith(COMPACT_EXTENSION));
}

/** Join a content-hashed `urlPrefix` with a prefix-relative artifact path. */
function joinPrefix(urlPrefix: string, relativePath: string): string {
  const base = urlPrefix.endsWith("/") ? urlPrefix.slice(0, -1) : urlPrefix;
  const suffix = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return `${base}/${suffix}`;
}

/** Why verify-before-announce refused to announce (FR-014). */
export type ArtifactVerifyFailureReason =
  /** The `manifest.json` fetch threw (network / unreachable read domain). */
  | "manifest-unfetchable"
  /** The `manifest.json` fetch returned non-2xx (stale/absent prefix — D36). */
  | "manifest-missing"
  /** The manifest body was not valid JSON or did not match the §5 schema. */
  | "manifest-invalid"
  /** The manifest parsed but a listed artifact was not fetchable (incomplete upload). */
  | "incomplete";

/** The internal verdict of {@link ArtifactOrchestrator.verifyPrefix}. */
type VerifyResult =
  | { readonly ok: true; readonly manifest: ArtifactManifest }
  | {
      readonly ok: false;
      readonly reason: ArtifactVerifyFailureReason;
      readonly missingPath: string | undefined;
    };

/** Telemetry carried on every outcome — the compiler version + latency hooks (D6, SC-008). */
export interface CompileTelemetry {
  /** The pinned compiler version from the result/check (D6/FR-012), if reached. */
  readonly compilerVersion: string | undefined;
  /** Nyx-measured check latency in ms (SC-008), if a check ran this turn. */
  readonly checkLatencyMs: number | undefined;
  /** The service-measured check `durationMs`, if a check ran this turn. */
  readonly checkDurationMs: number | undefined;
  /** Every queued/running heartbeat surfaced while polling the full job (FR-016). */
  readonly progress: readonly CompileProgressUpdate[];
}

/** The terminal result of a compile turn — a discriminated union tests assert on. */
export type CompileOutcome =
  /** EC-11 / scenario 9 — no `.compact` changed; no service call, no announce. */
  | { readonly kind: "skipped"; readonly reason: "frontend-only" }
  /** scenario 1 — check failed; diagnostics feed the verify loop, nothing announced. */
  | {
      readonly kind: "check-failed";
      readonly diagnostics: readonly Diagnostic[];
      readonly compilerVersion: string;
      readonly checkLatencyMs: number;
      readonly checkDurationMs: number;
    }
  /** The full job reached `failed` (compile or service error); nothing announced. */
  | {
      readonly kind: "compile-failed";
      readonly error: CompileJobError;
      readonly telemetry: CompileTelemetry;
    }
  /** FR-016 — the job never settled within the bounded wait; an explicit timeout. */
  | {
      readonly kind: "timeout";
      readonly jobId: string;
      readonly waitedMs: number;
      readonly lastStatus: JobStatus;
      readonly telemetry: CompileTelemetry;
    }
  /** FR-014 — a `succeeded` job's prefix is incomplete/unfetchable; NOT announced. */
  | {
      readonly kind: "verification-failed";
      readonly urlPrefix: string;
      readonly reason: ArtifactVerifyFailureReason;
      readonly missingPath: string | undefined;
      readonly guidance: string;
      readonly telemetry: CompileTelemetry;
    }
  /** The green path — prefix verified, `artifacts:ready` emitted exactly once. */
  | {
      readonly kind: "ready";
      readonly urlPrefix: string;
      readonly reused: boolean;
      readonly compilerVersion: string;
      readonly circuits: readonly CompileCircuit[];
      readonly announced: true;
      readonly telemetry: CompileTelemetry;
    };

/** Injectable dependencies for the orchestrator — every side effect is a seam. */
export interface ArtifactOrchestratorDeps {
  /** The Compile Service client (§4). */
  readonly client: CompileClient;
  /** The WS send for `artifacts:ready` (D12) — injected so tests assert calls. */
  readonly emitArtifactsReady: (payload: ArtifactsReadyPayload) => void | Promise<void>;
  /** `fetch` for reading R2 artifacts (manifest + files); defaults to the global. */
  readonly fetchArtifact?: typeof fetch;
  /** Clock for check-latency + the job-poll bound; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Inter-poll delay for the full job; defaults to a real `setTimeout`. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Poll cadence for the full job. */
  readonly pollIntervalMs?: number;
  /** Bounded max wait for the full job (FR-016). */
  readonly maxWaitMs?: number;
}

/** A turn's inputs: the project, its source set, and what changed this turn. */
export interface CompileTurnInput {
  readonly projectId: string;
  readonly files: readonly SourceFile[];
  /** The turn's changed paths — the EC-11 gate reads these. */
  readonly changedPaths: readonly string[];
  readonly entry?: string;
}

/** A reopen's inputs: the project + its source set (a full recompile, no gate). */
export interface ReopenInput {
  readonly projectId: string;
  readonly files: readonly SourceFile[];
  readonly entry?: string;
}

/** The pre-compile telemetry seed threaded from an optional check into the outcome. */
interface PreCompileTelemetry {
  readonly compilerVersion: string | undefined;
  readonly checkLatencyMs: number | undefined;
  readonly checkDurationMs: number | undefined;
}

/**
 * Orchestrates one turn's compile + artifact announce. Stateless across turns (one
 * `runTurn`/`reopen` call = one turn), so `artifacts:ready` fires at most once per
 * green turn by construction.
 */
export class ArtifactOrchestrator {
  private readonly client: CompileClient;
  private readonly emit: (payload: ArtifactsReadyPayload) => void | Promise<void>;
  private readonly fetchArtifact: typeof fetch;
  private readonly now: () => number;
  private readonly delay: ((ms: number) => Promise<void>) | undefined;
  private readonly pollIntervalMs: number | undefined;
  private readonly maxWaitMs: number | undefined;

  constructor(deps: ArtifactOrchestratorDeps) {
    this.client = deps.client;
    this.emit = deps.emitArtifactsReady;
    this.fetchArtifact = deps.fetchArtifact ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.delay = deps.delay;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.maxWaitMs = deps.maxWaitMs;
  }

  /**
   * Run one turn's compile pipeline: gate → check → (green) full → verify → announce.
   */
  async runTurn(input: CompileTurnInput): Promise<CompileOutcome> {
    // EC-11 / scenario 9 — a frontend-only turn never touches the service.
    if (!hasCompactChange(input.changedPaths)) {
      return { kind: "skipped", reason: "frontend-only" };
    }

    // D35 — check per iteration; measure Nyx-side latency for SC-008.
    const checkReq: CheckRequest = {
      files: [...input.files],
      ...(input.entry === undefined ? {} : { entry: input.entry }),
    };
    const startedAt = this.now();
    const check = await this.client.check(checkReq);
    const checkLatencyMs = this.now() - startedAt;

    // scenario 1 — a failed check feeds the verify loop; it is never done work.
    if (!check.ok) {
      return {
        kind: "check-failed",
        diagnostics: check.diagnostics,
        compilerVersion: check.compilerVersion,
        checkLatencyMs,
        checkDurationMs: check.durationMs,
      };
    }

    // Full on green.
    const compileReq: CompileRequest = {
      projectId: input.projectId,
      files: [...input.files],
      ...(input.entry === undefined ? {} : { entry: input.entry }),
    };
    return this.compileAndPublish(compileReq, {
      compilerVersion: check.compilerVersion,
      checkLatencyMs,
      checkDurationMs: check.durationMs,
    });
  }

  /**
   * Reopen path (FR-050/D36): re-submit a full compile to repopulate a fresh prefix.
   * No frontend-only gate and no check — reopen always recompiles (contract §7).
   */
  reopen(input: ReopenInput): Promise<CompileOutcome> {
    const compileReq: CompileRequest = {
      projectId: input.projectId,
      files: [...input.files],
      ...(input.entry === undefined ? {} : { entry: input.entry }),
    };
    return this.compileAndPublish(compileReq, {
      compilerVersion: undefined,
      checkLatencyMs: undefined,
      checkDurationMs: undefined,
    });
  }

  /** Submit + poll the full job, then verify-before-announce on a green result. */
  private async compileAndPublish(
    req: CompileRequest,
    pre: PreCompileTelemetry,
  ): Promise<CompileOutcome> {
    const progress: CompileProgressUpdate[] = [];

    let job: CompileJob;
    try {
      job = await runCompileJob(this.client, req, this.runJobOptions(progress));
    } catch (error) {
      if (error instanceof CompileJobTimeoutError) {
        // FR-016 — surface the hung job explicitly; nothing is announced.
        return {
          kind: "timeout",
          jobId: error.jobId,
          waitedMs: error.maxWaitMs,
          lastStatus: error.lastStatus,
          telemetry: this.telemetry(pre, progress),
        };
      }
      // A genuine transport/service fault propagates → US1 maps it to a loud D34 failure.
      throw error;
    }

    if (job.status === "failed") {
      const error: CompileJobError = job.error ?? {
        kind: "service",
        message: "compile job failed without an error body",
      };
      return {
        kind: "compile-failed",
        error,
        telemetry: this.telemetry(
          { ...pre, compilerVersion: error.compilerVersion ?? pre.compilerVersion },
          progress,
        ),
      };
    }

    const result = job.result;
    if (result === undefined) {
      // §4.3 — a `succeeded` job always carries `result`; a missing one is a breach.
      throw new CompileServiceProtocolError(`/v1/compile/${job.jobId}`);
    }

    const telemetry = this.telemetry({ ...pre, compilerVersion: result.compilerVersion }, progress);

    // FR-014 — verify the prefix is complete + fetchable BEFORE announcing.
    const verify = await this.verifyPrefix(result.urlPrefix);
    if (!verify.ok) {
      return {
        kind: "verification-failed",
        urlPrefix: result.urlPrefix,
        reason: verify.reason,
        missingPath: verify.missingPath,
        guidance: REOPEN_GUIDANCE,
        telemetry,
      };
    }

    // Green — announce exactly once (SC-006 reuse announces here too).
    await this.emit({ urlPrefix: result.urlPrefix });
    return {
      kind: "ready",
      urlPrefix: result.urlPrefix,
      reused: result.reused,
      compilerVersion: result.compilerVersion,
      circuits: result.circuits,
      announced: true,
      telemetry,
    };
  }

  /** Build the {@link runCompileJob} options from the injected clock/delay seams. */
  private runJobOptions(progress: CompileProgressUpdate[]): RunCompileJobOptions {
    return {
      now: this.now,
      onProgress: (update) => progress.push(update),
      ...(this.delay === undefined ? {} : { delay: this.delay }),
      ...(this.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.pollIntervalMs }),
      ...(this.maxWaitMs === undefined ? {} : { maxWaitMs: this.maxWaitMs }),
    };
  }

  /** Freeze the collected telemetry into an outcome-ready snapshot. */
  private telemetry(
    pre: PreCompileTelemetry,
    progress: readonly CompileProgressUpdate[],
  ): CompileTelemetry {
    return {
      compilerVersion: pre.compilerVersion,
      checkLatencyMs: pre.checkLatencyMs,
      checkDurationMs: pre.checkDurationMs,
      progress: [...progress],
    };
  }

  /**
   * Verify-before-announce (FR-014): the manifest must be present + valid AND every
   * artifact it lists must be fetchable. Any gap returns a reason (never a throw) so
   * a stale/incomplete prefix maps to reopen guidance rather than a silent hang.
   */
  private async verifyPrefix(urlPrefix: string): Promise<VerifyResult> {
    const manifestUrl = joinPrefix(urlPrefix, MANIFEST_FILENAME);

    let manifestResponse: Response;
    try {
      manifestResponse = await this.fetchArtifact(manifestUrl, { method: "GET" });
    } catch {
      return { ok: false, reason: "manifest-unfetchable", missingPath: MANIFEST_FILENAME };
    }
    if (!manifestResponse.ok) {
      return { ok: false, reason: "manifest-missing", missingPath: MANIFEST_FILENAME };
    }

    let manifestJson: unknown;
    try {
      manifestJson = await manifestResponse.json();
    } catch {
      return { ok: false, reason: "manifest-invalid", missingPath: MANIFEST_FILENAME };
    }
    const parsed = ArtifactManifestSchema.safeParse(manifestJson);
    if (!parsed.success) {
      return { ok: false, reason: "manifest-invalid", missingPath: MANIFEST_FILENAME };
    }

    // Confirm every listed artifact is actually fetchable (HEAD) before announcing.
    for (const file of parsed.data.files) {
      const fileUrl = joinPrefix(urlPrefix, file.path);
      let head: Response;
      try {
        head = await this.fetchArtifact(fileUrl, { method: "HEAD" });
      } catch {
        return { ok: false, reason: "incomplete", missingPath: file.path };
      }
      if (!head.ok) {
        return { ok: false, reason: "incomplete", missingPath: file.path };
      }
    }

    return { ok: true, manifest: parsed.data };
  }
}
