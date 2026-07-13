/**
 * Behavioural-verify telemetry + payload hygiene (US4) — two PURE functions.
 *
 * Both live at the edge of the verify loop and share the same discipline: no
 * I/O, no wall-clock, no randomness, no shared state — same input ⇒ same output
 * (SC-014). Neither one gates the loop.
 *
 * 1. {@link computeCircuitCoverage} — per-circuit test-coverage TELEMETRY
 *    (FR-032 / D41). D41 keeps green defined by "the cycle's suite passes";
 *    test adequacy is owned by steering + the Review agent, NOT a mechanical
 *    gate. Coverage is therefore reported as evidence only — it MUST NOT throw,
 *    fail, or gate on empty/low coverage. It exists so a floor can be added
 *    LATER via story revision if hollow-test greens appear.
 *
 * 2. {@link capTestResults} — deterministic failure-payload cap (FR-033 /
 *    REV-002). The `test:results` WIRE EVENT — `{ type, payload, ts }`, not the
 *    bare payload — is bounded to a tunable byte budget (default 32 KB), so the
 *    frame that actually crosses the socket honours the per-EVENT cap. Truncation
 *    ALWAYS preserves, for every retained failure, the per-test `name` and the
 *    first assertion message; long message bodies are shortened and trailing
 *    failures dropped as needed, and every reduction is signalled honestly (never
 *    silently) — an inline suffix on a truncated message + a synthetic marker
 *    failure for dropped ones. A cap too small to hold THIS payload's mandatory
 *    skeleton plus a minimal drop marker — a per-payload floor that scales with the
 *    `turnId` length (at least {@link MIN_TEST_RESULTS_CAP_BYTES} for a short id) — is
 *    refused with a `RangeError` rather than silently over-run the budget.
 *
 * Note on the spec cross-ref: D41's parenthetical mis-cites FR-033 for
 * coverage. The coverage FR is FR-032 (telemetry, no floor); FR-033 is the
 * payload cap. This module implements each to its correct FR.
 */
import type { TestFailure, TestResultsPayload, TurnId } from "@nyx/protocol";

// ─────────────────────────── coverage telemetry (FR-032 / D41) ───────────────

/**
 * Input for {@link computeCircuitCoverage}.
 *
 * `testNames` is the set of full test names from the run — BOTH passing and
 * failing. A {@link TestResultsPayload} alone carries only the *failing* names,
 * so when that is the only signal available a caller derives `testNames` via
 * {@link testNamesFromResults}; a richer runner can pass every executed name.
 */
export interface CircuitCoverageInput {
  /** The contract's circuit names, in the order they should be reported. */
  readonly circuits: readonly string[];
  /** Every test full-name observed this run (suite + title), passed and failed. */
  readonly testNames: readonly string[];
}

/** Per-circuit telemetry row — whether a circuit is referenced and by how many tests. */
export interface PerCircuitCoverage {
  /** The circuit name, echoed from the input. */
  readonly circuit: string;
  /** True when at least one test name references this circuit as a whole word. */
  readonly covered: boolean;
  /** How many distinct test names reference this circuit. */
  readonly testCount: number;
}

/** The whole coverage report — telemetry only, never a pass/fail verdict. */
export interface CircuitCoverageReport {
  /** One row per input circuit, in input order (deterministic). */
  readonly perCircuit: readonly PerCircuitCoverage[];
  /** How many circuits are covered by at least one test. */
  readonly coveredCount: number;
  /** Total circuits considered (= `circuits.length`). */
  readonly totalCount: number;
  /** `coveredCount / totalCount`, or `0` when there are no circuits (no divide-by-zero). */
  readonly ratio: number;
}

/** Regex metacharacters escaped so a circuit name is matched literally. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * A whole-word, case-insensitive matcher for `circuit`. A "word" character is a
 * letter, a digit, or an underscore (standard `\b`/`\w` semantics); a boundary is
 * any other character, or string start/end. So `mint` matches the token `mint` in
 * `"mint circuit mints once"` but NOT the substring inside `"reminting"` — the
 * loose-substring false positive FR-032 warns against. Crucially, because `_` is a
 * WORD character, `transfer` does NOT spuriously match the DIFFERENT circuit named
 * in `"transfer_from behaves"` or `"does_transfer_now"`, while `mint_token` still
 * matches `"mint_token works"` as one whole underscored token.
 */
