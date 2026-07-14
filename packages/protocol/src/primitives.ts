/**
 * Shared primitive schemas for the Nyx wire protocol.
 *
 * Conventions (data-model.md):
 * - Monetary amounts are `bigint`s **in code** but decimal **strings on the
 *   wire** — see the bigint↔string codec below.
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

// --- bigint ↔ string wire codec ---------------------------------------------
//
// `JSON.stringify` THROWS on a `bigint`, and `JSON.parse` / `Response.json()`
// never yields one — so no `bigint` can cross the wire directly. The protocol
// therefore represents every large integer (NYXT amounts, `bigserial` ids,
// monotonic versions) as a **decimal string** on the wire, decoding it to a
// `bigint` on the way in so server/client code stays ergonomic.
//
// Direction matters, and zod-3 transforms are one-way:
//  - INBOUND  — the schemas below accept a decimal string and `transform` it to
//    a `bigint` (`z.infer` is `bigint`; `z.input` is `string`). A JSON number is
//    rejected outright, since numbers lose precision past 2^53.
//  - OUTBOUND — the `encode*` helpers (here and beside each money DTO) map a
//    `bigint` back to its canonical decimal string, so `JSON.stringify` of an
//    encoded payload never throws and `decode(JSON.parse(...))` round-trips.

/** A non-negative base-10 integer, e.g. `"0"`, `"1000"`. */
const UNSIGNED_DECIMAL = /^\d+$/;
/** A base-10 integer that may be negative, e.g. `"-42"`, `"0"`, `"1000"`. */
const SIGNED_DECIMAL = /^-?\d+$/;

/**
 * Non-negative NYXT amount in base units — magnitude only. Reused for fields
 * whose sign is either impossible (spend, reserved holdings) or carried
 * elsewhere: `LedgerEntry.amount` is a magnitude whose sign is implied by its
 * `kind` (FR-043). On the wire it is a decimal string; in code it is a `bigint`.
 */
export const NyxtAmountSchema = z
  .string()
  .regex(UNSIGNED_DECIMAL, "NYXT amount must be a non-negative base-10 integer string")
  .transform((value) => BigInt(value));
export type NyxtAmount = z.infer<typeof NyxtAmountSchema>;

/**
 * Signed NYXT amount in base units, for *balances* that may go negative on
 * final-cycle overage (D34) — `available` and post-settlement `balance`. On
 * the wire it is a (possibly `-`-prefixed) decimal string; in code a `bigint`.
 */
export const NyxtSignedAmountSchema = z
  .string()
  .regex(SIGNED_DECIMAL, "NYXT amount must be a base-10 integer string")
  .transform((value) => BigInt(value));
export type NyxtSignedAmount = z.infer<typeof NyxtSignedAmountSchema>;

/**
 * A non-monetary `bigint` that overflows `int53` — `bigserial` ids and
 * monotonic version stamps. Same wire treatment as {@link NyxtAmountSchema}
 * (non-negative decimal string → `bigint`), named separately so amount and
 * identifier fields read distinctly.
 */
export const BigIntStringSchema = z
  .string()
  .regex(UNSIGNED_DECIMAL, "value must be a non-negative base-10 integer string")
  .transform((value) => BigInt(value));
export type BigIntString = z.infer<typeof BigIntStringSchema>;

/**
 * Encode a `bigint` to its canonical decimal-string wire form. Total and
 * side-effect-free: `(0n) → "0"`, `(-42n) → "-42"`, never throws. Use at the
 * emit boundary so `JSON.stringify` sees a string, not a `bigint`.
 */
export const encodeBigInt = (value: bigint): string => value.toString();

/**
 * Encode a NYXT amount (`bigint` in code) to its decimal-string wire form.
 * Alias of {@link encodeBigInt} carrying monetary intent; handles both the
 * unsigned and signed variants (a negative renders with a leading `-`).
 */
export const encodeNyxtAmount = (amount: bigint): string => encodeBigInt(amount);

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
