/**
 * Handoff archive contract tests (US13, FR-074/SC-042) — deterministic, in-memory, NO
 * Postgres.
 *
 * `buildArchive` materialises the LATEST committed tree (source only — the store never
 * persists `node_modules`/artifacts, D26) into a zip plus a generated handoff README that
 * documents local-run requirements. These tests pin:
 *  - SC-042 (the load-bearing guarantee): every archived FILE hashes back to the latest
 *    manifest EXACTLY. The test unzips with `fflate.unzipSync`, re-hashes each source file
 *    with the SAME `computeContentHash` the manifest uses, and asserts equality against the
 *    manifest entry — over a real multi-file, nested-path, Unicode project. The generated
 *    README is the ONLY archive member absent from the manifest.
 *  - Determinism: the same project state yields BYTE-IDENTICAL zip output (fixed mtime), so
 *    a re-download of an unchanged project is stable (D58 version-watermark caching).
 *  - The README documents `VITE_CONTRACT_ADDRESS` (intentionally NOT bundled — D10),
 *    `VITE_ZK_CONFIG_BASE_URL`, and a compile-+-run-locally outline.
 *  - The secrets gate: an archive whose tree contains a secret REJECTS (FR-077 scenario 5),
 *    and a files-vs-manifest divergence fails LOUDLY (EC-34) rather than shipping a lie.
 *
 * The primary case drives the shared {@link InMemoryProjectStore} through the real
 * `createProject`/`commit` path, so the manifest hashes are produced independently of the
 * archive — the hash-match is a genuine cross-check, not a tautology.
 */
import { strFromU8, unzipSync } from "fflate";
import type { Unzipped } from "fflate";
import { describe, expect, it } from "vitest";
import { ManifestEntrySchema } from "@nyx/protocol";
import {
  ArchiveManifestMismatchError,
  buildArchive,
  HANDOFF_README_PATH,
} from "../../src/projects/archive.js";
import { UnsafePathError } from "../../src/projects/paths.js";
import { SecretsFoundError } from "../../src/projects/secrets.js";
import { computeContentHash } from "../../src/projects/store.js";
import type { HandoffFile, ProjectStore } from "../../src/projects/store.js";
import { makeInMemoryStore } from "../projects/helpers.js";
import type { Clock } from "../projects/helpers.js";

const OWNER = "mn1qtestowneraddressunshielded0000000000000000000000000000";

/** A realistic multi-file, nested-path, Unicode source tree (all secret-free). */
const SOURCE_FILES = [
  {
    path: "client/src/lib/config.ts",
    content: [
      "// Contract-address chokepoint (D10).",
      "export function getContractAddress(): string {",
      "  const value = import.meta.env.VITE_CONTRACT_ADDRESS;",
      '  if (typeof value !== "string" || value.length === 0) {',
      '    throw new Error("deploy your contract first");',
      "  }",
      "  return value;",
      "}",
    ].join("\n"),
  },
  {
    path: "contracts/counter.compact",
    content: [
      "pragma language_version >= 0.16;",
      "import CompactStandardLibrary;",
      "export ledger count: Counter;",
      "export circuit increment(): [] { count.increment(1); }",
    ].join("\n"),
  },
  {
    path: "package.json",
    content: JSON.stringify({ name: "counter-dapp", version: "1.0.0", type: "module" }, null, 2),
  },
  {
    // A user's own README, with Unicode, to prove UTF-8 round-trips and that the
    // GENERATED handoff README lands at a DISTINCT reserved path.
    path: "README.md",
    content: "# Counter DApp\n\nBuilt with Nyx. Enjoy a café ☕ and some 日本語.\n",
  },
] satisfies { path: string; content: string }[];

/** Seed a fresh project, commit `files`, return its id. Caps are widened so a realistic
 *  tree fits (the shared store defaults to tiny caps to exercise rejection paths). */
async function seedProject(
  files: readonly { path: string; content: string }[],
): Promise<{ store: ProjectStore; projectId: string; name: string }> {
  const clock: Clock = { now: 1_000_000 };
  const store = makeInMemoryStore(clock, {
    maxFileBytes: 1_000_000,
    maxProjectBytes: 10_000_000,
    projectQuotaPerAccount: 10,
  });
  const name = "Counter DApp";
  const project = await store.createProject(OWNER, name);
  await store.commit(project.id, { author: "agent", files: [...files] });
  return { store, projectId: project.id, name };
}

/** Read one archive member, failing loudly if absent (keeps `noUncheckedIndexedAccess` honest). */
function bytesAt(unzipped: Unzipped, path: string): Uint8Array {
  const bytes = unzipped[path];
  if (bytes === undefined) {
    throw new Error(`archive missing ${path}`);
  }
  return bytes;
}

