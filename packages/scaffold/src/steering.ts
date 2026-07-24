/**
 * Nyx scaffold STEERING — the platform "house rules" the Scaffolding and
 * Implementation sub-agents must honour when generating a DApp (US1, T141).
 *
 * There is NO template engine (D3/FR-003): the sub-agents generate the app by
 * retrieving generic Midnight skills at runtime (Tome/mnm), then GROUND every
 * shape in what they retrieve (constitution I). This module holds the delta the
 * generic skills do not carry — Nyx-platform-specific rules the wiring injects
 * into each sub-agent's `instructions` so the generated app follows the same
 * conventions the rest of the platform relies on:
 *
 * - {@link ScaffoldSteering.configChokepointRule} — contract address only via the
 *   `config.ts` chokepoint (D10, FR-080/FR-081, constitution VII);
 * - {@link ScaffoldSteering.proverProviderRule} — HTTP prover by default,
 *   flippable to in-wallet proving by config (D37, FR-061);
 * - {@link ScaffoldSteering.networkGuardRule} — guard the wallet network id
 *   against `EXPECTED_NETWORK_ID` (FR-037);
 * - {@link ScaffoldSteering.compactTestingRule} — ship OZ-simulator + Vitest tests
 *   for generated contracts per the compact-testing skill.
 * - {@link ScaffoldSteering.packageManagerRule} — the generated project runs inside
 *   the user's browser WebContainer and uses PLAIN npm (pnpm/sfw is a host-side
 *   rule for the Nyx repo, never the user's code; design §7 supply-chain split);
 * - {@link ScaffoldSteering.devWalletRule} — in local/dev-wallet mode the app signs
 *   and submits its own transactions in-page from `VITE_DEV_WALLET_SEED`, with no
 *   `window.midnight` connector inside the preview iframe (design §6, D37).
 *
 * The rules are DATA (typed constants); {@link (buildScaffoldingInstructions:function)}
 * and {@link (buildImplementationInstructions:function)} in `./instructions` do the
 * light composition into an instruction string. The agents do the real generation.
 */

/**
 * A single Nyx house rule a sub-agent must honour. It is guidance text plus the
 * decisions/requirements it traces to, kept as structured data so the wiring can
 * render, filter, or audit the rule set rather than parse a prose blob.
 */
export interface SteeringRule {
  /** Stable, unique key for the rule (e.g. `"config-chokepoint"`). */
  readonly id: string;
  /** Short human-readable title (used as the rule heading in instructions). */
  readonly title: string;
  /** The decisions / requirements this rule traces to (e.g. `["D10", "FR-081"]`). */
  readonly decisions: readonly string[];
  /** The steering text injected into a sub-agent's instructions. */
  readonly guidance: string;
}

/** The Nyx house rules, addressable by name. */
export interface ScaffoldSteering {
  /** Contract address only via the `config.ts` chokepoint (D10, FR-080/FR-081). */
  readonly configChokepointRule: SteeringRule;
  /** Proving provider defaults to the Nyx HTTP prover, flippable to in-wallet (D37, FR-061). */
  readonly proverProviderRule: SteeringRule;
  /** Guard the wallet network id against `EXPECTED_NETWORK_ID` (FR-037). */
  readonly networkGuardRule: SteeringRule;
  /** Ship OZ-simulator + Vitest tests for generated contracts (compact-testing skill). */
  readonly compactTestingRule: SteeringRule;
  /** Generated projects use PLAIN npm inside the WebContainer — never pnpm/sfw (design §7). */
  readonly packageManagerRule: SteeringRule;
  /** Dev-wallet mode signs/submits in-page from `VITE_DEV_WALLET_SEED`, no `window.midnight` iframe injection (design §6, D37). */
  readonly devWalletRule: SteeringRule;
}

/**
 * The Nyx scaffold steering rule set — the single source of the platform house
 * rules injected into the generation sub-agents. See {@link ScaffoldSteering}.
 */
