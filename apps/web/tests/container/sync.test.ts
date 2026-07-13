/**
 * T083 — VFS sync tests (US3 WebContainer preview host).
 *
 * `createVfsSync` applies server→client `file:write` / `file:delete` events to a
 * booted WebContainer's fs (FR-019). These tests drive it against an in-memory
 * FAKE `WebContainerHandle` — no real WebContainer, no cross-origin-isolated
 * browser (both owner-gated) — that records every fs call in invocation order
 * and can HOLD each async op so ordering is asserted deterministically. Covers:
 *  - EC-14: events received before `markMounted()` are queued, never applied to
 *    an unmounted fs, then flushed in received order once mounted;
 *  - per-path serialization: two writes to the SAME path apply in received order
 *    (the second is not invoked until the first settles);
 *  - D26 exclusions: writes under `node_modules/` and the `.nyx/` artifact dir
 *    are dropped (no fs call) while a normal path still applies;
 *  - a delete calls `rm` with `{ recursive: true, force: true }`;
 *  - a nested write mkdir-p's the parent dir before `writeFile`, and a top-level
 *    write skips mkdir.
 */
import { describe, expect, it } from "vitest";

import { createVfsSync, isExcluded } from "@/container/sync";
import type {
  Unsubscribe,
  WebContainerFsHandle,
  WebContainerHandle,
  WebContainerProcessHandle,
} from "@/container/types";

/** A single recorded fs invocation, captured at call time. */
interface FsCall {
  readonly op: "writeFile" | "rm" | "mkdir";
  readonly path: string;
  readonly contents?: string;
  readonly recursive?: boolean;
  readonly force?: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

/** A promise plus its resolver; the executor runs sync, so `resolve` is set. */
function createDeferred(): Deferred {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolveFn?.();
    },
  };
}

interface FakeHandle {
  readonly handle: WebContainerHandle;
  /** Live view of every fs call, in invocation order. */
  readonly calls: readonly FsCall[];
  /** Resolve the oldest still-pending held async op (manual mode only). */
  releaseNext(): void;
}

/**
 * Build a fake handle whose `fs` records calls. In `manual` mode, `writeFile`,
 * `mkdir` and `rm` return promises that stay pending until `releaseNext()` — so a
 * test can prove that a chained op is not invoked until the prior one settles.
 */
function createFakeHandle(options?: { readonly manual?: boolean }): FakeHandle {
  const calls: FsCall[] = [];
  const held: Deferred[] = [];
  const manual = options?.manual ?? false;

  const settle = (): Promise<void> => {
    if (!manual) return Promise.resolve();
    const deferred = createDeferred();
    held.push(deferred);
    return deferred.promise;
  };

  const fs: WebContainerFsHandle = {
    writeFile: (path, contents) => {
      calls.push({ op: "writeFile", path, contents });
      return settle();
    },
    rm: (path, opts) => {
      calls.push({
        op: "rm",
        path,
        recursive: opts?.recursive ?? false,
        force: opts?.force ?? false,
      });
      return settle();
    },
    mkdir: (path) => {
      calls.push({ op: "mkdir", path });
      return settle().then(() => path);
    },
    readFile: () => Promise.resolve(""),
  };

  const handle: WebContainerHandle = {
    fs,
    mount: () => Promise.resolve(),
    spawn: () => new Promise<WebContainerProcessHandle>(() => undefined),
    onServerReady: (): Unsubscribe => () => undefined,
    onError: (): Unsubscribe => () => undefined,
    teardown: () => undefined,
  };

  return {
    handle,
    calls,
    releaseNext: () => {
      held.shift()?.resolve();
    },
  };
}

