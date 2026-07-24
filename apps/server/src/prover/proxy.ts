/**
 * Session-authenticated, same-origin PROVER PROXY (US6 — D37/D62).
 *
 * The interim Nyx-hosted proof server is FOUNDATIONAL infra (provisioned as
 * `infra/prover`; NOT deployed from here). Nyx-app flows (US6 deposits, US8
 * deploys) reach it through this SAME-ORIGIN proxy under COOKIE (session) auth —
 * there are NO proving tokens here: tokens gate only the later PUBLIC escape-hatch
 * exposure (S9/D52). Two pieces:
 *
 *  - a narrow {@link ProverClient} seam ({@link createProverClient}) that relays a
 *    stock proof-server request to the interim prover and returns its response;
 *  - {@link registerProverRoutes}, a Fastify plugin exposing `POST /prover/prove`
 *    behind the shared `requireSession` guard.
 *
 * CONSTITUTION I — the proxy is a TRANSPARENT BYTE/STREAM FORWARD. It NEVER
 * hand-writes any `@midnight-ntwrk/*` proof-server request/response SHAPE from
 * memory: the request body, its content-type, and the response body/status are
 * treated OPAQUELY (see {@link ProxyRequest} / {@link ProxyResult}). The exact
 * prover endpoint is owner-configured/owner-gated (`config.prover.url`, D37/D52).
 *
 * CONSTITUTION III — zero trust. Auth GATES the prover: `requireSession` runs as a
 * `preHandler`, so an unauthenticated request is rejected 401 BEFORE any forward.
 * The prover `baseUrl` (and any prover credential) live SERVER-SIDE only, injected
 * into the client — they never cross to the browser (the client holds no long-lived
 * secret; the session cookie is the only credential the browser carries).
 *
 * Mirrors the external-service client pattern of `../compile/client.ts` and
 * `../wallet/auth.ts`: an injectable `{ fetch?, baseUrl }` transport where a
 * TRANSPORT/gateway fault throws a named {@link ProverUnavailableError}, while a
 * prover HTTP response (any status) is relayed as DATA.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

/**
 * The wildcard route the proxy exposes: `POST /prover/*` relays the captured subpath
 * to `<config.prover.url>/<subpath>`. The modern proof-server protocol POSTs each
 * circuit's serialized preimage to `/check` AND `/prove` (SPIKE-2 §C), so BOTH the US6
 * deposit / US8 deploy flows and the P3 ceremony fallback share this same-origin relay.
 * A same-origin sibling of the app's other routes.
 */
export const PROVER_ROUTE = "/prover/*";

/**
 * An opaque proof-server request captured by the proxy. The bytes and content-type
 * are forwarded to the interim prover UNTOUCHED — this is never parsed as an SDK
 * shape (constitution I). `subpath` is the captured wildcard (e.g. `"prove"` or
 * `"check"`), appended to the prover base URL so the relay stays transparent.
 */
export interface ProxyRequest {
  /** The proof-server subpath to relay to (e.g. `"prove"`, `"check"`), path-safe. */
  readonly subpath: string;
  /** Raw request bytes, relayed to the prover verbatim. */
  readonly body: Buffer;
  /** The caller's `Content-Type`, propagated verbatim (opaque; may be absent). */
  readonly contentType: string | undefined;
}

/**
 * An opaque proof-server response relayed back through the proxy. A prover HTTP
 * response — including a 4xx/5xx — is DATA relayed unchanged; only an unreachable
 * prover (a `fetch` throw) becomes a {@link ProverUnavailableError} at the seam.
 */
export interface ProxyResult {
  /** The prover's HTTP status, relayed unchanged. */
  readonly status: number;
  /** Raw response bytes from the prover, relayed untouched. */
  readonly body: Buffer;
  /** The prover's `Content-Type`, propagated verbatim (opaque; may be absent). */
  readonly contentType: string | undefined;
}

