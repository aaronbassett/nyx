/**
 * Coverage-telemetry + failure-payload-cap tests (US4, behavioural verify loop).
 *
 * These drive the two PURE functions of {@link ../../src/agents/coverage.js}
 * directly — no I/O, no clock, no randomness — to pin the exact-spec behaviour:
 *  - FR-032 / D41 — per-circuit coverage is TELEMETRY, never a gate: it only
 *    measures + reports and MUST NOT throw on empty/low coverage. Whole-word,
 *    case-insensitive circuit↔test-name matching (so `mint` never matches
 *    `reminting`). Deterministic ordering = input circuit order.
 *  - FR-033 (REV-002) — test-failure payloads are capped at a tunable byte
 *    budget with DETERMINISTIC truncation that always preserves, for every
 *    retained failure, the per-test `name` and the first assertion message;
 *    drops are signalled honestly by a marker; identical input ⇒ identical
 *    output (SC-014).
 */
import { describe, expect, it } from "vitest";
import { TurnIdSchema } from "@nyx/protocol";
import type { TestFailure, TestResultsPayload } from "@nyx/protocol";
import {
  capTestResults,
  computeCircuitCoverage,
  DEFAULT_MAX_TEST_RESULTS_BYTES,
  MESSAGE_TRUNCATION_SUFFIX,
  MIN_TEST_RESULTS_CAP_BYTES,
  testNamesFromResults,
  TRUNCATION_MARKER_NAME,
} from "../../src/agents/coverage.js";

/** A fixed, deterministic turn id for every payload fixture. */
const TURN_ID = TurnIdSchema.parse("turn-1");

