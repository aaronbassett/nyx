/**
 * T086 — `contract:deployed` handler for the WebContainer preview host
 * (US3, D10, FR-055).
 *
 * When the server announces a finalized deploy, the client writes the contract
 * address into the container's `.env.local` (the D10 config chokepoint, via the
 * shared {@link ContainerEnv}) and then restarts the dev server so Vite re-reads
 * `import.meta.env` — a `.env.local` change is NOT picked up without a
 * dev-server restart. The write MUST precede the restart, or the freshly
 * respawned dev server would read a stale env.
 *
 * The restart mechanics (kill + respawn `npm run dev`) live in the
 * caller/coordinator and are injected as `restartDevServer`. The `ContainerEnv`
 * is likewise injected and shared with the `artifacts:ready` handler so the two
 * writers merge into one `.env.local` without clobbering each other. The
 * "deploy-first guard" (a pre-deploy render until the address is set) is the
 * generated scaffold's concern (US1), not this handler.
 */
import type { ContainerEnv } from "./env-file";
import type { ContractDeployedPayload } from "@nyx/protocol";

/** The Vite env var the generated scaffold reads for the deployed contract address (D10). */
export const CONTRACT_ADDRESS_ENV_KEY = "VITE_CONTRACT_ADDRESS";

/**
 * Handle a `contract:deployed` event: write `VITE_CONTRACT_ADDRESS` into
 * `.env.local` via the shared {@link ContainerEnv}, THEN restart the dev server
 * so Vite re-reads `import.meta.env`. The ordering is load-bearing — the write
 * is awaited to completion before the restart is triggered.
 */
export async function handleContractDeployed(
  payload: ContractDeployedPayload,
  deps: { env: ContainerEnv; restartDevServer: () => Promise<void> },
): Promise<void> {
  await deps.env.set(CONTRACT_ADDRESS_ENV_KEY, payload.address);
  await deps.restartDevServer();
}
