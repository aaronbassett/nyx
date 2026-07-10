/**
 * MCP client layer tests (T019).
 *
 * Fully deterministic: every session is a fake transport injected via
 * `sessionFactory`, so the suite passes with NO real MCP server present. It
 * proves the D31 contract — no silent timeouts (a non-responding transport
 * rejects with a named McpTimeoutError instead of hanging), unreachable
 * endpoints degrade to `reachable:false`, and calls are bounded by the
 * semaphore. Co-located under src/ to match the package's rootDir.
 */
import { describe, expect, it } from "vitest";
import type { McpConfig } from "../config/index.js";
import {
  McpCallError,
  McpClient,
  McpConnectionError,
  McpTimeoutError,
  createMcpClients,
  probeMcp,
} from "./index.js";
import type { McpSession, McpSessionFactory } from "./index.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A session that answers immediately and echoes tool calls back. */
const okSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: (name, args) => Promise.resolve({ echoed: { name, args } }),
  close: () => Promise.resolve(),
};

/** A session whose ping and callTool never settle (simulates a stuck server). */
const stuckSession: McpSession = {
  ping: () => new Promise<void>(() => undefined),
  callTool: () => new Promise<unknown>(() => undefined),
  close: () => Promise.resolve(),
};

const okFactory: McpSessionFactory = () => Promise.resolve(okSession);
const stuckFactory: McpSessionFactory = () => Promise.resolve(stuckSession);
const neverConnectFactory: McpSessionFactory = () => new Promise<McpSession>(() => undefined);
const refusedFactory: McpSessionFactory = () => Promise.reject(new Error("ECONNREFUSED"));

function makeClient(
  factory: McpSessionFactory,
  overrides: { timeoutMs?: number; healthTimeoutMs?: number; maxConcurrency?: number } = {},
): McpClient {
  return new McpClient({
    name: "test",
    endpoint: "http://mcp.test.local/mcp",
    timeoutMs: overrides.timeoutMs ?? 40,
    healthTimeoutMs: overrides.healthTimeoutMs ?? 40,
    maxConcurrency: overrides.maxConcurrency ?? 4,
    sessionFactory: factory,
  });
}

describe("McpClient — timeouts (D31: no silent timeouts)", () => {
  it("rejects a call against a stuck transport with McpTimeoutError, not a hang", async () => {
    await expect(makeClient(stuckFactory).call("compile", {})).rejects.toBeInstanceOf(
      McpTimeoutError,
    );
  });

  it("rejects connect with McpTimeoutError when the transport never connects", async () => {
    await expect(makeClient(neverConnectFactory).connect()).rejects.toBeInstanceOf(McpTimeoutError);
  });

  it("carries the endpoint, operation, and deadline on the timeout error", async () => {
    try {
      await makeClient(stuckFactory, { timeoutMs: 30 }).call("skills.route", { q: "x" });
      throw new Error("expected a timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(McpTimeoutError);
      const timeout = error as McpTimeoutError;
      expect(timeout.operation).toBe("call");
      expect(timeout.timeoutMs).toBe(30);
      expect(timeout.endpoint).toBe("http://mcp.test.local/mcp");
    }
  });
});

describe("McpClient — reachability", () => {
  it("reports reachable:false for an unreachable endpoint without throwing", async () => {
    const health = await makeClient(refusedFactory).health();
    expect(health.reachable).toBe(false);
    expect(health.error).toBeDefined();
    expect(health.name).toBe("test");
  });

  it("reports reachable:false when the health ping times out", async () => {
    const health = await makeClient(stuckFactory, { healthTimeoutMs: 25 }).health();
    expect(health.reachable).toBe(false);
  });

  it("reports reachable:true when the transport answers", async () => {
    const health = await makeClient(okFactory).health();
    expect(health.reachable).toBe(true);
    expect(typeof health.latencyMs).toBe("number");
  });

  it("surfaces McpConnectionError on connect against a refused endpoint", async () => {
    await expect(makeClient(refusedFactory).connect()).rejects.toBeInstanceOf(McpConnectionError);
  });
});

describe("McpClient — call behaviour", () => {
  it("passes the tool name and args through and returns the result", async () => {
    const result = await makeClient(okFactory).call("skills.route", { q: "midnight" });
    expect(result).toEqual({ echoed: { name: "skills.route", args: { q: "midnight" } } });
  });

  it("wraps a non-timeout tool failure in McpCallError", async () => {
    const failingSession: McpSession = {
      ping: () => Promise.resolve(),
      callTool: () => Promise.reject(new Error("boom")),
      close: () => Promise.resolve(),
    };
    await expect(
      makeClient(() => Promise.resolve(failingSession)).call("compile"),
    ).rejects.toBeInstanceOf(McpCallError);
  });

  it("bounds concurrency to maxConcurrency (D31)", async () => {
    let active = 0;
    let maxActive = 0;
    const gatedSession: McpSession = {
      ping: () => Promise.resolve(),
      callTool: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        return null;
      },
      close: () => Promise.resolve(),
    };
    const client = makeClient(() => Promise.resolve(gatedSession), {
      maxConcurrency: 1,
      timeoutMs: 1_000,
    });
    await Promise.all([client.call("a"), client.call("b"), client.call("c")]);
    expect(maxActive).toBe(1);
  });
});

describe("createMcpClients + probeMcp", () => {
  const mcpConfig: McpConfig = {
    toolchainUrl: "http://toolchain.test.local/mcp",
    tomeUrl: "http://tome.test.local/mcp",
    mnmUrl: "http://mnm.test.local/mcp",
    timeoutMs: 40,
    healthTimeoutMs: 40,
    maxConcurrency: 4,
  };

  it("builds the three named clients from config endpoints", () => {
    const clients = createMcpClients(mcpConfig, okFactory);
    expect(clients.toolchain.name).toBe("toolchain");
    expect(clients.tome.name).toBe("tome");
    expect(clients.mnm.name).toBe("mnm");
    expect(clients.toolchain.endpoint).toBe("http://toolchain.test.local/mcp");
  });

  it("aggregates health across all three without throwing when unreachable", async () => {
    const clients = createMcpClients(mcpConfig, refusedFactory);
    const probes = await probeMcp(clients);
    expect(probes.map((p) => p.name).sort()).toEqual(["mnm", "tome", "toolchain"]);
    expect(probes.every((p) => !p.reachable)).toBe(true);
  });
});
