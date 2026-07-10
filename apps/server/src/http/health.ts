/**
 * Health & readiness endpoints for the Nyx orchestrator (T015; http-api.md Ops).
 *
 *  GET /health      — liveness: the process is up (no dependency checks).
 *  GET /ready       — readiness: the DB is reachable via the db layer. MCP is
 *                     NOT a hard gate (those servers are scale-to-zero/remote).
 *  GET /health/mcp  — informational aggregate MCP probe (never gates readiness).
 */
import type { FastifyInstance } from "fastify";
import type { Queryable } from "../db/index.js";
import { probeMcp } from "../mcp/index.js";
import type { McpClients } from "../mcp/index.js";

export interface HealthDeps {
  readonly db: Queryable;
  readonly mcp: McpClients;
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

/** Register the liveness/readiness/MCP-probe endpoints on `app`. */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/health", () => ({ status: "ok" as const }));

  app.get("/ready", async (_request, reply) => {
    try {
      await deps.db.query<{ readonly ok: number }>("SELECT 1 AS ok");
      return { status: "ready" as const, db: "up" as const };
    } catch (error) {
      reply.code(503);
      return { status: "unready" as const, db: "down" as const, error: describeError(error) };
    }
  });

  // Informational only: reports each server's reachability without gating.
  app.get("/health/mcp", async () => {
    const servers = await probeMcp(deps.mcp);
    return { servers };
  });
}
