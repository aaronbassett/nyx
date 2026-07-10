/**
 * Auth layer public surface (US5: T035 nonce/verify/logout + T036 session
 * middleware). Wallet-connect + session establishment behind HttpOnly/Secure/
 * SameSite cookies, keyed by the unshielded address (D43), 7-day sliding (D44).
 */
export { buildSessionCookie, clearSessionCookie } from "./cookie.js";
export { createRequireSession } from "./middleware.js";
export type { RequireSessionDeps, SessionAuth } from "./middleware.js";
export { registerAuthRoutes } from "./routes.js";
export type { AuthRouteDeps } from "./routes.js";
export { DEFAULT_NONCE_TTL_MS, PgSessionAuthStore } from "./store.js";
export type {
  AuthDb,
  AuthNonce,
  IssueRequest,
  IssueResult,
  PgSessionAuthStoreOptions,
  SessionAuthStore,
} from "./store.js";
export {
  extractNonce,
  reconstructSignedBytes,
  verifyKeyAddressBinding,
  verifyMessageSignature,
} from "./verify.js";
export type { KeyAddressBindingInput, MessageSignatureInput } from "./verify.js";
