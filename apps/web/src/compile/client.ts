/**
 * `CompileWorkerClient` — a promise-map over a compile worker (US2 in-browser).
 *
 * Each `check` / `compileFull` posts a request tagged with a monotonically
 * increasing `id` and parks a resolver in a pending map; the worker's reply is
 * matched back by that `id`, so any number of compiles may be in flight at once
 * and each resolves (or rejects) its own caller. The transport is INJECTABLE
 * (mirroring the ledger/wallet clients and the `WebContainerHandle` seam): tests
 * pass a fake {@link WorkerLike}; production spins up the real Vite module worker
 * (`worker.ts`), which is browser-only and never exercised by the unit suite.
 */
import type { WasmSourceFile } from "@nyx/compact-wasm";

import type {
  CheckOutput,
  CompileWorkerRequest,
  CompileWorkerResponse,
  FullOutput,
} from "./messages";

/**
 * The narrow slice of a `Worker` this client uses — small enough to fake in a
 * test and structurally satisfied by the adapter around a real module worker.
 */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  terminate(): void;
}

/** The public compile surface consumed by the editor's Build button (P6). */
export interface CompileWorkerClient {
  /** Fast acceptance check (`--skip-zk`), no artifacts. */
  check(sources: WasmSourceFile[]): Promise<CheckOutput>;
  /** Full compile: artifacts, circuit table, and reuse `sourceHash`. */
  compileFull(sources: WasmSourceFile[]): Promise<FullOutput>;
  /** Terminate the worker and reject anything still in flight. */
  dispose(): void;
}

/** Injectable dependencies; omit `worker` to spin up the real module worker. */
export interface CompileWorkerClientDeps {
  worker?: WorkerLike;
}

/** A parked caller awaiting the worker's reply for one request id. */
interface Pending {
  resolve(result: CheckOutput | FullOutput): void;
  reject(error: Error): void;
}

/**
 * Wrap the real Vite module worker in the {@link WorkerLike} seam. Constructing
 * a `Worker` only works in the browser, so this runs solely in production — the
 * unit tests always inject a fake and never reach here. The adapter is needed
 * because a real `Worker.onmessage` handler is typed against the full
 * `MessageEvent`, which is not assignable to `WorkerLike`'s `{ data }` shape.
 */
function createDefaultWorker(): WorkerLike {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const like: WorkerLike = {
    postMessage(msg, transfer) {
      if (transfer && transfer.length > 0) {
        worker.postMessage(msg, transfer);
      } else {
        worker.postMessage(msg);
      }
    },
    onmessage: null,
    terminate() {
      worker.terminate();
    },
  };
  worker.onmessage = (event: MessageEvent): void => {
    like.onmessage?.({ data: event.data });
  };
  return like;
}

/**
 * Build a {@link CompileWorkerClient} over `deps.worker` (or a freshly spun-up
 * module worker). Requests correlate to callers by a monotonic `id`; a reply
 * whose `id` has no pending call is ignored (a stray/duplicate frame must never
 * corrupt the map or throw).
 */
export function createCompileWorkerClient(deps?: CompileWorkerClientDeps): CompileWorkerClient {
  const worker = deps?.worker ?? createDefaultWorker();
  const pending = new Map<number, Pending>();
  let nextId = 0;

  worker.onmessage = (event: { data: unknown }): void => {
    const response = event.data as CompileWorkerResponse;
    const entry = pending.get(response.id);
    if (!entry) {
      return;
    }
    pending.delete(response.id);
    if ("error" in response) {
      entry.reject(new Error(response.error));
    } else {
      entry.resolve(response.result);
    }
  };

  function request<T extends CheckOutput | FullOutput>(
    op: "check" | "full",
    sources: WasmSourceFile[],
  ): Promise<T> {
    const id = (nextId += 1);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve(result) {
          resolve(result as T);
        },
        reject,
      });
      const message: CompileWorkerRequest = { id, op, sources };
      worker.postMessage(message);
    });
  }

  return {
    check(sources) {
      return request<CheckOutput>("check", sources);
    },
    compileFull(sources) {
      return request<FullOutput>("full", sources);
    },
    dispose() {
      for (const entry of pending.values()) {
        entry.reject(new Error("compile worker disposed"));
      }
      pending.clear();
      worker.terminate();
    },
  };
}
