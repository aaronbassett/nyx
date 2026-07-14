/**
 * NYXT ledger + deposit HTTP routes (US1/US6 — FR-070/FR-042/D34/D43/D45).
 *
 * Contract (contracts/http-api.md, "Ledger & deposits"):
 *   GET  /ledger          → { available, reserved, entries[] } — server-derived only (FR-070)
 *   POST /deposits { amount } → { depositRef, expiresAt }       — preregisters the ref (D45)
 *   GET  /deposits/:ref   → { status, txRef? }                  — the ref lifecycle read
 *
 * Every route runs behind the injected `requireSession` preHandler and is keyed by the
 * session's unshielded account `address` (D43) — the ledger and every deposit ref belong
 * to that account, so there is no cross-account read/write surface here (the deposit ref
 * READ intentionally answers by ref alone, mirroring the contract, since a ref is an
 * unguessable 256-bit secret the depositor already holds).
 *
 * Money is `bigint` IN CODE and a decimal STRING ON THE WIRE (FR-070): the `GET /ledger`
 * response is serialized through `encodeLedgerResponse` (never a raw `bigint`, which
 * `JSON.stringify` throws on), and `POST /deposits` DECODES its string `amount` through
 * `CreateDepositRequestSchema` (string → `bigint`) at the boundary. Named store errors map
 * to HTTP statuses in one place, mirroring the projects-route convention:
 *   - a body that fails the request schema (malformed / non-positive / a JSON number) → 400;
 *   - a syntactically-valid amount that violates a business bound → 422
 *     (`DepositBelowMinimumError` / `DepositAboveMaximumError`, each with a named reason);
 *   - an unknown deposit ref → 404 (never a silent empty read).
 */
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { CreateDepositRequestSchema, encodeLedgerResponse } from "@nyx/protocol";
import type {
  CreateDepositResponse,
  DepositRef,
  DepositStatusResponse,
  LedgerEntry,
  LedgerResponse,
  MidnightAddress,
} from "@nyx/protocol";
import { DepositAboveMaximumError, DepositBelowMinimumError } from "./deposits.js";
import type { DepositStore } from "./deposits.js";
import type { LedgerEntryRecord, LedgerStore } from "./ledger.js";

export interface LedgerRouteDeps {
  /** Reserve-then-settle metering ledger (D34); the balance + entry read source. */
  readonly ledger: LedgerStore;
  /** Deposit-flow service (D45): pre-registration + ref lifecycle reads. */
  readonly deposits: DepositStore;
  /** Built once in `buildServer` from the resolved auth store and shared here. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

/**
 * Project a store {@link LedgerEntryRecord} onto the wire-bound {@link LedgerEntry}
 * domain shape `encodeLedgerResponse` consumes. `id`/`amount` stay `bigint` (the encoder
 * maps them to decimal strings); the plain `accountAddress` string is re-branded (D43),
 * and a `null` `ref` is OMITTED — never emitted as `ref: undefined` (`exactOptionalPropertyTypes`).
 */
function toLedgerEntry(record: LedgerEntryRecord): LedgerEntry {
  return {
    id: record.id,
    accountAddress: record.accountAddress as MidnightAddress,
    kind: record.kind,
    amount: record.amount,
    ...(record.ref === null ? {} : { ref: record.ref }),
  };
}

/**
 * Map a named deposit store error to its HTTP status + body, or rethrow (→ 500) if
 * unknown. A below/above-bound amount is syntactically valid but violates a business
 * rule, so it is 422 (Unprocessable Entity) — distinct from a malformed body (400). Every
 * monetary field is stringified (never a raw `bigint`, which would break `JSON.stringify`).
 */
function handleDepositError(reply: FastifyReply, error: unknown): void {
  if (error instanceof DepositBelowMinimumError) {
    reply.code(422).send({
      error: "deposit below minimum",
      amount: error.amount.toString(),
      minimum: error.minimum.toString(),
    });
    return;
  }
  if (error instanceof DepositAboveMaximumError) {
    reply.code(422).send({
      error: "deposit above maximum",
      amount: error.amount.toString(),
      maximum: error.maximum.toString(),
    });
    return;
  }
  throw error;
}

/** Register the ledger + deposit endpoints. Side-effect-free. */
export function registerLedgerRoutes(app: FastifyInstance, deps: LedgerRouteDeps): void {
  const { ledger, deposits, requireSession } = deps;

  app.get("/ledger", { preHandler: requireSession }, async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    // Balances are DERIVED server-side (SC-023); the UI never folds them itself (FR-070).
    const [balance, entries] = await Promise.all([
      ledger.getBalance(auth.address),
      ledger.getEntries(auth.address),
    ]);
    const response: LedgerResponse = {
      available: balance.available,
      reserved: balance.reserved,
      entries: entries.map(toLedgerEntry),
    };
    // Encode at the boundary: `bigint` money → decimal string, so the frame is JSON-safe.
    return encodeLedgerResponse(response);
  });

  app.post("/deposits", { preHandler: requireSession }, async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      reply.code(401);
      return { error: "unauthenticated" };
    }
    // Decode the string `amount` → `bigint` at the boundary; a malformed / non-positive /
    // JSON-number body is a 400 (distinct from the 422 business-bound rejections below).
    const parsed = CreateDepositRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid request" };
    }
    try {
      const registration = await deposits.preregister(auth.address, parsed.data.amount);
      reply.code(201);
      const response: CreateDepositResponse = {
        depositRef: registration.ref as DepositRef,
        expiresAt: registration.expiresAt,
      };
      return response;
    } catch (error) {
      handleDepositError(reply, error);
      return reply;
    }
  });

  app.get<{ Params: { ref: string } }>(
    "/deposits/:ref",
    { preHandler: requireSession },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        reply.code(401);
        return { error: "unauthenticated" };
      }
      const view = await deposits.getDeposit(request.params.ref);
      if (view === null) {
        // Fail loudly naming the ref — never a silent empty read (mirrors EC-34).
        reply.code(404);
        return { error: "deposit not found", ref: request.params.ref };
      }
      // The store's `DepositView.status` union is a SUPERSET of the wire enum: its `failed`
      // variant is surfaced via the deposit `CreditOutcome`, never persisted or returned by
      // `getDeposit` under the current schema — so narrowing to the wire status is safe.
      const response: DepositStatusResponse = {
        status: view.status as DepositStatusResponse["status"],
        ...(view.txRef === undefined ? {} : { txRef: view.txRef }),
      };
      return response;
    },
  );
}
