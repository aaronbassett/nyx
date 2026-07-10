/**
 * REST DTO schemas (contracts/http-api.md).
 *
 * All endpoints are session-authenticated via HttpOnly cookie unless noted.
 * Auth/session state travels in cookies, never in these DTOs — no secret
 * material crosses in a body except where an endpoint's purpose is to mint
 * a token (clone token, proving token).
 *
 * Endpoints without a JSON body are intentionally absent:
 * - `GET /projects/:id/archive` streams a zip (binary).
 * - `GET /git/:cloneToken/...` speaks read-only git HTTP.
 * - `POST /prover/prove` proxies the stock Midnight proof-server API opaquely.
 */
import { z } from "zod";

import {
  ChatMessageSchema,
  DeployRegistryRowSchema,
  DepositStatusSchema,
  LedgerEntrySchema,
  ManifestEntrySchema,
  ProjectSchema,
} from "./entities.js";
import {
  DepositRefSchema,
  FilePathSchema,
  MidnightAddressSchema,
  NyxtAmountSchema,
  TimestampMsSchema,
} from "./primitives.js";

// --- Auth (S5 — D13/D43/D44) -------------------------------------------------

/** `POST /auth/nonce` response — single-use, short expiry (no auth). */
export const AuthNonceResponseSchema = z.object({
  nonce: z.string().min(1),
  expiresAt: TimestampMsSchema,
});
export type AuthNonceResponse = z.infer<typeof AuthNonceResponseSchema>;

/**
 * `POST /auth/verify` request — SIWE-style signature over the issued nonce.
 * The nonce is burned on any attempt (FR-034/039).
 *
 * `verifyingKey` is the wallet's BIP-340 Schnorr verifying key (hex). It is
 * REQUIRED because the unshielded `address` is a hash of the key, so the server
 * cannot verify the signature — nor confirm the key↔address binding that
 * prevents key-substitution auth bypass (constitution III) — from
 * `{ address, message, signature }` alone. The web signer (T039) sends
 * `{ address, message, signature, verifyingKey }`.
 */
export const AuthVerifyRequestSchema = z.object({
  address: MidnightAddressSchema,
  signature: z.string().min(1),
  message: z.string().min(1),
  verifyingKey: z.string().min(1),
});
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;

/**
 * `POST /auth/verify` response — the authenticated account. The session
 * itself is set as an HttpOnly cookie, never returned in the body.
 */
export const AuthVerifyResponseSchema = z.object({
  address: MidnightAddressSchema,
});
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;

/** `POST /auth/logout` response — invalidation is immediate and server-side. */
export const AuthLogoutResponseSchema = z.object({});
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

// --- Projects & files (S7) ----------------------------------------------------

/** `GET /projects` response. */
export const ListProjectsResponseSchema = z.array(ProjectSchema);
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

/** `POST /projects` request. */
export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** `POST /projects` response. */
export const CreateProjectResponseSchema = ProjectSchema;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

/** `PATCH /projects/:id` request — partial update. */
export const UpdateProjectRequestSchema = z.object({
  name: z.string().min(1).optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

/** `PATCH /projects/:id` response. */
export const UpdateProjectResponseSchema = ProjectSchema;
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponseSchema>;

/** `DELETE /projects/:id` response — the soft-deleted row, `deletedAt` set (D49). */
export const DeleteProjectResponseSchema = ProjectSchema;
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;

/** `POST /projects/:id/restore` response — the rehydrated row (D49). */
export const RestoreProjectResponseSchema = ProjectSchema;
export type RestoreProjectResponse = z.infer<typeof RestoreProjectResponseSchema>;

/**
 * `GET /projects/:id/manifest` response — `(path, contentHash)[]` at the last
 * committed version; the reopen/reconnect resync convergence surface (D38).
 */
export const ProjectManifestResponseSchema = z.array(ManifestEntrySchema);
export type ProjectManifestResponse = z.infer<typeof ProjectManifestResponseSchema>;

/** `GET /projects/:id/files/:path` response — content at the latest version. */
export const ProjectFileResponseSchema = z.object({
  path: FilePathSchema,
  content: z.string(),
});
export type ProjectFileResponse = z.infer<typeof ProjectFileResponseSchema>;

/** `GET /projects/:id/chat` response — history for rehydration (D23). */
export const ProjectChatResponseSchema = z.array(ChatMessageSchema);
export type ProjectChatResponse = z.infer<typeof ProjectChatResponseSchema>;

// --- Ledger & deposits (S6/S12) ------------------------------------------------

/**
 * `GET /ledger` response — balances are server-derived folds over entries;
 * the UI never computes them client-side (FR-070).
 */
export const LedgerResponseSchema = z.object({
  available: NyxtAmountSchema,
  reserved: NyxtAmountSchema,
  entries: z.array(LedgerEntrySchema),
});
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;

/** `POST /deposits` request — amount in NYXT base units, strictly positive. */
export const CreateDepositRequestSchema = z.object({
  amount: z.bigint().positive(),
});
export type CreateDepositRequest = z.infer<typeof CreateDepositRequestSchema>;

/** `POST /deposits` response — preregisters the ref (D45). */
export const CreateDepositResponseSchema = z.object({
  depositRef: DepositRefSchema,
  expiresAt: TimestampMsSchema,
});
export type CreateDepositResponse = z.infer<typeof CreateDepositResponseSchema>;

/** `GET /deposits/:ref` response. */
export const DepositStatusResponseSchema = z.object({
  status: DepositStatusSchema,
  /** On-chain transaction reference, present once the deposit has been seen. */
  txRef: z.string().optional(),
});
export type DepositStatusResponse = z.infer<typeof DepositStatusResponseSchema>;

// --- Deploy reads (S8) ----------------------------------------------------------

/**
 * `GET /projects/:id/deploys` response — registry rows, exactly one `active`
 * (FR-057). Deploy *requests* travel over WS (`deploy:request`).
 */
export const ListDeploysResponseSchema = z.array(DeployRegistryRowSchema);
export type ListDeploysResponse = z.infer<typeof ListDeploysResponseSchema>;

// --- Handoff (S13 — D58/D59) -----------------------------------------------------

/** `POST /projects/:id/clone-token` response — the minted read-only token. */
export const CreateCloneTokenResponseSchema = z.object({
  cloneToken: z.string().min(1),
});
export type CreateCloneTokenResponse = z.infer<typeof CreateCloneTokenResponseSchema>;

/** `DELETE /projects/:id/clone-token` response — revocation is immediate (SC-043). */
export const RevokeCloneTokenResponseSchema = z.object({});
export type RevokeCloneTokenResponse = z.infer<typeof RevokeCloneTokenResponseSchema>;

// --- Prover (D37/D52/D62) ---------------------------------------------------------

/**
 * `POST /prover/token` response — short-lived proving token bound to the
 * session (D52). The scaffold injects it into generated app config.
 */
export const ProverTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: TimestampMsSchema,
});
export type ProverTokenResponse = z.infer<typeof ProverTokenResponseSchema>;
