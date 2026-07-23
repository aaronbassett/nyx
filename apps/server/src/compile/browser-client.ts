/**
 * `BrowserCompileClient` — a {@link CompileClient} that delegates the compile to the
 * BROWSER (P2 — Task 7).
 *
 * P2 retires the server-side Compile Service + R2-write path: user code compiles on the
 * user's own machine via the vendored wasm Compact toolchain (`@nyx/compact-wasm`). This
 * client preserves the EXISTING {@link CompileClient} interface the orchestrator/supervisor
 * already drive — but instead of an HTTP call it emits `compile:run { turnId, kind }` on the
 * project's live connection and awaits the client's `compile:results` through the
 * {@link CompileResultsInbox}. Everything downstream (`ArtifactOrchestrator.runTurn`,
 * `runCompileJob`, verify-before-announce) is unchanged: the orchestrator still reads the
 * committed artifact prefix over its `fetchArtifact` seam (Task 6's `storeFetchAdapter`)
 * BEFORE announcing, so a browser-reported green is only trusted once the artifacts it
 * uploaded are actually present.
 *
 * Discipline carried from the verify loop (D42) and US2:
 *  - a `null` inbox timeout is a FAILED result, never a hang — a dead/silent tab yields a
 *    synthesized failing `check` or a {@link CompileJobTimeoutError} for a `full` (which the
 *    orchestrator maps to its explicit `timeout` outcome);
 *  - a compile FAILURE is DATA — `ok:false` diagnostics map to a `check-failed` /
 *    `failed`-job outcome; only a genuine protocol gap throws.
 *
 * The `check`/`compile` `req` bodies are IGNORED (the impl omits the params): the browser
 * compiles its own live VFS — the source of truth on the client — so the server hands it only
 * the turn + kind. Omitting the params still satisfies {@link CompileClient} (fewer params is
 * assignable), so the orchestrator drives it unchanged.
 */
import type {
  CompileDiagnostic,
  CompileKind,
  CompileResultsPayload,
  CompileRunPayload,
} from "@nyx/protocol";
import { COMPACT_WASM_META } from "@nyx/compact-wasm/meta";
import type { CompileClient } from "./client.js";
import { CompileServiceResponseError, CompileJobTimeoutError } from "./errors.js";
import type {
  CheckResponse,
  CompileCircuit,
  CompileJob,
  CompileJobError,
  CompileResult,
  CompileSubmitResponse,
  CompilerVersions,
  Diagnostic,
} from "./schemas.js";
import type { CompileResultsInbox } from "./inbox.js";

/** The `compile:results` `compilerVersion` used when a turn timed out (no verdict arrived). */
const UNKNOWN_COMPILER_VERSION = "unknown";

/** The submit `sourceHash` for a failed full compile — no verified prefix to address. */
const UNAVAILABLE_SOURCE_HASH = "unavailable";

/**
 * One project's live server→client channel. `emitCompileRun` sends a single wire-encoded
 * `compile:run`; the reply arrives asynchronously via {@link CompileResultsInbox.deliver}.
 */
export interface BrowserCompileSession {
  readonly projectId: string;
  /** Send one server->client `compile:run` on the project's live connection. */
  emitCompileRun(payload: CompileRunPayload): void;
}

/** Injected dependencies for {@link createBrowserCompileClient} — all seams, no real I/O. */
export interface BrowserCompileClientDeps {
  /** The rendezvous the awaited `compile:results` is delivered through. */
  readonly inbox: CompileResultsInbox;
  /** The project's live connection (emit) + owning `projectId` (urlPrefix + ownership). */
  readonly session: BrowserCompileSession;
  /** Absolute public origin for `urlPrefix` construction, e.g. `http://localhost:8080`. */
  readonly publicOrigin: string;
  /** Bounded wait for a per-cycle `check` verdict (D42); a timeout is a failing check. */
  readonly checkTimeoutMs: number;
  /** Bounded wait for the green-only `full` verdict (D42); a timeout throws. */
  readonly fullTimeoutMs: number;
}

/**
 * Map a wire {@link CompileDiagnostic} (P2 events) to a server {@link Diagnostic} — the shapes
 * match except the server carries `raw` (a passthrough marker), which the browser never emits.
 */
function toServerDiagnostic(diagnostic: CompileDiagnostic): Diagnostic {
  return {
    severity: diagnostic.severity,
    source: diagnostic.source,
    message: diagnostic.message,
    raw: false,
    ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
    ...(diagnostic.span === undefined ? {} : { span: diagnostic.span }),
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  };
}

/** The synthesized FAILING check for a `check` wait that timed out (dead tab, no-hang D42). */
function timeoutCheckResponse(timeoutMs: number): CheckResponse {
  return {
    ok: false,
    diagnostics: [
      {
        severity: "error",
        source: "compactc",
        raw: false,
        message:
          `no compile:results within ${String(timeoutMs)}ms — treating this check as failing ` +
          `so a crashed or silent browser tab cannot hang the turn (no-hang, D42).`,
      },
    ],
    compilerVersion: UNKNOWN_COMPILER_VERSION,
    durationMs: timeoutMs,
  };
}

