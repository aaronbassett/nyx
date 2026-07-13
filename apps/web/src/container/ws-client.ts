/**
 * US3 — the {@link PreviewBridge} seam implemented over a real browser
 * `WebSocket`.
 *
 * The WebContainer preview host talks to the server (`GET /ws?projectId=<id>`,
 * same-origin) exclusively through the {@link PreviewBridge} seam
 * (`./types`): it `send`s client → server events (dev:status, console:*,
 * test:results, file:changed) and subscribes to server → client events
 * (file:write/delete, contract:deployed, artifacts:ready, session:takeover).
 * This module is the only place that owns a live socket; every other
 * `container/` module depends on the seam and is tested against an in-memory
 * bridge.
 *
 * Frames are UTF-8 JSON text. Inbound frames are UNTRUSTED, so each is decoded
 * defensively — `JSON.parse` then `parseServerToClientEvent` (the shared zod
 * union; runtime validation in the browser bundle is deliberate here) — and any
 * frame that is not valid JSON, is the wrong shape, or carries an unknown type is
 * DROPPED silently. One bad frame can never throw out of an event listener or
 * dispatch to a handler.
 *
 * Outbound client → server events carry no `bigint` (verified against
 * `ClientToServerEvent` in `@nyx/protocol`), so `JSON.stringify` is a total,
 * loss-free serializer for `send`. (The reverse is not symmetric: some server →
 * client events carry `bigint` NYXT amounts that the server wire-encodes as
 * decimal strings; their symmetric decode is a later protocol task. None of the
 * container-relevant server events carry `bigint`, so this bridge decodes every
 * event US3 consumes.)
 *
 * The transport is INJECTABLE via `socketFactory` (default `new WebSocket(url)`)
 * so tests drive the whole lifecycle against a fake with no real network.
 */
import { parseServerToClientEvent } from "@nyx/protocol";
import type { ClientToServerEvent, ServerToClientEvent } from "@nyx/protocol";

import type { PreviewBridge, ServerEventOf, Unsubscribe } from "./types";

/**
 * The minimal `WebSocket` surface the bridge drives. A real browser `WebSocket`
 * is a structural superset of this, so the default factory needs no cast; a test
 * supplies a fake and fires the `on*` handlers directly. The DOM event types keep
 * `new WebSocket(url)` assignable without a cast.
 */
export interface WebSocketLike {
  /** Put a UTF-8 text frame on the wire. */
  send(data: string): void;
  /** Begin closing the connection. */
  close(code?: number, reason?: string): void;
  /** Assigned by the bridge; the socket invokes it once, on open. */
  onopen: ((event: Event) => void) | null;
  /** Assigned by the bridge; the socket invokes it per inbound frame. */
  onmessage: ((event: MessageEvent) => void) | null;
  /** Assigned by the bridge; the socket invokes it once, on close. */
  onclose: ((event: CloseEvent) => void) | null;
}

/** The resolution value of {@link PreviewBridgeConnection.closed}. */
export interface CloseInfo {
  /** The WebSocket close code. */
  readonly code: number;
  /** The WebSocket close reason (possibly empty). */
  readonly reason: string;
}

/** Options for {@link createPreviewBridge}. */
export interface PreviewBridgeOptions {
  /** The project this connection is scoped to (the `?projectId=` query value). */
  readonly projectId: string;
  /**
   * Full socket URL. Defaults to {@link defaultPreviewSocketUrl} over the current
   * page origin (`ws(s)://<host>/ws?projectId=<id>`).
   */
  readonly url?: string;
  /**
   * Socket constructor. Defaults to `(url) => new WebSocket(url)`; tests inject a
   * fake. The browser attaches the same-origin HttpOnly session cookie
   * automatically, so no credentials/headers are set here.
   */
  readonly socketFactory?: (url: string) => WebSocketLike;
  /** Invoked once when the socket opens. */
  readonly onOpen?: () => void;
  /** Invoked once when the socket closes, with the close code and reason. */
  readonly onClose?: (info: CloseInfo) => void;
}

