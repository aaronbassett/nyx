/**
 * Reference snippets the Nyx sub-agents ADAPT when generating a DApp.
 *
 * These are NOT a template the platform emits verbatim (there is no template
 * engine — D3/FR-003): they are small, load-bearing reference bodies the
 * Scaffolding/Implementation agents adapt to the specific app they are building.
 * Two kinds live here:
 *
 * 1. {@link CONFIG_TS_REFERENCE} — a concrete, self-contained file body (the
 *    contract-address chokepoint) that is pure Vite-env plumbing with no SDK
 *    surface, so it CAN be adapted almost as-is (D10/FR-081, constitution VII).
 * 2. {@link PROVER_PROVIDER_REFERENCE} / {@link NETWORK_GUARD_REFERENCE} — policy
 *    snippets that name `@midnight-ntwrk/*` symbols only to fix the POLICY (which
 *    provider is the default, that a network check must exist). Their exact SDK
 *    call shapes are NOT authoritative and are marked {@link RETRIEVAL_SOURCED_MARKER}:
 *    the Implementation agent MUST retrieve the current shapes via mnm/MNE before
 *    writing real code, never copy them from here (constitution I).
 */

/**
 * The in-band marker stamped on any reference (or steering) surface whose
 * `@midnight-ntwrk/*` symbols are illustrative, not authoritative. A surface that
 * names an SDK package without this marker would be a constitution-I violation;
 * the package's own tests enforce the pairing.
 */
export const RETRIEVAL_SOURCED_MARKER = "RETRIEVAL-SOURCED";

/**
 * Reference body for the generated app's `client/src/lib/config.ts` — the single
 * contract-address chokepoint (D10, FR-081, constitution VII).
 *
 * The invariants the agent must preserve when adapting this:
 * - `import.meta.env` is read in EXACTLY ONE place (the private
 *   `readContractAddress` helper); every other module calls
 *   {@link CONFIG_TS_REFERENCE|getContractAddress} / `isContractDeployed`.
 * - The env var is `VITE_CONTRACT_ADDRESS` — the `VITE_` prefix is mandatory
 *   (Vite only exposes `VITE_`-prefixed vars to client code; an unprefixed name
 *   reads back `undefined`).
 * - The pre-deploy state renders a "deploy your contract" guard rather than
 *   white-screening (`isContractDeployed` is `false`, `getContractAddress` throws).
 *
 * No `@midnight-ntwrk/*` symbols appear here by design: the address is runtime
 * config, not an SDK shape.
 */
export const CONFIG_TS_REFERENCE = `/**
 * Contract-address chokepoint — the single place this app reads the deployed
 * contract address (D10, FR-081). Every other module MUST call getContractAddress()
 * or isContractDeployed(); nothing else touches the build env directly.
 *
 * The address is provisioned by the platform into .env.local as VITE_CONTRACT_ADDRESS
 * (the VITE_ prefix is mandatory — Vite drops unprefixed vars). Editing a .compact
 * source marks the deployed address stale until the next green verify cycle, so treat
 * a present address as "last known good", not "guaranteed live".
 */

/** Read the raw contract address from the Vite build env — the ONE chokepoint. */
function readContractAddress(): string | undefined {
  const value = import.meta.env.VITE_CONTRACT_ADDRESS;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True once a contract address has been provisioned (post-deploy). */
export function isContractDeployed(): boolean {
  return readContractAddress() !== undefined;
}

/**
 * The deployed contract address. Gate on isContractDeployed() first and render a
 * "deploy your contract" guard; this throws (rather than white-screening) when
 * called before a deploy.
 */
export function getContractAddress(): string {
  const address = readContractAddress();
  if (address === undefined) {
    throw new Error("No contract deployed yet — deploy before reading the address.");
  }
  return address;
}
`;

/**
 * Reference for the generated app's proving-provider wiring (D37, FR-061).
 *
 * POLICY only: default to the Nyx-hosted prover via `httpClientProofProvider`, and
 * keep `dappConnectorProofProvider` (in-wallet proving) as the config-flippable
 * path. The exact `@midnight-ntwrk/*` package exports and argument shapes are
 * {@link RETRIEVAL_SOURCED_MARKER} — the agent retrieves them via mnm/MNE and must
 * not treat the illustrative imports below as authoritative (constitution I).
 */
export const PROVER_PROVIDER_REFERENCE = `// Proving provider policy — ${RETRIEVAL_SOURCED_MARKER} (constitution I).
//
// This snippet fixes the POLICY only: default to the Nyx-hosted HTTP prover,
// flippable to in-wallet proving by a single config flag (D37, FR-061). The exact
// @midnight-ntwrk/* exports + argument shapes below are NOT authoritative — retrieve
// the current shapes via mnm/MNE before writing real code; do not copy from here.
//
//   // ${RETRIEVAL_SOURCED_MARKER}: verify package + export + args via retrieval
//   import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
//   import { dappConnectorProofProvider } from "@midnight-ntwrk/..."; // verify pkg + export
//
//   // Default path (D37): prove through the Nyx-hosted prover.
//   const proofProvider = appConfig.useInWalletProving
//     ? dappConnectorProofProvider(/* retrieve arg shape */)
//     : httpClientProofProvider(NYX_PROVER_URL /* retrieve arg shape */);
`;

/**
 * Reference for the generated app's wrong-network guard (FR-037).
 *
 * POLICY only: compare the connected wallet's network id against the app's
 * `EXPECTED_NETWORK_ID` (derived from the selected network profile, mirroring the
 * platform's own chokepoint) and block actions on a mismatch. The SDK call that
 * reads the wallet's current network id is {@link RETRIEVAL_SOURCED_MARKER}: the
 * agent retrieves the exact `@midnight-ntwrk/*` shape (constitution I).
 */
export const NETWORK_GUARD_REFERENCE = `// Wrong-network guard — ${RETRIEVAL_SOURCED_MARKER} (constitution I).
//
// Compare the connected wallet's network id against the app's EXPECTED_NETWORK_ID
// (derived from the selected network profile) and block actions on a mismatch
// (FR-037). The SDK call that reads the wallet's current network id is
// ${RETRIEVAL_SOURCED_MARKER} — retrieve the exact @midnight-ntwrk/* shape; only the
// comparison + gate below is fixed here.
//
//   const connected = /* retrieve: read the wallet network id via @midnight-ntwrk/* */;
//   if (connected !== EXPECTED_NETWORK_ID) {
//     // render a "switch to the right network" guard; do not proceed.
//   }
`;

/** A named reference snippet: a short label plus its adaptable body. */
export interface ReferenceSnippet {
  /** Human-readable label for the snippet (used as a section heading in instructions). */
  readonly label: string;
  /** The reference body the agent adapts. */
  readonly body: string;
}

/** Every reference snippet, keyed for iteration (e.g. the constitution-I guard). */
export const SCAFFOLD_REFERENCES = {
  configTs: CONFIG_TS_REFERENCE,
  proverProvider: PROVER_PROVIDER_REFERENCE,
  networkGuard: NETWORK_GUARD_REFERENCE,
} as const;
