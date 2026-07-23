import { describe, expect, it } from "vitest";
import { computeSourceHash } from "../src/source-hash.js";

const A = { path: "a.compact", content: "x" };
const B = { path: "b.compact", content: "y" };

describe("computeSourceHash", () => {
  it("is a lowercase sha-256 hex string", () => {
    expect(computeSourceHash([A], "0.1.0", [])).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is order-independent over files", () => {
    expect(computeSourceHash([A, B], "0.1.0", [])).toBe(computeSourceHash([B, A], "0.1.0", []));
  });

  it("changes when content, compilerVersion, or flags change", () => {
    const base = computeSourceHash([A], "0.1.0", []);
    expect(computeSourceHash([{ ...A, content: "z" }], "0.1.0", [])).not.toBe(base);
    expect(computeSourceHash([A], "0.2.0", [])).not.toBe(base);
    expect(computeSourceHash([A], "0.1.0", ["--skip-zk"])).not.toBe(base);
  });

  it("is stable across calls (deterministic)", () => {
    expect(computeSourceHash([A, B], "0.1.0", ["--skip-zk"])).toBe(
      computeSourceHash([A, B], "0.1.0", ["--skip-zk"]),
    );
  });
});