/** Build the pinned wasm toolchain versions from the vendored bundle metadata (D6). */
function browserCompilerVersions(): CompilerVersions {
  // The browser ships ONE pinned wasm bundle — the parser (`compactp`) and CLI are the same
  // artifact as `compactc`, so they report the compiler version. `ledger` is not carried by
  // the bundle meta (the generated JS pins `runtime`), so it is honestly `unknown`.
  return {
    compilerVersion: COMPACT_WASM_META.compilerVersion,
    languageVersion: COMPACT_WASM_META.languageVersion,
    ledger: UNKNOWN_COMPILER_VERSION,
    runtime: COMPACT_WASM_META.runtimeVersion,
    cli: COMPACT_WASM_META.compilerVersion,
    compactp: COMPACT_WASM_META.compilerVersion,
    skew: { ok: true, detail: "browser wasm toolchain (single pinned bundle)" },
  };
}

/**
 * A per-turn {@link CompileClient} bound to `turnId`. Each `forTurn` view owns its own
 * terminal-job map (`jobId = ${turnId}:full`), so `compile` stores and `pollCompile` reads
 * the same job with zero waiting — `runCompileJob` always polls at least once.
 */
function createTurnClient(deps: BrowserCompileClientDeps, turnId: string): CompileClient {
  const { inbox, session, publicOrigin, checkTimeoutMs, fullTimeoutMs } = deps;
  const jobs = new Map<string, CompileJob>();
  const fullJobId = `${turnId}:full`;

  const emitAndAwait = (
    kind: CompileKind,
    timeoutMs: number,
  ): Promise<CompileResultsPayload | null> => {
    // Emit FIRST, then register: `register` records the wait synchronously, so a reply the
    // client sends immediately after `compile:run` still lands on a pending wait.
    session.emitCompileRun({ turnId: turnId as CompileRunPayload["turnId"], kind });
    return inbox.register(turnId, kind, session.projectId, timeoutMs);
  };

  const buildFullJob = (payload: CompileResultsPayload): CompileJob => {
    if (payload.ok && payload.sourceHash !== undefined) {
      const circuits: CompileCircuit[] = (payload.circuits ?? []).map((circuit) => ({
        name: circuit.name,
        proof: circuit.proof,
      }));
      const result: CompileResult = {
        urlPrefix: `${publicOrigin}/artifacts/${session.projectId}/${payload.sourceHash}`,
        sourceHash: payload.sourceHash,
        compilerVersion: payload.compilerVersion,
        reused: false,
        circuits,
      };
      return { jobId: fullJobId, status: "succeeded", sourceHash: payload.sourceHash, result };
    }

    // A `!ok` full is a compile failure (data, feeds the verify loop). An `ok` full without a
    // `sourceHash` is a schema breach (a green full MUST carry one) — record it as a `service`
    // failure so verify-before-announce never runs against an un-addressable prefix.
    const error: CompileJobError = payload.ok
      ? {
          kind: "service",
          compilerVersion: payload.compilerVersion,
          message: "green full compile:results missing sourceHash",
        }
      : {
          kind: "compile",
          compilerVersion: payload.compilerVersion,
          diagnostics: payload.diagnostics.map(toServerDiagnostic),
        };
    return {
      jobId: fullJobId,
      status: "failed",
      sourceHash: payload.sourceHash ?? UNAVAILABLE_SOURCE_HASH,
      error,
    };
  };

  return {
    async check(): Promise<CheckResponse> {
      const payload = await emitAndAwait("check", checkTimeoutMs);
      if (payload === null) {
        return timeoutCheckResponse(checkTimeoutMs);
      }
      return {
        ok: payload.ok,
        diagnostics: payload.diagnostics.map(toServerDiagnostic),
        compilerVersion: payload.compilerVersion,
        durationMs: payload.durationMs,
      };
    },

    async compile(): Promise<CompileSubmitResponse> {
      const payload = await emitAndAwait("full", fullTimeoutMs);
      if (payload === null) {
        // A dead/silent tab: surface the explicit timeout the orchestrator maps to `timeout`.
        throw new CompileJobTimeoutError(fullJobId, fullTimeoutMs, "running");
      }
      const job = buildFullJob(payload);
      jobs.set(fullJobId, job);
      return { jobId: job.jobId, status: job.status, sourceHash: job.sourceHash };
    },

    pollCompile(jobId: string): Promise<CompileJob> {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return Promise.reject(
          new CompileServiceResponseError(`/v1/compile/${jobId}`, 404, "unknown job"),
        );
      }
      return Promise.resolve(job);
    },

    version(): Promise<CompilerVersions> {
      return Promise.resolve(browserCompilerVersions());
    },
  };
}

/**
 * Build the browser-delegating compile client. `forTurn(turnId)` returns a
 * {@link CompileClient} the orchestrator drives unchanged for that one turn.
 */
export function createBrowserCompileClient(deps: BrowserCompileClientDeps): {
  forTurn(turnId: string): CompileClient;
} {
  return {
    forTurn(turnId: string): CompileClient {
      return createTurnClient(deps, turnId);
    },
  };
}
