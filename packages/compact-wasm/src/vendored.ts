import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPILE_FLAGS } from "./engine.js";
import type {
  CompiledFile,
  CompilerEngine,
  EngineCompileResult,
  WasmDiagnostic,
  WasmSourceFile,
} from "./engine.js";

const VENDOR_DIR = fileURLToPath(new URL("../vendor/", import.meta.url));
const COMPACTC_JS = join(VENDOR_DIR, "compactc.js");
const COMPACTC_WASM = join(VENDOR_DIR, "compactc.wasm");

/** Thrown when the vendored wasm toolchain is not present (vendor/ absent). */
export class VendoredToolchainMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendoredToolchainMissingError";
  }
}

// --- The real Emscripten module surface (read from vendor/compactc.js + the
// PoC's node/compactc.mjs driver — Constitution I, not from memory). compactc.js
// is a UMD factory: `module.exports = createCompactc(moduleArg) => Promise<Module>`.
// The compiler `main` is NOT auto-run (shouldRunNow is false); it is invoked via
// `Module.callMain(argv)`. The Chez pb kernel boot images (`/petite.boot`,
// `/compactc.boot`) are embedded in compactc.data (emscripten packager). ---

interface MemFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
}

interface CompactcModule {
  FS: MemFS;
  callMain(args: string[]): number;
}

