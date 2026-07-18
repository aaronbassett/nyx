/**
 * US12 — NYXT amount + elapsed formatting (FR-070, EC-53).
 *
 * The formatter is the sole place a monetary `bigint` becomes a display string.
 * These cases pin thousands-grouping, the negative sign (D34 overage), zero, and
 * very large values that a `Number`-based formatter would corrupt.
 */
import { describe, expect, it } from "vitest";

import { formatElapsed, formatNyxt } from "@/ledger/format";

describe("formatNyxt", () => {
  it("formats zero", () => {
    expect(formatNyxt(0n)).toBe("0 NYXT");
  });

  it("formats a small positive value with no separators", () => {
    expect(formatNyxt(500n)).toBe("500 NYXT");
  });

  it("groups thousands", () => {
    expect(formatNyxt(1000n)).toBe("1,000 NYXT");
    expect(formatNyxt(1234567n)).toBe("1,234,567 NYXT");
  });

  it("formats a negative value with a leading sign (D34 overage)", () => {
    expect(formatNyxt(-500n)).toBe("-500 NYXT");
    expect(formatNyxt(-1234567n)).toBe("-1,234,567 NYXT");
  });

  it("formats values past Number.MAX_SAFE_INTEGER without precision loss", () => {
    // 2^64 - 1 — the per-deposit mint cap; a Number-based formatter would corrupt it.
    expect(formatNyxt(18446744073709551615n)).toBe("18,446,744,073,709,551,615 NYXT");
  });

  it("groups exactly on the 3-digit boundary", () => {
    expect(formatNyxt(999n)).toBe("999 NYXT");
    expect(formatNyxt(1000000n)).toBe("1,000,000 NYXT");
  });
});

describe("formatElapsed", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(3200)).toBe("3s");
  });

  it("renders minute+second durations", () => {
    expect(formatElapsed(65000)).toBe("1m 5s");
  });

  it("renders hours past 60 minutes (a stuck deposit, EC-30)", () => {
    // 2h 7m 42s — must not read as "127m 42s".
    expect(formatElapsed((2 * 3600 + 7 * 60 + 42) * 1000)).toBe("2h 7m 42s");
    expect(formatElapsed(3600 * 1000)).toBe("1h 0m 0s");
  });

  it("clamps negative input to zero", () => {
    expect(formatElapsed(-1000)).toBe("0s");
  });
});
