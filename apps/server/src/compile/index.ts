/**
 * Compile pipeline public surface (US2 — T066; P2 browser-compile).
 *
 * The compile client + artifact orchestrator the turn/agent layer (US1) drives. P2 retired
 * the HTTP Compile Service + R2-write path: the concrete client is now
 * {@link createBrowserCompileClient}, which delegates the compile to the user's browser
 * toolchain and whose green artifacts land in the server's own ArtifactStore. What remains
 * here is transport-agnostic — the {@link CompileClient} contract, the {@link runCompileJob}
 * submit→poll loop, and the {@link ArtifactOrchestrator} that reads+verifies a committed
 * prefix before announcing. Invoked in-process (no REST routes), exercised directly in tests.
 */
export {
  CompileServiceError,
  CompileServiceUnavailableError,
  CompileServiceResponseError,
  CompileServiceProtocolError,
  CompileJobTimeoutError,
} from "./errors.js";
export { runCompileJob, DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_WAIT_MS } from "./client.js";
export type { CompileClient, CompileProgressUpdate, RunCompileJobOptions } from "./client.js";
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
