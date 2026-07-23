/**
 * Raw compiler seam. The vendored wasm adapter (`src/vendored.ts`) implements
 * this interface; the `createCompiler` facade and its tests fake it.
 *
 * Keep this module dependency-free — it is the pure contract shared by the
 * adapter, the facade, and the fakes, so importing it must never pull in the
 * vendored toolchain.
 */

/** A single Compact source file presented to the compiler by path + content. */
export interface WasmSourceFile {
  path: string;
  content: string;
}

/**
 * A structured compiler diagnostic. Parsed from the vendored compiler's stderr
 * (0.31.1 emits no machine-readable diagnostics file — see SPIKE-1 §Evidence).
 */
export interface WasmDiagnostic {
  severity: "error" | "warning" | "note";
  /** `compactp` = Compact frontend/parser; `compactc` = the compiler pass. */
  source: "compactp" | "compactc";
  message: string;
  file?: string;
  span?: {
    start: { line: number; column: number };
    end?: { line: number; column: number };
  };
  code?: string;
}

export interface EngineCheckResult {
  ok: boolean;
  diagnostics: WasmDiagnostic[];
}

/** One artifact produced by a compile, with a best-effort MIME content type. */
export interface CompiledFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface EngineCompileResult {
  ok: boolean;
  diagnostics: WasmDiagnostic[];
  files: CompiledFile[];
  circuits: { name: string; proof: boolean }[];
}

/**
 * The raw compiler engine. `check` reports acceptance + diagnostics only;
 * `compile` additionally returns the generated artifacts and circuit table.
 *
 * A compilation *failure* is DATA (`ok: false` + diagnostics), never a throw —
 * only an infrastructure fault (a broken/absent wasm module) rejects.
 */
export interface CompilerEngine {
  check(sources: WasmSourceFile[]): Promise<EngineCheckResult>;
  compile(sources: WasmSourceFile[]): Promise<EngineCompileResult>;
}

/**
 * Flags the vendored compiler is invoked with, and the flags folded into the
 * reuse source-hash (SC-006). The compiler always runs `--skip-zk`: the keys /
 * `.bzkir` come from a SEPARATE zkir keygen step (gated, not vendored in this
 * task — see the task brief facts block and SPIKE-1 risk 1).
 */
export const COMPILE_FLAGS: readonly string[] = ["--skip-zk"];
