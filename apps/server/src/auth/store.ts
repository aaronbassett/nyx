/**
 * Session + nonce persistence for the auth layer (T036).
 *
 * {@link SessionAuthStore} is the WRITE-capable superset of the read-only
 * {@link SessionStore} the WS layer depends on: it adds nonce issuance, the atomic
 * verify-and-issue path, sliding renewal, and revocation. Defining it as a separate
 * interface keeps `SessionStore` (and its in-memory test doubles that implement only
 * `get`) untouched.
 *
 * All expiry and single-use decisions are made by the DATABASE clock (`now()`),
 * never the process clock, and every value is bound as a parameter — never
 * interpolated into SQL.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { PgSessionStore } from "../protocol/session.js";
import type { Session, SessionStore } from "../protocol/session.js";

/** A freshly issued single-use nonce and its epoch-ms expiry. */
export interface AuthNonce {
  readonly nonce: string;
  readonly expiresAt: number;
}

/** Inputs to the atomic verify-and-issue path. */
export interface IssueRequest {
  /** The server-issued nonce embedded in (and extracted from) the signed message. */
  readonly nonce: string;
  /** The account key — the Bech32m unshielded address (D43). */
  readonly accountAddress: string;
  /**
   * Pure predicate run AFTER the nonce is atomically burned and BEFORE the account
   * and session are written. It performs the signature + key↔address checks. It must
   * not throw. Returning `false` still commits the burn (the nonce is spent on ANY
   * attempt, FR-039) but writes no account or session.
   */
  readonly verify: () => boolean;
}

/** Outcome of {@link SessionAuthStore.issue}. */
export type IssueResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: "nonce" | "signature" };

/**
 * The write-capable session store the auth endpoints and middleware depend on.
 * Extends the read-only {@link SessionStore} so a single implementation serves both
 * the WS read path (`get`) and the US5 write paths.
 */
export interface SessionAuthStore extends SessionStore {
  /** Mint + persist a fresh single-use nonce with a short expiry. */
  issueNonce(): Promise<AuthNonce>;
  /**
   * Atomically burn the nonce (single-use CAS), run `verify`, auto-create the
   * account (D43), and issue a session — all in one transaction so the burn persists
   * on rejection while the account + session commit only on success (FR-039).
   */
  issue(request: IssueRequest): Promise<IssueResult>;
  /** Slide a live session's expiry forward and return its account, or `null`. */
  slide(sessionId: string): Promise<Session | null>;
  /** Revoke a session immediately (logout); idempotent. */
  revoke(sessionId: string): Promise<void>;
}

/** A pooled DB handle that can also open a transaction (a real `Db` satisfies this). */
export type AuthDb = Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

/** Default single-use nonce lifetime — short by design (SIWE). */
export const DEFAULT_NONCE_TTL_MS = 300_000; // 5 minutes.

export interface PgSessionAuthStoreOptions {
  /** 7-day sliding session lifetime in ms (D44); usually `config.tunables.sessionLifetimeMs`. */
  readonly sessionLifetimeMs: number;
  /** Single-use nonce lifetime in ms (default {@link DEFAULT_NONCE_TTL_MS}). */
  readonly nonceTtlMs?: number;
  /** Nonce source; defaults to a cryptographically-random UUID. */
  readonly generateNonce?: () => string;
}

interface SessionIdRow {
  readonly id: string;
}

interface AccountAddressRow {
  readonly account_address: string;
}

interface NonceExpiryRow {
  readonly expires_at_ms: string;
}

/**
 * Postgres-backed {@link SessionAuthStore}. Reads (`get`) delegate to
 * {@link PgSessionStore}; writes express single-use, expiry, and revocation entirely
 * in SQL against the database clock.
 */
export class PgSessionAuthStore implements SessionAuthStore {
  private readonly reader: PgSessionStore;
  private readonly sessionLifetimeMs: number;
  private readonly nonceTtlMs: number;
  private readonly generateNonce: () => string;

  constructor(
    private readonly db: AuthDb,
    options: PgSessionAuthStoreOptions,
  ) {
    this.reader = new PgSessionStore(db);
    this.sessionLifetimeMs = options.sessionLifetimeMs;
    this.nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
    this.generateNonce = options.generateNonce ?? randomUUID;
  }

  get(sessionId: string): Promise<Session | null> {
    return this.reader.get(sessionId);
  }

  async issueNonce(): Promise<AuthNonce> {
    const nonce = this.generateNonce();
    const { rows } = await this.db.query<NonceExpiryRow>(
      `INSERT INTO auth_nonces (nonce, expires_at)
         VALUES ($1, now() + ($2::text || ' milliseconds')::interval)
       RETURNING (extract(epoch from expires_at) * 1000)::bigint AS expires_at_ms`,
      [nonce, this.nonceTtlMs],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("nonce insert returned no row");
    }
    return { nonce, expiresAt: Number(row.expires_at_ms) };
  }

  issue(request: IssueRequest): Promise<IssueResult> {
    return this.db.transaction(async (tx) => {
      // Atomic single-use burn (compare-and-swap): unknown / consumed / expired → 0 rows.
      const burned = await tx.query(
        `UPDATE auth_nonces
            SET consumed_at = now()
          WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING nonce`,
        [request.nonce],
      );
      if (burned.rows.length === 0) {
        return { ok: false, reason: "nonce" };
      }

      // Verify AFTER burning: a rejection here still commits the burn (nonce spent).
      if (!request.verify()) {
        return { ok: false, reason: "signature" };
      }

      // Account auto-create on first sign-in (D43).
      await tx.query(
        `INSERT INTO accounts (address) VALUES ($1) ON CONFLICT (address) DO NOTHING`,
        [request.accountAddress],
      );

      const inserted = await tx.query<SessionIdRow>(
        `INSERT INTO sessions (account_address, expires_at)
           VALUES ($1, now() + ($2::text || ' milliseconds')::interval)
         RETURNING id`,
        [request.accountAddress, this.sessionLifetimeMs],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        // Unexpected: roll the transaction back (un-burning the nonce) and surface 500.
        throw new Error("session insert returned no row");
      }
      return { ok: true, sessionId: row.id };
    });
  }

  async slide(sessionId: string): Promise<Session | null> {
    const { rows } = await this.db.query<AccountAddressRow>(
      `UPDATE sessions
          SET expires_at = now() + ($2::text || ' milliseconds')::interval
        WHERE id = $1 AND expires_at > now() AND revoked_at IS NULL
      RETURNING account_address`,
      [sessionId, this.sessionLifetimeMs],
    );
    const row = rows[0];
    return row === undefined ? null : { accountAddress: row.account_address };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }
}
