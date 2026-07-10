// Copies the compiled ZK artifacts (prover key, verifier key, zkir) out of the
// contract's `managed/` output and into `public/zk/counter/` so the Vite dev
// server serves them statically. The browser ZK-config provider (and, for
// in-wallet proving, the wallet's KeyMaterialProvider) fetch them from there.
import { cp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const from = resolve(root, "contract/managed/counter");
const to = resolve(root, "public/zk/counter");

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
for (const sub of ["keys", "zkir"]) {
  await cp(resolve(from, sub), resolve(to, sub), { recursive: true });
  console.log(`synced ${sub} -> public/zk/counter/${sub}`);
}
