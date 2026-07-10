/**
 * Named errors for the MCP client layer (T019).
 *
 * D31 contract: no silent timeouts. Every failure surfaces one of these named
 * errors (never a bare hang or a swallowed rejection) so callers and logs can
 * tell a timeout from an unreachable endpoint from a tool-call failure.
 */

/** Base for every MCP client failure. Carries the endpoint that produced it. */
export class McpError extends Error {
  /** The MCP endpoint URL involved in the failure. */
  readonly endpoint: string;

  constructor(message: string, endpoint: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpError";
    this.endpoint = endpoint;
  }
}

/** The endpoint could not be reached / the session could not be established. */
export class McpConnectionError extends McpError {
  constructor(endpoint: string, cause?: unknown) {
    super(`MCP endpoint unreachable: ${endpoint}`, endpoint, cause);
    this.name = "McpConnectionError";
  }
}

/**
 * An operation exceeded its strict deadline. Surfaced (not swallowed) so no call
 * can hang indefinitely (D31).
 */
export class McpTimeoutError extends McpError {
  /** Which operation timed out: "connect" | "health" | "call". */
  readonly operation: string;
  /** The deadline that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(endpoint: string, operation: string, timeoutMs: number) {
    super(`MCP ${operation} timed out after ${String(timeoutMs)}ms: ${endpoint}`, endpoint);
    this.name = "McpTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** A tool invocation failed (non-timeout). */
export class McpCallError extends McpError {
  /** The tool name that was called. */
  readonly tool: string;

  constructor(endpoint: string, tool: string, cause?: unknown) {
    super(`MCP tool call "${tool}" failed: ${endpoint}`, endpoint, cause);
    this.name = "McpCallError";
    this.tool = tool;
  }
}
