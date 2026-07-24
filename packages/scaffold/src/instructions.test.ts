import { describe, expect, it } from "vitest";

import { buildImplementationInstructions, buildScaffoldingInstructions } from "./instructions.js";
import { SCAFFOLD_STEERING } from "./steering.js";

describe("buildScaffoldingInstructions", () => {
  it("is deterministic (stable across calls)", () => {
    expect(buildScaffoldingInstructions()).toBe(buildScaffoldingInstructions());
  });

  it("carries a Nyx house-rules header", () => {
    expect(buildScaffoldingInstructions()).toContain("Nyx");
  });

  it("composes the skeleton house rules (chokepoint, prover, network guard)", () => {
    const text = buildScaffoldingInstructions();
    expect(text).toContain("getContractAddress");
    expect(text).toContain("httpClientProofProvider");
    expect(text).toContain("EXPECTED_NETWORK_ID");
  });

  it("carries the container package-manager and dev-wallet rule titles", () => {
    const text = buildScaffoldingInstructions();
    expect(text).toContain(SCAFFOLD_STEERING.packageManagerRule.title);
    expect(text).toContain(SCAFFOLD_STEERING.devWalletRule.title);
    expect(text).toContain("VITE_DEV_WALLET_SEED");
  });

  it("embeds the reference config.ts body for the agent to adapt", () => {
    expect(buildScaffoldingInstructions()).toContain("VITE_CONTRACT_ADDRESS");
  });
});

describe("buildImplementationInstructions", () => {
  it("is deterministic (stable across calls)", () => {
    expect(buildImplementationInstructions()).toBe(buildImplementationInstructions());
  });

  it("composes all six house rules incl. compact-testing, package-manager, dev-wallet", () => {
    const text = buildImplementationInstructions();
    expect(text).toContain("getContractAddress");
    expect(text).toContain("httpClientProofProvider");
    expect(text).toContain("EXPECTED_NETWORK_ID");
    expect(text).toContain("compact-testing");
    expect(text).toContain(SCAFFOLD_STEERING.packageManagerRule.title);
    expect(text).toContain(SCAFFOLD_STEERING.devWalletRule.title);
    expect(text).toContain("VITE_DEV_WALLET_SEED");
  });

  it("carries a Nyx house-rules header", () => {
    expect(buildImplementationInstructions()).toContain("Nyx");
  });
});
