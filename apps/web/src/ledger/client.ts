/**
 * `GET /ledger` data-fetch client (US12, FR-070).
 *
 * This is the ONE module in the ledger feature that runtime-imports zod, and it
 * does so deliberately — exactly as `container/ws-client.ts` does for inbound WS
 * frames. Monetary amounts cross the wire as decimal STRINGS (a `bigint` cannot
 * be `JSON.parse`d), so the response body must be decoded string → `bigint`
 * before the rest of the UI touches it. Rather than hand-roll `BigInt()` over an
 * untyped body, we parse it through `@nyx/protocol`'s own `LedgerResponseSchema`,
 * whose transforms perform the canonical decode (and reject a JSON number, which
 * would silently lose precision past 2^53). Isolating the runtime-zod import here
 * keeps it out of every other ledger module (which import `@nyx/protocol`
 * type-only).
 *
 * The transport is INJECTABLE (`{ fetch, baseUrl }`, mirroring `wallet/auth.ts`):
 * the real adapter calls the relative same-origin `/ledger` path with the
 * HttpOnly session cookie (`credentials: "include"`); tests pass a mock `fetch`
 * and never touch a backend. A network error, a non-2xx status, or a
 * malformed/ill-typed body all surface as a typed {@link LedgerFetchError} — a
 * fetch failure is NEVER swallowed into a default balance (FR-070).
 */
import { LedgerResponseSchema } from "@nyx/protocol";
import type { LedgerEntry } from "@nyx/protocol";

/**
 * The decoded ledger snapshot in code: every amount is a `bigint`. Structurally
 * identical to `@nyx/protocol`'s `LedgerResponse`, re-declared here so the
 * feature's public surface does not leak the wire DTO name.
 */
export interface LedgerView {
  /** Available balance; may be negative on final-cycle overage (D34). */
  readonly available: bigint;
  /** Reserved holdings; non-negative. */
  readonly reserved: bigint;
  /** Append-only ledger entries as returned by the server (unordered here). */
  readonly entries: readonly LedgerEntry[];
}

/** The read seam the ledger state depends on; injected so tests fake it. */
export interface LedgerClient {
  /** Fetch + decode the current ledger snapshot (`GET /ledger`). */
  fetchLedger(): Promise<LedgerView>;
}

/** Why a {@link LedgerClient.fetchLedger} call did not yield a decoded snapshot. */
export type LedgerFetchReason =
  /** `fetch` threw (offline, DNS, aborted) — never reached a response. */
  | "network"
  /** The server answered with a non-2xx status. */
  | "http"
  /** The body was not JSON, or did not match the ledger schema (bad amounts). */
  | "malformed";

/** A typed ledger-fetch failure; carries the reason and any HTTP status. */
export class LedgerFetchError extends Error {
  readonly reason: LedgerFetchReason;
  readonly status: number | undefined;

  constructor(reason: LedgerFetchReason, message: string, status?: number) {
    super(message);
    this.name = "LedgerFetchError";
    this.reason = reason;
    this.status = status;
  }
}

/** Injectable transport for {@link createHttpLedgerClient}. */
export interface HttpLedgerClientDeps {
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Base URL prefixed to the relative `/ledger` path; defaults to `""`. */
  readonly baseUrl?: string;
}

/** Resolve the `fetch` to use — the injected one, else the global. */
function resolveFetch(deps: HttpLedgerClientDeps | undefined): typeof fetch {
  return deps?.fetch ?? globalThis.fetch;
}

/**
 * Build the real `GET /ledger` client. `fetchLedger` reads the same-origin
 * endpoint with the session cookie and decodes the string amounts to `bigint`
 * via `LedgerResponseSchema`; every failure mode is a typed {@link LedgerFetchError}.
 */
export function createHttpLedgerClient(deps?: HttpLedgerClientDeps): LedgerClient {
  const doFetch = resolveFetch(deps);
  const baseUrl = deps?.baseUrl ?? "";

  return {
    async fetchLedger(): Promise<LedgerView> {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/ledger`, {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json" },
        });
      } catch {
        throw new LedgerFetchError("network", "Could not reach the ledger service.", undefined);
      }

      if (!response.ok) {
        throw new LedgerFetchError(
          "http",
          `Ledger request failed (${String(response.status)}).`,
          response.status,
        );
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new LedgerFetchError("malformed", "Ledger response was not valid JSON.", undefined);
      }

      // Decode string amounts → bigint. A JSON number or a bad shape fails here
      // rather than silently degrading a balance to an imprecise `Number`.
      const parsed = LedgerResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new LedgerFetchError(
          "malformed",
          "Ledger response did not match the expected shape.",
          undefined,
        );
      }

      return {
        available: parsed.data.available,
        reserved: parsed.data.reserved,
        entries: parsed.data.entries,
      };
    },
  };
}
