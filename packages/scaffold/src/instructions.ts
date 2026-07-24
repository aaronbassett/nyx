/**
 * Instruction composition — folds the Nyx house rules ({@link SCAFFOLD_STEERING})
 * and reference snippets ({@link SCAFFOLD_REFERENCES}) into the instruction string
 * the US1 wiring appends to a sub-agent's base `instructions`.
 *
 * The server's generation sub-agents build a Vercel AI SDK `ToolLoopAgent` with a
 * base `instructions` string (see `apps/server/src/agents/scaffolding.ts` and
 * `implementation.ts`). This module supplies the Nyx-platform delta the wiring
 * concatenates onto that base, e.g.:
 *
 * ```ts
 * import { buildScaffoldingInstructions } from "@nyx/scaffold";
 * const instructions = [SCAFFOLD_INSTRUCTIONS, buildScaffoldingInstructions()].join("\n\n");
 * new ToolLoopAgent({ model, instructions, tools, ... });
 * ```
 *
 * Both builders are pure and deterministic (no clock, no randomness): the same
 * process produces byte-identical instructions every call, so a golden-string
 * assertion is stable.
 */
import {
  CONFIG_TS_REFERENCE,
  NETWORK_GUARD_REFERENCE,
  PROVER_PROVIDER_REFERENCE,
  type ReferenceSnippet,
} from "./references.js";
import { SCAFFOLD_STEERING, SCAFFOLD_STEERING_RULES, type SteeringRule } from "./steering.js";

/** Heading for the house-rules block prepended to the composed instructions. */
const HOUSE_RULES_HEADER =
  "Nyx platform house rules — these are Nyx-specific rules ON TOP OF the generic " +
  "Midnight skills you retrieve. Follow them exactly for the generated DApp:";

/** Heading for the reference-snippets block. */
const REFERENCES_HEADER =
  "Reference patterns to ADAPT (do not copy any @midnight-ntwrk/* shape verbatim; " +
  "ground exact shapes in retrieval — see the per-snippet notes):";

/**
 * The reference snippets attached to every generation agent's instructions: the
 * config chokepoint file body plus the prover and network-guard policy snippets.
 */
const STANDARD_REFERENCES: readonly ReferenceSnippet[] = [
  { label: "client/src/lib/config.ts — contract-address chokepoint", body: CONFIG_TS_REFERENCE },
  { label: "proving provider policy", body: PROVER_PROVIDER_REFERENCE },
  { label: "wrong-network guard", body: NETWORK_GUARD_REFERENCE },
];

/** Render one rule as a numbered, decision-tagged instruction line. */
function renderRule(rule: SteeringRule, index: number): string {
  return `${String(index + 1)}. ${rule.title} (${rule.decisions.join(", ")}): ${rule.guidance}`;
}

/** Render one reference snippet as a labelled, fenced block. */
function renderReference(snippet: ReferenceSnippet): string {
  return `--- ${snippet.label} ---\n${snippet.body}`;
}

/** Compose a header + numbered rules + labelled references into one instruction string. */
function composeInstructions(
  rules: readonly SteeringRule[],
  references: readonly ReferenceSnippet[],
): string {
  const ruleBlock = rules.map(renderRule).join("\n\n");
  const referenceBlock = references.map(renderReference).join("\n\n");
  return [HOUSE_RULES_HEADER, ruleBlock, REFERENCES_HEADER, referenceBlock].join("\n\n");
}

/**
 * Build the steering block for the Scaffolding sub-agent (cold-start skeleton,
 * D3/FR-003). It carries the rules the skeleton wires up — the config chokepoint,
 * the proving-provider default, the wrong-network guard, the container package
 * manager (the skeleton emits package.json + scripts), and the dev-wallet signing
 * mode (the skeleton wires the wallet-connection path) — plus the reference
 * snippets to adapt. The compact-testing rule is omitted: the skeleton does not
 * write the contract's tests (that is the Implementation agent's job).
 */
export function buildScaffoldingInstructions(): string {
  return composeInstructions(
    [
      SCAFFOLD_STEERING.configChokepointRule,
      SCAFFOLD_STEERING.proverProviderRule,
      SCAFFOLD_STEERING.networkGuardRule,
      SCAFFOLD_STEERING.packageManagerRule,
      SCAFFOLD_STEERING.devWalletRule,
    ],
    STANDARD_REFERENCES,
  );
}

/**
 * Build the steering block for the Implementation sub-agent (the build step of a
 * verify cycle, D3/FR-002). It carries ALL house rules — the Implementation agent
 * honours the chokepoint when reading the address, wires the providers per policy,
 * gates on the network, ships OZ-simulator + Vitest tests for the contract, uses
 * plain npm in the container, and signs via the dev wallet in local mode — plus
 * the same reference snippets to adapt.
 */
export function buildImplementationInstructions(): string {
  return composeInstructions(SCAFFOLD_STEERING_RULES, STANDARD_REFERENCES);
}
