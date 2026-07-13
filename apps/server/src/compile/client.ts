/**
 * Compile Service HTTP client (US2 — compile pipeline, T066).
 *
 * The Nyx-side client for the owner-built Compile Service (`infra/compile-service/
 * API.md`). Nyx does NOT compile or write R2 — the service holds the only R2 write
 * credentials (constitution III); Nyx authenticates with a server-only bearer
 * token (`COMPILE_SERVICE_TOKEN`) that grants compile+publish, not raw R2 access.
 *
 * Injectable transport mirrors the web auth client (`apps/web/src/wallet/auth.ts`):
 * `{ fetch, baseUrl, token }` — relative `/v1/*` paths under the base, a mockable
 * `fetch`, no real service in tests. The four endpoint methods (`check`,
 * `compile`, `pollCompile`, `version`) validate every 2xx body against the §3/§4
 * contract schemas. A compile FAILURE is DATA (`ok:false` / job `status:"failed"`)
 * — only transport/service faults throw a named {@link CompileServiceError}.
 *
 * {@link runCompileJob} is the submit→poll loop (§4.2→§4.3): it surfaces
 * queued/running `progress` and enforces a BOUNDED max wait with an INJECTABLE
 * delay + clock, so FR-016 ("explicit queued/progress, never a silent timeout") is
 * deterministically testable and a hung job raises {@link CompileJobTimeoutError}
 * rather than looping forever.
 */
import {
  CompileJobTimeoutError,
  CompileServiceProtocolError,
  CompileServiceResponseError,
  CompileServiceUnavailableError,
} from "./errors.js";
import {
  CheckResponseSchema,
  CompileJobSchema,
  CompileSubmitResponseSchema,
  CompilerVersionsSchema,
  ServiceErrorBodySchema,
} from "./schemas.js";
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

/** A minimal zod schema surface the client uses to validate a response body. */
interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * Injectable transport. `token` is the server-only bearer (required); `fetch`
 * defaults to the global and `baseUrl` to `""` so tests drive relative paths
 * against a mock, and a deployment points at the private `.flycast` service.
 */
export interface CompileServiceClientDeps {
  /** The server-only `COMPILE_SERVICE_TOKEN` sent as `Authorization: Bearer`. */
  readonly token: string;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Base URL prefixed to the relative `/v1/*` paths; defaults to `""`. */
  readonly baseUrl?: string;
}

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

const CHECK_PATH = "/v1/check";
const COMPILE_PATH = "/v1/compile";
const VERSION_PATH = "/v1/version";

/** The Streamable-HTTP client for the Compile Service. Stateless; safe to share. */
export class HttpCompileClient implements CompileClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(deps: CompileServiceClientDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.baseUrl = deps.baseUrl ?? "";
    this.token = deps.token;
  }

  /** Issue a request, mapping a `fetch` throw to a named unreachable error. */
  private async send(path: string, method: "GET" | "POST", body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CompileServiceUnavailableError(path, error);
    }
  }

  /** Validate a 2xx body against `schema`, raising a protocol error on a mismatch. */
  private async parse<T>(path: string, response: Response, schema: ResponseSchema<T>): Promise<T> {
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new CompileServiceProtocolError(path, error);
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new CompileServiceProtocolError(path, result.error);
    }
    return result.data;
  }

  /** Raise a {@link CompileServiceResponseError} for a non-2xx status (§4 envelope). */
  private async fail(path: string, response: Response): Promise<never> {
    let detail = response.statusText;
    let code: string | undefined;
    try {
      const parsed = ServiceErrorBodySchema.safeParse(await response.json());
      if (parsed.success) {
        detail = parsed.data.error.message;
        code = parsed.data.error.code;
      }
    } catch {
      // No body / non-JSON — keep the status text as the detail.
    }
    throw new CompileServiceResponseError(path, response.status, detail, code);
  }

  async check(req: CheckRequest): Promise<CheckResponse> {
    const response = await this.send(CHECK_PATH, "POST", req);
    if (!response.ok) {
      return this.fail(CHECK_PATH, response);
    }
    return this.parse(CHECK_PATH, response, CheckResponseSchema);
  }

  async compile(req: CompileRequest): Promise<CompileSubmitResponse> {
    // Both 202 (work started) and 200 (terminal immediately) are `ok`.
    const response = await this.send(COMPILE_PATH, "POST", req);
    if (!response.ok) {
      return this.fail(COMPILE_PATH, response);
    }
    return this.parse(COMPILE_PATH, response, CompileSubmitResponseSchema);
  }

  async pollCompile(jobId: string): Promise<CompileJob> {
    const path = `${COMPILE_PATH}/${encodeURIComponent(jobId)}`;
    const response = await this.send(path, "GET");
    if (!response.ok) {
      return this.fail(path, response);
    }
    return this.parse(path, response, CompileJobSchema);
  }

  async version(): Promise<CompilerVersions> {
    const response = await this.send(VERSION_PATH, "GET");
    if (!response.ok) {
      return this.fail(VERSION_PATH, response);
    }
    return this.parse(VERSION_PATH, response, CompilerVersionsSchema);
  }
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
