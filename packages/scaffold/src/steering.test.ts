import { describe, expect, it } from "vitest";

import { SCAFFOLD_STEERING, SCAFFOLD_STEERING_RULES, type SteeringRule } from "./steering.js";

describe("SCAFFOLD_STEERING", () => {
  const rules: readonly [keyof typeof SCAFFOLD_STEERING, SteeringRule][] = [
    ["configChokepointRule", SCAFFOLD_STEERING.configChokepointRule],
    ["proverProviderRule", SCAFFOLD_STEERING.proverProviderRule],
    ["networkGuardRule", SCAFFOLD_STEERING.networkGuardRule],
    ["compactTestingRule", SCAFFOLD_STEERING.compactTestingRule],
  ];

  it("exposes four rules, each with non-empty id/title/guidance/decisions", () => {
    expect(rules).toHaveLength(4);
    for (const [name, rule] of rules) {
      expect(rule.id.trim().length, name).toBeGreaterThan(0);
      expect(rule.title.trim().length, name).toBeGreaterThan(0);
      expect(rule.guidance.trim().length, name).toBeGreaterThan(0);
      expect(rule.decisions.length, name).toBeGreaterThan(0);
    }
  });

  it("collects the same four rules in SCAFFOLD_STEERING_RULES with unique ids", () => {
    expect(SCAFFOLD_STEERING_RULES).toHaveLength(4);
    const ids = SCAFFOLD_STEERING_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("config chokepoint rule names the helpers and the mandatory VITE_ prefix (D10/FR-081)", () => {
    const guidance = SCAFFOLD_STEERING.configChokepointRule.guidance;
    expect(guidance).toContain("config.ts");
    expect(guidance).toContain("getContractAddress");
    expect(guidance).toContain("isContractDeployed");
    expect(guidance).toContain("import.meta.env");
    expect(guidance).toContain("VITE_");
  });

  it("prover provider rule defaults to the Nyx HTTP prover, flippable to in-wallet (D37/FR-061)", () => {
    const guidance = SCAFFOLD_STEERING.proverProviderRule.guidance;
    expect(guidance).toContain("httpClientProofProvider");
    expect(guidance).toContain("dappConnectorProofProvider");
    expect(guidance.toLowerCase()).toContain("in-wallet");
  });

  it("network guard rule references the EXPECTED_NETWORK_ID wrong-network gate", () => {
    const guidance = SCAFFOLD_STEERING.networkGuardRule.guidance;
    expect(guidance).toContain("EXPECTED_NETWORK_ID");
    expect(guidance.toLowerCase()).toContain("network");
  });

  it("compact-testing rule points at the compact-testing skill + OZ-simulator Vitest tests", () => {
    const guidance = SCAFFOLD_STEERING.compactTestingRule.guidance;
    expect(guidance).toContain("compact-testing");
    expect(guidance).toContain("Vitest");
    expect(guidance.toLowerCase()).toContain("retriev");
  });
});