/** Drain the microtask queue (and any 0ms timers) so ordering is observable. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("isExcluded (D26)", () => {
  it("flags any node_modules or .nyx path segment", () => {
    expect(isExcluded("node_modules/foo/index.js")).toBe(true);
    expect(isExcluded("packages/x/node_modules/y.js")).toBe(true);
    expect(isExcluded(".nyx/artifacts/increment.prover")).toBe(true);
    expect(isExcluded("/node_modules/foo")).toBe(true);
  });

  it("does not flag normal source paths", () => {
    expect(isExcluded("src/App.tsx")).toBe(false);
    expect(isExcluded("a.txt")).toBe(false);
    expect(isExcluded("src/a/b.ts")).toBe(false);
  });
});

describe("createVfsSync", () => {
  it("queues events until markMounted, then applies them in received order (EC-14)", async () => {
    const fake = createFakeHandle();
    const sync = createVfsSync(fake.handle);

    sync.applyWrite({ path: "a.txt", content: "1" });
    sync.applyWrite({ path: "b.txt", content: "2" });

    // Nothing may touch an unmounted fs, even after the task queue drains.
    await flush();
    expect(fake.calls).toHaveLength(0);

    sync.markMounted();
    await sync.idle;

    expect(fake.calls).toEqual([
      { op: "writeFile", path: "a.txt", contents: "1" },
      { op: "writeFile", path: "b.txt", contents: "2" },
    ]);
  });

  it("serializes writes to the same path in received order", async () => {
    const fake = createFakeHandle({ manual: true });
    const sync = createVfsSync(fake.handle);
    sync.markMounted();

    sync.applyWrite({ path: "same.txt", content: "first" });
    sync.applyWrite({ path: "same.txt", content: "second" });

    // The second write is chained behind the (still-pending) first.
    await flush();
    expect(fake.calls).toEqual([{ op: "writeFile", path: "same.txt", contents: "first" }]);

    fake.releaseNext();
    await flush();
    expect(fake.calls).toEqual([
      { op: "writeFile", path: "same.txt", contents: "first" },
      { op: "writeFile", path: "same.txt", contents: "second" },
    ]);

    fake.releaseNext();
    await sync.idle;
  });

  it("drops writes under node_modules and .nyx, applying only the normal path (D26)", async () => {
    const fake = createFakeHandle();
    const sync = createVfsSync(fake.handle);
    sync.markMounted();

    sync.applyWrite({ path: "node_modules/foo/index.js", content: "x" });
    sync.applyWrite({ path: ".nyx/artifacts/keys.prover", content: "y" });
    sync.applyWrite({ path: "src/App.tsx", content: "z" });

    await sync.idle;

    const writes = fake.calls.filter((call) => call.op === "writeFile");
    expect(writes).toEqual([{ op: "writeFile", path: "src/App.tsx", contents: "z" }]);
  });

  it("also drops excluded deletes", async () => {
    const fake = createFakeHandle();
    const sync = createVfsSync(fake.handle);
    sync.markMounted();

    sync.applyDelete({ path: "node_modules/foo/index.js" });

    await sync.idle;
    expect(fake.calls).toHaveLength(0);
  });

  it("applies a delete via rm with recursive+force", async () => {
    const fake = createFakeHandle();
    const sync = createVfsSync(fake.handle);
    sync.markMounted();

    sync.applyDelete({ path: "src/gone.ts" });
    await sync.idle;

    expect(fake.calls).toEqual([{ op: "rm", path: "src/gone.ts", recursive: true, force: true }]);
  });

  it("mkdir-p's the parent dir before writing a nested file", async () => {
    const fake = createFakeHandle();
    const sync = createVfsSync(fake.handle);
    sync.markMounted();

    sync.applyWrite({ path: "src/a/b.ts", content: "hi" });
    await sync.idle;

    expect(fake.calls).toEqual([
      { op: "mkdir", path: "src/a" },
      { op: "writeFile", path: "src/a/b.ts", contents: "hi" },
    ]);
  });

  it("skips mkdir for a top-level path with no parent dir", async () => {
    const fake = createFakeHandle();
    const sync = createVfsSync(fake.handle);
    sync.markMounted();

    sync.applyWrite({ path: "top.txt", content: "hi" });
    await sync.idle;

    expect(fake.calls).toEqual([{ op: "writeFile", path: "top.txt", contents: "hi" }]);
  });
});
