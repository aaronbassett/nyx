/**
 * Project persistence layer public surface (US7: T051 file store + T052 manifest/read
 * routes + T054 lifecycle/cascade + T055 chat). Postgres rows are the authoritative
 * copy (D26); turn-scoped transactional commits, the manifest convergence surface
 * (D38), soft-delete with 30-day recovery (D49), and chat rehydration (D23).
 */
export { PgChatStore } from "./chat.js";
export type { ChatStore, ChatWrite } from "./chat.js";
export { createCloneService, createTokenBucketLimiter } from "./clone.js";
export type {
  CloneAuthAttempt,
  CloneAuthLogger,
  CloneAuthOutcome,
  CloneService,
  CloneServiceDeps,
  CloneStore,
  GitHttpRequest,
  GitHttpResponse,
  RateLimiter,
  TokenBucketOptions,
} from "./clone.js";
export {
  CloneRateLimitError,
  CloneTokenNotFoundError,
  FileTooLargeError,
  HandoffDisabledError,
  ProjectCountQuotaExceededError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "./errors.js";
export {
  createInMemoryGitFs,
  createInMemoryRepoCache,
  DEFAULT_BRANCH,
  materializeRepo,
} from "./git.js";
export type {
  CachedRepo,
  GitFs,
  GitStats,
  MaterializedRepo,
  MaterializeOptions,
  MaterializeStore,
  RepoCache,
} from "./git.js";
export { createDeletionCascade } from "./lifecycle.js";
export type { CascadeSeams, DeletionCascade } from "./lifecycle.js";
export { assertSafePaths, isSafePath, UnsafePathError } from "./paths.js";
export { registerGitHttpRoutes, registerProjectRoutes } from "./routes.js";
export type { GitHttpRouteDeps, ProjectRouteDeps } from "./routes.js";
export {
  computeContentHash,
  DEFAULT_DELETION_RECOVERY_DAYS,
  defaultCloneTokenGenerator,
  PgProjectStore,
} from "./store.js";
export type {
  CommitRequest,
  CommitResult,
  FileAuthor,
  FileWrite,
  HandoffFile,
  PgProjectStoreOptions,
  ProjectDb,
  ProjectStore,
  VersionSnapshot,
} from "./store.js";
