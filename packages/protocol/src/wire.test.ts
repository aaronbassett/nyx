import { describe, expect, it } from "vitest";

import {
  CreateDepositRequestSchema,
  encodeCreateDepositRequest,
  encodeLedgerEntry,
  encodeLedgerResponse,
  encodeLedgerUpdateEvent,
  encodeNyxtAmount,
  encodeTurnSettledEvent,
  LedgerEntrySchema,
  LedgerResponseSchema,
  LedgerUpdateEventSchema,
  NyxtAmountSchema,
  NyxtSignedAmountSchema,
  TurnIdSchema,
  TurnSettledEventSchema,
  type LedgerEntry,
  type LedgerResponse,
  type LedgerUpdateEvent,
  type TurnSettledEvent,
} from "./index.js";

const ts = 1_752_000_000_000;

// Representative amounts, chosen to exercise the whole contract:
//  - `ZERO`     — boundary, must survive as `"0"`, not `""` or `null`.
//  - `HUGE`     — 2^63 + 1, beyond Number.MAX_SAFE_INTEGER and NOT representable
//                 as a JS double (2^63 itself is, being a power of two), so it
//                 proves a JS number would lose precision where a string does not.
//  - `NEGATIVE` — a below-zero balance (final-cycle overage, D34).
const ZERO = 0n;
const HUGE = 9_223_372_036_854_775_809n;
const NEGATIVE = -42n;

/** Build a domain {@link LedgerEntry} (bigint `id`/`amount`) from its wire form. */
const sampleEntry = (): LedgerEntry =>
  LedgerEntrySchema.parse({
    id: "42",
    accountAddress: "mn_addr_test1qexample",
    kind: "deposit_credit",
    amount: "1000",
    ref: "dep-1",
  });

describe("bigint amount codec — round-trip", () => {
  it("round-trips 0n through encode → JSON.stringify → JSON.parse → decode", () => {
    const decoded = NyxtAmountSchema.parse(JSON.parse(JSON.stringify(encodeNyxtAmount(ZERO))));
    expect(decoded).toBe(ZERO);
  });

  it("round-trips a value beyond 2^63 with no precision loss", () => {
    const wire = encodeNyxtAmount(HUGE);
    expect(wire).toBe("9223372036854775809");
    // The decimal string is exact; routing the same value through a JS number is lossy.
    expect(BigInt(wire)).toBe(HUGE);
    expect(BigInt(Number(wire))).not.toBe(HUGE);
    const decoded = NyxtAmountSchema.parse(JSON.parse(JSON.stringify(wire)));
    expect(decoded).toBe(HUGE);
  });

  it("round-trips a negative balance through the signed codec", () => {
    const decoded = NyxtSignedAmountSchema.parse(
      JSON.parse(JSON.stringify(encodeNyxtAmount(NEGATIVE))),
    );
    expect(decoded).toBe(NEGATIVE);
  });
});