/** The narrow forwarding seam — the ONLY thing the route depends on. */
export interface ProverClient {
  /**
   * Relay one opaque proof-server request to the interim prover (at
   * `<baseUrl>/<request.subpath>`) and return its response. Rejects with a
   * {@link ProverUnavailableError} on a transport/gateway fault; a prover HTTP
   * response (any status) resolves as a {@link ProxyResult}.
   */
  relay(request: ProxyRequest): Promise<ProxyResult>;
}

/**
 * Injectable transport for {@link createProverClient}. `baseUrl` is the interim
 * prover's BASE URL (server-only — `config.prover.url`, never client-bound); the
 * per-request `subpath` (`"check"`/`"prove"`) is appended to it. `fetch` defaults to
 * the global so tests drive a mock.
 */
export interface ProverClientDeps {
  /** The interim prover base URL (server-only, owner-gated; D37/D52). */
  readonly baseUrl: string;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * The interim prover could not be reached — `fetch` threw (network / DNS /
 * connection refused). Distinct from a prover HTTP response (which is relayed as
 * data): this is the throw channel the route maps to a 502, so an unreachable
 * prover never leaks internals and never surfaces as an unhandled rejection.
 */
export class ProverUnavailableError extends Error {
  /** The prover target URL involved in the failed forward. */
  readonly target: string;

