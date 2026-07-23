/**
 * The wire contract between {@link CompileWorkerClient} (main thread) and the
 * compile worker. Both sides import these types only — the payloads cross the
 * thread boundary by structured clone, so every field must be clone-safe
 * (`WasmSourceFile` is plain strings; `CompiledFile.bytes` is a `Uint8Array`,
 * whose backing `ArrayBuffer` the worker additionally hands over in the transfer
 * list to avoid copying compiled artifacts).
 *
 * These types are declared against `@nyx/compact-wasm`'s pure engine types and
 * are structurally identical to its `CheckResult` / `CompileResult` facades, so
 * a worker can post a facade result straight back as a response.
 */
import type { CompiledFile, WasmDiagnostic, WasmSourceFile } from "@nyx/compact-wasm";

/** A `check` verdict: acceptance, diagnostics, and toolchain identity + timing. */
export interface CheckOutput {
  ok: boolean;
  diagnostics: WasmDiagnostic[];
  compilerVersion: string;
  durationMs: number;
}

/**
 * A `full` compile result. On success it additionally carries the reuse
 * `sourceHash`, the generated `files`, and the `circuits` table; on failure
 * those are absent (there is nothing to cache or serve).
 */
export interface FullOutput extends CheckOutput {
  sourceHash?: string;
  circuits?: { name: string; proof: boolean }[];
  files?: CompiledFile[];
}

/** A request from the client to the worker, correlated by `id`. */
export interface CompileWorkerRequest {
  id: number;
  op: "check" | "full";
  sources: WasmSourceFile[];
}

/**
 * The worker's reply, correlated back by the same `id`: either a compile result
 * or a stringified fault (the worker never dies silently — every throw becomes
 * an `error` response).
 */
export type CompileWorkerResponse =
  { id: number; result: CheckOutput | FullOutput } | { id: number; error: string };