interface ModuleArg {
  arguments: string[];
  locateFile: (path: string) => string;
  quit: (status: number, toThrow: unknown) => void;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

type CompactcFactory = (arg: ModuleArg) => Promise<CompactcModule>;

function loadFactory(): CompactcFactory {
  if (!existsSync(COMPACTC_WASM) || !existsSync(COMPACTC_JS)) {
    throw new VendoredToolchainMissingError(
      `vendored Compact compiler not found at ${VENDOR_DIR}. Run ` +
        `\`pnpm --filter @nyx/compact-wasm vendor\` to produce it (the artifacts are committed).`,
    );
  }
  const require = createRequire(import.meta.url);
  return require(COMPACTC_JS) as CompactcFactory;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".json": "application/json",
  ".zkir": "application/json",
  ".map": "application/json",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

interface RunResult {
  status: number;
  stderr: string[];
  files: CompiledFile[];
}

/** Ensure every parent directory of a MEMFS path exists. */
function mkdirp(fs: MemFS, filePath: string): void {
  const parts = filePath.split("/").filter(Boolean).slice(0, -1);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    try {
      fs.mkdir(cur);
    } catch {
      // already exists
    }
  }
}

function readOutTree(fs: MemFS, memDir: string, rel: string, out: CompiledFile[]): void {
  for (const name of fs.readdir(memDir)) {
    if (name === "." || name === "..") continue;
    const memPath = memDir + "/" + name;
    const childRel = rel ? `${rel}/${name}` : name;
    if (fs.isDir(fs.stat(memPath).mode)) {
      readOutTree(fs, memPath, childRel, out);
    } else {
      const bytes = fs.readFile(memPath);
      out.push({
        path: childRel,
        bytes: new Uint8Array(bytes),
        contentType: contentTypeFor(childRel),
      });
    }
  }
}

/**
 * Run the vendored compiler over `sources` (entry = sources[0]), replicating the
 * PoC driver's invocation. A wasm instance is created per call for MEMFS
 * isolation. Compilation failure is reported via a non-zero exit status +
 * stderr, never a throw; only a broken wasm module rejects.
 */
async function runCompiler(
  factory: CompactcFactory,
  sources: WasmSourceFile[],
  flags: readonly string[],
): Promise<RunResult> {
  if (sources.length === 0) {
    throw new Error("runCompiler: no sources provided");
  }
  const entry = sources[0];
  if (!entry) throw new Error("runCompiler: missing entry source");

  const stderr: string[] = [];

  const savedFetch = (globalThis as { fetch?: unknown }).fetch;
  // emscripten 3.1.69 glue predates node's global fetch and fetch()es the .data/
  // .wasm sidecars; force the fs fallback during instantiation, then restore.
  (globalThis as { fetch?: unknown }).fetch = undefined;
  let mod: CompactcModule;
  try {
    mod = await factory({
      arguments: [],
      locateFile: (p) => join(VENDOR_DIR, p),
      quit: (_status, toThrow) => {
        throw toThrow;
      },
      print: () => {
        /* compactc is silent on stdout; diagnostics land on stderr */
      },
      printErr: (line) => stderr.push(line),
    });
  } finally {
    (globalThis as { fetch?: unknown }).fetch = savedFetch;
  }

  const fs = mod.FS;
  fs.mkdir("/work");
  fs.mkdir("/out");
  for (const source of sources) {
    const memPath = "/work/" + source.path;
    mkdirp(fs, memPath);
    fs.writeFile(memPath, new TextEncoder().encode(source.content));
  }

  let status = 0;
  try {
    status = mod.callMain([
      "-q",
      "-b",
      "/petite.boot",
      "-b",
      "/compactc.boot",
      ...flags,
      "/work/" + entry.path,
      "/out",
    ]);
  } catch (err) {
    if (err && typeof err === "object" && (err as { name?: string }).name === "ExitStatus") {
      status = (err as { status: number }).status;
    } else {
      throw err;
    }
  }

  const files: CompiledFile[] = [];
  readOutTree(fs, "/out", "", files);
  return { status, stderr, files };
}

const HEADER_RE =
  /^(?:Exception|Error):\s*(?<file>.+?)\s+line\s+(?<line>\d+)\s+char\s+(?<col>\d+):\s*$/u;

/**
 * Parse the vendored compiler's stderr into structured diagnostics. 0.31.1 emits
 * no machine-readable diagnostics file; the human format is:
 *   `Exception: <file> line <N> char <C>:`
 *   `  <message...>`
 */
function parseDiagnostics(stderr: string[]): WasmDiagnostic[] {
  const lines = stderr.join("\n").split("\n");
  const diagnostics: WasmDiagnostic[] = [];
  let current: WasmDiagnostic | null = null;
  let messageParts: string[] = [];

  const flush = (): void => {
    if (current) {
      current.message = messageParts.join(" ").trim() || current.message;
      current.source = current.message.toLowerCase().includes("parse") ? "compactp" : "compactc";
      diagnostics.push(current);
    }
    current = null;
    messageParts = [];
  };

  for (const line of lines) {
    const match = HEADER_RE.exec(line);
    if (match?.groups) {
      flush();
      const lineNo = Number(match.groups.line);
      const colNo = Number(match.groups.col);
      current = {
        severity: "error",
        source: "compactc",
        message: "",
        span: { start: { line: lineNo, column: colNo } },
      };
      if (match.groups.file) current.file = match.groups.file;
      messageParts = [];
    } else if (current) {
      if (line.trim()) messageParts.push(line.trim());
    }
  }
  flush();

  if (diagnostics.length === 0 && stderr.join("\n").trim()) {
    diagnostics.push({ severity: "error", source: "compactc", message: stderr.join("\n").trim() });
  }
  return diagnostics;
}

function extractCircuits(files: CompiledFile[]): EngineCompileResult["circuits"] {
  const info = files.find(
    (f) => f.path === "compiler/contract-info.json" || basename(f.path) === "contract-info.json",
  );
  if (!info) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(info.bytes)) as {
      circuits?: { name?: unknown; proof?: unknown }[];
    };
    return (parsed.circuits ?? [])
      .filter(
        (c): c is { name: string; proof: boolean } =>
          typeof c.name === "string" && typeof c.proof === "boolean",
      )
      .map((c) => ({ name: c.name, proof: c.proof }));
  } catch {
    return [];
  }
}

/**
 * Load the vendored wasm compiler as a {@link CompilerEngine}. Rejects with a
 * {@link VendoredToolchainMissingError} when the vendored artifacts are absent.
 *
 * The compiler runs `--skip-zk`: it produces the generated JS, ZKIR, and
 * contract-info, but NOT prover/verifier keys — those come from a separate zkir
 * keygen step that is gated and not vendored in this task. The generated JS's
 * `checkRuntimeVersion('0.16.0')` is passed through untouched (no-bypass rule).
 */
export function loadVendoredEngine(): Promise<CompilerEngine> {
  const factory = loadFactory();
  const engine: CompilerEngine = {
    async check(sources) {
      const run = await runCompiler(factory, sources, COMPILE_FLAGS);
      return { ok: run.status === 0, diagnostics: parseDiagnostics(run.stderr) };
    },
    async compile(sources) {
      const run = await runCompiler(factory, sources, COMPILE_FLAGS);
      return {
        ok: run.status === 0,
        diagnostics: parseDiagnostics(run.stderr),
        files: run.files,
        circuits: extractCircuits(run.files),
      };
    },
  };
  return Promise.resolve(engine);
}
