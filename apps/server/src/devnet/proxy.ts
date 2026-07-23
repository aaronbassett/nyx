/**
 * Session-authenticated, same-origin DEVNET FORWARDING PROXY (P3 Task 1).
 *
 * Under cross-origin isolation (COOP/COEP) the DApp frontend in the browser
 * cannot fetch the local devnet's `localhost:9944` (node) / `localhost:8088`
 * (indexer) endpoints directly, so it talks SAME-ORIGIN to the Nyx server, which
 * forwards opaquely to the devnet. This module is the server side of that: a pair
 * of transparent forwarders + the Fastify routes that expose them, cloned from the
 * prover-proxy pattern (`../prover/proxy.ts`).
 *
 * Two forwarding shapes, because SPIKE-2's verified submit path needs both:
 *  - HTTP: {@link createDevnetForwarder} + `POST|GET /devnet/{node,indexer}/*` —
 *    an opaque byte relay (request bytes + content-type out, response
 *    status/bytes/content-type back).
 *  - WebSocket: {@link createDevnetWsRelay} + a session-gated upgrade on the SAME
 *    two prefixes — a thin socket-pair relay (browser WS ↔ a server-side `ws`
 *    client to the devnet's `ws://` endpoints). Submission rides the node WS relay
 *    (`ws://…:9944`) and wallet sync rides the indexer WS
 *    (`ws://…:8088/api/v4/graphql/ws`), so both must be reachable same-origin.
 *
 * CONSTITUTION I — TRANSPARENT relay. Neither the HTTP forwarder nor the WS relay
 * ever parses a node/indexer payload or frame as an `@midnight-ntwrk/*` SDK shape:
 * bodies, content-types, and frames are treated OPAQUELY. The target endpoint URLs
 * come from the server-side {@link NetworkProfile} config (`config.network.*`),
 * never hand-written.
 *
 * CONSTITUTION III — zero trust. `requireSession` runs as a `preHandler`, so an
 * unauthenticated request is rejected 401 (or its WS upgrade aborted) BEFORE any
 * forward. The devnet endpoint URLs live SERVER-SIDE only, injected into the
 * forwarders/relays — the browser never learns them beyond the same-origin path.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { WebSocket as WsWebSocket } from "ws";
import type { RawData } from "ws";

/** The two forwarded devnet prefixes (public, same-origin sibling routes). */
export const DEVNET_NODE_PREFIX = "/devnet/node";
export const DEVNET_INDEXER_PREFIX = "/devnet/indexer";

/** The indexer's WebSocket sub-path (GraphQL subscriptions; SPIKE-1 risk 7). */
export const INDEXER_WS_SUBPATH = "/api/v4/graphql/ws";

/**
 * An opaque devnet HTTP request captured by the proxy. The method, subpath, query
 * string, body bytes, and content-type are forwarded to the devnet UNTOUCHED —
 * never parsed as an SDK shape (constitution I).
 */
export interface ForwardRequest {
  /** The HTTP method (`GET` | `POST`), relayed verbatim. */
  readonly method: string;
  /** The path AFTER the prefix (e.g. `/api/foo`; a leading slash is optional). */
  readonly subpath: string;
  /** The raw query string WITHOUT the leading `?` (may be empty). */
  readonly query: string;
  /** Raw request bytes, relayed verbatim; `undefined` for a bodyless (GET) request. */
  readonly body: Buffer | undefined;
  /** The caller's `Content-Type`, propagated verbatim (opaque; may be absent). */
  readonly contentType: string | undefined;
}

/**
 * An opaque devnet HTTP response relayed back through the proxy. A devnet HTTP
 * response — including a 4xx/5xx — is DATA relayed unchanged; only an unreachable
 * devnet (a `fetch` throw) becomes a {@link DevnetUnavailableError} at the seam.
 */
export interface ForwardResult {
  /** The devnet's HTTP status, relayed unchanged. */
  readonly status: number;
  /** Raw response bytes from the devnet, relayed untouched. */
  readonly body: Buffer;
  /** The devnet's `Content-Type`, propagated verbatim (opaque; may be absent). */
  readonly contentType: string | undefined;
}

