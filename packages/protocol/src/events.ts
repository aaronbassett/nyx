/**
 * WebSocket event protocol (D12, completed per D62).
 *
 * Every event on the wire is `{ type, payload, ts }` — `ts` is epoch-ms.
 * Events are split into two discriminated unions keyed by `type`:
 * `ServerToClientEvent` and `ClientToServerEvent`. These schemas are the
 * single source of truth for both apps; neither side defines event shapes
 * locally.
 *
 * Payload size caps are config tunables enforced server-side (EC-16, D47),
 * so schemas here validate shape, not size.
 */
import { z } from "zod";

import { encodeLedgerEntry, LedgerEntrySchema } from "./entities.js";
import type { LedgerEntryWire } from "./entities.js";
import {
  ContractAddressSchema,
  encodeNyxtAmount,
  FilePathSchema,
  NyxtAmountSchema,
  NyxtSignedAmountSchema,
  ProjectIdSchema,
  TimestampMsSchema,
  TurnIdSchema,
} from "./primitives.js";

/** Builds the `{ type, payload, ts }` envelope for one event type. */
const eventSchema = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) =>
  z.object({
    type: z.literal(type),
    payload,
    ts: TimestampMsSchema,
  });

// ============================================================================
// Server → client
// ============================================================================

/** `file:write` — VFS write → HMR (FR-019). */
export const FileWritePayloadSchema = z.object({
  path: FilePathSchema,
  content: z.string(),
});
export type FileWritePayload = z.infer<typeof FileWritePayloadSchema>;
export const FileWriteEventSchema = eventSchema("file:write", FileWritePayloadSchema);
export type FileWriteEvent = z.infer<typeof FileWriteEventSchema>;

/** `file:delete` — VFS remove (FR-019). */
export const FileDeletePayloadSchema = z.object({
  path: FilePathSchema,
});
export type FileDeletePayload = z.infer<typeof FileDeletePayloadSchema>;
export const FileDeleteEventSchema = eventSchema("file:delete", FileDeletePayloadSchema);
export type FileDeleteEvent = z.infer<typeof FileDeleteEventSchema>;

/**
 * `contract:deployed` — emitted exactly once per deploy, post-finality
 * (FR-055, D10). Client writes `VITE_CONTRACT_ADDRESS` and restarts dev
 * server.
 */
export const ContractDeployedPayloadSchema = z.object({
  address: ContractAddressSchema,
});
export type ContractDeployedPayload = z.infer<typeof ContractDeployedPayloadSchema>;
export const ContractDeployedEventSchema = eventSchema(
  "contract:deployed",
  ContractDeployedPayloadSchema,
);
export type ContractDeployedEvent = z.infer<typeof ContractDeployedEventSchema>;

/** `artifacts:ready` — re-point FetchZkConfigProvider; at most once per green turn (FR-014, D35). */
export const ArtifactsReadyPayloadSchema = z.object({
  urlPrefix: z.string().url(),
});
export type ArtifactsReadyPayload = z.infer<typeof ArtifactsReadyPayloadSchema>;
export const ArtifactsReadyEventSchema = eventSchema(
  "artifacts:ready",
  ArtifactsReadyPayloadSchema,
);
export type ArtifactsReadyEvent = z.infer<typeof ArtifactsReadyEventSchema>;

/** `turn:activity` — activity-stream rendering: sub-agent feed, cycle counts (D20). */
export const TurnActivityPayloadSchema = z.object({
  turnId: TurnIdSchema,
  agent: z.string().min(1),
  phase: z.string().min(1),
  detail: z.string(),
});
export type TurnActivityPayload = z.infer<typeof TurnActivityPayloadSchema>;
export const TurnActivityEventSchema = eventSchema("turn:activity", TurnActivityPayloadSchema);
export type TurnActivityEvent = z.infer<typeof TurnActivityEventSchema>;

/**
 * `turn:settled` — ledger UI update (FR-071). `consumed` is a non-negative
 * spend; `balance` is the available balance after settlement and may be
 * negative on final-cycle overage (D34). Both are decimal strings on the wire.
 */
