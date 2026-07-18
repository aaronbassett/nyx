/**
 * US12 — `GET /ledger` client decode + typed errors (FR-070).
 *
 * The client is the one place string wire amounts are decoded to `bigint` (via
 * `@nyx/protocol`'s `LedgerResponseSchema`). These tests prove: string → bigint
 * decode (including a NEGATIVE `available`, D34), the same-origin cookie request
 * shape, and that every failure mode (network throw, non-2xx, malformed / bad
 * shape) surfaces as a typed `LedgerFetchError` rather than a silent default.
 */
import { describe, expect, it, vi } from "vitest";

import { createHttpLedgerClient, LedgerFetchError } from "@/ledger/client";
import type { LedgerResponseWire, MidnightAddress } from "@nyx/protocol";

const ADDR = "addr1" as MidnightAddress;

/** A minimal `Response` stand-in exposing just what the client reads. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const WIRE: LedgerResponseWire = {
  available: "-42",
  reserved: "1000",
  entries: [
    { id: "5", accountAddress: ADDR, kind: "settlement", amount: "7", ref: "turn-1" },
    { id: "4", accountAddress: ADDR, kind: "deposit_credit", amount: "1000", ref: "dep-9" },
  ],
};

describe("createHttpLedgerClient", () => {
  it("decodes string amounts to bigint, including a negative available (D34)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(WIRE))) as unknown as typeof fetch;
    const client = createHttpLedgerClient({ fetch: fetchMock });

    const view = await client.fetchLedger();

    expect(view.available).toBe(-42n);
    expect(view.reserved).toBe(1000n);
    expect(view.entries).toHaveLength(2);
    const [first] = view.entries;
    expect(first?.id).toBe(5n);
    expect(first?.amount).toBe(7n);
    expect(first?.kind).toBe("settlement");
    // Decoded to real bigints, never Number.
    expect(typeof view.available).toBe("bigint");
    expect(typeof first?.amount).toBe("bigint");
  });

  it("requests the same-origin /ledger path with the session cookie", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(WIRE))) as unknown as typeof fetch;
    const client = createHttpLedgerClient({ fetch: fetchMock, baseUrl: "https://api.test" });

    await client.fetchLedger();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/ledger",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("throws a typed network error when fetch rejects", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const client = createHttpLedgerClient({ fetch: fetchMock });

    await expect(client.fetchLedger()).rejects.toBeInstanceOf(LedgerFetchError);
    await expect(client.fetchLedger()).rejects.toMatchObject({ reason: "network" });
  });

  it("throws a typed http error on a non-2xx status", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({}, { ok: false, status: 401 })),
    ) as unknown as typeof fetch;
    const client = createHttpLedgerClient({ fetch: fetchMock });

    await expect(client.fetchLedger()).rejects.toMatchObject({ reason: "http", status: 401 });
  });

  it("throws a typed malformed error when a numeric amount is on the wire", async () => {
    // A JSON number (not a decimal string) must be rejected — it would lose
    // precision past 2^53. The schema fails, so the client throws.
    const badBody = { available: 42, reserved: "0", entries: [] };
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(badBody)),
    ) as unknown as typeof fetch;
    const client = createHttpLedgerClient({ fetch: fetchMock });

    await expect(client.fetchLedger()).rejects.toMatchObject({ reason: "malformed" });
  });

  it("throws a typed malformed error when the body is not valid JSON", async () => {
    const throwingResponse = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    } as unknown as Response;
    const fetchMock = vi.fn(() => Promise.resolve(throwingResponse)) as unknown as typeof fetch;
    const client = createHttpLedgerClient({ fetch: fetchMock });

    await expect(client.fetchLedger()).rejects.toMatchObject({ reason: "malformed" });
  });
});
