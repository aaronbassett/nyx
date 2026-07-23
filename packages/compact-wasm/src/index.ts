import { COMPILE_FLAGS } from "./engine.js";
import { COMPACT_WASM_META } from "./meta.js";
import { computeSourceHash } from "./source-hash.js";
import type {
  CompilerEngine,
  EngineCompileResult,
  WasmDiagnostic,
  WasmSourceFile,
} from "./engine.js";

export type {
  CompilerEngine,
  CompiledFile,
  EngineCheckResult,
  EngineCompileResult,
  WasmDiagnostic,
  WasmSourceFile,
} from "./engine.js";
export { COMPILE_FLAGS } from "./engine.js";
export { computeSourceHash } from "./source-hash.js";
export { COMPACT_WASM_META } from "./meta.js";
export type { CompactWasmMeta } from "./meta.js";
export { loadVendoredEngine, VendoredToolchainMissingError } from "./vendored.js";

/** Result of `check` — engine verdict plus toolchain identity and timing. */
export interface CheckResult {
  ok: boolean;
  diagnostics: WasmDiagnostic[];
  compilerVersion: string;
  durationMs: number;
}

/**
 * Result of `compileFull`. On success (`ok: true`) it carries the reuse
 * `sourceHash`, the generated `files`, and the `circuits` table; on failure
 * those are absent (there is nothing to cache or serve).
 */
export interface CompileResult {
  ok: boolean;
  diagnostics: WasmDiagnostic[];
  compilerVersion: string;
  durationMs: number;
  sourceHash?: string;
  files?: EngineCompileResult["files"];
  circuits?: EngineCompileResult["circuits"];
}

export interface CreateCompilerDeps {
  engine: CompilerEngine;
  /** Injectable monotonic clock (ms) for deterministic duration measurement. */
  now?: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A wasm fault is DATA, never a crash: one synthesized compiler-level error. */
function faultDiagnostic(err: unknown): WasmDiagnostic {
  return { severity: "error", source: "compactc", message: `compiler error: ${errorMessage(err)}` };
}

/**
 * Thin facade over a raw {@link CompilerEngine}: stamps every result with the
 * vendored `compilerVersion`, measures `durationMs`, computes the reuse
 * `sourceHash` on a successful full compile, and turns an engine throw into a
 * failing result the turn loop can render — it never rejects.
 */
export function createCompiler(deps: CreateCompilerDeps): {
  check(sources: WasmSourceFile[]): Promise<CheckResult>;
  compileFull(sources: WasmSourceFile[]): Promise<CompileResult>;
} {
  const now = deps.now ?? Date.now;
  const compilerVersion = COMPACT_WASM_META.compilerVersion;

  return {
    async check(sources) {
      const started = now();
      try {
        const result = await deps.engine.check(sources);
        return {
          ok: result.ok,
          diagnostics: result.diagnostics,
          compilerVersion,
          durationMs: now() - started,
        };
      } catch (err) {
        return {
          ok: false,
          diagnostics: [faultDiagnostic(err)],
          compilerVersion,
          durationMs: now() - started,
        };
      }
    },

    async compileFull(sources) {
      const started = now();
      let result: EngineCompileResult;
      try {
        result = await deps.engine.compile(sources);
      } catch (err) {
        return {
          ok: false,
          diagnostics: [faultDiagnostic(err)],
          compilerVersion,
          durationMs: now() - started,
        };
      }
      const durationMs = now() - started;
      if (!result.ok) {
        return { ok: false, diagnostics: result.diagnostics, compilerVersion, durationMs };
      }
      return {
        ok: true,
        diagnostics: result.diagnostics,
        compilerVersion,
        durationMs,
        sourceHash: computeSourceHash(sources, compilerVersion, COMPILE_FLAGS),
        files: result.files,
        circuits: result.circuits,
      };
    },
  };
}