export const TurnSettledPayloadSchema = z.object({
  turnId: TurnIdSchema,
  consumed: NyxtAmountSchema,
  balance: NyxtSignedAmountSchema,
});
export type TurnSettledPayload = z.infer<typeof TurnSettledPayloadSchema>;
export const TurnSettledEventSchema = eventSchema("turn:settled", TurnSettledPayloadSchema);
export type TurnSettledEvent = z.infer<typeof TurnSettledEventSchema>;

/** JSON-wire form of {@link TurnSettledPayload}: money fields are decimal strings. */
export type TurnSettledPayloadWire = Omit<TurnSettledPayload, "consumed" | "balance"> & {
  consumed: string;
  balance: string;
};

/** JSON-wire form of {@link TurnSettledEvent}. */
export type TurnSettledEventWire = Omit<TurnSettledEvent, "payload"> & {
  payload: TurnSettledPayloadWire;
};

/** Encode a {@link TurnSettledEvent} to a JSON-safe outbound frame (never throws). */
export const encodeTurnSettledEvent = (event: TurnSettledEvent): TurnSettledEventWire => ({
  ...event,
  payload: {
    ...event.payload,
    consumed: encodeNyxtAmount(event.payload.consumed),
    balance: encodeNyxtAmount(event.payload.balance),
  },
});

/** `session:takeover` — this tab disconnected; show session-moved banner (D40). */
export const SessionTakeoverPayloadSchema = z.object({});
export type SessionTakeoverPayload = z.infer<typeof SessionTakeoverPayloadSchema>;
export const SessionTakeoverEventSchema = eventSchema(
  "session:takeover",
  SessionTakeoverPayloadSchema,
);
export type SessionTakeoverEvent = z.infer<typeof SessionTakeoverEventSchema>;

/**
 * Roles that stream over `turn:message` (D62, D20): assistant replies and
 * supervisor narration. User text never streams server → client.
 */
export const TurnMessageRoleSchema = z.enum(["assistant", "supervisor"]);
export type TurnMessageRole = z.infer<typeof TurnMessageRoleSchema>;

/** `turn:message` — chat stream delta, distinct from the sub-agent feed (D62, D20). */
export const TurnMessagePayloadSchema = z.object({
  turnId: TurnIdSchema,
  role: TurnMessageRoleSchema,
  delta: z.string(),
});
export type TurnMessagePayload = z.infer<typeof TurnMessagePayloadSchema>;
export const TurnMessageEventSchema = eventSchema("turn:message", TurnMessagePayloadSchema);
export type TurnMessageEvent = z.infer<typeof TurnMessageEventSchema>;

/**
 * `verify:run` — signal the client's WebContainer to run the OZ-simulator /
 * Vitest behavioural suite for this turn (US4, FR-007/FR-020). The server drives
 * the turn but the CLIENT owns the verify run; it replies with `test:results`
 * carrying the same `turnId`.
 */
export const VerifyRunPayloadSchema = z.object({
  turnId: TurnIdSchema,
});
export type VerifyRunPayload = z.infer<typeof VerifyRunPayloadSchema>;
export const VerifyRunEventSchema = eventSchema("verify:run", VerifyRunPayloadSchema);
export type VerifyRunEvent = z.infer<typeof VerifyRunEventSchema>;

/** Deploy pipeline phases surfaced to the client (D62, FR-054). */
export const DeployStatusPhaseSchema = z.enum([
  "validating",
  "proving",
  "submitting",
  "awaiting_finality",
  "failed",
]);
export type DeployStatusPhase = z.infer<typeof DeployStatusPhaseSchema>;

/** `deploy:status` — deploys are not turns; `turn:activity` never carries them (D62). */
export const DeployStatusPayloadSchema = z.object({
  requestId: z.string().min(1),
  phase: DeployStatusPhaseSchema,
  detail: z.string().optional(),
});
export type DeployStatusPayload = z.infer<typeof DeployStatusPayloadSchema>;
export const DeployStatusEventSchema = eventSchema("deploy:status", DeployStatusPayloadSchema);
export type DeployStatusEvent = z.infer<typeof DeployStatusEventSchema>;