function circuitMatcher(circuit: string): RegExp {
  const escaped = circuit.replace(REGEX_METACHARACTERS, "\\$&");
  // `_` is inside the word class (letters + digits + underscore) so snake_case
  // tokens are matched whole — no snake_case boundary false positives.
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, "i");
}

/** Count how many `testNames` reference `circuit` as a whole word. */
function countReferences(circuit: string, testNames: readonly string[]): number {
  // An empty circuit name has no meaningful token to match — treat as uncovered
  // rather than let a degenerate regex match every boundary.
  if (circuit.length === 0) {
    return 0;
  }
  const matcher = circuitMatcher(circuit);
  let count = 0;
  for (const name of testNames) {
    if (matcher.test(name)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Measure per-circuit coverage as TELEMETRY (FR-032 / D41).
 *
 * A circuit is "covered" when its name appears as a whole word (case-insensitive)
 * in at least one test name. This never throws and never gates: an empty circuit
 * set or an empty test set simply yields a zeroed report. Ordering follows the
 * input circuit order so the output is deterministic.
 */
export function computeCircuitCoverage(input: CircuitCoverageInput): CircuitCoverageReport {
  const perCircuit: PerCircuitCoverage[] = input.circuits.map((circuit) => {
    const testCount = countReferences(circuit, input.testNames);
    return { circuit, covered: testCount > 0, testCount };
  });

  const coveredCount = perCircuit.reduce(
    (running, entry) => (entry.covered ? running + 1 : running),
    0,
  );
  const totalCount = input.circuits.length;
  // Guard divide-by-zero: no circuits ⇒ ratio 0 (telemetry, not an error).
  const ratio = totalCount === 0 ? 0 : coveredCount / totalCount;

  return { perCircuit, coveredCount, totalCount, ratio };
}

/**
 * Derive test names from a {@link TestResultsPayload} when it is the only signal
 * available. The payload carries only *failing* test names, so this is the
 * fallback input for {@link computeCircuitCoverage} — a richer runner should pass
 * the full passed-and-failed set instead.
 */
export function testNamesFromResults(results: TestResultsPayload): readonly string[] {
  return results.failures.map((failure) => failure.name);
}

// ─────────────────────────── failure-payload cap (FR-033) ────────────────────

/** The FR-033 default cap: 32 KB per `test:results` event. */
export const DEFAULT_MAX_TEST_RESULTS_BYTES = 32_768;

/** Name of the synthetic failure appended when whole failures are dropped. */
export const TRUNCATION_MARKER_NAME = "verify:truncated";

/** Inline suffix appended to a message body that was shortened to fit the cap. */
export const MESSAGE_TRUNCATION_SUFFIX = "... [truncated]";

/**
 * A fixed, representative wire `ts` used ONLY for deterministic size measurement.
 * Epoch-ms is a plain number (`TimestampMsSchema`); 13 digits is the widest
 * realistic value (a 13-digit ms count runs through the year 2286), so a payload
 * that fits under this measured frame fits under the real one whatever the actual
 * `ts` is. Pure — never `Date.now()`.
 */
const REPRESENTATIVE_WIRE_TS = 9_999_999_999_999;

/**
 * Constant byte overhead of the `{ "type": "test:results", "payload": …, "ts": … }`
 * wire frame around the payload, measured with a 13-digit `ts`: 53 bytes. Documents
 * {@link serializedBytes} and derives {@link MIN_TEST_RESULTS_CAP_BYTES}.
 */
const EVENT_ENVELOPE_RESERVE_BYTES = 53;

/**
 * The mandatory `{"turnId":…,"pass":…,"failures":[]}` payload skeleton for a
 * representative SHORT turn id (~6 chars): ~46 bytes. This is only the common-case
 * assumption — {@link TurnIdSchema} (`z.string().min(1)`) sets NO maximum length, so
 * the runtime floor is computed dynamically from the ACTUAL `turnId` (see
 * {@link minCapBytesFor}), never from this constant.
 */
const MANDATORY_SKELETON_BYTES = 46;

/**
 * Room for a minimal honest {@link TRUNCATION_MARKER_NAME} marker object inside the
 * `failures` array — the smallest drop signal, so a truncation is never silent: ~61
 * bytes.
 */
const MINIMAL_MARKER_BYTES = 61;

/**
 * The documented common-case floor (= envelope reserve + short-id skeleton + minimal
 * marker = 160) — the smallest `maxBytes` {@link capTestResults} accepts FOR A SHORT
 * `turnId`. Below it, the mandatory `{ type, payload: { turnId, pass, failures: [] }, ts }`
 * skeleton plus a minimal drop marker cannot fit inside the wire frame, so capping
 * would silently over-run the cap and/or drop every failure with NO marker — a silent
 * breach of the FR-033 budget.
 *
 * ⚠️ This is a DOCUMENTATION constant for callers/docs only. Because {@link TurnIdSchema}
 * has no maximum length, the ACTUAL runtime guard is {@link minCapBytesFor}, which
 * recomputes the floor from the real `turnId`/`pass` — a long `turnId` lifts the floor
 * ABOVE this constant. Comparing against this constant alone would let a long-`turnId`
 * payload slip a sub-skeleton cap through and silently over-run the wire budget.
 * Below the dynamic floor the cap is refused LOUDLY with a `RangeError` (mirroring the
 * `maxCycles` guard in `verify.ts`). Every real cap — 256/512 and the 32 KB default —
 * sits comfortably above it for the short ids these caps target.
 */
export const MIN_TEST_RESULTS_CAP_BYTES =
  EVENT_ENVELOPE_RESERVE_BYTES + MANDATORY_SKELETON_BYTES + MINIMAL_MARKER_BYTES;

/** Options for {@link capTestResults}; `maxBytes` is the config-tunable seam. */
export interface CapTestResultsOptions {
  /**
   * Byte budget for the serialized WIRE EVENT (`{ type, payload, ts }`, not the bare
   * payload); defaults to {@link DEFAULT_MAX_TEST_RESULTS_BYTES}. Must be at least the
   * per-payload dynamic floor ({@link minCapBytesFor}, which equals
   * {@link MIN_TEST_RESULTS_CAP_BYTES} for a short `turnId` but grows with a longer one)
   * or {@link capTestResults} throws a `RangeError`.
   */
  readonly maxBytes?: number;
}

/** Minimal readonly shape the size measurement needs (accepts a real payload). */
interface SerializableResults {
  readonly turnId: TurnId;
  readonly pass: boolean;
  readonly failures: readonly TestFailure[];
}

/**
 * Deterministic serialized size in bytes of the REAL wire event — the single source
 * of "how big is it". FR-033 caps 32 KB per EVENT, and the transport frames every
 * payload as `{ type: "test:results", payload, ts }` (`eventSchema`, `@nyx/protocol`),
 * so we measure the whole frame with a worst-case 13-digit `ts`
 * ({@link EVENT_ENVELOPE_RESERVE_BYTES} of envelope). A payload capped this way yields
 * a wire frame genuinely within `maxBytes`, not one ~53 bytes over it.
 */
function serializedBytes(value: SerializableResults): number {
  const wireEvent = { type: "test:results", payload: value, ts: REPRESENTATIVE_WIRE_TS };
  return Buffer.byteLength(JSON.stringify(wireEvent), "utf8");
}

/** True when `{ turnId, pass, failures }` serializes within `maxBytes`. */
function fitsWithin(
  turnId: TurnId,
  pass: boolean,
  failures: readonly TestFailure[],
  maxBytes: number,
): boolean {
  return serializedBytes({ turnId, pass, failures }) <= maxBytes;
}

/**
 * The DYNAMIC, per-payload floor for {@link capTestResults}'s `maxBytes`.
 *
 * The smallest wire budget that can still hold THIS payload's mandatory fields AND
 * signal a drop honestly: the wire-wrapped `{ turnId, pass, failures: [] }` skeleton
 * (measured via {@link serializedBytes}, envelope included) plus {@link MINIMAL_MARKER_BYTES}
 * of room for a minimal honest drop marker. Adding a single object to the empty
 * `failures` array grows the JSON by exactly that object's serialized size, so this
 * equals the wire size of `{ turnId, pass, failures: [<minimal marker>] }`.
 *
 * Unlike the static {@link MIN_TEST_RESULTS_CAP_BYTES}, this is computed from the ACTUAL
 * `turnId`/`pass`. {@link TurnIdSchema} has no maximum length, so a long `turnId` inflates
 * the skeleton well past the ~46-byte short-id assumption and lifts the floor above the
 * static constant — closing the silent-breach hole where a big `turnId` under a
 * sub-skeleton cap would over-run the wire budget with no throw and no marker. For a
 * representative short `turnId` this equals {@link MIN_TEST_RESULTS_CAP_BYTES}.
 */
function minCapBytesFor(turnId: TurnId, pass: boolean): number {
  return serializedBytes({ turnId, pass, failures: [] }) + MINIMAL_MARKER_BYTES;
}

/** A message body shortened to `keep` leading code points, with the truncation suffix. */
function buildTruncatedMessage(codePoints: readonly string[], keep: number): string {
  return `${codePoints.slice(0, keep).join("")}${MESSAGE_TRUNCATION_SUFFIX}`;
}

/**
 * Keep `failure`'s name intact and shorten its message to the largest leading
 * prefix that still fits the remaining budget once appended to `retained`.
 *
 * Binary-searches over code points (never splitting a surrogate pair) so the
 * result is the deterministic maximal-fidelity first message. Returns `undefined`
 * only when not even the name + an empty (suffix-only) message fits — the caller
 * then drops the failure rather than breach the cap.
 */
function truncateFailureToFit(
  turnId: TurnId,
  pass: boolean,
  retained: readonly TestFailure[],
  failure: TestFailure,
  maxBytes: number,
): TestFailure | undefined {
  const codePoints = Array.from(failure.message);
  let low = 0;
  let high = codePoints.length;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate: TestFailure = {
      name: failure.name,
      message: buildTruncatedMessage(codePoints, mid),
    };
    if (fitsWithin(turnId, pass, [...retained, candidate], maxBytes)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best < 0) {
    return undefined;
  }
  return { name: failure.name, message: buildTruncatedMessage(codePoints, best) };
}

/** The honest drop marker for `dropped` failures / `omittedBytes` bytes removed. */
function makeMarker(dropped: number, omittedBytes: number, maxBytes: number): TestFailure {
  return {
    name: TRUNCATION_MARKER_NAME,
    message: `${String(dropped)} failure(s) and ${String(omittedBytes)} byte(s) omitted to honour the ${String(maxBytes)}-byte cap (FR-033)`,
  };
}

/**
 * Append the drop marker as the final failure — never silently (FR-033).
 *
 * The marker itself costs bytes, so if it does not fit, retained failures are
 * shed from the tail (raising the drop count, in order) until it does. Bounded:
 * at most `retained.length + 1` attempts. If even the marker alone overflows a
 * pathologically small cap, it is omitted rather than breach the budget.
 */
function appendTruncationMarker(
  turnId: TurnId,
  pass: boolean,
  retained: readonly TestFailure[],
  dropped: number,
  originalBytes: number,
  maxBytes: number,
): TestResultsPayload {
  for (let shed = 0; shed <= retained.length; shed += 1) {
    const kept = retained.slice(0, retained.length - shed);
    const droppedCount = dropped + shed;
    // Bytes omitted = the reduction achieved before the marker is re-added.
    const omittedBytes = originalBytes - serializedBytes({ turnId, pass, failures: kept });
    const marker = makeMarker(droppedCount, omittedBytes, maxBytes);
    if (fitsWithin(turnId, pass, [...kept, marker], maxBytes)) {
      return { turnId, pass, failures: [...kept, marker] };
    }
  }
  // Even a lone marker overflows this (already in-budget) cap — omit it; turnId + pass
  // still survive. This bare skeleton is provably ≤ maxBytes: capTestResults' up-front
  // dynamic floor guard (minCapBytesFor) guarantees maxBytes ≥ skeleton + a minimal
  // marker > skeleton, so this fallback can never return an over-cap frame.
  return { turnId, pass, failures: [] };
}

/**
 * Cap a `test:results` payload at `maxBytes` with deterministic truncation
 * (FR-033 / REV-002).
 *
 * Algorithm:
 *  1. If the payload already serializes within the cap, return it UNCHANGED
 *     (same reference — no allocation, no reordering).
 *  2. Otherwise fill an in-order prefix of the failures greedily: take each
 *     failure whole while it fits; at the first that does not, keep it with a
 *     truncated first message (name intact) if any prefix fits — else drop it —
 *     and stop. This preserves, for every retained failure, the `name` and the
 *     first assertion message.
 *  3. If any failures were dropped, append the {@link TRUNCATION_MARKER_NAME}
 *     marker (shedding tail failures until it fits) so the drop is observable —
 *     never silently. A truncated message is self-evident from its inline
 *     {@link MESSAGE_TRUNCATION_SUFFIX}.
 *
 * `turnId` and `pass` are always preserved. `maxBytes` is measured against the whole
 * `{ type, payload, ts }` wire frame (not the bare payload) and must be at least the
 * per-payload dynamic floor ({@link minCapBytesFor} — the wire-wrapped mandatory
 * skeleton for THIS `turnId`/`pass` plus a minimal drop marker; it equals
 * {@link MIN_TEST_RESULTS_CAP_BYTES} for a short `turnId` and grows with a longer one):
 * a smaller cap cannot honestly hold even the mandatory skeleton + a drop marker, so
 * it is rejected with a `RangeError` rather than silently over-run the budget. Because
 * the guard is dynamic, whenever this function does NOT throw its result is provably
 * ≤ `maxBytes` AND any drop is signalled by a marker — no long-`turnId` payload can
 * slip an over-cap frame through. The function is otherwise pure: identical
 * `(payload, maxBytes)` ⇒ identical output.
 */
export function capTestResults(
  payload: TestResultsPayload,
  opts?: CapTestResultsOptions,
): TestResultsPayload {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_TEST_RESULTS_BYTES;
  // DYNAMIC floor: computed from THIS payload's actual turnId/pass, not the static
  // short-id constant. TurnIdSchema has no max length, so a long turnId can push the
  // mandatory skeleton + a minimal drop marker above MIN_TEST_RESULTS_CAP_BYTES; a
  // cap below the dynamic floor can't hold them inside the wire frame, so capping
  // would silently breach FR-033 (over-run and/or drop-with-no-marker). Fail loudly.
  const floor = minCapBytesFor(payload.turnId, payload.pass);
  if (maxBytes < floor) {
    throw new RangeError(
      `maxBytes must be at least ${String(floor)} bytes to hold this payload's ` +
        `{ type, payload: { turnId, pass, failures: [] }, ts } skeleton and a minimal ` +
        `truncation marker within the FR-033 wire cap, got ${String(maxBytes)} ` +
        `(turnId is ${String(payload.turnId.length)} chars; the ` +
        `${String(MIN_TEST_RESULTS_CAP_BYTES)}-byte MIN_TEST_RESULTS_CAP_BYTES floor ` +
        `assumes a short turnId)`,
    );
  }

  const originalBytes = serializedBytes(payload);
  if (originalBytes <= maxBytes) {
    // Within budget — hand back the exact payload, structurally unchanged.
    return payload;
  }

  const { turnId, pass, failures } = payload;
  const retained: TestFailure[] = [];
  let dropped = 0;

  for (const [index, failure] of failures.entries()) {
    // Cheapest, highest-fidelity path: take the failure whole while it fits.
    if (fitsWithin(turnId, pass, [...retained, failure], maxBytes)) {
      retained.push(failure);
      continue;
    }
    // The whole failure overflows: keep its name + a bounded first message if any
    // prefix fits, else drop it. Either way we stop — the fill is an in-order prefix.
    const truncated = truncateFailureToFit(turnId, pass, retained, failure, maxBytes);
    if (truncated === undefined) {
      dropped = failures.length - index;
    } else {
      retained.push(truncated);
      dropped = failures.length - (index + 1);
    }
    break;
  }

  if (dropped > 0) {
    return appendTruncationMarker(turnId, pass, retained, dropped, originalBytes, maxBytes);
  }
  // No drops: `retained` was assembled solely from `fitsWithin(..., maxBytes)`-gated
  // pushes, so this frame is provably ≤ maxBytes without needing the guard.
  return { turnId, pass, failures: retained };
}