export const SCAFFOLD_STEERING: ScaffoldSteering = {
  configChokepointRule: {
    id: "config-chokepoint",
    title: "Contract-address chokepoint",
    decisions: ["D10", "FR-080", "FR-081"],
    guidance:
      "The generated app reads the deployed contract address ONLY through " +
      "client/src/lib/config.ts via getContractAddress() and isContractDeployed(); no " +
      "other module may touch import.meta.env. The address comes from " +
      "import.meta.env.VITE_CONTRACT_ADDRESS — the VITE_ prefix is MANDATORY (Vite drops " +
      "unprefixed vars, so an unprefixed name reads back undefined). Before a contract " +
      "exists, isContractDeployed() is false and the UI renders a 'deploy your contract " +
      "first' guard instead of white-screening; a .compact edit marks the deployed " +
      "address stale until the next green verify cycle (D10, FR-080/FR-081). Adapt the " +
      "reference config.ts body — do not invent an alternative env-access path.",
  },
  proverProviderRule: {
    id: "prover-provider",
    title: "Proving-provider default",
    decisions: ["D37", "FR-061"],
    guidance:
      "Default the app's proving provider to the Nyx-hosted prover via " +
      "httpClientProofProvider, keeping dappConnectorProofProvider (in-wallet proving) as " +
      "a config-flippable path you switch to by a single config flag (D37, FR-061). This " +
      "rule fixes only the POLICY (HTTP prover by default, flippable to in-wallet); the " +
      "exact provider call shapes are RETRIEVAL-SOURCED (constitution I) — retrieve them " +
      "via mnm/MNE before writing them, never from memory.",
  },
  networkGuardRule: {
    id: "network-guard",
    title: "Wrong-network guard",
    decisions: ["FR-037"],
    guidance:
      "Guard the connected wallet's network id against the app's configured " +
      "EXPECTED_NETWORK_ID and block DApp actions on a mismatch (the wrong-network gate, " +
      "FR-037), mirroring the platform's network-profile chokepoint where " +
      "EXPECTED_NETWORK_ID derives from the selected NetworkProfile. The SDK call that " +
      "reads the wallet's current network id is RETRIEVAL-SOURCED (constitution I) — " +
      "retrieve the exact @midnight-ntwrk/* shape; this rule fixes only that the " +
      "comparison MUST exist and gate on equality.",
  },
  compactTestingRule: {
    id: "compact-testing",
    title: "Compact simulator tests",
    decisions: ["FR-027"],
    guidance:
      "Every generated Compact contract MUST ship behavioural tests written with the " +
      "OpenZeppelin Compact-simulator + Vitest, per the compact-testing skill. Do NOT " +
      "hand-write these tests from memory: retrieve and apply the compact-testing skill " +
      "(and the OZ-simulator patterns) so the tests use the real simulator API, then keep " +
      "them green as part of the verify cycle.",
  },
  packageManagerRule: {
    id: "package-manager",
    title: "Container package manager",
    decisions: ["design §7 supply-chain split"],
    guidance:
      "Generated projects run inside the user's browser WebContainer and use PLAIN npm for " +
      "every install/script (npm install, npm run dev, npm test) — exactly what the " +
      "in-browser runtime ships. NEVER generate pnpm, pnpm-lock.yaml, sfw, corepack, or " +
      "any custom registry configuration into a user project: pnpm+sfw hardening is a " +
      "HOST-side rule for the Nyx repo itself and must not leak into user code. Keep " +
      "generated package.json scripts boringly standard npm.",
  },
  devWalletRule: {
    id: "dev-wallet",
    title: "Dev-wallet transaction signing (local mode)",
    decisions: ["design §6 preview interaction", "D37"],
    guidance:
      "In local/dev-wallet mode the generated app signs and submits its own transactions " +
      "in-page: it reads the signing seed from import.meta.env.VITE_DEV_WALLET_SEED " +
      "(merged into the container .env.local by the platform — never hardcode a key, " +
      "never prompt for one) and derives the wallet identity from it. There is NO " +
      "window.midnight connector inside the preview iframe — do not generate connector " +
      "detection for local mode; gate any connector path behind the absence of " +
      "VITE_DEV_WALLET_SEED. The exact SDK call shapes for deriving the identity and " +
      "building/submitting transactions are RETRIEVAL-SOURCED (constitution I): retrieve " +
      "the platform's verified dev-wallet recipe (mirrored from the Nyx dev wallet and " +
      "ceremony modules) rather than writing SDK calls from memory.",
  },
};

/**
 * The steering rules as an ordered list — convenient for iteration (rendering
 * instructions, auditing the constitution-I flags). Same rules as
 * {@link SCAFFOLD_STEERING}, in a stable order (append-only — never reorder).
 */
export const SCAFFOLD_STEERING_RULES: readonly SteeringRule[] = [
  SCAFFOLD_STEERING.configChokepointRule,
  SCAFFOLD_STEERING.proverProviderRule,
  SCAFFOLD_STEERING.networkGuardRule,
  SCAFFOLD_STEERING.compactTestingRule,
  SCAFFOLD_STEERING.packageManagerRule,
  SCAFFOLD_STEERING.devWalletRule,
];
