/**
 * Ledger + deposit route tests (US1/US6) — driven through `app.inject()` against the
 * real `buildServer` wiring with an injected in-memory auth store (to mint a real session
 * cookie) plus minimal in-memory ledger/deposit stores, so they are fully deterministic
 * with NO external Postgres and NO wallet.
 *
 * Coverage:
 *  - `GET /ledger` derives + serializes STRING money (FR-070): balances and entry
 *    id/amount are decimal strings on the wire (JSON-safe), including a NEGATIVE
 *    available balance (final-cycle overage, D34);
 *  - `POST /deposits` DECODES a string `amount` (string → bigint) → preregisters →
 *    `{ depositRef, expiresAt }` (D45); a malformed body → 400; a below-minimum /
 *    above-maximum amount → 422 with a named reason;
 *  - `GET /deposits/:ref` returns the ref lifecycle status; an unknown ref → 404;
 *  - every route is gated by `requireSession`: an unauthenticated call → 401.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildServer } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createMcpClients } from "../../src/mcp/index.js";
import type { McpSession } from "../../src/mcp/index.js";
import type { Queryable } from "../../src/db/index.js";
import { SESSION_COOKIE_NAME } from "../../src/protocol/index.js";
import { DepositAboveMaximumError, DepositBelowMinimumError } from "../../src/ledger/deposits.js";
import type {
  CreditOutcome,
  DepositRegistration,
  DepositStore,
  DepositView,
  OpenDepositRef,
} from "../../src/ledger/deposits.js";
import type { Balance, LedgerEntryRecord, LedgerStore, Turn } from "../../src/ledger/ledger.js";
import { InMemoryAuthStore } from "../auth/helpers.js";

// ── Test env (mirrors the foundation + projects harnesses) ─────────────────────

const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/nyx_test",
  MCP_TOME_URL: "http://tome.test.local/mcp",
  MCP_MNM_URL: "http://mnm.test.local/mcp",
  PROVER_URL: "http://prover.test.local",
  DEPLOY_KEY: "test-deploy-key",
  MODEL_ROUTING: JSON.stringify({
    supervisor: { provider: "anthropic", model: "claude" },
    scaffolding: { provider: "anthropic", model: "claude" },
    planning: { provider: "anthropic", model: "claude" },
    implementation: { provider: "anthropic", model: "claude" },
    review: { provider: "anthropic", model: "claude" },
  }),
};

const SESSION_LIFETIME_MS = 604_800_000;
const NONCE_TTL_MS = 300_000;

const OWNER = "owner-address";
const FAKE_MINIMUM = 10n;
const FAKE_MAXIMUM = 1_000_000n;

// ── Minimal in-memory stores (only what the routes touch) ──────────────────────

/**
 * Minimal {@link LedgerStore} double: only `getBalance`/`getEntries` are exercised by the
 * routes. Balances + entries are seeded per address; the metering methods reject (never
 * reached by these read routes) so a stray call fails loudly rather than silently passing.
 */
class FakeLedgerStore implements LedgerStore {
  private readonly balances = new Map<string, Balance>();
  private readonly entriesByAddress = new Map<string, LedgerEntryRecord[]>();

  seed(address: string, balance: Balance, entries: LedgerEntryRecord[]): void {
    this.balances.set(address, balance);
    this.entriesByAddress.set(address, entries);
  }

  getBalance(address: string): Promise<Balance> {
    return Promise.resolve(this.balances.get(address) ?? { available: 0n, reserved: 0n });
  }

  getEntries(address: string): Promise<LedgerEntryRecord[]> {
    return Promise.resolve(this.entriesByAddress.get(address) ?? []);
  }

  openTurn(): Promise<Turn> {
    return Promise.reject(new Error("openTurn not used by the ledger read routes"));
  }
  getTurn(): Promise<Turn | null> {
    return Promise.reject(new Error("getTurn not used by the ledger read routes"));
  }
  creditDeposit(): Promise<Balance> {
    return Promise.reject(new Error("creditDeposit not used by the ledger read routes"));
  }
  placeReserve(): Promise<Balance> {
    return Promise.reject(new Error("placeReserve not used by the ledger read routes"));
  }
  settle(): Promise<Balance> {
    return Promise.reject(new Error("settle not used by the ledger read routes"));
  }
  decline(): Promise<Turn> {
    return Promise.reject(new Error("decline not used by the ledger read routes"));
  }
}

