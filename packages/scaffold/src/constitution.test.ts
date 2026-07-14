import { describe, expect, it } from "vitest";

import { RETRIEVAL_SOURCED_MARKER, SCAFFOLD_REFERENCES } from "./references.js";
import { SCAFFOLD_STEERING_RULES } from "./steering.js";

/**
 * Constitution I guard: this package holds STEERING + reference snippets, never
 * authoritative `@midnight-ntwrk/*` API shapes. Any surface that names an
 * `@midnight-ntwrk` package MUST flag itself retrieval-sourced, so the agent
 * verifies the exact shape via mnm/MNE rather than copying it from here.
 */
describe("constitution I — no authoritative SDK shapes", () => {
  const surfaces: Record<string, string> = {
    ...SCAFFOLD_REFERENCES,
    ...Object.fromEntries(
      SCAFFOLD_STEERING_RULES.map((rule): [string, string] => [`rule:${rule.id}`, rule.guidance]),
    ),
  };

  it("flags every @midnight-ntwrk mention as retrieval-sourced", () => {
    for (const [name, text] of Object.entries(surfaces)) {
      if (text.includes("@midnight-ntwrk")) {
        expect(text, name).toContain(RETRIEVAL_SOURCED_MARKER);
      }
    }
  });

  it("has at least one retrieval-sourced surface (the guard is meaningful)", () => {
    const flagged = Object.values(surfaces).filter((text) =>
      text.includes(RETRIEVAL_SOURCED_MARKER),
    );
    expect(flagged.length).toBeGreaterThan(0);
  });

  it("keeps the contract-address chokepoint free of SDK shapes", () => {
    expect(SCAFFOLD_REFERENCES.configTs).not.toContain("@midnight-ntwrk");
  });
});
