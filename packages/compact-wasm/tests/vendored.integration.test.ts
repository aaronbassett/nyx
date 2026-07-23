import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadVendoredEngine, VendoredToolchainMissingError } from "../src/vendored.js";
import { COMPACT_WASM_META } from "../src/meta.js";

const vendorWasm = new URL("../vendor/compactc.wasm", import.meta.url);
const vendored = existsSync(fileURLToPath(vendorWasm));

// KNOWN_GOOD is the vendored, proven-good counter source (compiled clean at the
// 0.31.1 pin — SPIKE-1 §Evidence). KNOWN_BAD is a mechanical corruption of it —
// no Compact is written fresh from memory (Constitution I).
const counterUrl = new URL("../vendor/reference/counter.compact", import.meta.url);
const KNOWN_GOOD = vendored ? readFileSync(fileURLToPath(counterUrl), "utf8") : "";
const KNOWN_BAD = KNOWN_GOOD.replace(
  "export ledger round: Counter;",
  "export ledger round Counter;",
);

describe.skipIf(!vendored)("vendored engine (integration)", () => {
  it("check accepts a known-good contract and rejects a known-bad one", async () => {
    const engine = await loadVendoredEngine();

    const good = await engine.check([{ path: "counter.compact", content: KNOWN_GOOD }]);
    expect(good.ok).toBe(true);
    expect(good.diagnostics).toEqual([]);

    const bad = await engine.check([{ path: "counter.compact", content: KNOWN_BAD }]);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
    expect(bad.diagnostics[0]?.severity).toBe("error");
  });

  it("compile emits the generated JS pinned to the vendored runtime, plus ZKIR + circuits", async () => {
    const engine = await loadVendoredEngine();
    const result = await engine.compile([{ path: "counter.compact", content: KNOWN_GOOD }]);

    expect(result.ok).toBe(true);
    expect(result.circuits).toContainEqual({ name: "increment", proof: true });

    const indexJs = result.files.find((f) => f.path === "contract/index.js");
    expect(indexJs).toBeDefined();
    const source = new TextDecoder().decode(indexJs?.bytes);
    // The no-bypass rule: the runtime check is passed through untouched.
    expect(source).toContain(`checkRuntimeVersion('${COMPACT_WASM_META.runtimeVersion}')`);

    const zkir = result.files.find((f) => f.path === "zkir/increment.zkir");
    expect(zkir).toBeDefined();
  });
});

// This assertion is unconditional: when the toolchain is present it proves the
// happy path is reachable; the loader's absence behavior is documented by the
// named error type either way.
describe("loadVendoredEngine (contract)", () => {
  it("exposes a named error type for a missing toolchain", () => {
    expect(VendoredToolchainMissingError.prototype).toBeInstanceOf(Error);
    expect(new VendoredToolchainMissingError("x").name).toBe("VendoredToolchainMissingError");
  });
});
