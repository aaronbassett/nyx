/**
 * Named errors for the Compile Service client + artifact orchestrator (US2, T066).
 *
 * The contract's rule: a compile FAILURE is data (`ok:false` / job
 * `status:"failed"` + diagnostics), never a thrown error — only TRANSPORT or
 * SERVICE faults throw. These named errors are that throw channel, so callers and
 * logs distinguish an unreachable service from a 4xx/5xx envelope from a
 * malformed body from an explicit job timeout (FR-016 — never a silent hang).
 * They mirror the `McpError` family (`src/mcp/errors.ts`).
 */
import type { JobStatus } from "./schemas.js";

/** Base for every Compile Service transport/service failure; carries the path. */
export class CompileServiceError extends Error {
  /** The request path (or job path) involved in the failure. */
  readonly path: string;

  constructor(message: string, path: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompileServiceError";
    this.path = path;
  }
}

/** The service could not be reached — `fetch` threw (network / DNS / refused). */
export class CompileServiceUnavailableError extends CompileServiceError {
  constructor(path: string, cause?: unknown) {
    super(`compile service unreachable: ${path}`, path, cause);
    this.name = "CompileServiceUnavailableError";
  }
}

/**
 * The service returned a non-2xx status (§4: 400 malformed, 401 auth, 404 unknown
 * job, 5xx service/compact-mcp fault). Distinct from a compile failure, which is a
 * 200 body. Carries the `{ error: { code, message } }` envelope when present.
 */
export class CompileServiceResponseError extends CompileServiceError {
  /** The HTTP status code. */
  readonly status: number;
  /** The service error `code`, when the response carried the error envelope. */
  readonly code: string | undefined;

  constructor(path: string, status: number, detail: string, code?: string) {
    super(`compile service responded ${String(status)} for ${path}: ${detail}`, path);
    this.name = "CompileServiceResponseError";
    this.status = status;
    this.code = code;
  }
}

/** A 2xx response whose body did not match the contract schema (a protocol breach). */
export class CompileServiceProtocolError extends CompileServiceError {
  constructor(path: string, cause?: unknown) {
    super(`compile service returned a malformed response for ${path}`, path, cause);
    this.name = "CompileServiceProtocolError";
  }
}

/**
 * A compile job did not reach a terminal state within the bounded max wait
 * (FR-016). Surfaced (not swallowed) so a hung job is an EXPLICIT timeout, never
 * an infinite poll loop.
 */
export class CompileJobTimeoutError extends CompileServiceError {
  /** The job that never settled. */
  readonly jobId: string;
  /** The bounded max wait that was exceeded, in milliseconds. */
  readonly maxWaitMs: number;
  /** The last non-terminal status observed (queued | running). */
  readonly lastStatus: JobStatus;

  constructor(jobId: string, maxWaitMs: number, lastStatus: JobStatus) {
    super(
      `compile job ${jobId} did not reach a terminal state within ${String(maxWaitMs)}ms (last status: ${lastStatus})`,
      `/v1/compile/${jobId}`,
    );
    this.name = "CompileJobTimeoutError";
    this.jobId = jobId;
    this.maxWaitMs = maxWaitMs;
    this.lastStatus = lastStatus;
  }
}