/**
 * `ledger:update` — live ledger propagation: deposit pending→credited,
 * reserves, settlements (D62, FR-041, FR-071). Balances are server-derived
 * folds — the client never computes them (FR-070).
 */
export const LedgerUpdatePayloadSchema = z.object({
  entry: LedgerEntrySchema,
  available: NyxtSignedAmountSchema,
  reserved: NyxtAmountSchema,
});
export type LedgerUpdatePayload = z.infer<typeof LedgerUpdatePayloadSchema>;
export const LedgerUpdateEventSchema = eventSchema("ledger:update", LedgerUpdatePayloadSchema);
export type LedgerUpdateEvent = z.infer<typeof LedgerUpdateEventSchema>;

/**
 * JSON-wire form of {@link LedgerUpdatePayload}: the embedded entry's `id`
 * and `amount`, plus `available` (signed) and `reserved`, are decimal strings.
 */
export type LedgerUpdatePayloadWire = Omit<
  LedgerUpdatePayload,
  "entry" | "available" | "reserved"
> & {
  entry: LedgerEntryWire;
  available: string;
  reserved: string;
};

/** JSON-wire form of {@link LedgerUpdateEvent}. */
export type LedgerUpdateEventWire = Omit<LedgerUpdateEvent, "payload"> & {
  payload: LedgerUpdatePayloadWire;
};

/** Encode a {@link LedgerUpdateEvent} to a JSON-safe outbound frame (never throws). */
export const encodeLedgerUpdateEvent = (event: LedgerUpdateEvent): LedgerUpdateEventWire => ({
  ...event,
  payload: {
    entry: encodeLedgerEntry(event.payload.entry),
    available: encodeNyxtAmount(event.payload.available),
    reserved: encodeNyxtAmount(event.payload.reserved),
  },
});

/** Every event the server may send to the client (D12/D62). */
export const ServerToClientEventSchema = z.discriminatedUnion("type", [
  FileWriteEventSchema,
  FileDeleteEventSchema,
  ContractDeployedEventSchema,
  ArtifactsReadyEventSchema,
  TurnActivityEventSchema,
  TurnSettledEventSchema,
  SessionTakeoverEventSchema,
  TurnMessageEventSchema,
  VerifyRunEventSchema,
  DeployStatusEventSchema,
  LedgerUpdateEventSchema,
]);
export type ServerToClientEvent = z.infer<typeof ServerToClientEventSchema>;

// ============================================================================
// Client → server
// ============================================================================

/**
 * `prompt:submit` — THE entry point of every turn (D62). Rejected with a
 * named reason while a turn is active (FR-009/D24).
 */
export const PromptSubmitPayloadSchema = z.object({
  projectId: ProjectIdSchema,
  text: z.string().min(1),
});
export type PromptSubmitPayload = z.infer<typeof PromptSubmitPayloadSchema>;
export const PromptSubmitEventSchema = eventSchema("prompt:submit", PromptSubmitPayloadSchema);
export type PromptSubmitEvent = z.infer<typeof PromptSubmitEventSchema>;

/** One failing test parsed from structured Vitest output (FR-020, FR-028). */
export const TestFailureSchema = z.object({
  /** Full test name (suite + test title). */
  name: z.string().min(1),
  /** Failure message as reported by Vitest. */
  message: z.string(),
});
export type TestFailure = z.infer<typeof TestFailureSchema>;

/** `test:results` — behavioural verdict for the turn (FR-020, FR-028). */
export const TestResultsPayloadSchema = z.object({
  turnId: TurnIdSchema,
  pass: z.boolean(),
  failures: z.array(TestFailureSchema),
});
export type TestResultsPayload = z.infer<typeof TestResultsPayloadSchema>;
export const TestResultsEventSchema = eventSchema("test:results", TestResultsPayloadSchema);
export type TestResultsEvent = z.infer<typeof TestResultsEventSchema>;

