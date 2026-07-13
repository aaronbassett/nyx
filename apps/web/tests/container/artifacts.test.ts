/**
 * T087 — `artifacts:ready` re-pointer tests (US3 WebContainer preview host).
 *
 * `createArtifactsRepointer` handles the server→client `artifacts:ready` event by
 * re-pointing the generated app's `FetchZkConfigProvider` at the new R2 prefix —
 * it writes the ZK-config base env var into the container's `.env.local` (via the
 * SHARED {@link createContainerEnv}, D10) and then triggers the coordinator's
 * re-point/reload through an injected callback (FR-014, D35).
 *
 * These tests drive it against the REAL `createContainerEnv` over an in-memory
 * FAKE {@link WebContainerFsHandle} that records every write in order — no real
 * WebContainer, no cross-origin-isolated browser (both owner-gated). Covers:
 *  - a first `artifacts:ready` sets `VITE_ZK_CONFIG_BASE_URL` and fires the
 *    re-point callback once;
 *  - the SAME `urlPrefix` again is a no-op (no redundant write, no re-point) —
 *    idempotency (D35, at most once per green turn);
 *  - a DIFFERENT `urlPrefix` re-points: it rewrites the value and fires again;
 *  - the callback is optional; and the merge never clobbers a co-owned key
 *    (e.g. the contract handler's `VITE_CONTRACT_ADDRESS`) on the shared instance.
 */
import { describe, expect, it, vi } from "vitest";

import { ZK_CONFIG_BASE_ENV_KEY, createArtifactsRepointer } from "@/container/artifacts";
import { ENV_LOCAL_PATH, createContainerEnv } from "@/container/env-file";
import type { WebContainerFsHandle } from "@/container/types";
import type { ArtifactsReadyPayload } from "@nyx/protocol";

/** A single recorded `writeFile`, captured at call time. */
interface WriteCall {
  readonly path: string;
  readonly contents: string;
}

interface FakeFs {
  readonly fs: WebContainerFsHandle;
  /** Live view of every `writeFile`, in invocation order. */
  readonly writes: readonly WriteCall[];
}

/** A fake fs handle that records `writeFile`s; other ops are inert. */
function createFakeFs(): FakeFs {
  const writes: WriteCall[] = [];
  const fs: WebContainerFsHandle = {
    writeFile: (path, contents) => {
      writes.push({ path, contents });
      return Promise.resolve();
    },
    rm: () => Promise.resolve(),
    readFile: () => Promise.resolve(""),
    mkdir: (path) => Promise.resolve(path),
  };
  return { fs, writes };
}

const PREFIX_A = "https://r2/pfx-a/";
const PREFIX_B = "https://r2/pfx-b/";

const ready = (urlPrefix: string): ArtifactsReadyPayload => ({ urlPrefix });

describe("createArtifactsRepointer", () => {
  it("sets VITE_ZK_CONFIG_BASE_URL and fires the re-point callback on the first artifacts:ready", async () => {
    const fake = createFakeFs();
    const env = createContainerEnv(fake.fs);
    const onRepointed = vi.fn<(urlPrefix: string) => void>();
    const repointer = createArtifactsRepointer({ env, onRepointed });

    await repointer.handleArtifactsReady(ready(PREFIX_A));

    expect(env.snapshot()).toEqual({ [ZK_CONFIG_BASE_ENV_KEY]: PREFIX_A });
    expect(fake.writes).toEqual([
      { path: ENV_LOCAL_PATH, contents: `${ZK_CONFIG_BASE_ENV_KEY}=${PREFIX_A}\n` },
    ]);
    expect(onRepointed).toHaveBeenCalledTimes(1);
    expect(onRepointed).toHaveBeenCalledWith(PREFIX_A);
  });

  it("is idempotent: the same urlPrefix again writes nothing and does not re-point (D35)", async () => {
    const fake = createFakeFs();
    const env = createContainerEnv(fake.fs);
    const onRepointed = vi.fn<(urlPrefix: string) => void>();
    const repointer = createArtifactsRepointer({ env, onRepointed });

    await repointer.handleArtifactsReady(ready(PREFIX_A));
    await repointer.handleArtifactsReady(ready(PREFIX_A));

    // No redundant fs write and no redundant re-point for the unchanged prefix.
    expect(fake.writes).toHaveLength(1);
    expect(onRepointed).toHaveBeenCalledTimes(1);
    expect(env.snapshot()).toEqual({ [ZK_CONFIG_BASE_ENV_KEY]: PREFIX_A });
  });

  it("re-points to a new value when a different urlPrefix arrives", async () => {
    const fake = createFakeFs();
    const env = createContainerEnv(fake.fs);
    const onRepointed = vi.fn<(urlPrefix: string) => void>();
    const repointer = createArtifactsRepointer({ env, onRepointed });

    await repointer.handleArtifactsReady(ready(PREFIX_A));
    await repointer.handleArtifactsReady(ready(PREFIX_B));

    expect(env.snapshot()).toEqual({ [ZK_CONFIG_BASE_ENV_KEY]: PREFIX_B });
    expect(fake.writes).toEqual([
      { path: ENV_LOCAL_PATH, contents: `${ZK_CONFIG_BASE_ENV_KEY}=${PREFIX_A}\n` },
      { path: ENV_LOCAL_PATH, contents: `${ZK_CONFIG_BASE_ENV_KEY}=${PREFIX_B}\n` },
    ]);
    expect(onRepointed).toHaveBeenCalledTimes(2);
    expect(onRepointed).toHaveBeenNthCalledWith(1, PREFIX_A);
    expect(onRepointed).toHaveBeenNthCalledWith(2, PREFIX_B);
  });

  it("works without a re-point callback (it is optional)", async () => {
    const fake = createFakeFs();
    const env = createContainerEnv(fake.fs);
    const repointer = createArtifactsRepointer({ env });

    await repointer.handleArtifactsReady(ready(PREFIX_A));

    expect(env.snapshot()).toEqual({ [ZK_CONFIG_BASE_ENV_KEY]: PREFIX_A });
    expect(fake.writes).toHaveLength(1);
  });

  it("merges into .env.local without clobbering a co-owned key (D10 shared instance)", async () => {
    const fake = createFakeFs();
    const env = createContainerEnv(fake.fs);
    // Simulate the contract handler having already set its key on the SAME env.
    await env.set("VITE_CONTRACT_ADDRESS", "0xdeadbeef");
    const repointer = createArtifactsRepointer({ env });

    await repointer.handleArtifactsReady(ready(PREFIX_A));

    expect(env.snapshot()).toEqual({
      VITE_CONTRACT_ADDRESS: "0xdeadbeef",
      [ZK_CONFIG_BASE_ENV_KEY]: PREFIX_A,
    });
  });
});
