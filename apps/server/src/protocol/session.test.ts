/**
 * Session validation tests for the WS session layer (T022).
 *
 * Deterministic and DB-free: {@link PgSessionStore} is driven by a faked
 * {@link Queryable} that models the sessions table and applies the SAME
 * predicate the real SQL does (id match AND not expired AND not revoked). This
 * proves the store maps a filtered row to a {@link Session} and every other case
 * to `null` — and, separately, that it asks the database to apply that filter
 * (asserted against the emitted SQL text). The live predicate against real
 * Postgres is covered by the schema suite behind DATABASE_URL.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../db/index.js";
import { PgSessionStore, SESSION_COOKIE_NAME } from "./session.js";

interface SeedSession {
  readonly id: string;
  readonly accountAddress: string;
  /** Models `expires_at <= now()`. */
  readonly expired?: boolean;
  /** Models `revoked_at IS NOT NULL`. */
  readonly revoked?: boolean;
}

/** A faked Queryable that applies the sessions-table predicate and records SQL. */
function fakeDb(seed: readonly SeedSession[]): {
  readonly db: Queryable;
  readonly lastSql: () => string;
} {
  let sql = "";
  const db: Queryable = {
    query: <R extends QueryResultRow>(
      text: string,
      params?: unknown[],
    ): Promise<QueryResult<R>> => {
      sql = text;
      const id = params?.[0];
      const match = seed.find(
        (session) => session.id === id && session.expired !== true && session.revoked !== true,
      );
      const rows =
        match === undefined ? [] : [{ account_address: match.accountAddress } as unknown as R];
      return Promise.resolve({
        command: "SELECT",
        rowCount: rows.length,
        oid: 0,
        rows,
        fields: [],
      });
    },
  };
  return { db, lastSql: () => sql };
}

const LIVE: SeedSession = { id: "live", accountAddress: "addr_live" };
const EXPIRED: SeedSession = { id: "expired", accountAddress: "addr_expired", expired: true };
const REVOKED: SeedSession = { id: "revoked", accountAddress: "addr_revoked", revoked: true };

describe("PgSessionStore.get", () => {
  it("resolves a live session to its account address", async () => {
    const { db } = fakeDb([LIVE, EXPIRED, REVOKED]);
    const session = await new PgSessionStore(db).get("live");
    expect(session).toEqual({ accountAddress: "addr_live" });
  });

  it("returns null for an expired session", async () => {
    const { db } = fakeDb([EXPIRED]);
    expect(await new PgSessionStore(db).get("expired")).toBeNull();
  });

  it("returns null for a revoked session", async () => {
    const { db } = fakeDb([REVOKED]);
    expect(await new PgSessionStore(db).get("revoked")).toBeNull();
  });

  it("returns null for an unknown session id", async () => {
    const { db } = fakeDb([LIVE]);
    expect(await new PgSessionStore(db).get("does-not-exist")).toBeNull();
  });

  it("passes the session id as a bound parameter, never interpolated", async () => {
    const captured: unknown[][] = [];
    const db: Queryable = {
      query: <R extends QueryResultRow>(
        _text: string,
        params?: unknown[],
      ): Promise<QueryResult<R>> => {
        captured.push(params ?? []);
        return Promise.resolve({
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          rows: [] as R[],
          fields: [],
        });
      },
    };
    await new PgSessionStore(db).get("abc-123");
    expect(captured).toEqual([["abc-123"]]);
  });

  it("asks the database to filter on expiry and revocation", async () => {
    const { db, lastSql } = fakeDb([LIVE]);
    await new PgSessionStore(db).get("live");
    expect(lastSql()).toContain("expires_at > now()");
    expect(lastSql()).toContain("revoked_at IS NULL");
  });
});

describe("SESSION_COOKIE_NAME", () => {
  it("is the shared constant US5 reuses for issuance/logout", () => {
    expect(SESSION_COOKIE_NAME).toBe("nyx_session");
  });
});
