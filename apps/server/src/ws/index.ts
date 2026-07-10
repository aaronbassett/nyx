/**
 * WebSocket endpoint seam for the Nyx orchestrator (T015).
 *
 * BOUNDARY: session-cookie auth, single-live-session takeover (D40), and the
 * typed event router are a SEPARATE task (T022). This module only stands up the
 * WS route and leaves a clean, documented hook. T022 will replace the default
 * handler with one that authenticates the session cookie, enforces last-tab-wins
 * takeover, and routes frames through `parseEvent` from `@nyx/protocol`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
// The socket @fastify/websocket hands the handler is a `ws` WebSocket; import
// its type from the canonical source (pnpm isolates ws under the plugin, so the
// plugin's re-exported type does not resolve directly).
import type { WebSocket } from "ws";

/**
 * Handles one accepted WebSocket connection. This is the seam T022 plugs into.
 */
export type WsConnectionHandler = (socket: WebSocket, request: FastifyRequest) => void;

/**
 * Foundational bare-accept handler: it accepts the connection and cleans up on
 * error/close, but performs NO auth and NO event routing yet.
 */
const bareAcceptHandler: WsConnectionHandler = (socket) => {
  // TODO(T022): replace with cookie-authenticated connect + single-live-session
  // takeover (D40) + a typed event router that validates frames with
  // `parseEvent` from `@nyx/protocol` before dispatch.
  socket.on("message", () => {
    // No-op until T022 wires the event router; frames are intentionally ignored.
  });
  socket.on("error", () => {
    socket.close();
  });
};

/**
 * Register the WebSocket route. Pass a custom `handler` (T022) to take over the
 * connection lifecycle; the default merely accepts and tidies up.
 */
export function registerWs(
  app: FastifyInstance,
  path: string,
  handler: WsConnectionHandler = bareAcceptHandler,
): void {
  app.get(path, { websocket: true }, (socket, request) => {
    handler(socket, request);
  });
}
