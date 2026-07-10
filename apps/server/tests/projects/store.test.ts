/**
 * Project store contract tests (T050) — deterministic, in-memory, NO Postgres.
 *
 * These drive {@link InMemoryProjectStore} directly (no HTTP) to pin the persistence
 * semantics US7 depends on:
 *  - project-wide MONOTONIC version allocation across turn-scoped batch commits;
 *  - SC-025: the manifest is stable across reopen and reproduces the exact tree via
 *    content-hash equality;
 *  - SC-026: a crash injected mid-batch leaves the PREVIOUS consistent version intact
 *    (atomic rollback), and never consumes a version;
 *  - scenario 6: size caps and quotas raise NAMED errors, never a silent truncation;
 *  - SC-028: soft-delete/restore round-trips both ways, and an expired window is named;
 *  - D48/D49: retention pruning and the 30-day purge;
 *  - D23: chat persists with a monotonic `seq` and rehydrates in order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { computeContentHash } from "../../src/projects/index.js";
import {
  FileTooLargeError,
  ProjectCountQuotaExceededError,
  ProjectQuotaExceededError,
  RestoreWindowExpiredError,
} from "../../src/projects/index.js";
import { makeInMemoryStore } from "./helpers.js";
import type { Clock, InMemoryProjectStore } from "./helpers.js";

const OWNER = "owner-address";
const DAY_MS = 86_400_000;

let clock: Clock;
let store: InMemoryProjectStore;

beforeEach(() => {
  clock = { now: 1_000_000 };
  store = makeInMemoryStore(clock);
});

describe("commit — project-wide monotonic version (scenario 1)", () => {
  it("stamps each batch with the next version and keeps current state at the latest", async () => {
    const project = await store.createProject(OWNER, "demo");

    const first = await store.commit(project.id, {
      author: "agent",
      files: [
        { path: "src/a.ts", content: "alpha" },
        { path: "src/b.ts", content: "beta" },
      ],
    });
    expect(first.version).toBe(1);

    const second = await store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/a.ts", content: "alpha-2" }],
    });
    expect(second.version).toBe(2);

    const fileA = await store.getFile(project.id, "src/a.ts");
    expect(fileA?.content).toBe("alpha-2");
    const fileB = await store.getFile(project.id, "src/b.ts");
    expect(fileB?.content).toBe("beta");
  });
});

describe("manifest — reopen equality (SC-025 / D38)", () => {
  it("serves a deterministic (path, contentHash) set that reproduces the tree on reopen", async () => {
    const project = await store.createProject(OWNER, "demo");
    const files = [
      { path: "b.ts", content: "second" },
      { path: "a.ts", content: "first" },
    ];
    await store.commit(project.id, { author: "agent", files });

    const manifest = await store.getManifest(project.id);
    // Ordered by path — a stable set to hash-compare on reconnect/reopen.
    expect(manifest.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);

    // Reopen: reading the manifest again yields an identical set (SC-025).
    const reopened = await store.getManifest(project.id);
    expect(reopened).toEqual(manifest);

    // Each hash is the server-side hash of the file content it points at.
    for (const entry of manifest) {
      const file = await store.getFile(project.id, entry.path);
      expect(file).not.toBeNull();
      expect(entry.contentHash).toBe(computeContentHash(file?.content ?? ""));
    }
  });

  it("gives identical content an identical hash so manifest equality holds", async () => {
    const p1 = await store.createProject(OWNER, "one");
    const p2 = await store.createProject(OWNER, "two");
    await store.commit(p1.id, { author: "agent", files: [{ path: "x.ts", content: "same" }] });
    await store.commit(p2.id, { author: "user", files: [{ path: "x.ts", content: "same" }] });

    const [m1] = await store.getManifest(p1.id);
    const [m2] = await store.getManifest(p2.id);
    expect(m1?.contentHash).toBe(m2?.contentHash);
  });
});

describe("commit — crash mid-batch leaves the previous version intact (SC-026)", () => {
  it("rolls back a partial batch and never consumes a version", async () => {
    const project = await store.createProject(OWNER, "demo");
    await store.commit(project.id, {
      author: "agent",
      files: [{ path: "a.ts", content: "one" }],
    });

    // Arm a crash after the FIRST of two writes lands, then attempt a 2-file batch.
    store.failNextCommitAfter(1);
    await expect(
      store.commit(project.id, {
        author: "agent",
        files: [
          { path: "b.ts", content: "two" },
          { path: "c.ts", content: "three" },
        ],
      }),
    ).rejects.toThrow(/mid-commit fault/);

    // The previous consistent state survives: only a.ts, still at version 1.
    const manifest = await store.getManifest(project.id);
    expect(manifest.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(await store.getFile(project.id, "b.ts")).toBeNull();
    expect(await store.getFile(project.id, "c.ts")).toBeNull();

    // The failed batch did not consume version 2 — the next good commit gets it.
    const next = await store.commit(project.id, {
      author: "agent",
      files: [{ path: "b.ts", content: "two" }],
    });
    expect(next.version).toBe(2);
  });
});

describe("size caps + quotas — named errors, never silent truncation (scenario 6)", () => {
  it("rejects a file exceeding maxFileBytes with FileTooLargeError and persists nothing", async () => {
    const project = await store.createProject(OWNER, "demo");
    const oversized = "x".repeat(100); // > maxFileBytes (64)
    await expect(
      store.commit(project.id, { author: "user", files: [{ path: "big.ts", content: oversized }] }),
    ).rejects.toBeInstanceOf(FileTooLargeError);

    expect(await store.getManifest(project.id)).toEqual([]);
  });

  it("rejects a commit exceeding maxProjectBytes with ProjectQuotaExceededError", async () => {
    const small = makeInMemoryStore(clock, { maxFileBytes: 64, maxProjectBytes: 100 });
    const project = await small.createProject(OWNER, "demo");
    await expect(
      small.commit(project.id, {
        author: "agent",
        files: [
          { path: "a.ts", content: "x".repeat(60) },
          { path: "b.ts", content: "y".repeat(60) }, // 120 > 100
        ],
      }),
    ).rejects.toBeInstanceOf(ProjectQuotaExceededError);
    expect(await small.getManifest(project.id)).toEqual([]);
  });

  it("rejects creating past the per-account project quota", async () => {
    const capped = makeInMemoryStore(clock, { projectQuotaPerAccount: 2 });
    await capped.createProject(OWNER, "one");
    await capped.createProject(OWNER, "two");
    await expect(capped.createProject(OWNER, "three")).rejects.toBeInstanceOf(
      ProjectCountQuotaExceededError,
    );
  });
});

describe("soft-delete + restore — both ways within the window (SC-028 / D49)", () => {
  it("hides a soft-deleted project from the list and restores it on request", async () => {
    const project = await store.createProject(OWNER, "demo");

    const deleted = await store.softDeleteProject(project.id);
    expect(deleted.deletedAt).toBeGreaterThan(0);
    expect(await store.listProjects(OWNER)).toEqual([]);

    const restored = await store.restoreProject(project.id);
    expect(restored.deletedAt).toBeUndefined();
    expect((await store.listProjects(OWNER)).map((p) => p.id)).toEqual([project.id]);
  });

  it("rejects a restore after the 30-day recovery window with a named error", async () => {
    const project = await store.createProject(OWNER, "demo");
    await store.softDeleteProject(project.id);

    clock.now += 31 * DAY_MS; // Past the 30-day window.
    await expect(store.restoreProject(project.id)).rejects.toBeInstanceOf(
      RestoreWindowExpiredError,
    );
  });

  it("purges soft-deleted projects only after the window elapses", async () => {
    const project = await store.createProject(OWNER, "demo");
    await store.softDeleteProject(project.id);

    clock.now += 10 * DAY_MS;
    expect(await store.purgeDeletedProjects()).toBe(0);
    expect(await store.getProject(project.id)).not.toBeNull();

    clock.now += 21 * DAY_MS; // Now 31 days total.
    expect(await store.purgeDeletedProjects()).toBe(1);
    expect(await store.getProject(project.id)).toBeNull();
  });
});

describe("version retention pruning (D48)", () => {
  it("keeps the newest N and the current version, pruning older-and-aged history", async () => {
    const project = await store.createProject(OWNER, "demo");
    // Five commits to the same path → versions 1..5 (retention count is 2).
    for (let i = 1; i <= 5; i += 1) {
      await store.commit(project.id, {
        author: "agent",
        files: [{ path: "a.ts", content: `v${String(i)}` }],
      });
    }
    clock.now += 40 * DAY_MS; // Age everything past the 30-day retention window.

    const removed = await store.pruneFileVersions();
    // Newest 2 (v4, v5) kept by count; v5 is also current — 3 old versions pruned.
    expect(removed).toBe(3);

    // The current content is untouched by pruning.
    const file = await store.getFile(project.id, "a.ts");
    expect(file?.content).toBe("v5");
  });
});

describe("chat — persistence + rehydration (D23)", () => {
  it("assigns a monotonic seq per project and rehydrates in order", async () => {
    const project = await store.createProject(OWNER, "demo");

    const first = await store.appendChat(project.id, { role: "user", content: "build me a dapp" });
    const second = await store.appendChat(project.id, {
      role: "assistant",
      content: "on it",
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const history = await store.getChat(project.id);
    expect(history.map((m) => m.content)).toEqual(["build me a dapp", "on it"]);
    expect(history.map((m) => m.seq)).toEqual([1, 2]);
  });
});
