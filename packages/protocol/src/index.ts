/**
 * @nyx/protocol — the single source of truth for the Nyx wire protocol.
 *
 * Exports zod schemas and inferred types for:
 * - WebSocket events (contracts/websocket-protocol.md): two discriminated
 *   unions, `ServerToClientEvent` and `ClientToServerEvent`, plus direction-
 *   aware parse helpers.
 * - REST DTOs (contracts/http-api.md): auth, projects/files/manifest,
 *   ledger/deposits, deploy reads, handoff, prover.
 * - Shared primitives and entities (data-model.md): branded identifiers,
 *   bigint NYXT amounts, epoch-ms timestamps.
 */
export const NYX_PROTOCOL_VERSION = "0.0.0";

export * from "./primitives.js";
export * from "./entities.js";
export * from "./events.js";
export * from "./http.js";
