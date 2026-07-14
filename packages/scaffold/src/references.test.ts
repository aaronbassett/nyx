import { describe, expect, it } from "vitest";

import {
  CONFIG_TS_REFERENCE,
  NETWORK_GUARD_REFERENCE,
  PROVER_PROVIDER_REFERENCE,
  RETRIEVAL_SOURCED_MARKER,
  SCAFFOLD_REFERENCES,
} from "./references.js";

describe("CONFIG_TS_REFERENCE", () => {
  it("exposes the chokepoint helpers and the VITE_CONTRACT_ADDRESS env var", () => {
    expect(CONFIG_TS_REFERENCE).toContain("getContractAddress");
    expect(CONFIG_TS_REFERENCE).toContain("isContractDeployed");
    expect(CONFIG_TS_REFERENCE).toContain("VITE_CONTRACT_ADDRESS");
  });

  it("reads import.meta.env exactly once, inside the chokepoint read helper (D10/FR-081)", () => {
    const occurrences = CONFIG_TS_REFERENCE.split("import.meta.env").length - 1;
    expect(occurrences).toBe(1);
    const readLine = CONFIG_TS_REFERENCE.split("\n").find((line) =>
      line.includes("import.meta.env"),
    );
    expect(readLine).toBeDefined();
    expect(readLine).toContain("VITE_CONTRACT_ADDRESS");
  });

  it("is a pure Vite-env chokepoint — no @midnight-ntwrk SDK shapes (constitution I)", () => {
    expect(CONFIG_TS_REFERENCE).not.toContain("@midnight-ntwrk");
  });
});

describe("PROVER_PROVIDER_REFERENCE", () => {
  it("fixes the provider policy and flags SDK shapes as retrieval-sourced", () => {
    expect(PROVER_PROVIDER_REFERENCE).toContain("httpClientProofProvider");
    expect(PROVER_PROVIDER_REFERENCE).toContain("dappConnectorProofProvider");
    expect(PROVER_PROVIDER_REFERENCE).toContain(RETRIEVAL_SOURCED_MARKER);
  });
});

describe("NETWORK_GUARD_REFERENCE", () => {
  it("references EXPECTED_NETWORK_ID and flags SDK shapes as retrieval-sourced", () => {
    expect(NETWORK_GUARD_REFERENCE).toContain("EXPECTED_NETWORK_ID");
    expect(NETWORK_GUARD_REFERENCE).toContain(RETRIEVAL_SOURCED_MARKER);
  });
});

describe("SCAFFOLD_REFERENCES", () => {
  it("collects every reference snippet by key", () => {
    expect(SCAFFOLD_REFERENCES.configTs).toBe(CONFIG_TS_REFERENCE);
    expect(SCAFFOLD_REFERENCES.proverProvider).toBe(PROVER_PROVIDER_REFERENCE);
    expect(SCAFFOLD_REFERENCES.networkGuard).toBe(NETWORK_GUARD_REFERENCE);
  });
});
