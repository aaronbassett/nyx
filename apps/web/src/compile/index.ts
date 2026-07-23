/**
 * Public barrel for the in-browser compile feature. The editor's Build button
 * (P6) imports {@link createCompileWorkerClient} from here; `worker.ts` is not
 * re-exported (it is loaded by URL, never imported as a module).
 */
export { createCompileWorkerClient } from "./client";
export type { CompileWorkerClient, CompileWorkerClientDeps, WorkerLike } from "./client";
export type {
  CheckOutput,
  CompileWorkerRequest,
  CompileWorkerResponse,
  FullOutput,
} from "./messages";
