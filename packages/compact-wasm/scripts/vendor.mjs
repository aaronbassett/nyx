#!/usr/bin/env node
/**
 * Vendor the prebuilt wasm Compact compiler into `packages/compact-wasm/vendor/`.
 *
 * The vendored artifacts are the `build/out/compactc.{js,wasm,data}` outputs of
 * a REBUILD of the compactc-wasm PoC at the pinned compact rev
 * `0da5b0452eb0c1053d42418bf34b12cc29c7d63e` (`compactc-v0.31.1`) — NOT the PoC
 * repo's committed `web/*` files (those are the HEAD pin: compiler 0.33.109 /
 * runtime 0.18.101, whose generated JS hard-fails on the devnet's
 * compact-runtime@0.16.0 stack; see SPIKE-1 report §Compiler pin decision).
 *
 * Before copying, this script runs the BYTE-IDENTITY GATE: it compiles the
 * reference contracts (counter, nyxt-vault) with the wasm compiler AND the
 * native 0.31.1 toolchain and asserts the generated `contract/index.js`
 * (including `checkRuntimeVersion('0.16.0')`), `compiler/contract-info.json`,
 * and every `zkir/<circuit>.zkir` are byte-identical. It STOPS on any mismatch.
 *
 * Source resolution:
 *   - `COMPACTC_WASM_SRC=<path>`  reuse an existing PoC checkout whose
 *     `build/out/compactc.{js,wasm,data}` already exist (the SPIKE-1 build).
 *   - otherwise, with `REBUILD=1`, clone `sourceRepo`, pin `COMPACT_REV`, and run
 *     the build stages. The reproducible-from-scratch build additionally needs
 *     the SPIKE-1 environment fixups (emscripten 3.1.69 / clang-19 — see
 *     SPIKE1_REPORT.md §Compiler pin decision). Consumers never run this; the
 *     vendored artifacts are committed.
 *
 * The zkir keygen wasm is NOT vendored by this script — its ledger-8 rebuild +
 * byte-compare gate is a later task/decision (SPIKE-1 risk 1). `zkirArtifactsDir`
 * stays absent until then and the loader surfaces that honestly.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.dirname(here);
const repoRoot = path.resolve(pkgRoot, "..", "..");
const vendorDir = path.join(pkgRoot, "vendor");
const referenceDir = path.join(vendorDir, "reference");

const config = JSON.parse(fs.readFileSync(path.join(pkgRoot, "vendor.config.json"), "utf8"));

function log(msg) {
  console.log(`[vendor] ${msg}`);
}

/** Resolve a PoC checkout whose build/out artifacts exist, cloning+building if asked. */
function resolveSource() {
  const fromEnv = process.env.COMPACTC_WASM_SRC;
  if (fromEnv) {
    const src = path.resolve(fromEnv);
    if (!config.artifacts.every((a) => fs.existsSync(path.join(src, a)))) {
      throw new Error(
        `COMPACTC_WASM_SRC=${src} is missing built artifacts (${config.artifacts.join(", ")}). ` +
          `Build the PoC there first, or unset COMPACTC_WASM_SRC and rerun with REBUILD=1.`,
      );
    }
    log(`reusing prebuilt PoC checkout: ${src}`);
    return src;
  }
  if (process.env.REBUILD !== "1") {
    throw new Error(
      "no COMPACTC_WASM_SRC set and REBUILD!=1. Point COMPACTC_WASM_SRC at a built compactc-wasm " +
        "checkout (SPIKE-1 build), or set REBUILD=1 to clone+build (needs the SPIKE-1 emscripten/clang-19 " +
        "environment fixups — see SPIKE1_REPORT.md §Compiler pin decision).",
    );
  }
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "compactc-wasm-"));
  log(`cloning ${config.sourceRepo} -> ${src}`);
  execFileSync("git", ["clone", "--no-checkout", config.sourceRepo, src], { stdio: "inherit" });
  execFileSync("git", ["-C", src, "checkout", "HEAD", "--", "."], { stdio: "inherit" });
  // Pin the compact source rev the rebuild uses (the load-bearing compactc-v0.31.1 pin).
  const envScript = path.join(src, "scripts", "00-env.sh");
  const envText = fs
    .readFileSync(envScript, "utf8")
    .replace(/^COMPACT_REV=.*$/mu, `COMPACT_REV=${config.compactRev}`);
  fs.writeFileSync(envScript, envText);
  log(`set COMPACT_REV=${config.compactRev}; running build stages (stage 03 takes >10 min)...`);
  execFileSync("npm", ["install"], { cwd: src, stdio: "inherit" });
  execFileSync("bash", ["scripts/build-all.sh"], { cwd: src, stdio: "inherit" });
  if (!config.artifacts.every((a) => fs.existsSync(path.join(src, a)))) {
    throw new Error(
      "build finished but build/out artifacts are missing — the SPIKE-1 environment fixups are " +
        "likely not applied (see SPIKE1_REPORT.md §Compiler pin decision).",
    );
  }
  return src;
}

