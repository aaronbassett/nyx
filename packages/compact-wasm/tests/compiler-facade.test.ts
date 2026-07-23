import { describe, expect, it } from "vitest";

import { createCompiler } from "../src/index.js";
import { computeSourceHash } from "../src/source-hash.js";
import { COMPILE_FLAGS } from "../src/engine.js";
import { COMPACT_WASM_META } from "../src/meta.js";
import type {
  CompilerEngine,
  EngineCheckResult,
  EngineCompileResult,
  WasmSourceFile,
} from "../src/engine.js";

const SOURCES: WasmSourceFile[] = [{ path: "c.compact", content: "pragma;" }];

/** A fake engine with scripted results and a deterministic clock stepping by 5ms per read. */
function fakeEngine(overrides: Partial<CompilerEngine>): CompilerEngine {
  return {
    check: overrides.check ?? (() => Promise.resolve({ ok: true, diagnostics: [] })),
    compile:
      overrides.compile ??
      (() => Promise.resolve({ ok: true, diagnostics: [], files: [], circuits: [] })),
  };
}

function steppingClock(step = 5): () => number {
  let t = 1000;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

describe("createCompiler.check", () => {
  it("passes through ok + diagnostics and adds compilerVersion + measured durationMs", async () => {
    const result: EngineCheckResult = {
      ok: false,
      diagnostics: [{ severity: "error", source: "compactp", message: "boom" }],
    };
    const compiler = createCompiler({
      engine: fakeEngine({ check: () => Promise.resolve(result) }),
      now: steppingClock(5),
    });
    const out = await compiler.check(SOURCES);
    expect(out.ok).toBe(false);
    expect(out.diagnostics).toEqual(result.diagnostics);
    expect(out.compilerVersion).toBe(COMPACT_WASM_META.compilerVersion);
    expect(out.durationMs).toBe(5);
  });

  it("surfaces an engine throw as ok:false with a synthesized compactc error diagnostic", async () => {
    const compiler = createCompiler({
      engine: fakeEngine({ check: () => Promise.reject(new Error("wasm exploded")) }),
    });
    const out = await compiler.check(SOURCES);
    expect(out.ok).toBe(false);
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]?.severity).toBe("error");
    expect(out.diagnostics[0]?.source).toBe("compactc");
    expect(out.diagnostics[0]?.message).toContain("wasm exploded");
  });
});

describe("createCompiler.compileFull", () => {
  it("on ok:true computes sourceHash and passes through files + circuits", async () => {
    const engineResult: EngineCompileResult = {
      ok: true,
      diagnostics: [],
      files: [
        {
          path: "contract/index.js",
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "application/javascript",
        },
      ],
      circuits: [{ name: "increment", proof: true }],
    };
    const compiler = createCompiler({
      engine: fakeEngine({ compile: () => Promise.resolve(engineResult) }),
      now: steppingClock(7),
    });
    const out = await compiler.compileFull(SOURCES);
    expect(out.ok).toBe(true);
    expect(out.compilerVersion).toBe(COMPACT_WASM_META.compilerVersion);
    expect(out.durationMs).toBe(7);
    expect(out.sourceHash).toBe(
      computeSourceHash(SOURCES, COMPACT_WASM_META.compilerVersion, COMPILE_FLAGS),
    );
    expect(out.files).toEqual(engineResult.files);
    expect(out.circuits).toEqual(engineResult.circuits);
  });

  it("on ok:false returns diagnostics with NO sourceHash/files/circuits", async () => {
    const engineResult: EngineCompileResult = {
      ok: false,
      diagnostics: [{ severity: "error", source: "compactc", message: "nope" }],
      files: [],
      circuits: [],
    };
    const compiler = createCompiler({
      engine: fakeEngine({ compile: () => Promise.resolve(engineResult) }),
    });
    const out = await compiler.compileFull(SOURCES);
    expect(out.ok).toBe(false);
    expect(out.diagnostics).toEqual(engineResult.diagnostics);
    expect(out.sourceHash).toBeUndefined();
    expect(out.files).toBeUndefined();
    expect(out.circuits).toBeUndefined();
  });

  it("surfaces an engine throw as ok:false with a synthesized error and no artifacts", async () => {
    const compiler = createCompiler({
      engine: fakeEngine({ compile: () => Promise.reject(new Error("kaboom")) }),
    });
    const out = await compiler.compileFull(SOURCES);
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]?.source).toBe("compactc");
    expect(out.diagnostics[0]?.message).toContain("kaboom");
    expect(out.sourceHash).toBeUndefined();
    expect(out.files).toBeUndefined();
  });
});
