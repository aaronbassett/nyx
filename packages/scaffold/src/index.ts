/**
 * @nyx/scaffold — agent STEERING assets for generated DApps (US1, T141).
 *
 * There is NO template engine (D3/FR-003): the Scaffolding/Implementation
 * sub-agents generate each DApp by retrieving generic Midnight skills at runtime
 * and grounding every shape in what they retrieve (constitution I). This package
 * holds the Nyx-platform-specific DELTA the generic skills do not carry — the
 * house rules and reference patterns the wiring injects into each sub-agent's
 * `instructions`:
 *
 * - {@link SCAFFOLD_STEERING} — the four typed house rules (config chokepoint,
 *   prover default, wrong-network guard, compact-testing);
 * - {@link CONFIG_TS_REFERENCE} / {@link PROVER_PROVIDER_REFERENCE} /
 *   {@link NETWORK_GUARD_REFERENCE} — adaptable reference bodies (SDK shapes are
 *   flagged {@link RETRIEVAL_SOURCED_MARKER}, never authoritative);
 * - {@link (buildScaffoldingInstructions:function)} /
 *   {@link (buildImplementationInstructions:function)} — deterministic composers
 *   that fold the rules + references into an instruction string.
 *
 * It is DATA plus light composition; the agents do the real generation.
 */
export const NYX_SCAFFOLD_VERSION = "0.0.0";

export * from "./steering.js";
export * from "./references.js";
export * from "./instructions.js";