describe("buildArchive — SC-042 hash-match", () => {
  it("archives every source file so it hashes back to the latest manifest exactly", async () => {
    const { store, projectId, name } = await seedProject(SOURCE_FILES);

    const { zip } = await buildArchive(store, projectId, { projectName: name });
    const manifest = await store.getManifest(projectId);
    const unzipped = unzipSync(zip);

    // Every manifest entry is present AND its archived bytes re-hash to the manifest hash.
    for (const entry of manifest) {
      const roundTripped = strFromU8(bytesAt(unzipped, entry.path));
      expect(computeContentHash(roundTripped)).toBe(entry.contentHash);
    }

    // The archive's source members are EXACTLY the manifest paths; the generated README is
    // the sole extra member (it is deliberately not part of the committed tree/manifest).
    const memberPaths = Object.keys(unzipped).sort((a, b) => a.localeCompare(b));
    const sourcePaths = memberPaths.filter((p) => p !== HANDOFF_README_PATH);
    const manifestPaths = manifest.map((e) => e.path).sort((a, b) => a.localeCompare(b));
    expect(sourcePaths).toEqual(manifestPaths);
    expect(memberPaths).toContain(HANDOFF_README_PATH);
    expect(manifestPaths).not.toContain(HANDOFF_README_PATH);
  });

  it("round-trips Unicode content byte-exactly through the zip", async () => {
    const { store, projectId, name } = await seedProject(SOURCE_FILES);
    const { zip } = await buildArchive(store, projectId, { projectName: name });
    const unzipped = unzipSync(zip);
    expect(strFromU8(bytesAt(unzipped, "README.md"))).toContain("café ☕");
    expect(strFromU8(bytesAt(unzipped, "README.md"))).toContain("日本語");
  });
});

describe("buildArchive — generated README", () => {
  it("documents the project name and local-run requirements", async () => {
    const { store, projectId, name } = await seedProject(SOURCE_FILES);
    const { zip, readme } = await buildArchive(store, projectId, { projectName: name });

    // The README the caller sees matches the one inside the archive, byte-for-byte.
    const inZip = strFromU8(bytesAt(unzipSync(zip), HANDOFF_README_PATH));
    expect(inZip).toBe(readme);

    expect(readme).toContain(name);
    expect(readme).toContain("VITE_CONTRACT_ADDRESS");
    expect(readme).toContain(".env.local");
    expect(readme).toContain("VITE_ZK_CONFIG_BASE_URL");
    // The address chokepoint value is intentionally NOT bundled (D10).
    expect(readme.toLowerCase()).toContain("not include");
  });
});

describe("buildArchive — determinism", () => {
  it("produces byte-identical output for the same project state", async () => {
    const { store, projectId, name } = await seedProject(SOURCE_FILES);
    const first = await buildArchive(store, projectId, { projectName: name });
    const second = await buildArchive(store, projectId, { projectName: name });
    expect(Buffer.from(first.zip).equals(Buffer.from(second.zip))).toBe(true);
    expect(first.readme).toBe(second.readme);
  });
});

describe("buildArchive — safety gates", () => {
  it("rejects with SecretsFoundError when the tree contains a secret (FR-077)", async () => {
    const withSecret = [
      ...SOURCE_FILES,
      {
        path: "deploy/keys.ts",
        // A fake AWS access key smuggled into the tree — must never be served.
        content: 'export const KEY = "AKIAIOSFODNN7EXAMPLE";\n',
      },
    ];
    const { store, projectId, name } = await seedProject(withSecret);
    await expect(buildArchive(store, projectId, { projectName: name })).rejects.toBeInstanceOf(
      SecretsFoundError,
    );
  });

  it("rejects a zip-slip `..` traversal path in the stored tree (FIX 4)", async () => {
    const { store, projectId, name } = await seedProject([
      { path: "../../etc/passwd", content: "root\n" },
    ]);
    await expect(buildArchive(store, projectId, { projectName: name })).rejects.toBeInstanceOf(
      UnsafePathError,
    );
  });

  it("rejects a `.git`-rooted stored path (FIX 4)", async () => {
    const { store, projectId, name } = await seedProject([
      { path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" },
    ]);
    await expect(buildArchive(store, projectId, { projectName: name })).rejects.toBeInstanceOf(
      UnsafePathError,
    );
  });

  it("fails loudly when the files diverge from the manifest (EC-34)", async () => {
    // A store whose getFiles content does NOT hash to the manifest it reports.
    const files: HandoffFile[] = [
      { path: "a.ts", content: "hello", contentHash: computeContentHash("hello") },
    ];
    const staleStore: Pick<ProjectStore, "getFiles" | "getManifest"> = {
      getFiles: () => Promise.resolve(files),
      getManifest: () =>
        Promise.resolve([
          ManifestEntrySchema.parse({ path: "a.ts", contentHash: computeContentHash("STALE") }),
        ]),
    };
    await expect(buildArchive(staleStore, "proj-x", { projectName: "x" })).rejects.toBeInstanceOf(
      ArchiveManifestMismatchError,
    );
  });
});
