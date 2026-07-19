/**
 * Handoff REST client (US13 — FR-074/FR-075/D58/D59) — "take your project home".
 *
 * The thin transport over the three read-only handoff endpoints:
 *
 *   - `POST /projects/:id/clone-token`   → mint a read-only git clone token
 *   - `DELETE /projects/:id/clone-token` → revoke it (immediate, SC-043)
 *   - `GET /projects/:id/archive`        → a source-only zip (a URL, not a fetch)
 *
 * The mint/revoke calls are session-cookie authenticated same-origin requests
 * (`credentials: "include"`), mirroring `wallet/auth.ts` and `ledger/client.ts`.
 * The archive is deliberately NOT fetched here — it is a browser navigation /
 * download, so the client only BUILDS its URL and the UI's download seam
 * triggers it (the cookie rides along on the same-origin GET automatically).
 *
 * The transport is INJECTABLE (`{ fetch, baseUrl }`): the real adapter hits the
 * relative same-origin paths with the HttpOnly session cookie; tests pass a mock
 * `fetch` and never touch a backend. A network throw, a non-2xx status, or a
 * malformed mint body all surface as a typed {@link HandoffFetchError} — a
 * failure is NEVER swallowed into a silent default.
 *
 * The response DTO (`CreateCloneTokenResponse`) comes from `@nyx/protocol` as a
 * TYPE-ONLY import, so no runtime zod enters the web bundle (the token is a
 * plain string, validated structurally here). The empty revoke body
 * (`RevokeCloneTokenResponse = {}`) carries no data, so it is not parsed.
 */
import type { CreateCloneTokenResponse } from "@nyx/protocol";

/** The handoff seam the panel depends on; injected so tests fake it. */
export interface HandoffClient {
  /** Mint (or replace) the read-only clone token (`POST /projects/:id/clone-token`). */
  mintCloneToken(projectId: string): Promise<CreateCloneTokenResponse>;
  /** Revoke the clone token immediately (`DELETE /projects/:id/clone-token`, SC-043). */
  revokeCloneToken(projectId: string): Promise<void>;
  /** Build the source-archive download href (`GET /projects/:id/archive`). Pure. */
  archiveUrl(projectId: string): string;
}

/** Why a {@link HandoffClient} request did not complete. */
export type HandoffFetchReason =
  /** `fetch` threw (offline, DNS, aborted) — never reached a response. */
  | "network"
  /** The server answered with a non-2xx status. */
  | "http"
  /** The body was not JSON, or the mint payload did not carry a token string. */
  | "malformed";

/** A typed handoff-request failure; carries the reason and any HTTP status. */
export class HandoffFetchError extends Error {
  readonly reason: HandoffFetchReason;
  readonly status: number | undefined;

  constructor(reason: HandoffFetchReason, message: string, status?: number) {
    super(message);
    this.name = "HandoffFetchError";
    this.reason = reason;
    this.status = status;
  }
}

/** Injectable transport for {@link createHttpHandoffClient}. */
export interface HttpHandoffClientDeps {
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Base URL prefixed to the relative `/projects/*` paths; defaults to `""`. */
  readonly baseUrl?: string;
}

/** Resolve the `fetch` to use — the injected one, else the global. */
function resolveFetch(deps: HttpHandoffClientDeps | undefined): typeof fetch {
  return deps?.fetch ?? globalThis.fetch;
}

/** Build the clone-token endpoint path for `projectId` under the base URL. */
function cloneTokenPath(baseUrl: string, projectId: string): string {
  return `${baseUrl}/projects/${encodeURIComponent(projectId)}/clone-token`;
}

/** Validate the mint body carries a non-empty token string; else `malformed`. */
function parseCloneToken(raw: unknown): CreateCloneTokenResponse {
  if (typeof raw === "object" && raw !== null) {
    const token = (raw as { cloneToken?: unknown }).cloneToken;
    if (typeof token === "string" && token.length > 0) {
      return { cloneToken: token };
    }
  }
  throw new HandoffFetchError("malformed", "Clone-token response was not in the expected shape.");
}

/**
 * Build the real handoff client. `mintCloneToken`/`revokeCloneToken` hit the
 * same-origin endpoints with the session cookie; every failure mode is a typed
 * {@link HandoffFetchError}. `archiveUrl` is a pure URL builder (no request).
 */
export function createHttpHandoffClient(deps?: HttpHandoffClientDeps): HandoffClient {
  const doFetch = resolveFetch(deps);
  const baseUrl = deps?.baseUrl ?? "";

  return {
    async mintCloneToken(projectId: string): Promise<CreateCloneTokenResponse> {
      let response: Response;
      try {
        response = await doFetch(cloneTokenPath(baseUrl, projectId), {
          method: "POST",
          credentials: "include",
          headers: { accept: "application/json" },
        });
      } catch {
        throw new HandoffFetchError("network", "Could not reach the handoff service.");
      }

      if (!response.ok) {
        throw new HandoffFetchError(
          "http",
          `Clone-token mint failed (${String(response.status)}).`,
          response.status,
        );
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new HandoffFetchError("malformed", "Clone-token response was not valid JSON.");
      }
      return parseCloneToken(raw);
    },

    async revokeCloneToken(projectId: string): Promise<void> {
      let response: Response;
      try {
        response = await doFetch(cloneTokenPath(baseUrl, projectId), {
          method: "DELETE",
          credentials: "include",
          headers: { accept: "application/json" },
        });
      } catch {
        throw new HandoffFetchError("network", "Could not reach the handoff service.");
      }

      if (!response.ok) {
        throw new HandoffFetchError(
          "http",
          `Clone-token revoke failed (${String(response.status)}).`,
          response.status,
        );
      }
      // The revoke body is empty (`RevokeCloneTokenResponse = {}`); nothing to read.
    },

    archiveUrl(projectId: string): string {
      return `${baseUrl}/projects/${encodeURIComponent(projectId)}/archive`;
    },
  };
}
