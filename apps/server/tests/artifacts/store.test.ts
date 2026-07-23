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
  ArtifactStagingQuotaError,
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

/** Caps + clock overrides a test may hand `make` (all optional — sane defaults otherwise). */
interface StoreCaps {
  maxFileBytes?: number;
  maxBundleBytes?: number;
  maxStagedBytesPerProject?: number;
  maxStagedPrefixesPerProject?: number;
  clock?: () => number;
}

/** Each entry supplies a fresh store + an optional teardown; shared by both impls. */
interface StoreCase {
  readonly name: string;
  make(caps?: StoreCaps): Promise<ArtifactStore>;
  cleanup(): Promise<void>;
}

const tmpRoots: string[] = [];

/** Register + return a fresh temp root (swept in `afterAll`). */
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nyx-artifacts-"));
  tmpRoots.push(root);
  return root;
}

const cases: StoreCase[] = [
  {
    name: "in-memory",
    make: (caps) =>
      Promise.resolve(
        createInMemoryArtifactStore({
          maxFileBytes: caps?.maxFileBytes ?? 1_000_000,
          maxBundleBytes: caps?.maxBundleBytes ?? 10_000_000,
          ...(caps?.maxStagedBytesPerProject === undefined
            ? {}
            : { maxStagedBytesPerProject: caps.maxStagedBytesPerProject }),
          ...(caps?.maxStagedPrefixesPerProject === undefined
            ? {}
            : { maxStagedPrefixesPerProject: caps.maxStagedPrefixesPerProject }),
          ...(caps?.clock === undefined ? {} : { clock: caps.clock }),
        }),
      ),
    cleanup: () => Promise.resolve(),
  },
  {
    name: "local-disk",
    make: async (caps) =>
      createLocalArtifactStore({
        rootDir: await freshRoot(),
        maxFileBytes: caps?.maxFileBytes ?? 1_000_000,
        maxBundleBytes: caps?.maxBundleBytes ?? 10_000_000,
        ...(caps?.maxStagedBytesPerProject === undefined
          ? {}
          : { maxStagedBytesPerProject: caps.maxStagedBytesPerProject }),
        ...(caps?.maxStagedPrefixesPerProject === undefined
          ? {}
          : { maxStagedPrefixesPerProject: caps.maxStagedPrefixesPerProject }),
        ...(caps?.clock === undefined ? {} : { clock: caps.clock }),
      }),
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

  it("putFile REJECTS UnsafePathError for a NUL / C0 control char in the path (L3)", async () => {
    // A `\0` truncates at the syscall boundary (poison null) and makes Node fs throw a TypeError
    // (→ a 500) unless rejected up-front. The shared `isSafePath` now refuses the whole C0 range.
    const bytes = enc.encode("x");
    for (const path of ["a\u0000.bin", "dir/\u0000name", "a\u0001b.bin", "a\u001fb.bin"]) {
      await expect(
        store.putFile(PROJECT, SOURCE_HASH, path, bytes, "application/octet-stream"),
      ).rejects.toBeInstanceOf(UnsafePathError);
    }
  });

  it("putFile REJECTS ArtifactStagingQuotaError past the per-project staged-BYTES cap (M1)", async () => {
    // Generous per-prefix bundle cap, but a tight per-project STAGED (uncommitted) byte budget:
    // two distinct sourceHash prefixes together exceed it → the second PUT is refused.
    const capped = await testCase.make({ maxBundleBytes: 1_000, maxStagedBytesPerProject: 10 });
    const otherHash = "b".repeat(64);
    await capped.putFile(
      PROJECT,
      SOURCE_HASH,
      "a.bin",
      enc.encode("123456"),
      "application/octet-stream",
    ); // 6 staged
    await expect(
      capped.putFile(PROJECT, otherHash, "b.bin", enc.encode("12345"), "application/octet-stream"), // +5 → 11 > 10
    ).rejects.toBeInstanceOf(ArtifactStagingQuotaError);
  });

  it("putFile REJECTS ArtifactStagingQuotaError past the per-project uncommitted-PREFIX cap; committed prefixes do not count (M1)", async () => {
    const capped = await testCase.make({ maxStagedPrefixesPerProject: 1 });
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const hashC = "c".repeat(64);
    const bytes = enc.encode("x");

    // Prefix A is staged AND committed → durable, no longer counts against the staged-prefix cap.
    await capped.putFile(PROJECT, hashA, "f.bin", bytes, "application/octet-stream");
    await capped.commit(
      PROJECT,
      hashA,
      manifestFor([{ path: "f.bin", bytes, contentType: "application/octet-stream" }]),
    );

    // Prefix B is the ONE allowed uncommitted prefix …
    await expect(
      capped.putFile(PROJECT, hashB, "f.bin", bytes, "application/octet-stream"),
    ).resolves.toBeUndefined();
    // … prefix C would be a SECOND uncommitted prefix → refused (A being committed did not count).
    await expect(
      capped.putFile(PROJECT, hashC, "f.bin", bytes, "application/octet-stream"),
    ).rejects.toBeInstanceOf(ArtifactStagingQuotaError);
  });

  it("sweepStaged removes only uncommitted-and-old prefixes; committed + fresh survive (M1)", async () => {
    let t = 1_000;
    const capped = await testCase.make({ clock: () => t });
    const oldHash = "a".repeat(64);
    const doneHash = "b".repeat(64);
    const freshHash = "c".repeat(64);
    const bytes = enc.encode("payload");

    // OLD: staged at t=1000, never committed.
    await capped.putFile(PROJECT, oldHash, "f.bin", bytes, "application/octet-stream");
    // DONE: staged AND committed at t=1000 (durable — must survive the sweep).
    await capped.putFile(PROJECT, doneHash, "f.bin", bytes, "application/octet-stream");
    await capped.commit(
      PROJECT,
      doneHash,
      manifestFor([{ path: "f.bin", bytes, contentType: "application/octet-stream" }]),
    );

    // Advance the clock, then stage FRESH — its recent stagedAt keeps it above the cutoff.
    t = 5_000;
    await capped.putFile(PROJECT, freshHash, "f.bin", bytes, "application/octet-stream");

    // Cutoff = 5000 - 2000 = 3000: OLD (stagedAt 1000) is reclaimed; FRESH (5000) + DONE survive.
    const removed = await capped.sweepStaged(2_000);
    expect(removed).toBe(1);
    expect(await capped.getFile(PROJECT, oldHash, "f.bin")).toBeNull();
    expect(await capped.getManifest(PROJECT, doneHash)).not.toBeNull();
    expect(await capped.getFile(PROJECT, freshHash, "f.bin")).not.toBeNull();
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

describe("createLocalArtifactStore — per-prefix write serialization (L2 TOCTOU)", () => {
  it("two concurrent PUTs to ONE prefix whose sum exceeds the bundle cap → exactly one rejects", async () => {
    // The disk `putFile` reads the prefix's staged total, checks the bundle cap, THEN writes.
    // Without per-prefix serialization two racers both read total 0 and both pass (0 rejects) —
    // a TOCTOU. The mutex serializes them, so the second sees the first's bytes and is refused.
    const store = createLocalArtifactStore({
      rootDir: await freshRoot(),
      maxFileBytes: 1_000,
      maxBundleBytes: 10,
    });
    const ct = "application/octet-stream";
    const results = await Promise.allSettled([
      store.putFile(PROJECT, SOURCE_HASH, "a.bin", enc.encode("123456"), ct), // 6
      store.putFile(PROJECT, SOURCE_HASH, "b.bin", enc.encode("12345"), ct), // +5 → 11 > 10
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    const reason: unknown = rejected[0]?.status === "rejected" ? rejected[0].reason : undefined;
    expect(reason).toBeInstanceOf(ArtifactBundleTooLargeError);
  });
});
