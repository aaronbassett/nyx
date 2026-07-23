/**
 * ArtifactStore contract tests (P2 Task 5) — deterministic, parameterized over BOTH impls.
 *
 * The same behavioral suite drives the in-memory double and a `createLocalArtifactStore`
 * rooted in an `fs.mkdtemp` dir, pinning the semantics Task 6's routes stack over this store:
 *  - put → commit → getManifest / getFile round-trip;
 *  - manifest-last: `getManifest` returns `null` BEFORE commit (verifyPrefix must never see a
 *    half-uploaded prefix);
 *  - commit REJECTS `ArtifactHashMismatchError` when a listed sha256 ≠ the uploaded bytes;
 *  - commit REJECTS `ArtifactManifestIncompleteError` when a listed path was never uploaded;
 *  - `putFile` REJECTS `UnsafePathError` for `../`, absolute, and `.git/…` paths, and
 *    `InvalidSourceHashError` for a non-`^[a-f0-9]{64}$` hash;
 *  - per-file + cumulative bundle caps reject with their named errors;
 *  - a second `commit` for the same `(projectId, sourceHash)` is idempotent (content-addressed
 *    prefixes are immutable).
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactManifest } from "../../src/compile/schemas.js";
import {
  ArtifactBundleTooLargeError,
  ArtifactFileTooLargeError,
  ArtifactHashMismatchError,
  ArtifactManifestIncompleteError,
  InvalidSourceHashError,
  UnsafePathError,
} from "../../src/artifacts/index.js";
import {
  createInMemoryArtifactStore,
  createLocalArtifactStore,
} from "../../src/artifacts/index.js";
import type { ArtifactStore } from "../../src/artifacts/index.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const SOURCE_HASH = "a".repeat(64);
const enc = new TextEncoder();

/** sha256 hex of some bytes — the addressing the manifest asserts against. */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build a well-formed manifest listing the given `(path → bytes)` pairs. */
function manifestFor(
  files: { path: string; bytes: Uint8Array; contentType: string }[],
): ArtifactManifest {
  return {
    sourceHash: SOURCE_HASH,
    compilerVersion: "0.31.1",
    circuits: [{ name: "main", proof: true }],
    files: files.map((f) => ({
      path: f.path,
      sha256: sha256(f.bytes),
      bytes: f.bytes.length,
      contentType: f.contentType,
    })),
  };
}

/** Each entry supplies a fresh store + an optional teardown; shared by both impls. */
interface StoreCase {
  readonly name: string;
  make(caps?: { maxFileBytes?: number; maxBundleBytes?: number }): Promise<ArtifactStore>;
  cleanup(): Promise<void>;
}

const tmpRoots: string[] = [];

const cases: StoreCase[] = [
  {
    name: "in-memory",
    make: (caps) =>
      Promise.resolve(
        createInMemoryArtifactStore({
          maxFileBytes: caps?.maxFileBytes ?? 1_000_000,
          maxBundleBytes: caps?.maxBundleBytes ?? 10_000_000,
        }),
      ),
    cleanup: () => Promise.resolve(),
  },
  {
    name: "local-disk",
    make: async (caps) => {
      const root = await mkdtemp(join(tmpdir(), "nyx-artifacts-"));
      tmpRoots.push(root);
      return createLocalArtifactStore({
        rootDir: root,
        maxFileBytes: caps?.maxFileBytes ?? 1_000_000,
        maxBundleBytes: caps?.maxBundleBytes ?? 10_000_000,
      });
    },
    cleanup: () => Promise.resolve(),
  },
];

