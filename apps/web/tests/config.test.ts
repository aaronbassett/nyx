/**
 * T273 — web network-profile chokepoint (constitution VII). Confirms the active
 * {@link NetworkProfile} is selected from `VITE_NYX_NETWORK` (default
 * `local-devnet`) and that the wallet layer's `EXPECTED_NETWORK_ID` is derived
 * from it (single source of truth for the network id).
 *
 * The profile is resolved at module-load, so each case resets the module
 * registry and re-imports `@/config` under a stubbed `import.meta.env`, exactly
 * how the app reads it at build time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("network-profile chokepoint", () => {
  it("defaults to the local-devnet profile when VITE_NYX_NETWORK is unset", async () => {
    vi.resetModules();
    const { NETWORK } = await import("@/config");
    expect(NETWORK.id).toBe("local-devnet");
    expect(NETWORK.nodeUrl).toBe("http://localhost:9944");
    expect(NETWORK.proofServerUrl).toBe("http://localhost:6300");
    expect(NETWORK.indexerUrl).toBe("http://localhost:8088");
  });

  it("selects the preprod profile when VITE_NYX_NETWORK=preprod", async () => {
    vi.stubEnv("VITE_NYX_NETWORK", "preprod");
    vi.resetModules();
    const { NETWORK, NETWORK_PROFILES } = await import("@/config");
    expect(NETWORK.id).toBe("preprod");
    expect(NETWORK).toBe(NETWORK_PROFILES.preprod);
  });

  it("derives the wallet EXPECTED_NETWORK_ID from the active profile networkId", async () => {
    vi.resetModules();
    const { NETWORK } = await import("@/config");
    const { EXPECTED_NETWORK_ID } = await import("@/wallet/config");
    expect(EXPECTED_NETWORK_ID).toBe(NETWORK.networkId);
  });

  it("exposes NYXT_VAULT_ADDRESS from VITE_NYXT_VAULT_ADDRESS when set", async () => {
    const address = "0200f1e2d3c4b5a600000000000000000000000000000000000000000000000000";
    vi.stubEnv("VITE_NYXT_VAULT_ADDRESS", address);
    vi.resetModules();
    const { NYXT_VAULT_ADDRESS } = await import("@/config");
    expect(NYXT_VAULT_ADDRESS).toBe(address);
  });

  it("defaults NYXT_VAULT_ADDRESS to the empty string when the var is unset", async () => {
    vi.resetModules();
    const { NYXT_VAULT_ADDRESS } = await import("@/config");
    expect(NYXT_VAULT_ADDRESS).toBe("");
  });
});