/**
 * `console:log` / `console:error` — runtime feedback streamed within the
 * turn (FR-007, FR-033). One chunk per event; caps enforced server-side.
 */
export const ConsoleOutputPayloadSchema = z.object({
  message: z.string(),
});
export type ConsoleOutputPayload = z.infer<typeof ConsoleOutputPayloadSchema>;
export const ConsoleLogEventSchema = eventSchema("console:log", ConsoleOutputPayloadSchema);
export type ConsoleLogEvent = z.infer<typeof ConsoleLogEventSchema>;
export const ConsoleErrorEventSchema = eventSchema("console:error", ConsoleOutputPayloadSchema);
export type ConsoleErrorEvent = z.infer<typeof ConsoleErrorEventSchema>;

/** Dev-server boot pipeline states (FR-024, D39). */
export const DevStatusStateSchema = z.enum(["booting", "ready", "crashed"]);
export type DevStatusState = z.infer<typeof DevStatusStateSchema>;

/** `dev:status` — boot pipeline + crash policy signals (FR-024, D39). */
export const DevStatusPayloadSchema = z.object({
  state: DevStatusStateSchema,
  phase: z.string().optional(),
  detail: z.string().optional(),
});
export type DevStatusPayload = z.infer<typeof DevStatusPayloadSchema>;
export const DevStatusEventSchema = eventSchema("dev:status", DevStatusPayloadSchema);
export type DevStatusEvent = z.infer<typeof DevStatusEventSchema>;

/** `deploy:request` — explicit deploy ask, user or user-instructed agent (FR-054). */
export const DeployRequestPayloadSchema = z.object({});
export type DeployRequestPayload = z.infer<typeof DeployRequestPayloadSchema>;
export const DeployRequestEventSchema = eventSchema("deploy:request", DeployRequestPayloadSchema);
export type DeployRequestEvent = z.infer<typeof DeployRequestEventSchema>;

/**
 * `file:changed` — editor auto-save → immediate single-file commit; rejected
 * during active turns (FR-047, D60).
 */
export const FileChangedPayloadSchema = z.object({
  path: FilePathSchema,
  content: z.string(),
});
export type FileChangedPayload = z.infer<typeof FileChangedPayloadSchema>;
export const FileChangedEventSchema = eventSchema("file:changed", FileChangedPayloadSchema);
export type FileChangedEvent = z.infer<typeof FileChangedEventSchema>;

/** Every event the client may send to the server (D12/D62). */
export const ClientToServerEventSchema = z.discriminatedUnion("type", [
  PromptSubmitEventSchema,
  TestResultsEventSchema,
  ConsoleLogEventSchema,
  ConsoleErrorEventSchema,
  DevStatusEventSchema,
  DeployRequestEventSchema,
  FileChangedEventSchema,
]);
export type ClientToServerEvent = z.infer<typeof ClientToServerEventSchema>;

// ============================================================================
// Parse helpers
// ============================================================================

/** Direction of travel for an incoming event. */
export type EventDirection = "server-to-client" | "client-to-server";

/** Safe-parses unknown data as a server → client event. */
export function parseServerToClientEvent(data: unknown) {
  return ServerToClientEventSchema.safeParse(data);
}

/** Safe-parses unknown data as a client → server event. */
export function parseClientToServerEvent(data: unknown) {
  return ClientToServerEventSchema.safeParse(data);
}

/**
 * Safe-parses an incoming event against the union for its direction.
 * Returns zod's safe-parse result; callers narrow on `success` and must
 * never act on events that fail validation.
 */
export function parseEvent(
  direction: "server-to-client",
  data: unknown,
): ReturnType<typeof parseServerToClientEvent>;
export function parseEvent(
  direction: "client-to-server",
  data: unknown,
): ReturnType<typeof parseClientToServerEvent>;
export function parseEvent(direction: EventDirection, data: unknown) {
  return direction === "server-to-client"
    ? parseServerToClientEvent(data)
    : parseClientToServerEvent(data);
}