/**
 * Minimal {@link DepositStore} double enforcing the configurable min/max bounds via the
 * REAL error classes (so the route's 422 mapping is exercised) and modelling the ref
 * lifecycle read. `observeFinalized`/`expireStale` are unused by the routes and reject.
 */
class FakeDepositStore implements DepositStore {
  private seq = 0;
  private readonly views = new Map<string, DepositView>();
  readonly registrations: { address: string; amount: bigint; ref: string }[] = [];

  constructor(
    private readonly minimum: bigint,
    private readonly maximum: bigint,
    private readonly expiresAt = 1_700_000_000_000,
  ) {}

  preregister(address: string, amount: bigint): Promise<DepositRegistration> {
    if (amount < this.minimum) {
      return Promise.reject(new DepositBelowMinimumError(address, amount, this.minimum));
    }
    if (amount > this.maximum) {
      return Promise.reject(new DepositAboveMaximumError(address, amount, this.maximum));
    }
    this.seq += 1;
    const ref = `dep-ref-${String(this.seq)}`;
    this.registrations.push({ address, amount, ref });
    this.views.set(ref, { status: "preregistered" });
    return Promise.resolve({ ref, expiresAt: this.expiresAt });
  }

  getDeposit(ref: string): Promise<DepositView | null> {
    return Promise.resolve(this.views.get(ref) ?? null);
  }

  observeFinalized(): Promise<CreditOutcome> {
    return Promise.reject(new Error("observeFinalized not used by the deposit routes"));
  }
  expireStale(): Promise<number> {
    return Promise.reject(new Error("expireStale not used by the deposit routes"));
  }
  listOpenRefs(): Promise<readonly OpenDepositRef[]> {
    return Promise.reject(new Error("listOpenRefs not used by the deposit routes"));
  }
}

// ── Boot harness ───────────────────────────────────────────────────────────────

const inertMcpSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: () => Promise.resolve(null),
  close: () => Promise.resolve(),
};

function stubDb(): Queryable {
  return {
    query: <R extends QueryResultRow>(): Promise<QueryResult<R>> =>
      Promise.resolve({ command: "SELECT", rowCount: 1, oid: 0, rows: [], fields: [] }),
  };
}

interface LedgerHarness {
  readonly app: FastifyInstance;
  readonly ledger: FakeLedgerStore;
  readonly deposits: FakeDepositStore;
  readonly seedSession: (address: string) => Promise<string>;
}

async function bootLedger(): Promise<LedgerHarness> {
  const config = loadConfig(TEST_ENV);
  const mcp = createMcpClients(config.mcp, () => Promise.resolve(inertMcpSession));
  const clock = { now: 1_000_000 };
  const authStore = new InMemoryAuthStore({
    clock: () => clock.now,
    sessionLifetimeMs: SESSION_LIFETIME_MS,
    nonceTtlMs: NONCE_TTL_MS,
  });
  const ledger = new FakeLedgerStore();
  const deposits = new FakeDepositStore(FAKE_MINIMUM, FAKE_MAXIMUM);
  const app = await buildServer({
    config,
    db: stubDb(),
    mcp,
    authStore,
    ledgerStore: ledger,
    depositStore: deposits,
  });
  await app.ready();

  const seedSession = async (address: string): Promise<string> => {
    const { nonce } = await authStore.issueNonce();
    const result = await authStore.issue({ nonce, accountAddress: address, verify: () => true });
    if (!result.ok) {
      throw new Error("failed to seed session");
    }
    return `${SESSION_COOKIE_NAME}=${result.sessionId}`;
  };

  return { app, ledger, deposits, seedSession };
}

let h: LedgerHarness;
let ownerCookie: string;

beforeEach(async () => {
  h = await bootLedger();
  ownerCookie = await h.seedSession(OWNER);
});

