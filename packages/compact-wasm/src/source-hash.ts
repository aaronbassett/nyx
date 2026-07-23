import { createHash } from "node:crypto";

import type { WasmSourceFile } from "./engine.js";

/**
 * Deterministic content-address of a compile input set.
 *
 * The hash folds the source files (sorted by path so order is irrelevant), the
 * compiler version, and the flags — so a cache keyed on it is correct across
 * compiler/flag changes (US2 SC-006 reuse correctness). Returns a lowercase
 * sha-256 hex digest.
 */
export function computeSourceHash(
  sources: WasmSourceFile[],
  compilerVersion: string,
  flags: readonly string[],
): string {
  const files = [...sources]
    .map((s) => ({ path: s.path, content: s.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const canonical = JSON.stringify({ files, compilerVersion, flags: [...flags] });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