/** The narrow HTTP forwarding seam — the ONLY thing the route depends on. */
export interface DevnetForwarder {
  /**
   * Relay one opaque devnet HTTP request to the target and return its response.
   * Rejects with a {@link DevnetUnavailableError} on a transport/gateway fault; a
   * devnet HTTP response (any status) resolves as a {@link ForwardResult}.
   */
  forward(request: ForwardRequest): Promise<ForwardResult>;
}

/**
 * Injectable transport for {@link createDevnetForwarder}. `baseUrl` is the devnet
 * endpoint (server-only — `config.network.nodeUrl` / `config.network.indexerUrl`,
 * never client-bound); `fetch` defaults to the global so tests drive a mock.
 */
export interface DevnetForwarderDeps {
  /** The devnet endpoint base URL (server-only; from the NetworkProfile). */
  readonly baseUrl: string;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * The devnet endpoint could not be reached — `fetch` threw (network / DNS /
 * connection refused). Distinct from a devnet HTTP response (which is relayed as
 * data): this is the throw channel the route maps to a 502, so an unreachable
 * devnet never leaks internals and never surfaces as an unhandled rejection.
 */
export class DevnetUnavailableError extends Error {
  /** The devnet target URL involved in the failed forward. */
  readonly target: string;

  constructor(target: string, cause?: unknown) {
    super(`devnet endpoint unreachable: ${target}`, cause === undefined ? undefined : { cause });
    this.name = "DevnetUnavailableError";
    this.target = target;
  }
}

/** Build `<base><subpath>?<query>`, normalising the base/subpath slash boundary. */
function buildTarget(base: string, subpath: string, query: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const path = subpath.startsWith("/") ? subpath : `/${subpath}`;
  const suffix = query.length > 0 ? `?${query}` : "";
  return `${trimmedBase}${path}${suffix}`;
}

/**
 * Build a {@link DevnetForwarder} that transparently relays a request to a devnet
 * endpoint. The method, body + content-type go out opaquely; the response status,
 * body, and content-type come back opaquely. A `fetch` throw becomes a named
 * {@link DevnetUnavailableError} (the named-unreachable-error mapping used across the
 * server's external-service clients). A GET (or HEAD) sends no body.
 */
export function createDevnetForwarder(deps: DevnetForwarderDeps): DevnetForwarder {
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  return {
    async forward(request: ForwardRequest): Promise<ForwardResult> {
      const target = buildTarget(deps.baseUrl, request.subpath, request.query);

      // Only the caller's own content-type is propagated — no SDK shape is assumed.
      const headers: Record<string, string> = {};
      if (request.contentType !== undefined) {
        headers["content-type"] = request.contentType;
      }

      const bodyless = request.method === "GET" || request.method === "HEAD";
      const init: RequestInit = { method: request.method, headers };
      if (!bodyless && request.body !== undefined) {
        init.body = new Uint8Array(request.body);
      }

      let response: Response;
      try {
        response = await fetchImpl(target, init);
      } catch (error) {
        throw new DevnetUnavailableError(target, error);
      }

      const bytes = await response.arrayBuffer();
      return {
        status: response.status,
        body: Buffer.from(bytes),
        contentType: response.headers.get("content-type") ?? undefined,
      };
    },
  };
}

/**
 * A transparent WebSocket relay for one browser socket: it opens a server-side
 * `ws` client to a fixed devnet `ws://` target and pipes frames verbatim both ways.
 */
export interface DevnetWsRelay {
  /** Attach `client` (the browser socket) to a fresh upstream devnet connection. */
  relay(client: WsWebSocket): void;
}

/**
 * Injectable deps for {@link createDevnetWsRelay}. `targetUrl` is the devnet `ws://`
 * endpoint (server-only, derived from the NetworkProfile via {@link httpToWs});
 * `connect` defaults to opening a real `ws` client so tests can point at a local
 * echo server (or inject a fake).
 */
export interface DevnetWsRelayDeps {
  /** The devnet WebSocket target (server-only; `ws://…` from the NetworkProfile). */
  readonly targetUrl: string;
  /** Upstream-connection factory; defaults to `new WsWebSocket(url)`. */
  readonly connect?: (url: string) => WsWebSocket;
}

/** Map an `http(s)://` endpoint to its `ws(s)://` equivalent, preserving host/path. */
export function httpToWs(url: string): string {
  return url.replace(/^http(s)?:\/\//i, (_match, secure: string | undefined) =>
    secure === undefined ? "ws://" : "wss://",
  );
}

/** A close code the WS protocol permits sending (1005/1006/1015 are receive-only). */
function safeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) {
    return 1000;
  }
  if (code >= 1000 && code <= 4999) {
    return code;
  }
  return 1000;
}