/** Byte size of the bare payload (the OLD, envelope-blind measure — kept for input checks). */
function payloadBytes(payload: TestResultsPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/**
 * Byte size of the REAL `test:results` wire frame `{ type, payload, ts }` — what
 * FR-033 actually caps. A 13-digit `ts` is the widest realistic epoch-ms, matching
 * the worst case {@link capTestResults} measures against.
 */
function wireFrameBytes(payload: TestResultsPayload): number {
  const frame = { type: "test:results", payload, ts: 9_999_999_999_999 };
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

/** Strip the inline message-truncation suffix so a prefix comparison is clean. */
function stripSuffix(message: string): string {
  return message.endsWith(MESSAGE_TRUNCATION_SUFFIX)
    ? message.slice(0, -MESSAGE_TRUNCATION_SUFFIX.length)
    : message;
}

/** Build a payload of `count` failures each carrying `message`. */
function makePayload(count: number, message: string, pass = false): TestResultsPayload {
  const failures: TestFailure[] = Array.from({ length: count }, (_unused, index) => ({
    name: `ledger suite > case ${String(index)} behaves`,
    message,
  }));
  return { turnId: TURN_ID, pass, failures };
}

describe("computeCircuitCoverage (FR-032 / D41 telemetry)", () => {
  it("reports full coverage when every circuit is named by a test", () => {
    const report = computeCircuitCoverage({
      circuits: ["deposit", "mint", "burn"],
      testNames: ["deposit adds balance", "mint creates supply", "burn destroys supply"],
    });

    expect(report.coveredCount).toBe(3);
    expect(report.totalCount).toBe(3);
    expect(report.ratio).toBe(1);
    expect(report.perCircuit.every((entry) => entry.covered)).toBe(true);
  });

  it("reports partial coverage with a correct covered/uncovered split and ratio", () => {
    const report = computeCircuitCoverage({
      circuits: ["deposit", "mint", "burn"],
      testNames: ["deposit adds balance", "burn destroys supply"],
    });

    expect(report.coveredCount).toBe(2);
    expect(report.totalCount).toBe(3);
    expect(report.ratio).toBeCloseTo(2 / 3);
    expect(report.perCircuit).toEqual([
      { circuit: "deposit", covered: true, testCount: 1 },
      { circuit: "mint", covered: false, testCount: 0 },
      { circuit: "burn", covered: true, testCount: 1 },
    ]);
  });

  it("yields a zeroed report with NO throw when there are no circuits", () => {
    const report = computeCircuitCoverage({ circuits: [], testNames: ["deposit adds balance"] });

    expect(report.perCircuit).toEqual([]);
    expect(report.coveredCount).toBe(0);
    expect(report.totalCount).toBe(0);
    expect(report.ratio).toBe(0);
  });

  it("never throws on empty/low coverage — it only measures (telemetry, not a gate)", () => {
    expect(() =>
      computeCircuitCoverage({ circuits: ["deposit", "mint"], testNames: [] }),
    ).not.toThrow();

    const report = computeCircuitCoverage({ circuits: ["deposit", "mint"], testNames: [] });
    expect(report.coveredCount).toBe(0);
    expect(report.ratio).toBe(0);
    expect(report.perCircuit.every((entry) => !entry.covered)).toBe(true);
  });

  it("matches whole words only — `mint` covers a token but not `reminting`", () => {
    const covered = computeCircuitCoverage({
      circuits: ["mint"],
      testNames: ["mint circuit mints once"],
    });
    expect(covered.perCircuit).toEqual([{ circuit: "mint", covered: true, testCount: 1 }]);

    const notCovered = computeCircuitCoverage({
      circuits: ["mint"],
      testNames: ["reminting resets the counter"],
    });
    expect(notCovered.perCircuit).toEqual([{ circuit: "mint", covered: false, testCount: 0 }]);
  });

  it("treats `_` as a word char so snake_case tokens never cross-match (no false positives)", () => {
    // `transfer` must NOT be credited for tests about the DIFFERENT `transfer_from`
    // circuit — `_` is a WORD char, so `transfer` is not a whole word in either name.
    const transfer = computeCircuitCoverage({
      circuits: ["transfer"],
      testNames: ["transfer_from behaves", "does_transfer_now works"],
    });
    expect(transfer.perCircuit).toEqual([{ circuit: "transfer", covered: false, testCount: 0 }]);

    // But a whole underscored circuit still matches its own snake_case test name.
    const snake = computeCircuitCoverage({
      circuits: ["mint_token"],
      testNames: ["mint_token works"],
    });
    expect(snake.perCircuit).toEqual([{ circuit: "mint_token", covered: true, testCount: 1 }]);
  });

  it("matches case-insensitively", () => {
    const report = computeCircuitCoverage({
      circuits: ["burn"],
      testNames: ["BURN reverts when the balance is empty"],
    });
    expect(report.perCircuit).toEqual([{ circuit: "burn", covered: true, testCount: 1 }]);
  });

  it("counts how many test names reference each circuit", () => {
    const report = computeCircuitCoverage({
      circuits: ["deposit", "mint"],
      testNames: ["deposit succeeds", "deposit twice fails", "mint tokens"],
    });

    expect(report.perCircuit).toEqual([
      { circuit: "deposit", covered: true, testCount: 2 },
      { circuit: "mint", covered: true, testCount: 1 },
    ]);
  });

  it("preserves input circuit order deterministically", () => {
    const report = computeCircuitCoverage({
      circuits: ["zeta", "alpha", "mint"],
      testNames: ["mint tokens"],
    });

    expect(report.perCircuit.map((entry) => entry.circuit)).toEqual(["zeta", "alpha", "mint"]);
  });

  it("derives test names from a TestResultsPayload's failures when only that is available", () => {
    const payload: TestResultsPayload = {
      turnId: TURN_ID,
      pass: false,
      failures: [
        { name: "deposit adds balance", message: "expected 10, received 0" },
        { name: "mint creates supply", message: "expected 5, received 4" },
      ],
    };

    expect(testNamesFromResults(payload)).toEqual(["deposit adds balance", "mint creates supply"]);

    const report = computeCircuitCoverage({
      circuits: ["deposit", "mint", "burn"],
      testNames: testNamesFromResults(payload),
    });
    expect(report.coveredCount).toBe(2);
    expect(report.perCircuit).toEqual([
      { circuit: "deposit", covered: true, testCount: 1 },
      { circuit: "mint", covered: true, testCount: 1 },
      { circuit: "burn", covered: false, testCount: 0 },
    ]);
  });
});

describe("capTestResults (FR-033 deterministic truncation)", () => {
  it("exposes a 32 KB default cap", () => {
    expect(DEFAULT_MAX_TEST_RESULTS_BYTES).toBe(32_768);
  });

  it("returns an under-cap payload unchanged (structurally identical)", () => {
    const payload: TestResultsPayload = {
      turnId: TURN_ID,
      pass: false,
      failures: [{ name: "deposit adds balance", message: "expected 10, received 0" }],
    };

    const result = capTestResults(payload);
    expect(result).toBe(payload);
  });

  it("truncates an over-cap payload to <= maxBytes while preserving turnId and pass", () => {
    const message = `assertion failed: ${"x".repeat(120)}`;
    const payload = makePayload(20, message);
    const maxBytes = 512;

    expect(payloadBytes(payload)).toBeGreaterThan(maxBytes);

    const result = capTestResults(payload, { maxBytes });

    expect(payloadBytes(result)).toBeLessThanOrEqual(maxBytes);
    expect(result.turnId).toBe(payload.turnId);
    expect(result.pass).toBe(payload.pass);
  });

  it("keeps name + first message for every surviving failure and appends a drop marker", () => {
    const message = `assertion failed: ${"x".repeat(120)}`;
    const payload = makePayload(20, message);
    const maxBytes = 512;

    const result = capTestResults(payload, { maxBytes });

    // The marker is appended LAST and signals the drop honestly (never silently).
    expect(result.failures.at(-1)?.name).toBe(TRUNCATION_MARKER_NAME);
    expect(result.failures.at(-1)?.message).toContain("FR-033");

    const survivors = result.failures.slice(0, -1);
    expect(survivors.length).toBeGreaterThan(0);
    survivors.forEach((survivor, index) => {
      const original = payload.failures.at(index);
      // Name is always preserved, in the original order.
      expect(survivor.name).toBe(original?.name);
      // The message is either intact or a truncated PREFIX of the original.
      expect(original?.message.startsWith(stripSuffix(survivor.message))).toBe(true);
    });
  });

  it("truncates a pathological huge single message to a bounded first message", () => {
    const huge = "boom ".repeat(50_000); // ~250 KB — far beyond the 32 KB cap
    const payload: TestResultsPayload = {
      turnId: TURN_ID,
      pass: false,
      failures: [{ name: "explosion suite > detonates loudly", message: huge }],
    };

    expect(payloadBytes(payload)).toBeGreaterThan(DEFAULT_MAX_TEST_RESULTS_BYTES);

    const result = capTestResults(payload);

    expect(payloadBytes(result)).toBeLessThanOrEqual(DEFAULT_MAX_TEST_RESULTS_BYTES);
    expect(result.failures).toHaveLength(1);

    const only = result.failures.at(0);
    expect(only?.name).toBe("explosion suite > detonates loudly");
    // The name is preserved and the message is a bounded, observable prefix.
    expect(only?.message.length ?? Number.MAX_SAFE_INTEGER).toBeLessThan(huge.length);
    expect(only?.message.endsWith(MESSAGE_TRUNCATION_SUFFIX)).toBe(true);
    expect(huge.startsWith(stripSuffix(only?.message ?? ""))).toBe(true);
  });

  it("respects a caller-tuned maxBytes seam", () => {
    const payload = makePayload(8, `assertion failed: ${"y".repeat(60)}`);

    const tight = capTestResults(payload, { maxBytes: 256 });
    const loose = capTestResults(payload, { maxBytes: 4_096 });

    expect(payloadBytes(tight)).toBeLessThanOrEqual(256);
    // A looser cap fits the whole payload untouched.
    expect(loose).toBe(payload);
  });

  it("is deterministic — identical input yields identical output across 100 runs (SC-014)", () => {
    const payload = makePayload(20, `assertion failed: ${"x".repeat(120)}`);
    const serialized = Array.from({ length: 100 }, () =>
      JSON.stringify(capTestResults(payload, { maxBytes: 512 })),
    );

    expect(new Set(serialized).size).toBe(1);
  });

  it("caps the whole {type,payload,ts} WIRE FRAME, not just the bare payload (FR-033 per-EVENT)", () => {
    const payload = makePayload(20, `assertion failed: ${"x".repeat(120)}`);
    const maxBytes = 512;

    const result = capTestResults(payload, { maxBytes });

    // The frame that actually crosses the socket — payload + ~53 bytes of envelope —
    // is within budget. (A bare-payload measure would let the wire frame breach it.)
    expect(wireFrameBytes(result)).toBeLessThanOrEqual(maxBytes);
    // And it genuinely used the envelope reserve: the bare payload sits below the cap
    // by at least the ~53-byte frame overhead, not flush against it.
    expect(payloadBytes(result)).toBeLessThan(maxBytes);
  });

  it("throws a RangeError when maxBytes is below the mandatory-skeleton floor (FIX 3)", () => {
    const payload = makePayload(4, "assertion failed: boom");

    // Absurdly small caps can't honestly hold the skeleton + a marker — refuse loudly.
    expect(() => capTestResults(payload, { maxBytes: 10 })).toThrow(RangeError);
    expect(() => capTestResults(payload, { maxBytes: MIN_TEST_RESULTS_CAP_BYTES - 1 })).toThrow(
      RangeError,
    );

    // At/above the floor it caps normally (no throw) and stays within the wire cap.
    expect(() => capTestResults(payload, { maxBytes: MIN_TEST_RESULTS_CAP_BYTES })).not.toThrow();
    const atFloor = capTestResults(payload, { maxBytes: MIN_TEST_RESULTS_CAP_BYTES });
    expect(wireFrameBytes(atFloor)).toBeLessThanOrEqual(MIN_TEST_RESULTS_CAP_BYTES);
    expect(atFloor.turnId).toBe(payload.turnId);
    expect(atFloor.pass).toBe(payload.pass);
  });

  it("throws for a long turnId whose skeleton overflows a cap above the STATIC floor (no silent breach)", () => {
    // TurnIdSchema (z.string().min(1)) has NO max length. A 300-char turnId inflates the
    // mandatory skeleton to a ~392-byte wire frame — larger than maxBytes 200 on its own.
    const longTurnId = TurnIdSchema.parse("x".repeat(300));
    const payload: TestResultsPayload = { turnId: longTurnId, pass: true, failures: [] };

    // 200 clears the STATIC MIN_TEST_RESULTS_CAP_BYTES (160)…
    expect(200).toBeGreaterThan(MIN_TEST_RESULTS_CAP_BYTES);
    // …but the DYNAMIC per-payload floor catches it: the old static guard returned a
    // ~392-byte frame here with no throw and no marker — the silent breach this fixes.
    expect(() => capTestResults(payload, { maxBytes: 200 })).toThrow(RangeError);
  });

  it("caps a long-turnId payload within the WIRE FRAME and still marks drops when above its floor", () => {
    const longTurnId = TurnIdSchema.parse("x".repeat(300));
    const message = `assertion failed: ${"z".repeat(120)}`;
    const failures: TestFailure[] = Array.from({ length: 12 }, (_unused, index) => ({
      name: `ledger suite > case ${String(index)} behaves`,
      message,
    }));
    const payload: TestResultsPayload = { turnId: longTurnId, pass: false, failures };
    // Comfortably above the ~453-byte dynamic floor for a 300-char turnId, but far below
    // the full payload, so real truncation (and a drop marker) must happen.
    const maxBytes = 900;

    const result = capTestResults(payload, { maxBytes });

    // The full wire frame that crosses the socket is within budget — no silent over-run.
    expect(wireFrameBytes(result)).toBeLessThanOrEqual(maxBytes);
    // Mandatory fields survive verbatim.
    expect(result.turnId).toBe(longTurnId);
    expect(result.pass).toBe(false);
    // Drops are signalled honestly by the marker (never silently).
    expect(result.failures.length).toBeLessThan(payload.failures.length);
    expect(result.failures.at(-1)?.name).toBe(TRUNCATION_MARKER_NAME);
    expect(result.failures.at(-1)?.message).toContain("FR-033");
  });

  it("scales the floor with turnId length — a cap that passes for a short turnId is refused for a long one", () => {
    const shortPayload = makePayload(4, "assertion failed: boom"); // turnId "turn-1"
    const longPayload: TestResultsPayload = {
      turnId: TurnIdSchema.parse("x".repeat(300)),
      pass: false,
      failures: shortPayload.failures,
    };

    // 200 clears the short-turnId floor (160) — capping proceeds, no throw…
    expect(() => capTestResults(shortPayload, { maxBytes: 200 })).not.toThrow();
    // …but the SAME 200 cannot hold a 300-char turnId's mandatory skeleton — refuse loudly.
    expect(() => capTestResults(longPayload, { maxBytes: 200 })).toThrow(RangeError);
  });
});