afterAll(async () => {
  for (const root of tmpRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

describe.each(cases)("ArtifactStore ($name)", (testCase) => {
  let store: ArtifactStore;

  beforeEach(async () => {
    store = await testCase.make();
  });

  it("round-trips put → commit → getManifest / getFile", async () => {
    const wasm = enc.encode("(module)");
    const key = enc.encode("zk-key-bytes");
    await store.putFile(PROJECT, SOURCE_HASH, "contract.wasm", wasm, "application/wasm");
    await store.putFile(PROJECT, SOURCE_HASH, "keys/main.prover", key, "application/octet-stream");

    const manifest = manifestFor([
      { path: "contract.wasm", bytes: wasm, contentType: "application/wasm" },
      { path: "keys/main.prover", bytes: key, contentType: "application/octet-stream" },
    ]);
    await store.commit(PROJECT, SOURCE_HASH, manifest);

    const got = await store.getManifest(PROJECT, SOURCE_HASH);
    expect(got).toEqual(manifest);

    const file = await store.getFile(PROJECT, SOURCE_HASH, "keys/main.prover");
    expect(file?.contentType).toBe("application/octet-stream");
    expect(file ? new Uint8Array(file.bytes) : null).toEqual(key);

    const missing = await store.getFile(PROJECT, SOURCE_HASH, "nope.bin");
    expect(missing).toBeNull();
  });

  it("getManifest returns null BEFORE commit (manifest-last)", async () => {
    const wasm = enc.encode("(module)");
    await store.putFile(PROJECT, SOURCE_HASH, "contract.wasm", wasm, "application/wasm");
    expect(await store.getManifest(PROJECT, SOURCE_HASH)).toBeNull();
    // ...and stays null for a prefix that was never touched at all.
    expect(await store.getManifest(PROJECT, "b".repeat(64))).toBeNull();
  });

  it("commit REJECTS ArtifactHashMismatchError when a listed sha256 is wrong", async () => {
    const wasm = enc.encode("(module)");
    await store.putFile(PROJECT, SOURCE_HASH, "contract.wasm", wasm, "application/wasm");
    const manifest = manifestFor([
      { path: "contract.wasm", bytes: wasm, contentType: "application/wasm" },
    ]);
    // Corrupt the listed hash so it no longer matches the uploaded bytes.
    const tampered: ArtifactManifest = {
      ...manifest,
      files: manifest.files.map((f) => ({ ...f, sha256: "f".repeat(64) })),
    };
    await expect(store.commit(PROJECT, SOURCE_HASH, tampered)).rejects.toBeInstanceOf(
      ArtifactHashMismatchError,
    );
    // A rejected commit leaves NO manifest (manifest-last is all-or-nothing).
    expect(await store.getManifest(PROJECT, SOURCE_HASH)).toBeNull();
  });

  it("commit REJECTS ArtifactManifestIncompleteError for a never-uploaded path", async () => {
    const wasm = enc.encode("(module)");
    await store.putFile(PROJECT, SOURCE_HASH, "contract.wasm", wasm, "application/wasm");
    const manifest = manifestFor([
      { path: "contract.wasm", bytes: wasm, contentType: "application/wasm" },
      {
        path: "keys/missing.prover",
        bytes: enc.encode("ghost"),
        contentType: "application/octet-stream",
      },
    ]);
    await expect(store.commit(PROJECT, SOURCE_HASH, manifest)).rejects.toBeInstanceOf(
      ArtifactManifestIncompleteError,
    );
    expect(await store.getManifest(PROJECT, SOURCE_HASH)).toBeNull();
  });

  it("putFile REJECTS UnsafePathError for traversal / absolute / .git paths", async () => {
    const bytes = enc.encode("x");
    for (const path of ["../escape.bin", "/etc/passwd", ".git/config", "a/../../b"]) {
      await expect(
        store.putFile(PROJECT, SOURCE_HASH, path, bytes, "application/octet-stream"),
      ).rejects.toBeInstanceOf(UnsafePathError);
    }
  });

  it("putFile REJECTS InvalidSourceHashError for a non-hex64 source hash", async () => {
    const bytes = enc.encode("x");
    for (const bad of ["deadbeef", "A".repeat(64), "g".repeat(64), `${SOURCE_HASH}0`]) {
      await expect(
        store.putFile(PROJECT, bad, "contract.wasm", bytes, "application/wasm"),
      ).rejects.toBeInstanceOf(InvalidSourceHashError);
    }
  });

  it("putFile REJECTS an unsafe project id (traversal via the id)", async () => {
    const bytes = enc.encode("x");
    for (const bad of ["../evil", "a/b", ".git", "has space"]) {
      await expect(
        store.putFile(bad, SOURCE_HASH, "contract.wasm", bytes, "application/wasm"),
      ).rejects.toBeInstanceOf(UnsafePathError);
    }
  });

  it("putFile REJECTS ArtifactFileTooLargeError past the per-file cap", async () => {
    const small = await testCase.make({ maxFileBytes: 8 });
    await expect(
      small.putFile(
        PROJECT,
        SOURCE_HASH,
        "big.bin",
        enc.encode("123456789"),
        "application/octet-stream",
      ),
    ).rejects.toBeInstanceOf(ArtifactFileTooLargeError);
    // A file exactly at the cap is accepted.
    await expect(
      small.putFile(
        PROJECT,
        SOURCE_HASH,
        "ok.bin",
        enc.encode("12345678"),
        "application/octet-stream",
      ),
    ).resolves.toBeUndefined();
  });

  it("putFile REJECTS ArtifactBundleTooLargeError past the cumulative cap", async () => {
    const capped = await testCase.make({ maxBundleBytes: 10 });
    await capped.putFile(
      PROJECT,
      SOURCE_HASH,
      "a.bin",
      enc.encode("123456"),
      "application/octet-stream",
    );
    await expect(
      capped.putFile(
        PROJECT,
        SOURCE_HASH,
        "b.bin",
        enc.encode("12345"),
        "application/octet-stream",
      ),
    ).rejects.toBeInstanceOf(ArtifactBundleTooLargeError);
    // Overwriting an existing path re-accounts its bytes (does not double-count).
    await expect(
      capped.putFile(PROJECT, SOURCE_HASH, "a.bin", enc.encode("1234"), "application/octet-stream"),
    ).resolves.toBeUndefined();
  });

  it("a second commit for the same (projectId, sourceHash) is idempotent", async () => {
    const wasm = enc.encode("(module)");
    await store.putFile(PROJECT, SOURCE_HASH, "contract.wasm", wasm, "application/wasm");
    const manifest = manifestFor([
      { path: "contract.wasm", bytes: wasm, contentType: "application/wasm" },
    ]);
    await store.commit(PROJECT, SOURCE_HASH, manifest);
    await expect(store.commit(PROJECT, SOURCE_HASH, manifest)).resolves.toBeUndefined();
    expect(await store.getManifest(PROJECT, SOURCE_HASH)).toEqual(manifest);
  });

  it("isolates files by (projectId, sourceHash) prefix", async () => {
    const a = enc.encode("alpha");
    const b = enc.encode("beta");
    const otherHash = "c".repeat(64);
    await store.putFile(PROJECT, SOURCE_HASH, "f.bin", a, "application/octet-stream");
    await store.putFile(PROJECT, otherHash, "f.bin", b, "application/octet-stream");
    await store.commit(
      PROJECT,
      SOURCE_HASH,
      manifestFor([{ path: "f.bin", bytes: a, contentType: "application/octet-stream" }]),
    );

    const fromA = await store.getFile(PROJECT, SOURCE_HASH, "f.bin");
    expect(fromA ? new Uint8Array(fromA.bytes) : null).toEqual(a);
    // The other prefix is untouched by the first prefix's commit.
    expect(await store.getManifest(PROJECT, otherHash)).toBeNull();
    const fromB = await store.getFile(PROJECT, otherHash, "f.bin");
    expect(fromB ? new Uint8Array(fromB.bytes) : null).toEqual(b);
  });
});
