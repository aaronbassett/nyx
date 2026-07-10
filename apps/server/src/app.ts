/**
 * Fastify application wiring for the Nyx orchestrator (T015).
 *
 * `buildServer` assembles the HTTP + WS surface from injected dependencies (no
 * process side effects, so it is testable). The bootstrap (index.ts) owns
 * config loading, dependency construction, and `listen`.
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { Config } from "./config/index.js";
import type { Queryable } from "./db/index.js";
import { registerHealthRoutes } from "./http/health.js";
import type { McpClients } from "./mcp/index.js";
import { registerWs } from "./ws/index.js";
import type { WsConnectionHandler } from "./ws/index.js";

export interface ServerDeps {
  readonly config: Config;
  /** DB handle for readiness checks (the db layer owns the pool). */
  readonly db: Queryable;
  readonly mcp: McpClients;
  /** Optional WS handler; T022 supplies the authenticated router. */
  readonly wsHandler?: WsConnectionHandler;
}

/** Build a fully-wired (but not-yet-listening) Fastify instance. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(fastifyWebsocket);

  registerHealthRoutes(app, { db: deps.db, mcp: deps.mcp });

  if (deps.wsHandler === undefined) {
    registerWs(app, "/ws");
  } else {
    registerWs(app, "/ws", deps.wsHandler);
  }

  return app;
}
