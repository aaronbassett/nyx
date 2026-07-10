/**
 * Project persistence layer public surface (US7: T051 file store + T052 manifest/read
 * routes + T054 lifecycle/cascade + T055 chat). Postgres rows are the authoritative
 * copy (D26); turn-scoped transactional commits, the manifest convergence surface
 * (D38), soft-delete with 30-day recovery (D49), and chat rehydration (D23).
 */
export { PgChatStore } from "./chat.js";
export type { ChatStore, ChatWrite } from "./chat.js";
export {
  FileTooLargeError,
  ProjectCountQuotaExceededError,
  ProjectNotFoundError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "./errors.js";
export { createDeletionCascade } from "./lifecycle.js";
export type { CascadeSeams, DeletionCascade } from "./lifecycle.js";
export { registerProjectRoutes } from "./routes.js";
export type { ProjectRouteDeps } from "./routes.js";
export { computeContentHash, DEFAULT_DELETION_RECOVERY_DAYS, PgProjectStore } from "./store.js";
export type {
  CommitRequest,
  CommitResult,
  FileAuthor,
  FileWrite,
  PgProjectStoreOptions,
  ProjectDb,
  ProjectStore,
} from "./store.js";
