/**
 * Shared test doubles for the US2 compile pipeline (T066) — deterministic, no
 * real Compile Service and no real R2.
 *
 * Three pieces the compile tests reuse:
 *  - {@link FakeCompileClient}: a configurable {@link CompileClient} double that
 *    records `check`/`compile`/`pollCompile` calls, replays a scripted poll
 *    sequence, and can advance an INJECTED clock during `check` (so SC-008 check
 *    latency is a real, deterministic assertion);
 *  - {@link makeArtifactFetch}: a `fetch` double for the R2 read side that serves a
 *    present / missing / invalid `manifest.json` and present / missing / throwing
 *    artifact files (so verify-before-announce is exercised without a bucket);
 *  - fixtures + an {@link advancingDelay} that bumps a mutable clock, so the
 *    bounded job-poll wait (FR-016) terminates with no real timers.
 *
 * All responses are real `Response` objects (Node's global), so `.json()`/`.ok`
 * behave exactly as they would against the live service.
 */
import { vi } from "vitest";
import type { Mock } from "vitest";
import { MANIFEST_FILENAME } from "../../src/compile/index.js";
import type {
  ArtifactManifest,
  CheckRequest,
  CheckResponse,
  CompileClient,
  CompileCircuit,
  CompileJob,
  CompileJobError,
  CompileRequest,
  CompileResult,
  CompileSubmitResponse,
  CompilerVersions,
  SourceFile,
} from "../../src/compile/index.js";

// ── Clock + delay ─────────────────────────────────────────────────────────────

/** A mutable clock the doubles read, so tests advance time deterministically. */
export interface Clock {
  now: number;
}

/** A delay that advances `clock` instead of sleeping — bounds the poll loop cheaply. */
export function advancingDelay(clock: Clock): (ms: number) => Promise<void> {
  return (ms) => {
    clock.now += ms;
    return Promise.resolve();
  };
}

// ── Response factories ────────────────────────────────────────────────────────

/** A JSON `Response`, matching what the service / R2 return. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A bodyless `Response` (a HEAD reply, or a bare 404). */
export function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** A mock `fetch`, typed so calls carry the real `fetch` argument tuple. */
export function mockFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>();
}

/** Resolve a fetch call's first argument to a URL string. */
export function callUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

export const PROJECT_ID = "proj-1";
export const JOB_ID = "job_1";
export const SOURCE_HASH = "e3b0c4";
export const URL_PREFIX = "https://r2.nyx.test/proj-1/e3b0c4";
export const COMPILER_VERSION = "0.31.1";

/** A single `.compact` source file — the compile path's minimal input. */
export const COMPACT_FILE: SourceFile = {
  path: "src/counter.compact",
  content: "pragma language_version >= 0.23;",
};

/** A frontend file — a turn touching only these must skip compilation (EC-11). */
export const FRONTEND_FILE: SourceFile = {
  path: "src/App.tsx",
  content: "export const App = () => null;",
};

export const SOURCE_FILES: readonly SourceFile[] = [COMPACT_FILE];

const CIRCUITS: CompileCircuit[] = [{ name: "increment", proof: true }];

/** A complete integrity manifest (§5) whose files all resolve by default. */
export const DEFAULT_MANIFEST: ArtifactManifest = {
  sourceHash: SOURCE_HASH,
  compilerVersion: COMPILER_VERSION,
  circuits: CIRCUITS,
  files: [
    {
      path: "keys/increment.prover",
      sha256: "aa",
      bytes: 12_345,
      contentType: "application/octet-stream",
    },
    {
      path: "keys/increment.verifier",
      sha256: "bb",
      bytes: 456,
      contentType: "application/octet-stream",
    },
    {
      path: "zkir/increment.bzkir",
      sha256: "cc",
      bytes: 678,
      contentType: "application/octet-stream",
    },
  ],
};

/** A green check (no diagnostics). */
export const CHECK_OK: CheckResponse = {
  ok: true,
  diagnostics: [],
  compilerVersion: COMPILER_VERSION,
  durationMs: 812.4,
};

/** A failed check carrying a parser diagnostic (scenario 1). */
export const CHECK_FAILED: CheckResponse = {
  ok: false,
  compilerVersion: COMPILER_VERSION,
  durationMs: 42,
  diagnostics: [
    {
      severity: "error",
      source: "compactp",
      message: "parse error: unexpected token",
      file: "src/counter.compact",
      raw: false,
    },
  ],
};

/** The immediate compile submit (a queued job handle). */
export const SUBMIT_QUEUED: CompileSubmitResponse = {
  jobId: JOB_ID,
  status: "queued",
  sourceHash: SOURCE_HASH,
};

/** A `succeeded` job whose result points at {@link URL_PREFIX}. */
export function succeededJob(
  opts: { urlPrefix?: string; reused?: boolean; compilerVersion?: string } = {},
): CompileJob {
  const result: CompileResult = {
    urlPrefix: opts.urlPrefix ?? URL_PREFIX,
    sourceHash: SOURCE_HASH,
    compilerVersion: opts.compilerVersion ?? COMPILER_VERSION,
    reused: opts.reused ?? false,
    circuits: CIRCUITS,
  };
  return { jobId: JOB_ID, status: "succeeded", sourceHash: SOURCE_HASH, result };
}

