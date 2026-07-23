import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Toolchain version strings for the vendored wasm Compact compiler.
 *
 * Every value is READ from `vendor/meta.json` (written by `scripts/vendor.mjs`
 * from `vendor.config.json.meta`, itself grounded in SPIKE-1 execution
 * evidence) — never hardcoded here. This keeps the TS surface and the vendored
 * binaries describing the same toolchain by construction.
 */
export interface CompactWasmMeta {
  /** compactc self-reported compiler version (e.g. "0.31.1"). */
  compilerVersion: string;
  /** Compact language version the compiler accepts (e.g. "0.23.0"). */
  languageVersion: string;
  /** compact-runtime version the generated JS pins via `checkRuntimeVersion` (e.g. "0.16.0"). */
  runtimeVersion: string;
  /** zkir version whose IR / key format the toolchain targets (e.g. "2.1.0"). */
  zkirVersion: string;
  /** The compact source rev the wasm compiler was rebuilt from (`compactc-v0.31.1`). */
  compactRev: string;
}

const metaUrl = new URL("../vendor/meta.json", import.meta.url);

function loadMeta(): CompactWasmMeta {
  let raw: string;
  try {
    raw = readFileSync(fileURLToPath(metaUrl), "utf8");
  } catch {
    throw new Error(
      `@nyx/compact-wasm: vendor/meta.json is missing. Run \`pnpm --filter @nyx/compact-wasm vendor\` ` +
        `to produce the vendored toolchain (it is committed to the repo).`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<CompactWasmMeta>;
  const field = (key: keyof CompactWasmMeta): string => {
    const value = parsed[key];
    if (typeof value !== "string") {
      throw new Error(`@nyx/compact-wasm: vendor/meta.json is missing string field "${key}"`);
    }
    return value;
  };
  return {
    compilerVersion: field("compilerVersion"),
    languageVersion: field("languageVersion"),
    runtimeVersion: field("runtimeVersion"),
    zkirVersion: field("zkirVersion"),
    compactRev: field("compactRev"),
  };
}

export const COMPACT_WASM_META: CompactWasmMeta = loadMeta();
