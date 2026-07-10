/**
 * Shared primitive schemas for the Nyx wire protocol.
 *
 * Conventions (data-model.md):
 * - Monetary amounts are `bigint`s in NYXT base units.
 * - Addresses are Midnight unshielded address strings (D43).
 * - Timestamps are epoch-milliseconds numbers.
 *
 * Branded strings are used for identifiers that cross the server/client
 * boundary so they cannot be swapped for one another at compile time.
 * Brands are compile-time only: raw JSON values validate normally.
 */
import { z } from "zod";

/** Epoch-milliseconds timestamp. */
export const TimestampMsSchema = z.number().int().nonnegative();
export type TimestampMs = z.infer<typeof TimestampMsSchema>;

/**
 * Monetary amount in NYXT base units.
 *
 * Signed: ledger entry amounts are signed by kind, and balances may go
 * negative on final-cycle overage (D34) — so no sign constraint here.
 */
export const NyxtAmountSchema = z.bigint();
export type NyxtAmount = z.infer<typeof NyxtAmountSchema>;

/** Midnight unshielded address — the identity key everywhere (D43). */
export const MidnightAddressSchema = z.string().min(1).brand<"MidnightAddress">();
export type MidnightAddress = z.infer<typeof MidnightAddressSchema>;

/** Deployed Midnight contract address (deploy registry, contract:deployed). */
export const ContractAddressSchema = z.string().min(1).brand<"ContractAddress">();
export type ContractAddress = z.infer<typeof ContractAddressSchema>;

/** Content hash of a project file — the manifest/resync convergence key (D38). */
export const ContentHashSchema = z.string().min(1).brand<"ContentHash">();
export type ContentHash = z.infer<typeof ContentHashSchema>;

/** Project identifier. */
export const ProjectIdSchema = z.string().min(1).brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectIdSchema>;

/** Turn identifier. */
export const TurnIdSchema = z.string().min(1).brand<"TurnId">();
export type TurnId = z.infer<typeof TurnIdSchema>;

/** Pre-registered deposit reference (D45). */
export const DepositRefSchema = z.string().min(1).brand<"DepositRef">();
export type DepositRef = z.infer<typeof DepositRefSchema>;

/**
 * Project-relative file path. Size/path caps are config tunables enforced
 * server-side (D47), so no length cap is baked into the schema.
 */
export const FilePathSchema = z.string().min(1);
export type FilePath = z.infer<typeof FilePathSchema>;