describe("bigint amount codec — inbound decode", () => {
  it("parses a decimal string to a bigint", () => {
    expect(NyxtAmountSchema.parse("250")).toBe(250n);
    expect(NyxtSignedAmountSchema.parse("-250")).toBe(-250n);
  });

  it("rejects a JSON number (precision loss past 2^53)", () => {
    expect(NyxtAmountSchema.safeParse(250).success).toBe(false);
    expect(NyxtSignedAmountSchema.safeParse(250).success).toBe(false);
  });

  it("rejects a bigint — JSON.parse never yields one", () => {
    expect(NyxtAmountSchema.safeParse(250n).success).toBe(false);
  });

  it("rejects a float string", () => {
    expect(NyxtAmountSchema.safeParse("1.5").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(NyxtAmountSchema.safeParse("").success).toBe(false);
  });

  it("rejects non-numeric text", () => {
    expect(NyxtAmountSchema.safeParse("12a").success).toBe(false);
  });

  it("rejects a negative for the unsigned amount, accepts it for the signed one", () => {
    expect(NyxtAmountSchema.safeParse("-1").success).toBe(false);
    expect(NyxtSignedAmountSchema.parse("-1")).toBe(-1n);
  });
});

describe("bigint amount codec — JSON.stringify never throws", () => {
  it("documents the bug: JSON.stringify throws on a raw bigint", () => {
    expect(() => JSON.stringify({ consumed: 250n })).toThrow(TypeError);
  });

  it("serializes an encoded turn:settled with string money fields", () => {
    const event: TurnSettledEvent = {
      type: "turn:settled",
      payload: { turnId: TurnIdSchema.parse("turn-1"), consumed: 250n, balance: NEGATIVE },
      ts,
    };
    const wire = encodeTurnSettledEvent(event);
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(wire.payload.consumed).toBe("250");
    expect(wire.payload.balance).toBe("-42");
  });

  it("serializes an encoded ledger:update, including the embedded entry id", () => {
    const event: LedgerUpdateEvent = {
      type: "ledger:update",
      payload: { entry: sampleEntry(), available: NEGATIVE, reserved: ZERO },
      ts,
    };
    const wire = encodeLedgerUpdateEvent(event);
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(wire.payload.entry.id).toBe("42");
    expect(wire.payload.entry.amount).toBe("1000");
    expect(wire.payload.available).toBe("-42");
    expect(wire.payload.reserved).toBe("0");
  });

  it("serializes an encoded LedgerResponse with a negative available balance", () => {
    const response: LedgerResponse = {
      available: NEGATIVE,
      reserved: ZERO,
      entries: [sampleEntry()],
    };
    const wire = encodeLedgerResponse(response);
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(wire.available).toBe("-42");
    expect(wire.entries[0]?.amount).toBe("1000");
  });
});

describe("money DTO encode ∘ decode round-trips", () => {
  it("LedgerEntry survives encode → JSON → decode", () => {
    const entry = sampleEntry();
    const decoded = LedgerEntrySchema.parse(JSON.parse(JSON.stringify(encodeLedgerEntry(entry))));
    expect(decoded).toEqual(entry);
    expect(decoded.id).toBe(42n);
    expect(decoded.amount).toBe(1000n);
  });

  it("turn:settled event survives encode → JSON → decode", () => {
    const event: TurnSettledEvent = {
      type: "turn:settled",
      payload: { turnId: TurnIdSchema.parse("turn-1"), consumed: 250n, balance: NEGATIVE },
      ts,
    };
    const decoded = TurnSettledEventSchema.parse(
      JSON.parse(JSON.stringify(encodeTurnSettledEvent(event))),
    );
    expect(decoded).toEqual(event);
  });

  it("ledger:update event survives encode → JSON → decode", () => {
    const event: LedgerUpdateEvent = {
      type: "ledger:update",
      payload: { entry: sampleEntry(), available: HUGE, reserved: ZERO },
      ts,
    };
    const decoded = LedgerUpdateEventSchema.parse(
      JSON.parse(JSON.stringify(encodeLedgerUpdateEvent(event))),
    );
    expect(decoded).toEqual(event);
    expect(decoded.payload.available).toBe(HUGE);
  });

  it("LedgerResponse survives encode → JSON → decode", () => {
    const response: LedgerResponse = {
      available: NEGATIVE,
      reserved: 250n,
      entries: [sampleEntry()],
    };
    const decoded = LedgerResponseSchema.parse(
      JSON.parse(JSON.stringify(encodeLedgerResponse(response))),
    );
    expect(decoded).toEqual(response);
  });

  it("CreateDepositRequest survives encode → JSON → decode", () => {
    const request = CreateDepositRequestSchema.parse({ amount: "100" });
    const decoded = CreateDepositRequestSchema.parse(
      JSON.parse(JSON.stringify(encodeCreateDepositRequest(request))),
    );
    expect(decoded.amount).toBe(100n);
  });
});
