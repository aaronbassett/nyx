/**
 * The three named MCP clients for the Nyx orchestrator (T019).
 *
 * toolchain — compile/check (D30/D31; consumed by T067)
 * tome      — skill routing (US1)
 * mnm       — docs Q&A (US1)
 *
 * Foundational scope here is construction from config endpoints + an aggregate
 * health probe for the informational /health/mcp endpoint. No tool calls.
 */
import type { McpConfig } from "../config/index.js";
import { McpClient } from "./client.js";
import type { McpClientOptions, McpHealth, McpSessionFactory } from "./client.js";

export interface McpClients {
  readonly toolchain: McpClient;
  readonly tome: McpClient;
  readonly mnm: McpClient;
}

/**
 * Build the three named clients from MCP config. `sessionFactory` is injectable
 * for tests (defaults to the real Streamable-HTTP transport).
 */
export function createMcpClients(mcp: McpConfig, sessionFactory?: McpSessionFactory): McpClients {
  const make = (name: string, endpoint: string): McpClient => {
    const options: McpClientOptions = {
      name,
      endpoint,
      timeoutMs: mcp.timeoutMs,
      healthTimeoutMs: mcp.healthTimeoutMs,
      maxConcurrency: mcp.maxConcurrency,
      ...(sessionFactory === undefined ? {} : { sessionFactory }),
    };
    return new McpClient(options);
  };

  return {
    toolchain: make("toolchain", mcp.toolchainUrl),
    tome: make("tome", mcp.tomeUrl),
    mnm: make("mnm", mcp.mnmUrl),
  };
}

/**
 * Probe all three MCP servers concurrently. Never throws — each entry reports
 * its own reachability so an unreachable (scale-to-zero) server is a value, not
 * a boot failure.
 */
export function probeMcp(clients: McpClients): Promise<McpHealth[]> {
  return Promise.all([clients.toolchain.health(), clients.tome.health(), clients.mnm.health()]);
}

/** Close every client (graceful shutdown). */
export async function closeMcpClients(clients: McpClients): Promise<void> {
  await Promise.all([clients.toolchain.close(), clients.tome.close(), clients.mnm.close()]);
}
