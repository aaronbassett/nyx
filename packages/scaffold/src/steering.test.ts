import { describe, expect, it } from "vitest";

import { SCAFFOLD_STEERING, SCAFFOLD_STEERING_RULES, type SteeringRule } from "./steering.js";

describe("SCAFFOLD_STEERING", () => {
  const rules: readonly [keyof typeof SCAFFOLD_STEERING, SteeringRule][] = [
    ["configChokepointRule", SCAFFOLD_STEERING.configChokepointRule],
    ["proverProviderRule", SCAFFOLD_STEERING.proverProviderRule],
    ["networkGuardRule", SCAFFOLD_STEERING.networkGuardRule],
    ["compactTestingRule", SCAFFOLD_STEERING.compactTestingRule],
    ["packageManagerRule", SCAFFOLD_STEERING.packageManagerRule],
    ["devWalletRule", SCAFFOLD_STEERING.devWalletRule],
  ];

  it("exposes six rules, each with non-empty id/title/guidance/decisions", () => {
    expect(rules).toHaveLength(6);
    for (const [name, rule] of rules) {
      expect(rule.id.trim().length, name).toBeGreaterThan(0);
      expect(rule.title.trim().length, name).toBeGreaterThan(0);
      expect(rule.guidance.trim().length, name).toBeGreaterThan(0);
      expect(rule.decisions.length, name).toBeGreaterThan(0);
    }
  });

  it("collects the same six rules in SCAFFOLD_STEERING_RULES with unique ids", () => {
    expect(SCAFFOLD_STEERING_RULES).toHaveLength(6);
    const ids = SCAFFOLD_STEERING_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("package-manager");
    expect(ids).toContain("dev-wallet");
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

  it("package-manager rule mandates in-container npm and forbids pnpm/sfw (host-side only)", () => {
    const rule = SCAFFOLD_STEERING.packageManagerRule;
    expect(rule.id).toBe("package-manager");
    expect(rule.guidance).toContain("npm");
    // The container is the user's machine — the pnpm/sfw hardening must never leak in.
    expect(rule.guidance).toContain("pnpm");
    expect(rule.guidance).toContain("sfw");
    expect(rule.guidance).toContain("NEVER");
  });

  it("dev-wallet rule names the seed env var, .env.local, and the constitution-I marker", () => {
    const rule = SCAFFOLD_STEERING.devWalletRule;
    expect(rule.id).toBe("dev-wallet");
    expect(rule.guidance).toContain("VITE_DEV_WALLET_SEED");
    expect(rule.guidance).toContain(".env.local");
    // No window.midnight injection into the preview iframe (T185/US9 side-step).
    expect(rule.guidance).toContain("window.midnight");
    // SDK call shapes must be grounded in retrieval, never written from memory.
    expect(rule.guidance).toContain("RETRIEVAL-SOURCED");
    expect(rule.guidance.toLowerCase()).toContain("constitution");
  });
});
