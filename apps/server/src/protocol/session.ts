/**
 * WS session validation layer (T022).
 *
 * The connection handler authenticates a WebSocket upgrade by resolving the
 * session cookie to an account via a {@link SessionStore}. This module owns the
 * READ/validate half only.
 *
 * BOUNDARY (US5, T035/T036): session ISSUANCE, the 7-day sliding-expiry bump,
 * and logout revocation are NOT built here. This layer only reads an existing
 * session and reports whether it is currently valid. US5 reuses
 * {@link SESSION_COOKIE_NAME} so both halves agree on the cookie name.
 */
import type { Queryable } from "../db/index.js";

/**
 * Name of the cookie that carries the session id. Exported so US5 (session
 * issuance/logout) sets and clears exactly the cookie this layer reads.
 */
export const SESSION_COOKIE_NAME = "nyx_session";

/** A validated, live session. The account is the Midnight unshielded address (D43). */
export interface Session {
  readonly accountAddress: string;
}

/**
 * Resolves a session id to its owning account. Injectable so the integration
 * test (T024) and unit tests can supply an in-memory implementation with no
 * database.
 */
export interface SessionStore {
  /**
   * Returns the session iff it exists, has `expires_at > now()`, and is not
   * revoked (`revoked_at IS NULL`). Returns `null` for every other case
   * (missing, expired, or revoked) — never throws for "not found".
   */
  get(sessionId: string): Promise<Session | null>;
}

/** Columns projected by the session lookup query. */
interface SessionRow {
  readonly account_address: string;
}

/**
 * Postgres-backed {@link SessionStore}. Validation is expressed entirely in SQL
 * so expiry and revocation are checked against the database clock, never the
 * process clock. READS only — issuance/renewal/logout are US5.
 */
export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Queryable) {}

  async get(sessionId: string): Promise<Session | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT account_address
         FROM sessions
        WHERE id = $1
          AND expires_at > now()
          AND revoked_at IS NULL`,
      [sessionId],
    );
    const row = rows[0];
    return row === undefined ? null : { accountAddress: row.account_address };
  }
}
