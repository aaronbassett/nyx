/**
 * Compile worker — a thin host that runs the vendored wasm Compact compiler off
 * the main thread. BROWSER-ONLY: it is loaded via `new Worker(new URL(...))` and
 * boots the emscripten toolchain, so the deterministic unit suite drives the
 * CLIENT against a fake instead (this module is exercised by the P5 demo smoke).
 *
 * The engine is booted lazily on the first request and reused across calls.
 * EVERYTHING is wrapped in try/catch so a fault becomes an `error` response —
 * the worker must never die silently and strand a pending client call.
 */
import { createCompiler, loadVendoredEngine } from "@nyx/compact-wasm";

import type {
  CheckOutput,
  CompileWorkerRequest,
  CompileWorkerResponse,
  FullOutput,
} from "./messages";

type Compiler = ReturnType<typeof createCompiler>;

/**
 * The dedicated-worker global, typed structurally. The app's tsconfig ships the
 * DOM lib (not WebWorker) so `self` is typed as a window; we cast to the narrow
 * shape the worker actually uses rather than fight overlapping global libs.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<CompileWorkerRequest>) => void) | null;
  postMessage(message: CompileWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

let compilerPromise: Promise<Compiler> | null = null;

/** Boot the vendored engine once; every request reuses the same compiler. */
function getCompiler(): Promise<Compiler> {
  compilerPromise ??= loadVendoredEngine().then((engine) => createCompiler({ engine }));
  return compilerPromise;
}

/** Run one request and post its reply, turning any fault into an `error` frame. */
async function handle(request: CompileWorkerRequest): Promise<void> {
  try {
    const compiler = await getCompiler();
    if (request.op === "check") {
      const result: CheckOutput = await compiler.check(request.sources);
      scope.postMessage({ id: request.id, result });
      return;
    }
    const result: FullOutput = await compiler.compileFull(request.sources);
    // Hand the compiled artifact buffers over instead of copying them.
    const transfer = (result.files ?? []).map((file) => file.bytes.buffer as ArrayBuffer);
    scope.postMessage({ id: request.id, result }, transfer);
  } catch (err) {
    scope.postMessage({ id: request.id, error: String(err) });
  }
}

scope.onmessage = (event): void => {
  void handle(event.data);
};
