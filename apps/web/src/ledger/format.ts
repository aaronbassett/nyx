/**
 * NYXT amount + elapsed-time formatters (US12, FR-070/EC-53).
 *
 * PURE and deterministic: identical inputs always yield the identical string,
 * and no locale, clock, or DOM is read. Money is a `bigint` base-unit magnitude
 * everywhere in code; these helpers are the ONLY place a monetary `bigint` is
 * turned into a display string, and they neither round nor lose precision (a
 * `bigint` cannot overflow the way `Number` would). They never DERIVE a figure —
 * they render the value they are given verbatim (FR-070).
 */

/** The unit suffix shown after every NYXT figure. */
const NYXT_SUFFIX = "NYXT";

/**
 * Insert `,` thousands separators into a run of decimal digits. Input is assumed
 * to match `/^\d+$/` (the caller strips any sign first). The lookahead groups the
 * digits into threes from the right without any index access.
 */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

/**
 * Format a NYXT base-unit `bigint` as a display string with thousands separators
 * and a `NYXT` suffix, preserving the sign. A negative balance (final-cycle
 * overage, D34) renders with a leading `-`.
 *
 * `formatNyxt(1234567n)` → `"1,234,567 NYXT"`; `formatNyxt(-500n)` → `"-500 NYXT"`;
 * `formatNyxt(0n)` → `"0 NYXT"`.
 */
export function formatNyxt(amount: bigint): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const grouped = groupThousands(magnitude.toString());
  return `${negative ? "-" : ""}${grouped} ${NYXT_SUFFIX}`;
}

/**
 * Format an elapsed duration (ms) as `"3s"`, `"1m 5s"`, or `"2h 7m 42s"`, for the EC-53
 * pending-deposit "elapsed" display. Hours are shown once past 60 minutes so a genuinely
 * stuck deposit (EC-30 indexer outage) reads sensibly rather than as `"127m 42s"`. Sub-second
 * and negative inputs clamp to `"0s"`.
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  }
  return minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`;
}