/** Close a socket only if it is still open/connecting; never throw. */
function safeClose(socket: WsWebSocket, code: number, reason: string): void {
  if (socket.readyState === WsWebSocket.OPEN || socket.readyState === WsWebSocket.CONNECTING) {
    try {
      socket.close(code, reason.slice(0, 120));
    } catch {
      socket.terminate();
    }
  }
}

/**
 * Build a {@link DevnetWsRelay}. Each {@link DevnetWsRelay.relay} call opens ONE
 * upstream `ws` connection to `targetUrl` and bridges it to the browser socket:
 * frames (binary + text) are forwarded verbatim both directions, client frames
 * that arrive before the upstream is open are queued, and a close/error on EITHER
 * side tears down BOTH. The relay never inspects a frame (constitution I).
 */
export function createDevnetWsRelay(deps: DevnetWsRelayDeps): DevnetWsRelay {
  const connect = deps.connect ?? ((url: string): WsWebSocket => new WsWebSocket(url));

  return {
    relay(client: WsWebSocket): void {
      const upstream = connect(deps.targetUrl);
      const pending: { data: RawData; isBinary: boolean }[] = [];
      let upstreamReady = false;
      let torndown = false;

      const teardown = (code: number, reason: string): void => {
        if (torndown) {
          return;
        }
        torndown = true;
        safeClose(client, code, reason);
        safeClose(upstream, code, reason);
      };

      upstream.on("open", () => {
        upstreamReady = true;
        for (const frame of pending.splice(0)) {
          upstream.send(frame.data, { binary: frame.isBinary });
        }
      });
      upstream.on("message", (data: RawData, isBinary: boolean) => {
        if (client.readyState === WsWebSocket.OPEN) {
          client.send(data, { binary: isBinary });
        }
      });
      upstream.on("close", (code: number, reason: Buffer) => {
        teardown(safeCloseCode(code), reason.toString("utf8"));
      });
      upstream.on("error", () => {
        teardown(1011, "devnet upstream error");
      });

      client.on("message", (data: RawData, isBinary: boolean) => {
        if (upstreamReady && upstream.readyState === WsWebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        } else if (!torndown) {
          pending.push({ data, isBinary });
        }
      });
      client.on("close", (code: number, reason: Buffer) => {
        teardown(safeCloseCode(code), reason.toString("utf8"));
      });
      client.on("error", () => {
        teardown(1011, "devnet client error");
      });
    },
  };
}

/** Dependencies for {@link registerDevnetRoutes}. */
export interface DevnetRouteDeps {
  /** The node HTTP forwarding seam (real forwarder server-side; a fake in tests). */
  readonly nodeForwarder: DevnetForwarder;
  /** The indexer HTTP forwarding seam. */
  readonly indexerForwarder: DevnetForwarder;
  /** The shared session gate built once in `buildServer` from the resolved auth store. */
  readonly requireSession: preHandlerAsyncHookHandler;
  /** The node WebSocket relay (submission rides `ws://…:9944`). */
  readonly nodeWsRelay: DevnetWsRelay;
  /** The indexer WebSocket relay (wallet sync rides `ws://…:8088/api/v4/graphql/ws`). */
  readonly indexerWsRelay: DevnetWsRelay;
}

