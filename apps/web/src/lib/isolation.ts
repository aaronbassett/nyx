/**
 * Runtime cross-origin isolation check (FR-025 / D39).
 *
 * `crossOriginIsolated` is `true` only when the document was served with the
 * strict COOP/COEP pair and is therefore permitted to use `SharedArrayBuffer` —
 * the hard requirement for the in-browser WebContainer. The property is absent
 * in some runtimes (older browsers, jsdom), so we coerce defensively to a
 * strict boolean rather than trusting the DOM lib's non-nullable type.
 */
export function isCrossOriginIsolated(): boolean {
  // The DOM lib types `crossOriginIsolated` as a non-nullable `boolean`, but it
  // is absent in some runtimes (older browsers, jsdom). Read it as
  // possibly-undefined and require an explicit `true`.
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return isolated === true;
}
