/**
 * Git materializer contract tests (US13 / FR-076 / D59 / EC-56/57) — deterministic,
 * in-memory, NO Postgres and NO browser.
 *
 * These drive {@link materializeRepo} over the in-memory {@link InMemoryProjectStore} and
 * read the result back with `isomorphic-git` itself (`log`/`readTree`/`readBlob`) to pin:
 *  - one synthesized commit PER version, oldest→newest, with descriptive messages (D59);
 *  - cumulative trees — a file added at v1 is still present in v3's tree (FR-076);
 *  - DETERMINISM — identical history in ⇒ identical commit SHAs out (SC-041);
 *  - EC-57 — a zero-version project materializes a valid one-commit README repo;
 *  - EC-56 — the repo is cached per `clone_materialized_at_version` watermark, and a new
 *    commit invalidates the cache; the watermark is persisted to the store column.
 */
import * as git from "isomorphic-git";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryRepoCache,
  DEFAULT_BRANCH,
  materializeRepo,
  UnsafePathError,
} from "../../src/projects/index.js";
import type { FileAuthor, MaterializedRepo } from "../../src/projects/index.js";
import { SecretsFoundError } from "../../src/projects/secrets.js";
import { makeInMemoryStore } from "../projects/helpers.js";
import type { Clock, InMemoryProjectStore } from "../projects/helpers.js";

const OWNER = "owner-address";