/** Send a structured JSON error without leaking any internal detail. */
function sendError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).send({ error: message });
}

/** Extract the (post-prefix) wildcard subpath from a matched request. */
function subpathOf(request: FastifyRequest): string {
  const params = request.params as Record<string, string | undefined>;
  const wildcard = params["*"] ?? "";
  return wildcard.startsWith("/") ? wildcard : `/${wildcard}`;
}

/** Extract the raw query string (without `?`) from the untouched request URL. */
function queryOf(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? "";
  const idx = rawUrl.indexOf("?");
  return idx >= 0 ? rawUrl.slice(idx + 1) : "";
}

/**
 * Register one encapsulated prefix — its `GET|POST /<prefix>/*` HTTP forwarder AND
 * its session-gated WebSocket relay (dual handler). The catch-all buffer
 * content-type parser is confined to this child scope so a transparent forward
 * never clobbers sibling routes' JSON parsing. `requireSession` (preHandler) gates
 * both the HTTP forward and the WS upgrade BEFORE either runs (constitution III).
 */
function registerPrefix(
  app: FastifyInstance,
  prefix: string,
  forwarder: DevnetForwarder,
  wsRelay: DevnetWsRelay,
  requireSession: preHandlerAsyncHookHandler,
): void {
  app.register((scope, _opts, done) => {
    // Encapsulated to this scope: forward EVERY content-type as raw bytes so the
    // proxy stays a transparent relay and never parses the body as an SDK shape.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, onDone) => {
      onDone(null, body);
    });

    // Opaque byte forward to the devnet endpoint (both methods share it).
    const httpHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const method = request.method;
      const bodyless = method === "GET" || method === "HEAD";
      const forwardRequest: ForwardRequest = {
        method,
        subpath: subpathOf(request),
        query: queryOf(request),
        body: bodyless ? undefined : Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        contentType: request.headers["content-type"],
      };

      let result: ForwardResult;
      try {
        result = await forwarder.forward(forwardRequest);
      } catch (error) {
        // A transport/gateway fault maps to a sane 5xx — internals stay in the
        // log, never in the response body (constitution III).
        request.log.error({ err: error }, `devnet: forward to ${prefix} failed`);
        return sendError(reply, 502, "devnet unreachable");
      }

      reply.code(result.status);
      if (result.contentType !== undefined) {
        reply.header("content-type", result.contentType);
      }
      return reply.send(result.body);
    };

    // POST: HTTP forward only.
    scope.route({
      method: "POST",
      url: `${prefix}/*`,
      preHandler: requireSession,
      handler: httpHandler,
    });

    // GET: HTTP forward AND the WebSocket relay (@fastify/websocket requires the
    // wsHandler to live on a GET-only route). `requireSession` (preHandler) gates
    // both — an unauthenticated upgrade is 401'd BEFORE the socket is handed over.
    scope.route({
      method: "GET",
      url: `${prefix}/*`,
      preHandler: requireSession,
      handler: httpHandler,
      wsHandler: (socket) => {
        wsRelay.relay(socket);
      },
    });

    done();
  });
}

/**
 * Register the same-origin devnet forwarding surface: `GET|POST /devnet/node/*`
 * and `GET|POST /devnet/indexer/*`, each with an HTTP byte forwarder and a
 * session-gated WebSocket relay, all behind the shared `requireSession` guard.
 *
 * Side-effect-free registration. Each prefix lives in its OWN encapsulated child
 * scope (like the prover proxy) so the catch-all buffer parser applies only there.
 * Requires `@fastify/websocket` to be registered on `app` first (buildServer does).
 */
export function registerDevnetRoutes(app: FastifyInstance, deps: DevnetRouteDeps): void {
  registerPrefix(
    app,
    DEVNET_NODE_PREFIX,
    deps.nodeForwarder,
    deps.nodeWsRelay,
    deps.requireSession,
  );
  registerPrefix(
    app,
    DEVNET_INDEXER_PREFIX,
    deps.indexerForwarder,
    deps.indexerWsRelay,
    deps.requireSession,
  );
}
