#!/usr/bin/env node
// Node CLI wrapper for the wasm build of compactc.
//
//   node node/compactc.mjs [compactc flags...] <source.compact> <output-dir>
//
// Runs the Compact compiler entirely inside WebAssembly (Chez Scheme pb
// kernel under Emscripten), against an in-memory filesystem, then copies the
// outputs back to the host output directory.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Prefer a locally built compiler (scripts/build-all.sh), else fall back to
// the prebuilt artifacts committed in web/ — a fresh clone has only the latter.
const candidates = [
  path.join(here, '..', 'build', 'out', 'compactc.js'),
  path.join(here, '..', 'web', 'compactc.js'),
];
const outJs = candidates.find((p) => fs.existsSync(p));
if (!outJs) {
  console.error(`missing compiler artifacts (looked in ${candidates.join(', ')})`);
  process.exit(1);
}

// emscripten 3.1.6 glue predates Node's global fetch and tries to fetch()
// local file paths; force the fs fallback.
globalThis.fetch = undefined;

const require = createRequire(import.meta.url);
const createCompactc = require(outJs);

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: compactc.mjs [flags...] <source.compact> <output-dir>');
  process.exit(1);
}
const hostOut = args[args.length - 1];
const hostSrc = args[args.length - 2];
const flags = args.slice(0, -2);

const Module = await createCompactc({
  arguments: [],
  locateFile: (p) => path.join(path.dirname(outJs), p),
  // default node quit() calls process.exit before we can copy files out of
  // MEMFS; rethrow instead so callMain surfaces ExitStatus to us.
  quit: (_status, toThrow) => { throw toThrow; },
});

const FS = Module.FS;
FS.mkdir('/work');
FS.mkdir('/out');
FS.writeFile('/work/' + path.basename(hostSrc), fs.readFileSync(hostSrc));

let status = 0;
try {
  status = Module.callMain([
    '-q', '-b', '/petite.boot', '-b', '/compactc.boot',
    ...flags, '/work/' + path.basename(hostSrc), '/out',
  ]);
} catch (e) {
  if (e && e.name === 'ExitStatus') status = e.status;
  else throw e;
}

// copy MEMFS /out back to the host
const copyTree = (memDir, dstDir) => {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of FS.readdir(memDir)) {
    if (name === '.' || name === '..') continue;
    const memPath = memDir + '/' + name;
    const st = FS.stat(memPath);
    if (FS.isDir(st.mode)) copyTree(memPath, path.join(dstDir, name));
    else fs.writeFileSync(path.join(dstDir, name), FS.readFile(memPath));
  }
};
copyTree('/out', hostOut);
process.exit(status);
