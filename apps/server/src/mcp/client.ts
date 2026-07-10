/**
 * Generic MCP client wrapper for the Nyx orchestrator (T019).
 *
 * Foundational scope = connect + health + a generic `call` helper ONLY. It does
 * NOT know any tool names/shapes — compile/check calls (T067) and retrieval
 * (US1) supply those. Per the D31 contract every operation has an explicit,
 * strict deadline and surfaces a named error on timeout/failure (never a hang),
 * and calls are bounded by a small semaphore.
 *
 * The session is created through an injectable factory (`sessionFactory`) so
 * tests drive the wrapper against a fake transport with no real MCP server. The
 * default factory speaks Streamable HTTP via the official SDK.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Semaphore } from "./concurrency.js";
import { McpCallError, McpConnectionError, McpTimeoutError } from "./errors.js";

/** The minimal MCP session surface the wrapper uses (a subset of the SDK Client). */
export interface McpSession {
  /** Protocol-level liveness probe (MCP `ping`). */
  ping(): Promise<void>;
  /** Invoke a named tool. The caller supplies the name/args (never guessed here). */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Close the underlying transport. */
  close(): Promise<void>;
}

/** Establishes a connected {@link McpSession} for an endpoint. */
export type McpSessionFactory = (
  endpoint: string,
  opts: { readonly timeoutMs: number },
) => Promise<McpSession>;

export interface McpClientOptions {
  /** Human-readable client name (toolchain | tome | mnm). */
  readonly name: string;
  /** MCP endpoint URL. */
  readonly endpoint: string;
  /** Strict deadline for connect + call operations (D31). */
  readonly timeoutMs: number;
  /** Shorter deadline for health probes. */
  readonly healthTimeoutMs: number;
  /** Bounded concurrency for `call` (D31). */
  readonly maxConcurrency: number;
  /** Injectable session factory; defaults to the Streamable-HTTP SDK client. */
  readonly sessionFactory?: McpSessionFactory;
}

/** Result of a health probe; `reachable:false` is a value, never a throw. */
export interface McpHealth {
  readonly name: string;
  readonly endpoint: string;
  readonly reachable: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

/** Internal marker distinguishing a deadline breach from a real rejection. */
class DeadlineExceeded extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

/** Reject with {@link DeadlineExceeded} if `promise` does not settle within `ms`. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceeded());
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } catch (error) {
    if (error instanceof DeadlineExceeded) {
      // The abandoned operation may still settle later; swallow it so a late
      // rejection cannot surface as an unhandled rejection.
      void promise.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

/** The default Streamable-HTTP session factory backed by the official SDK. */
const streamableHttpSessionFactory: McpSessionFactory = async (endpoint, opts) => {
  const client = new Client({ name: "nyx-orchestrator", version: "0.0.0" });
  // The concrete transport exposes `sessionId: string | undefined`, which trips
  // exactOptionalPropertyTypes against the Transport interface; assert at this
  // single SDK boundary.
  const transport = new StreamableHTTPClientTransport(new URL(endpoint)) as Transport;
  await client.connect(transport, { timeout: opts.timeoutMs });
  return {
    ping: async () => {
      await client.ping({ timeout: opts.timeoutMs });
    },
    callTool: (name, args) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: opts.timeoutMs }),
    close: () => client.close(),
  };
};

/**
 * A single named MCP client. Lazily connects on first use, caches the session,
 * bounds concurrent calls, and enforces a strict deadline on every operation.
 */
export class McpClient {
  readonly name: string;
  readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly factory: McpSessionFactory;
  private readonly semaphore: Semaphore;
  private session: McpSession | undefined;

  constructor(options: McpClientOptions) {
    this.name = options.name;
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs;
    this.healthTimeoutMs = options.healthTimeoutMs;
    this.factory = options.sessionFactory ?? streamableHttpSessionFactory;
    this.semaphore = new Semaphore(options.maxConcurrency);
  }

  /** Run `op` under a strict deadline, mapping a breach to a named timeout error. */
  private async guarded<T>(
    operation: "connect" | "health" | "call",
    timeoutMs: number,
    op: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withDeadline(op(), timeoutMs);
    } catch (error) {
      if (error instanceof DeadlineExceeded) {
        throw new McpTimeoutError(this.endpoint, operation, timeoutMs);
      }
      throw error;
    }
  }

  /** Establish (or reuse) the session under the given deadline. */
  private async openSession(timeoutMs: number): Promise<McpSession> {
    if (this.session !== undefined) {
      return this.session;
    }
    let session: McpSession;
    try {
      session = await this.guarded("connect", timeoutMs, () =>
        this.factory(this.endpoint, { timeoutMs }),
      );
    } catch (error) {
      if (error instanceof McpTimeoutError) {
        throw error;
      }
      throw new McpConnectionError(this.endpoint, error);
    }
    this.session = session;
    return session;
  }

  /** Connect (or reuse an existing session). Throws a named error on failure. */
  connect(): Promise<McpSession> {
    return this.openSession(this.timeoutMs);
  }

  /**
   * Probe liveness. NEVER throws: an unreachable endpoint or a timeout returns
   * `reachable:false` so boot and the /health/mcp probe degrade gracefully —
   * these servers are scale-to-zero / remote.
   */
  async health(): Promise<McpHealth> {
    const startedAt = Date.now();
    try {
      const session = await this.openSession(this.healthTimeoutMs);
      await this.guarded("health", this.healthTimeoutMs, () => session.ping());
      return {
        name: this.name,
        endpoint: this.endpoint,
        reachable: true,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        name: this.name,
        endpoint: this.endpoint,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: describeError(error),
      };
    }
  }

  /**
   * Invoke a named tool under bounded concurrency and a strict deadline. The
   * caller owns the tool name/args — this layer never invents them (T067/US1).
   */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const session = await this.connect();
    return this.semaphore.run(async () => {
      try {
        return await this.guarded("call", this.timeoutMs, () => session.callTool(tool, args));
      } catch (error) {
        if (error instanceof McpTimeoutError) {
          throw error;
        }
        throw new McpCallError(this.endpoint, tool, error);
      }
    });
  }

  /** Close the session, if any. */
  async close(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    this.session = undefined;
    await session.close();
  }
}
