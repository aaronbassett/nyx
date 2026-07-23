/**
 * Compile pipeline public surface (US2 — T066).
 *
 * The Nyx-side Compile Service client + artifact orchestrator: consumers of the
 * owner-built Compile Service (`infra/compile-service/API.md`). US2 adds NO REST
 * routes — the pipeline is invoked by the turn/agent layer (US1) via these
 * injectable-deps modules, exercised directly in tests. Nyx never compiles or
 * writes R2; the service is owner-gated (constitution III).
 */
export {
  CompileServiceError,
  CompileServiceUnavailableError,
  CompileServiceResponseError,
  CompileServiceProtocolError,
  CompileJobTimeoutError,
} from "./errors.js";
export {
  HttpCompileClient,
  runCompileJob,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MAX_WAIT_MS,
} from "./client.js";
export type {
  CompileClient,
  CompileServiceClientDeps,
  CompileProgressUpdate,
  RunCompileJobOptions,
} from "./client.js";
export { createCompileResultsInbox } from "./inbox.js";
export type { CompileResultsInbox } from "./inbox.js";
export { createBrowserCompileClient } from "./browser-client.js";
export type { BrowserCompileClientDeps, BrowserCompileSession } from "./browser-client.js";
export {
  ArtifactOrchestrator,
  hasCompactChange,
  MANIFEST_FILENAME,
  REOPEN_GUIDANCE,
} from "./orchestrator.js";
export type {
  ArtifactOrchestratorDeps,
  ArtifactVerifyFailureReason,
  CompileOutcome,
  CompileTelemetry,
  CompileTurnInput,
  ReopenInput,
} from "./orchestrator.js";
export {
  ArtifactManifestSchema,
  CheckRequestSchema,
  CheckResponseSchema,
  CompileJobSchema,
  CompileRequestSchema,
  CompileSubmitResponseSchema,
  CompilerVersionsSchema,
  DiagnosticSchema,
} from "./schemas.js";
export type {
  ArtifactManifest,
  ArtifactManifestFile,
  CheckRequest,
  CheckResponse,
  CompileCircuit,
  CompileJob,
  CompileJobError,
  CompileProgress,
  CompileRequest,
  CompileResult,
  CompileSubmitResponse,
  CompilerVersions,
  Diagnostic,
  JobStatus,
  SourceFile,
} from "./schemas.js";