/** Compile a single source with the wasm compiler at <outDir> (build/out), writing to dstDir. */
async function wasmCompile(outDir, srcPath, dstDir, flags) {
  const createCompactc = require(path.join(outDir, "compactc.js"));
  const savedFetch = globalThis.fetch;
  // emscripten 3.1.69 glue predates node global fetch and fetch()es sidecar files; force fs fallback.
  globalThis.fetch = undefined;
  let Module;
  try {
    Module = await createCompactc({
      arguments: [],
      locateFile: (p) => path.join(outDir, p),
      quit: (_status, toThrow) => {
        throw toThrow;
      },
      print: () => undefined,
      printErr: () => undefined,
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
  const FS = Module.FS;
  FS.mkdir("/work");
  FS.mkdir("/out");
  const base = path.basename(srcPath);
  FS.writeFile("/work/" + base, fs.readFileSync(srcPath));
  let status = 0;
  try {
    status = Module.callMain([
      "-q",
      "-b",
      "/petite.boot",
      "-b",
      "/compactc.boot",
      ...flags,
      "/work/" + base,
      "/out",
    ]);
  } catch (e) {
    if (e && e.name === "ExitStatus") status = e.status;
    else throw e;
  }
  const copyTree = (memDir, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of FS.readdir(memDir)) {
      if (name === "." || name === "..") continue;
      const memPath = memDir + "/" + name;
      if (FS.isDir(FS.stat(memPath).mode)) copyTree(memPath, path.join(dst, name));
      else fs.writeFileSync(path.join(dst, name), FS.readFile(memPath));
    }
  };
  copyTree("/out", dstDir);
  return status;
}

function nativeCompactc() {
  const base = path.join(os.homedir(), ".compact", "versions", config.meta.compilerVersion);
  if (!fs.existsSync(base)) return null;
  for (const triple of fs.readdirSync(base)) {
    const bin = path.join(base, triple, "compactc");
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Byte-identity gate: wasm output must equal native 0.31.1 output for the reference contracts. */
async function byteIdentityGate(srcOutDir) {
  const native = nativeCompactc();
  const refs = [
    {
      name: "counter",
      src: path.join(srcOutDir, "..", "..", "web", "examples", "counter.compact"),
    },
    {
      name: "nyxt-vault",
      src: path.join(repoRoot, "packages", "nyxt-vault", "src", "nyxt-vault.compact"),
    },
  ].filter((r) => fs.existsSync(r.src));

  if (!native) {
    log(
      `WARNING: native compactc ${config.meta.compilerVersion} not found under ~/.compact/versions — ` +
        `the byte-identity gate was NOT run by this script. Verify it manually before trusting the vendored artifacts.`,
    );
    return;
  }
  log(`byte-identity gate against native ${native}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "compactc-gate-"));
  for (const ref of refs) {
    const wasmOut = path.join(work, `${ref.name}-wasm`);
    const nativeOut = path.join(work, `${ref.name}-native`);
    await wasmCompile(srcOutDir, ref.src, wasmOut, ["--skip-zk"]);
    execFileSync(native, ["--skip-zk", ref.src, nativeOut], { stdio: "pipe" });
    const compare = [
      path.join("contract", "index.js"),
      path.join("compiler", "contract-info.json"),
    ];
    for (const z of fs.readdirSync(path.join(wasmOut, "zkir"))) compare.push(path.join("zkir", z));
    for (const rel of compare) {
      const a = path.join(wasmOut, rel);
      const b = path.join(nativeOut, rel);
      if (!fs.existsSync(b) || sha256(a) !== sha256(b)) {
        throw new Error(
          `BYTE-IDENTITY GATE FAILED for ${ref.name}/${rel}: wasm output differs from native ${config.meta.compilerVersion}. ` +
            `STOP — do not vendor these artifacts (SPIKE-1 §Evidence §6).`,
        );
      }
    }
    const idx = fs.readFileSync(path.join(wasmOut, "contract", "index.js"), "utf8");
    if (!idx.includes(`checkRuntimeVersion('${config.meta.runtimeVersion}')`)) {
      throw new Error(
        `${ref.name}: generated index.js does not pin checkRuntimeVersion('${config.meta.runtimeVersion}') — wrong compiler pin. STOP.`,
      );
    }
    log(
      `  ${ref.name}: IDENTICAL (${compare.length} files, checkRuntimeVersion('${config.meta.runtimeVersion}') present)`,
    );
  }
  fs.rmSync(work, { recursive: true, force: true });
}

async function main() {
  const src = resolveSource();
  const srcOutDir = path.join(src, "build", "out");

  await byteIdentityGate(srcOutDir);

  // Copy the vendored artifacts (verbatim) and verify integrity.
  fs.mkdirSync(vendorDir, { recursive: true });
  // compactc.js is a CommonJS UMD module (uses module.exports); @nyx/compact-wasm
  // is "type": "module", so mark vendor/ as a CommonJS boundary or `require()`
  // would treat compactc.js as ESM and drop its export (mirrors the PoC's build/out).
  fs.writeFileSync(
    path.join(vendorDir, "package.json"),
    JSON.stringify({ type: "commonjs" }) + "\n",
  );
  for (const artifact of config.artifacts) {
    const from = path.join(src, artifact);
    const to = path.join(vendorDir, path.basename(artifact));
    fs.copyFileSync(from, to);
    if (sha256(from) !== sha256(to)) throw new Error(`copy integrity check failed for ${artifact}`);
    log(`copied ${path.basename(artifact)} (${fs.statSync(to).size} bytes)`);
  }
  // The compiler boot images (`/petite.boot`, `/compactc.boot`) are embedded in
  // compactc.data (emscripten packager manifest) — no standalone boot files needed.

  // Reference copies (Constitution I): the PoC's Node driver documents the real
  // invocation shape, and the known-good sources drive the integration test.
  fs.mkdirSync(referenceDir, { recursive: true });
  for (const rel of config.referenceFiles) {
    const from = path.join(src, rel);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(referenceDir, path.basename(rel)));
      log(`reference: ${path.basename(rel)}`);
    }
  }
  const nyxtVault = path.join(repoRoot, "packages", "nyxt-vault", "src", "nyxt-vault.compact");
  if (fs.existsSync(nyxtVault))
    fs.copyFileSync(nyxtVault, path.join(referenceDir, "nyxt-vault.compact"));

  // meta.json — canonical version strings from vendor.config.json.meta (never
  // hardcoded in TS) plus provenance for the vendored artifacts.
  let pocCommit = null;
  try {
    pocCommit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    pocCommit = null;
  }
  const meta = {
    ...config.meta,
    provenance: {
      sourceRepo: config.sourceRepo,
      pocCommit,
      artifacts: config.artifacts.map((a) => path.basename(a)),
      generatedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(path.join(vendorDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  log(`wrote vendor/meta.json (compiler ${meta.compilerVersion}, compactRev ${meta.compactRev})`);
  log("done.");
}

main().catch((err) => {
  console.error(`[vendor] ${err.message}`);
  process.exit(1);
});