/** A `failed` job carrying the given error body. */
export function failedJob(error: CompileJobError): CompileJob {
  return { jobId: JOB_ID, status: "failed", sourceHash: SOURCE_HASH, error };
}

/** A `queued` poll heartbeat (FR-016). */
export function queuedPoll(elapsedSeconds: number): CompileJob {
  return {
    jobId: JOB_ID,
    status: "queued",
    sourceHash: SOURCE_HASH,
    progress: { message: "queued", elapsedSeconds },
  };
}

/** A `running` poll heartbeat (FR-016). */
export function runningPoll(elapsedSeconds: number): CompileJob {
  return {
    jobId: JOB_ID,
    status: "running",
    sourceHash: SOURCE_HASH,
    progress: { message: "compiling and generating proving keys", elapsedSeconds },
  };
}

// ── Compile client double ─────────────────────────────────────────────────────

/** Configuration for {@link FakeCompileClient}; every field is optional. */
export interface FakeCompileConfig {
  /** The `check` response; a check-driven test must set it. */
  readonly check?: CheckResponse;
  /** Ms to advance the injected clock during `check` (drives the SC-008 assertion). */
  readonly checkAdvanceMs?: number;
  /** The `compile` submit reply; defaults to {@link SUBMIT_QUEUED}. */
  readonly submit?: CompileSubmitResponse;
  /** The scripted `pollCompile` sequence, consumed in order. */
  readonly polls?: readonly CompileJob[];
  /** Returned once `polls` is exhausted — a never-terminating job (hung-job test). */
  readonly pollDefault?: CompileJob;
  /** The `version` reply. */
  readonly version?: CompilerVersions;
}

/**
 * A {@link CompileClient} double: records calls and replays scripted responses, with
 * optional clock advancement during `check`. Never touches the network.
 */
export class FakeCompileClient implements CompileClient {
  readonly checkCalls: CheckRequest[] = [];
  readonly compileCalls: CompileRequest[] = [];
  readonly pollCalls: string[] = [];
  private readonly polls: CompileJob[];

  constructor(
    private readonly config: FakeCompileConfig,
    private readonly clock?: Clock,
  ) {
    this.polls = [...(config.polls ?? [])];
  }

  check(req: CheckRequest): Promise<CheckResponse> {
    this.checkCalls.push(req);
    if (this.config.checkAdvanceMs !== undefined && this.clock !== undefined) {
      this.clock.now += this.config.checkAdvanceMs;
    }
    if (this.config.check === undefined) {
      return Promise.reject(new Error("FakeCompileClient: no `check` configured"));
    }
    return Promise.resolve(this.config.check);
  }

  compile(req: CompileRequest): Promise<CompileSubmitResponse> {
    this.compileCalls.push(req);
    return Promise.resolve(this.config.submit ?? SUBMIT_QUEUED);
  }

  pollCompile(jobId: string): Promise<CompileJob> {
    this.pollCalls.push(jobId);
    const next = this.polls.shift() ?? this.config.pollDefault;
    if (next === undefined) {
      return Promise.reject(new Error("FakeCompileClient: poll sequence exhausted"));
    }
    return Promise.resolve(next);
  }

  version(): Promise<CompilerVersions> {
    if (this.config.version === undefined) {
      return Promise.reject(new Error("FakeCompileClient: no `version` configured"));
    }
    return Promise.resolve(this.config.version);
  }
}

// ── Artifact (R2) fetch double ────────────────────────────────────────────────

/** Configuration for {@link makeArtifactFetch}. */
export interface ArtifactFetchConfig {
  /** The manifest served at `<prefix>/manifest.json`, or a failure mode. */
  readonly manifest?: ArtifactManifest | "missing" | "invalid" | "throw";
  /** Artifact paths that return 404 on their HEAD (an incomplete upload). */
  readonly missingFiles?: readonly string[];
  /** Artifact paths whose HEAD throws (an unreachable read). */
  readonly throwFiles?: readonly string[];
}

/**
 * A `fetch` double for the R2 read side. The manifest fetch (GET) and per-file
 * probes (HEAD) are dispatched by URL suffix, so verify-before-announce runs with
 * no real bucket. Defaults to a complete, all-present prefix.
 */
export function makeArtifactFetch(config: ArtifactFetchConfig = {}): Mock<typeof fetch> {
  return vi.fn<typeof fetch>((input) => {
    const url = callUrl(input);
    if (url.endsWith(`/${MANIFEST_FILENAME}`)) {
      if (config.manifest === "throw") {
        return Promise.reject(new Error("artifact read failed"));
      }
      if (config.manifest === "missing") {
        return Promise.resolve(emptyResponse(404));
      }
      if (config.manifest === "invalid") {
        return Promise.resolve(jsonResponse({ not: "a manifest" }));
      }
      return Promise.resolve(jsonResponse(config.manifest ?? DEFAULT_MANIFEST));
    }
    if ((config.throwFiles ?? []).some((path) => url.endsWith(`/${path}`))) {
      return Promise.reject(new Error("artifact read failed"));
    }
    if ((config.missingFiles ?? []).some((path) => url.endsWith(`/${path}`))) {
      return Promise.resolve(emptyResponse(404));
    }
    return Promise.resolve(emptyResponse(200));
  });
}