interface SeedCommit {
  readonly author: FileAuthor;
  readonly at: number;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** Seed a project's version history at explicit timestamps (deterministic commit SHAs). */
async function seed(
  store: InMemoryProjectStore,
  clock: Clock,
  commits: readonly SeedCommit[],
): Promise<string> {
  const project = await store.createProject(OWNER, "demo");
  for (const commit of commits) {
    clock.now = commit.at;
    await store.commit(project.id, { author: commit.author, files: [...commit.files] });
  }
  return project.id;
}

/** The commit messages oldest→newest (git.log returns newest-first). */
async function messagesOldestFirst(repo: MaterializedRepo): Promise<string[]> {
  const log = await git.log({ fs: repo.fs, gitdir: repo.gitdir, ref: "HEAD" });
  return log.map((entry) => entry.commit.message.trimEnd()).reverse();
}

/** Read one path's blob content at HEAD. */
async function readFileAtHead(repo: MaterializedRepo, filepath: string): Promise<string> {
  const { blob } = await git.readBlob({
    fs: repo.fs,
    gitdir: repo.gitdir,
    oid: repo.headOid,
    filepath,
  });
  return Buffer.from(blob).toString("utf8");
}

/** The entry paths of a tree at HEAD (`filepath: ""` = root). */
async function treePathsAtHead(repo: MaterializedRepo, filepath: string): Promise<string[]> {
  const { tree } = await git.readTree({
    fs: repo.fs,
    gitdir: repo.gitdir,
    oid: repo.headOid,
    filepath,
  });
  return tree.map((entry) => entry.path);
}

const THREE_VERSIONS: readonly SeedCommit[] = [
  {
    author: "agent",
    at: 1_700_000_000_000,
    files: [
      { path: "README.md", content: "# demo\n" },
      { path: "src/index.ts", content: "export const a = 1;\n" },
    ],
  },
  {
    author: "user",
    at: 1_700_000_100_000,
    files: [{ path: "src/index.ts", content: "export const a = 2;\n" }],
  },
  {
    author: "agent",
    at: 1_700_000_200_000,
    files: [{ path: "src/lib/util.ts", content: "export const u = 0;\n" }],
  },
];

let clock: Clock;
let store: InMemoryProjectStore;

beforeEach(() => {
  clock = { now: 1_000_000 };
  store = makeInMemoryStore(clock);
});

describe("materializeRepo — one commit per version (D59)", () => {
  it("synthesizes one commit per version, oldest→newest, chained by parent", async () => {
    const projectId = await seed(store, clock, THREE_VERSIONS);

    const repo = await materializeRepo(store, projectId);

    expect(repo.commitCount).toBe(3);
    expect(repo.defaultBranch).toBe(DEFAULT_BRANCH);
    const log = await git.log({ fs: repo.fs, gitdir: repo.gitdir, ref: "HEAD" });
    expect(log).toHaveLength(3);
    // HEAD resolves to the tip commit.
    expect(log[0]?.oid).toBe(repo.headOid);
  });

  it("writes descriptive messages from author + version + changed paths", async () => {
    const projectId = await seed(store, clock, [
      ...THREE_VERSIONS,
      {
        author: "agent",
        at: 1_700_000_300_000,
        files: [
          { path: "a.ts", content: "1" },
          { path: "b.ts", content: "2" },
          { path: "c.ts", content: "3" },
          { path: "d.ts", content: "4" },
        ],
      },
    ]);

    const repo = await materializeRepo(store, projectId);

    expect(await messagesOldestFirst(repo)).toEqual([
      "Agent turn v1: README.md, src/index.ts",
      "User edit v2: src/index.ts",
      "Agent turn v3: src/lib/util.ts",
      "Agent turn v4: a.ts, b.ts, c.ts (+1 more)",
    ]);
  });
});

describe("materializeRepo — cumulative trees (FR-076)", () => {
  it("folds files cumulatively — a v1 file survives into the v3 tree", async () => {
    const projectId = await seed(store, clock, THREE_VERSIONS);

    const repo = await materializeRepo(store, projectId);

    // HEAD (v3) tree still contains README.md (added at v1) plus the nested src tree.
    expect((await treePathsAtHead(repo, "")).sort()).toEqual(["README.md", "src"]);
    expect((await treePathsAtHead(repo, "src")).sort()).toEqual(["index.ts", "lib"]);
    expect(await treePathsAtHead(repo, "src/lib")).toEqual(["util.ts"]);
    // The v2 edit to src/index.ts is the content present at HEAD.
    expect(await readFileAtHead(repo, "src/index.ts")).toBe("export const a = 2;\n");
    // README.md, untouched since v1, is byte-identical at HEAD.
    expect(await readFileAtHead(repo, "README.md")).toBe("# demo\n");
  });
});

describe("materializeRepo — determinism (SC-041)", () => {
  it("produces identical SHAs for identical history across independent builds", async () => {
    const projectA = await seed(store, clock, THREE_VERSIONS);
    const repoA = await materializeRepo(store, projectA);

    const clockB: Clock = { now: 1_000_000 };
    const storeB = makeInMemoryStore(clockB);
    const projectB = await seed(storeB, clockB, THREE_VERSIONS);
    const repoB = await materializeRepo(storeB, projectB);

    expect(repoB.headOid).toBe(repoA.headOid);
    expect(repoB.objectOids).toEqual(repoA.objectOids);
    expect(repoB.commitCount).toBe(repoA.commitCount);
  });
});

describe("materializeRepo — empty project (EC-57)", () => {
  it("materializes a valid one-commit README repo for zero versions", async () => {
    const project = await store.createProject(OWNER, "empty");

    const repo = await materializeRepo(store, project.id, {
      emptyRepoTimestampMs: 1_700_000_000_000,
    });

    expect(repo.watermark).toBe(0);
    expect(repo.commitCount).toBe(1);
    const log = await git.log({ fs: repo.fs, gitdir: repo.gitdir, ref: "HEAD" });
    expect(log).toHaveLength(1);
    expect(await treePathsAtHead(repo, "")).toEqual(["README.md"]);
    const readme = await readFileAtHead(repo, "README.md");
    expect(readme).toContain(project.id);
  });

  it("is deterministic for the empty case too", async () => {
    const projectA = await store.createProject(OWNER, "empty");
    const repoA = await materializeRepo(store, projectA.id, { emptyRepoTimestampMs: 42_000 });

    const storeB = makeInMemoryStore({ now: 1_000_000 });
    const projectB = await storeB.createProject(OWNER, "empty");
    const repoB = await materializeRepo(storeB, projectB.id, { emptyRepoTimestampMs: 42_000 });

    // Same project id ("proj-1") + same README + same timestamp ⇒ same SHA.
    expect(repoB.headOid).toBe(repoA.headOid);
  });
});

describe("materializeRepo — secrets scan over FULL history (SC-044/FR-077, FIX 1)", () => {
  it("refuses a repo whose HISTORY carries a secret, even if the CURRENT tree is clean", async () => {
    // v1 commits a file with an AWS access key; v2 overwrites it with clean content. The latest
    // tree is clean, but the secret survives in `git log` — so the clone must be refused.
    const projectId = await seed(store, clock, [
      {
        author: "agent",
        at: 1_700_000_000_000,
        files: [{ path: "src/config.ts", content: 'const KEY = "AKIAIOSFODNN7EXAMPLE";\n' }],
      },
      {
        author: "user",
        at: 1_700_000_100_000,
        files: [{ path: "src/config.ts", content: "const KEY = readEnv();\n" }],
      },
    ]);

    await expect(materializeRepo(store, projectId)).rejects.toBeInstanceOf(SecretsFoundError);
  });

  it("materializes a clean history without incident", async () => {
    const projectId = await seed(store, clock, THREE_VERSIONS);
    const repo = await materializeRepo(store, projectId);
    expect(repo.commitCount).toBe(3);
  });
});

describe("materializeRepo — unsafe stored path (zip-slip, FIX 4)", () => {
  it("refuses a `..` traversal path anywhere in history", async () => {
    const projectId = await seed(store, clock, [
      {
        author: "agent",
        at: 1_700_000_000_000,
        files: [{ path: "../../etc/passwd", content: "root\n" }],
      },
    ]);
    await expect(materializeRepo(store, projectId)).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("refuses a `.git`-rooted path (control-dir plant)", async () => {
    const projectId = await seed(store, clock, [
      {
        author: "agent",
        at: 1_700_000_000_000,
        files: [{ path: ".git/hooks/post-checkout", content: "#!/bin/sh\n" }],
      },
    ]);
    await expect(materializeRepo(store, projectId)).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe("materializeRepo — watermark cache (EC-56)", () => {
  it("returns the cached repo at the same watermark and rebuilds after a new commit", async () => {
    const cache = createInMemoryRepoCache();
    const projectId = await seed(store, clock, THREE_VERSIONS);

    const first = await materializeRepo(store, projectId, { cache });
    const cachedHit = await materializeRepo(store, projectId, { cache });
    expect(cachedHit).toBe(first); // Same object identity — no rebuild at the same watermark.
    expect(first.watermark).toBe(3);

    // A new commit raises the watermark → cache miss → a fresh, different repo.
    clock.now = 1_700_000_400_000;
    await store.commit(projectId, {
      author: "user",
      files: [{ path: "NOTES.md", content: "hi\n" }],
    });
    const rebuilt = await materializeRepo(store, projectId, { cache });
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.watermark).toBe(4);
    expect(rebuilt.headOid).not.toBe(first.headOid);
    expect(rebuilt.commitCount).toBe(4);
  });

  it("persists the watermark to the store column, unless disabled", async () => {
    const projectId = await seed(store, clock, THREE_VERSIONS);
    expect(await store.getCloneMaterializedVersion(projectId)).toBeNull();

    await materializeRepo(store, projectId);
    expect(await store.getCloneMaterializedVersion(projectId)).toBe(3);

    // A second project materialized with persistWatermark:false leaves its column null.
    const other = await store.createProject(OWNER, "other");
    clock.now = 1_700_000_500_000;
    await store.commit(other.id, { author: "agent", files: [{ path: "x.ts", content: "x" }] });
    await materializeRepo(store, other.id, { persistWatermark: false });
    expect(await store.getCloneMaterializedVersion(other.id)).toBeNull();
  });
});
