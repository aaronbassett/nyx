/**
 * US5 wallet-connect layer — expected network id (FR-037 wrong-network gate).
 *
 * The expected Midnight network id is configurable via the
 * `VITE_MIDNIGHT_NETWORK_ID` build-time env var and drives the wrong-network
 * comparison. The wrong-network LOGIC (compare connected vs expected) is correct
 * regardless of the literal value.
 *
 * TODO(verify): the platform targets Midnight pre-production, so this defaults to
 * "preprod". Confirm the exact pre-prod network-id string the connector reports
 * against `@midnight-ntwrk/midnight-js-network-id` at wiring (T039) and set
 * `VITE_MIDNIGHT_NETWORK_ID` accordingly.
 */

/** Read `import.meta.env.VITE_MIDNIGHT_NETWORK_ID` defensively (Vite-injected). */
function readConfiguredNetworkId(): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const value = meta.env?.VITE_MIDNIGHT_NETWORK_ID;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The network id the wallet is expected to be connected to. */
export const EXPECTED_NETWORK_ID: string = readConfiguredNetworkId() ?? "preprod";