/** A {@link PreviewBridge} plus its connection lifecycle. */
export interface PreviewBridgeConnection extends PreviewBridge {
  /** Close the underlying socket. Idempotent from the caller's perspective. */
  close(): void;
  /** Resolves with the close info when the socket closes. */
  readonly closed: Promise<CloseInfo>;
}

/** A server → client handler stored with its parameter widened to the full union. */
type AnyServerHandler = (event: ServerToClientEvent) => void;

/**
 * Derive the default preview-socket URL from a page `origin`. PURE: it never
 * reads the DOM or the clock. `http(s)` → `ws(s)` by rewriting the scheme prefix,
 * and the `projectId` is percent-encoded so it is safe in the query string.
 */
export function defaultPreviewSocketUrl(projectId: string, origin: string): string {
  const wsOrigin = origin.replace(/^http/u, "ws");
  return `${wsOrigin}/ws?projectId=${encodeURIComponent(projectId)}`;
}

/** Resolve the socket URL — the explicit override, else the page-origin default. */
function resolveUrl(options: PreviewBridgeOptions): string {
  return options.url ?? defaultPreviewSocketUrl(options.projectId, location.origin);
}

/**
 * Open a {@link PreviewBridge} over a real (or injected) `WebSocket`. The socket
 * is created immediately; handlers registered with {@link PreviewBridge.on}
 * before the first frame arrives all receive it.
 */
export function createPreviewBridge(options: PreviewBridgeOptions): PreviewBridgeConnection {
  const socketFactory =
    options.socketFactory ?? ((url: string): WebSocketLike => new WebSocket(url));
  const socket = socketFactory(resolveUrl(options));

  /** type → the set of handlers subscribed to it. */
  const handlers = new Map<ServerToClientEvent["type"], Set<AnyServerHandler>>();

  let signalClosed: ((info: CloseInfo) => void) | undefined;
  const closed = new Promise<CloseInfo>((resolve) => {
    signalClosed = resolve;
  });

  /** Fan a decoded, validated event out to every handler for its type. */
  function dispatch(event: ServerToClientEvent): void {
    const set = handlers.get(event.type);
    if (set === undefined) {
      return;
    }
    for (const handler of set) {
      handler(event);
    }
  }

  /** Decode one inbound frame defensively; drop anything that is not a valid event. */
  function handleFrame(data: unknown): void {
    if (typeof data !== "string") {
      // Not UTF-8 JSON text (e.g. a binary frame) — nothing to decode.
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      // Malformed JSON — drop silently, never throw out of the listener.
      return;
    }
    const parsed = parseServerToClientEvent(raw);
    if (!parsed.success) {
      // Unknown type or invalid payload — the server never sends these; ignore.
      return;
    }
    dispatch(parsed.data);
  }

  socket.onopen = (): void => {
    options.onOpen?.();
  };

  socket.onmessage = (event: MessageEvent): void => {
    // `MessageEvent.data` is `any`; narrow it to `unknown` at the boundary so the
    // decoder only ever sees an untyped value it must validate.
    handleFrame(event.data as unknown);
  };

  socket.onclose = (event: CloseEvent): void => {
    const info: CloseInfo = { code: event.code, reason: event.reason };
    options.onClose?.(info);
    signalClosed?.(info);
  };

  return {
    send(event: ClientToServerEvent): void {
      // No `bigint` in any client → server event, so `JSON.stringify` is total.
      socket.send(JSON.stringify(event));
    },

    on<T extends ServerToClientEvent["type"]>(
      type: T,
      handler: (event: ServerEventOf<T>) => void,
    ): Unsubscribe {
      // Widening the parameter type is sound: `dispatch` only ever invokes this
      // handler with an event whose `.type` equals the key it is stored under, so
      // the runtime event is always assignable to `ServerEventOf<T>`.
      const erased = handler as AnyServerHandler;
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set<AnyServerHandler>();
        handlers.set(type, set);
      }
      set.add(erased);
      return (): void => {
        set.delete(erased);
      };
    },

    close(): void {
      socket.close();
    },

    closed,
  };
}