afterEach(async () => {
  await h.app.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /ledger — server-derived, string money (FR-070/SC-023)", () => {
  it("serializes balances + entry id/amount as decimal strings (JSON-safe)", async () => {
    h.ledger.seed(OWNER, { available: 750n, reserved: 250n }, [
      {
        id: 42n,
        accountAddress: OWNER,
        kind: "deposit_credit",
        amount: 1000n,
        ref: "dep-1",
        createdAt: 1_000_000,
      },
    ]);

    const response = await h.app.inject({
      method: "GET",
      url: "/ledger",
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);

    // `.json()` is `JSON.parse` of the body — every monetary field is a STRING, not a number.
    const body = response.json<{
      available: unknown;
      reserved: unknown;
      entries: { id: unknown; amount: unknown; kind: string; ref?: string }[];
    }>();
    expect(body.available).toBe("750");
    expect(body.reserved).toBe("250");
    expect(typeof body.available).toBe("string");
    const entry = body.entries[0];
    expect(entry?.id).toBe("42");
    expect(entry?.amount).toBe("1000");
    expect(entry?.kind).toBe("deposit_credit");
    expect(entry?.ref).toBe("dep-1");
  });

  it("serializes a NEGATIVE available balance as a signed decimal string (D34 overage)", async () => {
    h.ledger.seed(OWNER, { available: -42n, reserved: 0n }, []);

    const response = await h.app.inject({
      method: "GET",
      url: "/ledger",
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ available: unknown; reserved: unknown; entries: unknown[] }>();
    expect(body.available).toBe("-42");
    expect(body.reserved).toBe("0");
    expect(body.entries).toEqual([]);
  });

  it("rejects an unauthenticated read with 401", async () => {
    const response = await h.app.inject({ method: "GET", url: "/ledger" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /deposits — decode string amount → preregister (D45/FR-042)", () => {
  it("decodes a string amount, preregisters, and returns { depositRef, expiresAt }", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/deposits",
      headers: { cookie: ownerCookie },
      payload: { amount: "100" },
    });
    expect(response.statusCode).toBe(201);

    const body = response.json<{ depositRef: string; expiresAt: number }>();
    expect(body.depositRef).toBe("dep-ref-1");
    expect(body.expiresAt).toBe(1_700_000_000_000);
    // The store saw the DECODED bigint amount keyed to the session address (D43).
    expect(h.deposits.registrations).toEqual([{ address: OWNER, amount: 100n, ref: "dep-ref-1" }]);
  });

  it("rejects a malformed body (JSON number / non-positive) with 400", async () => {
    const asNumber = await h.app.inject({
      method: "POST",
      url: "/deposits",
      headers: { cookie: ownerCookie },
      payload: { amount: 100 },
    });
    expect(asNumber.statusCode).toBe(400);

    const zero = await h.app.inject({
      method: "POST",
      url: "/deposits",
      headers: { cookie: ownerCookie },
      payload: { amount: "0" },
    });
    expect(zero.statusCode).toBe(400);
  });

  it("maps a below-minimum amount to 422 with a named reason", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/deposits",
      headers: { cookie: ownerCookie },
      payload: { amount: "5" },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: string; amount: string; minimum: string }>();
    expect(body.error).toBe("deposit below minimum");
    expect(body.amount).toBe("5");
    expect(body.minimum).toBe("10");
  });

  it("maps an above-maximum amount to 422 with a named reason", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/deposits",
      headers: { cookie: ownerCookie },
      payload: { amount: "2000000" },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: string; amount: string; maximum: string }>();
    expect(body.error).toBe("deposit above maximum");
    expect(body.amount).toBe("2000000");
    expect(body.maximum).toBe("1000000");
  });

  it("rejects an unauthenticated deposit with 401", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/deposits",
      payload: { amount: "100" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /deposits/:ref — ref lifecycle read", () => {
  it("returns the status for a known ref", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/deposits",
      headers: { cookie: ownerCookie },
      payload: { amount: "100" },
    });
    const { depositRef } = created.json<{ depositRef: string }>();

    const response = await h.app.inject({
      method: "GET",
      url: `/deposits/${depositRef}`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("preregistered");
  });

  it("returns 404 naming the ref for an unknown deposit", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/deposits/does-not-exist",
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ ref: string }>().ref).toBe("does-not-exist");
  });

  it("rejects an unauthenticated ref read with 401", async () => {
    const response = await h.app.inject({ method: "GET", url: "/deposits/dep-ref-1" });
    expect(response.statusCode).toBe(401);
  });
});
