import { describe, expect, it } from "vitest";

import { buildImplementationInstructions, buildScaffoldingInstructions } from "./instructions.js";

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

  it("embeds the reference config.ts body for the agent to adapt", () => {
    expect(buildScaffoldingInstructions()).toContain("VITE_CONTRACT_ADDRESS");
  });
});

describe("buildImplementationInstructions", () => {
  it("is deterministic (stable across calls)", () => {
    expect(buildImplementationInstructions()).toBe(buildImplementationInstructions());
  });

  it("composes all four house rules incl. compact-testing", () => {
    const text = buildImplementationInstructions();
    expect(text).toContain("getContractAddress");
    expect(text).toContain("httpClientProofProvider");
    expect(text).toContain("EXPECTED_NETWORK_ID");
    expect(text).toContain("compact-testing");
  });

  it("carries a Nyx house-rules header", () => {
    expect(buildImplementationInstructions()).toContain("Nyx");
  });
});