  constructor(target: string, cause?: unknown) {
    super(`interim prover unreachable: ${target}`, cause === undefined ? undefined : { cause });
    this.name = "ProverUnavailableError";
    this.target = target;
  }
}

/**
 * Build a {@link ProverClient} that transparently relays a request to the interim
 * prover. The body + content-type go out opaquely; the response status, body, and
 * content-type come back opaquely. A `fetch` throw becomes a named
 * {@link ProverUnavailableError} (the named-unreachable-error mapping used across the
 * server's external-service clients).
 */
export function createProverClient(deps: ProverClientDeps): ProverClient {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");

  return {
    async relay(request: ProxyRequest): Promise<ProxyResult> {
      const target = `${baseUrl}/${request.subpath}`;
      // Only the caller's own content-type is propagated — no SDK shape is assumed.
      const headers: Record<string, string> = {};
      if (request.contentType !== undefined) {
        headers["content-type"] = request.contentType;
      }

      let response: Response;
      try {
        response = await fetchImpl(target, {
          method: "POST",
          headers,
          body: new Uint8Array(request.body),
        });
      } catch (error) {
        throw new ProverUnavailableError(target, error);
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

/** The verdict of a per-session rate-limit check. */
export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs?: number };

/** The authenticated identity a rate-limit check is scoped to (per-session, D52). */
export interface RateLimitContext {
  readonly sessionId: string;
  readonly address: string;
}

/**
 * A per-session rate-limit SEAM. Injected so the real S9/D52 public-exposure limits
 * can slot in later; the default is a no-op (see {@link ALLOW_ALL}). Kept
 * deliberately light — this is an injection POINT, not a full limiter. May answer
 * synchronously or asynchronously (a real limiter is likely Redis-backed).
 */
export interface ProverRateLimiter {
  check(context: RateLimitContext): RateLimitDecision | Promise<RateLimitDecision>;
}

/** The default limiter — allows everything (the real per-session limits are S9/D52). */
const ALLOW_ALL: ProverRateLimiter = {
  check: () => ({ allowed: true }),
};

/** Dependencies for {@link registerProverRoutes}. */
export interface ProverRouteDeps {
  /** The forwarding seam (real client server-side; a fake in tests). */
  readonly proverClient: ProverClient;
  /** The shared session gate built once in `buildServer` from the resolved auth store. */
  readonly requireSession: preHandlerAsyncHookHandler;
  /** Optional per-session rate-limit seam; defaults to {@link ALLOW_ALL} (S9/D52). */
  readonly rateLimiter?: ProverRateLimiter;
}

/** Send a structured JSON error without leaking any internal detail. */
function sendError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).send({ error: message });
}

/** Read the (post-`requireSession`) session identity, or `null` if somehow absent. */
function sessionOf(request: FastifyRequest): RateLimitContext | null {
  const auth = request.auth;
  return auth === null ? null : { sessionId: auth.sessionId, address: auth.address };
}

/**
 * True for a relay subpath that is a safe, single-level (or nested) path segment set:
 * non-empty, no leading slash, no `..`/`//` traversal, and only URL-path-safe chars.
 * The relay appends it to the prover base URL, so a hostile subpath must never be able
 * to repoint the forward off-base (e.g. `../admin`, `//evil.example`).
 */
function isSafeSubpath(subpath: string): boolean {
  if (subpath.length === 0 || subpath.startsWith("/")) {
    return false;
  }
  if (subpath.includes("..") || subpath.includes("//")) {
    return false;
  }
  return /^[A-Za-z0-9._~/-]+$/.test(subpath);
}

/**
 * Register `POST /prover/*` — the same-origin proxy to the interim prover, relaying
 * the captured subpath (`prove`/`check`) to `<baseUrl>/<subpath>`.
 *
 * Side-effect-free registration. The route is placed in an ENCAPSULATED child scope
 * so the catch-all "read the body as bytes" content-type parser (required for a
 * transparent forward) applies ONLY to the prover route and never clobbers JSON
 * parsing on sibling routes when this plugin is mounted on a shared app.
 *
 * Lifecycle: `requireSession` (preHandler) rejects an unauthenticated caller 401
 * BEFORE the handler runs, so the prover is unreachable without a session
 * (constitution III). The handler validates the subpath (400 on a traversal), consults
 * the rate-limit seam (429 on denial, no forward), forwards the opaque bytes to
 * {@link ProverClient.relay}, and relays the prover's status + body + content-type back.
 * A client rejection (transport fault) maps to a 502 with a structured error — never an
 * unhandled throw.
 */
export function registerProverRoutes(app: FastifyInstance, deps: ProverRouteDeps): void {
  const { proverClient, requireSession } = deps;
  const rateLimiter = deps.rateLimiter ?? ALLOW_ALL;

  app.register((scope, _opts, done) => {
    // Encapsulated to this scope: forward EVERY content-type as raw bytes so the
    // proxy stays a transparent relay and never parses the body as an SDK shape.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, onDone) => {
      onDone(null, body);
    });

    scope.post<{ Params: { "*": string } }>(
      PROVER_ROUTE,
      { preHandler: requireSession },
      async (request, reply) => {
        // Defensive: `requireSession` already 401s an unauthenticated request before
        // the handler runs, so this branch is unreachable in practice — but it keeps
        // the prover strictly unreachable without a resolved session.
        const session = sessionOf(request);
        if (session === null) {
          return sendError(reply, 401, "unauthenticated");
        }

        // Guard the relay target: a hostile subpath must never repoint the forward
        // off the configured prover base (constitution III).
        const subpath = request.params["*"];
        if (!isSafeSubpath(subpath)) {
          return sendError(reply, 400, "invalid prover subpath");
        }

        // Per-session rate-limit seam (S9/D52): a denial short-circuits BEFORE any
        // forward, so a throttled caller never reaches the prover.
        const decision = await rateLimiter.check(session);
        if (!decision.allowed) {
          if (decision.retryAfterMs !== undefined) {
            reply.header("retry-after", Math.ceil(decision.retryAfterMs / 1000));
          }
          return sendError(reply, 429, "rate limited");
        }

        const proxyRequest: ProxyRequest = {
          subpath,
          // The buffer content-type parser guarantees a Buffer body (or none).
          body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          contentType: request.headers["content-type"],
        };

        let result: ProxyResult;
        try {
          result = await proverClient.relay(proxyRequest);
        } catch (error) {
          // A transport/gateway fault is mapped to a sane 5xx — internals stay in the
          // log, never in the response body (constitution III).
          request.log.error({ err: error }, "prover: forward to interim prover failed");
          return sendError(reply, 502, "prover unavailable");
        }

        // Relay the prover's opaque response (status + bytes + content-type) verbatim.
        reply.code(result.status);
        if (result.contentType !== undefined) {
          reply.header("content-type", result.contentType);
        }
        return reply.send(result.body);
      },
    );

    done();
  });
}
