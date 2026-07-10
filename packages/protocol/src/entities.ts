/**
 * Entity DTO schemas shared by WebSocket events and REST responses.
 *
 * Shapes follow specs/001-nyx-platform/data-model.md, projected to wire
 * form: snake_case columns become camelCase fields, timestamptz columns
 * become epoch-ms numbers.
 */
import { z } from "zod";

import {
  ContentHashSchema,
  ContractAddressSchema,
  FilePathSchema,
  MidnightAddressSchema,
  NyxtAmountSchema,
  ProjectIdSchema,
  TimestampMsSchema,
  TurnIdSchema,
} from "./primitives.js";

// --- Ledger -----------------------------------------------------------------

/**
 * Append-only ledger entry kinds (FR-043). Burn accounting is vault-global
 * (reconcile_runs) and never appears as a per-account entry.
 */
export const LedgerEntryKindSchema = z.enum([
  "deposit_credit",
  "reserve",
  "reserve_release",
  "settlement",
]);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKindSchema>;

/** One append-only ledger entry. `amount` is signed by kind. */
export const LedgerEntrySchema = z.object({
  /** bigserial primary key — bigint to survive int53 overflow. */
  id: z.bigint(),
  accountAddress: MidnightAddressSchema,
  kind: LedgerEntryKindSchema,
  amount: NyxtAmountSchema,
  /** deposit_ref / turn_id / reconcile_run_id linkage. */
  ref: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// --- Projects & files -------------------------------------------------------

/** Project row as exposed to its owner. Clone tokens are never embedded here. */
export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  ownerAddress: MidnightAddressSchema,
  name: z.string().min(1),
  createdAt: TimestampMsSchema,
  /** Present only while soft-deleted (restorable window, D49). */
  deletedAt: TimestampMsSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** One manifest row: `(path, contentHash)` at the last committed version (D38). */
export const ManifestEntrySchema = z.object({
  path: FilePathSchema,
  contentHash: ContentHashSchema,
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

// --- Chat -------------------------------------------------------------------

/**
 * Chat history roles: user prompts, assistant replies, and supervisor
 * narration (D20/D23 — narration is part of the rehydrated stream).
 */
export const ChatRoleSchema = z.enum(["user", "assistant", "supervisor"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/** Persisted chat message, rehydrated on project open (D23). */
export const ChatMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: ChatRoleSchema,
  content: z.string(),
  turnId: TurnIdSchema.optional(),
  createdAt: TimestampMsSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// --- Deploy registry ---------------------------------------------------------

/** Registry row lifecycle — exactly one `active` per project (FR-057). */
export const DeployRegistryStatusSchema = z.enum(["active", "superseded", "torn_down"]);
export type DeployRegistryStatus = z.infer<typeof DeployRegistryStatusSchema>;

/** One deploy registry row (FR-057). */
export const DeployRegistryRowSchema = z.object({
  projectId: ProjectIdSchema,
  address: ContractAddressSchema,
  /** Project version stamp the deploy was built from (bigint, monotonic). */
  version: z.bigint(),
  status: DeployRegistryStatusSchema,
  deployedAt: TimestampMsSchema,
  txRef: z.string().min(1),
});
export type DeployRegistryRow = z.infer<typeof DeployRegistryRowSchema>;

// --- Deposits ---------------------------------------------------------------

/** Deposit ref lifecycle: preregistered → seen → credited | expired (D45/D46). */
export const DepositStatusSchema = z.enum(["preregistered", "seen", "credited", "expired"]);
export type DepositStatus = z.infer<typeof DepositStatusSchema>;
