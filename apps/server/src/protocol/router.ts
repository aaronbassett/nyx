/**
 * Typed WebSocket event router + outbound send (T022).
 *
 * Inbound frames are parsed with `parseEvent("client-to-server", …)` from
 * `@nyx/protocol` — the single source of truth for wire shapes — and dispatched
 * to a handler registered by event `type`. A malformed frame (bad JSON or a
 * schema miss) is reported as a {@link DispatchOutcome}; it never throws, so one
 * bad frame can never crash the socket.
 *
 * Outbound events go through {@link sendEvent}, which validates against the
 * server → client union before serializing, so the server never emits a
 * malformed frame.
 */
import { parseEvent } from "@nyx/protocol";
import type { ClientToServerEvent, ServerToClientEvent } from "@nyx/protocol";
import type { Session } from "./session.js";

/** The minimal outbound surface {@link sendEvent} needs (a `ws` socket satisfies it). */
export interface Sendable {
  send(data: string): void;
}

/**
 * Per-connection context handed to every event handler. Deliberately exposes the
 * authenticated identity and typed I/O only — never the raw socket — so handlers
 * (and their tests) depend on capabilities, not the transport.
 */
export interface ConnectionContext {
  /** The authenticated account for this connection. */
  readonly session: Session;
  /** The project this connection is scoped to (from the `?projectId=` query). */
  readonly projectId: string;
  /** Validate + serialize + send a server → client event. Never throws. */
  send(event: ServerToClientEvent): void;
  /** Close this connection with a WS close code and a short reason. */
  close(code: number, reason: string): void;
}

/** Narrow a client → server event to the variant carrying `type` `T`. */
type ClientEventOf<T extends ClientToServerEvent["type"]> = Extract<
  ClientToServerEvent,
  { type: T }
>;

/** Handler for one client → server event type, receiving the narrowed event. */
export type ClientEventHandler<T extends ClientToServerEvent["type"]> = (
  event: ClientEventOf<T>,
  ctx: ConnectionContext,
) => void | Promise<void>;

/** Loosened handler used only for internal storage (see `on` for why this is sound). */
type AnyClientHandler = (
  event: ClientToServerEvent,
  ctx: ConnectionContext,
) => void | Promise<void>;

/** The result of dispatching one inbound frame. Every path is non-throwing. */
export type DispatchOutcome =
  | { readonly status: "dispatched"; readonly type: ClientToServerEvent["type"] }
  | { readonly status: "unhandled"; readonly type: ClientToServerEvent["type"] }
  | { readonly status: "handler-error"; readonly type: ClientToServerEvent["type"] }
  | { readonly status: "invalid-json" }
  | { readonly status: "invalid-event"; readonly issues: string };

export interface EventRouter {
  /** Register the handler for one client → server event type. Chainable. */
  on<T extends ClientToServerEvent["type"]>(type: T, handler: ClientEventHandler<T>): EventRouter;
  /**
   * Parse one raw text frame and dispatch it to its handler, returning what
   * happened. Never throws: bad JSON, schema misses, missing handlers, and
   * handler faults are all reported as outcomes.
   */
  dispatch(frame: string, ctx: ConnectionContext): DispatchOutcome;
}

/** Condense a Zod error into a compact, log-friendly summary. */
function summarizeIssues(error: {
  issues: readonly { path: (string | number)[]; message: string }[];
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Create an empty {@link EventRouter}. */
export function createEventRouter(): EventRouter {
  const handlers = new Map<ClientToServerEvent["type"], AnyClientHandler>();

  const router: EventRouter = {
    on(type, handler) {
      // Widening the parameter type is sound: dispatch only ever invokes this
      // handler with an event whose `.type` equals the key it was stored under.
      handlers.set(type, handler as AnyClientHandler);
      return router;
    },

    dispatch(frame, ctx) {
      let raw: unknown;
      try {
        raw = JSON.parse(frame);
      } catch {
        return { status: "invalid-json" };
      }

      const parsed = parseEvent("client-to-server", raw);
      if (!parsed.success) {
        return { status: "invalid-event", issues: summarizeIssues(parsed.error) };
      }

      const event = parsed.data;
      const handler = handlers.get(event.type);
      if (handler === undefined) {
        return { status: "unhandled", type: event.type };
      }

      try {
        const result = handler(event, ctx);
        if (result instanceof Promise) {
          // Handlers own their async errors; swallow at the boundary so a
          // rejected promise can never crash the socket or leak an
          // unhandled rejection. (Rich async error propagation is a later story.)
          result.catch(() => undefined);
        }
      } catch {
        return { status: "handler-error", type: event.type };
      }
      return { status: "dispatched", type: event.type };
    },
  };

  return router;
}

/**
 * Serialize a server → client event to a wire frame. NYXT `bigint` amounts have
 * no JSON representation, so they are encoded as decimal strings; the symmetric
 * decode is owned by the wire codec a later protocol task adds. This keeps
 * serialization total (it never throws on a `bigint`).
 */
export function serializeEvent(event: ServerToClientEvent): string {
  return JSON.stringify(event, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * Validate, serialize, and send a server → client event. Returns `false` (and
 * sends nothing) if `event` fails the server → client schema, so a server bug
 * can never put a malformed frame on the wire.
 */
export function sendEvent(socket: Sendable, event: ServerToClientEvent): boolean {
  const parsed = parseEvent("server-to-client", event);
  if (!parsed.success) {
    return false;
  }
  socket.send(serializeEvent(parsed.data));
  return true;
}
