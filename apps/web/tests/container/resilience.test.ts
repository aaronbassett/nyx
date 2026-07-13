/**
 * T089 — resilience policy tests (US3 WebContainer preview host).
 *
 * The `container/resilience` module holds the four preview-host resilience
 * policies, each pure orchestration over an injected seam so it unit-tests with
 * no real WebContainer and no socket (both owner-gated):
 *  - manifest-diff resync (D38, SC-010): compute the local↔remote file diff and
 *    drive it through a {@link VfsSync} so local converges to remote on reconnect;
 *  - one-auto-reboot crash policy (D39): the first crash reboots once, a second
 *    crash before recovery surfaces loudly with no further reboot, and `reset()`
 *    (a healthy server-ready) re-arms the one-shot;
 *  - last-tab-wins takeover (D40): subscribe to `session:takeover` and invoke a
 *    callback, returning the bridge `Unsubscribe`;
 *  - the cross-origin-isolation hard gate: throw when `crossOriginIsolated` is
 *    false so the preview never attempts to boot without `SharedArrayBuffer`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertCrossOriginIsolated,
  computeManifestDiff,
  createCrashPolicy,
  resyncFromManifest,
  subscribeTakeover,
} from "@/container/resilience";
import type { VfsSync } from "@/container/sync";
import type { PreviewBridge } from "@/container/types";
import type { ContentHash, ManifestEntry, ServerToClientEvent } from "@nyx/protocol";

/** Build a manifest row; brands are compile-time only so the cast is inert. */
function entry(path: string, contentHash: string): ManifestEntry {
  return { path, contentHash: contentHash as ContentHash };
}

/** One recorded VFS operation, in invocation order. */
type RecordedOp =
  | { readonly op: "write"; readonly path: string; readonly content: string }
  | { readonly op: "delete"; readonly path: string };

interface RecordingSync {
  readonly sync: VfsSync;
  /** Live view of every applyWrite/applyDelete, in invocation order. */
  readonly ops: readonly RecordedOp[];
}

/** A fake {@link VfsSync} that records applies; `idle` is always settled. */
function createRecordingSync(): RecordingSync {
  const ops: RecordedOp[] = [];
  const sync: VfsSync = {
    applyWrite: (payload) => {
      ops.push({ op: "write", path: payload.path, content: payload.content });
    },
    applyDelete: (payload) => {
      ops.push({ op: "delete", path: payload.path });
    },
    markMounted: () => undefined,
    idle: Promise.resolve(),
  };
  return { sync, ops };
}

/** A handler stored irrespective of its concrete event type. */
type AnyServerHandler = (event: ServerToClientEvent) => void;

interface FakeBridge {
  readonly bridge: PreviewBridge;
  /** Deliver an event to every handler subscribed to its `type`. */
  emit(event: ServerToClientEvent): void;
}

/** A {@link PreviewBridge} whose `on` registers handlers `emit` can drive. */
function createFakeBridge(): FakeBridge {
  const handlers = new Map<string, Set<AnyServerHandler>>();
  const bridge: PreviewBridge = {
    send: () => undefined,
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set<AnyServerHandler>();
      // `handler` accepts only its own event subtype; widen it to store it.
      set.add(handler as AnyServerHandler);
      handlers.set(type, set);
      return () => {
        set.delete(handler as AnyServerHandler);
      };
    },
  };
  return {
    bridge,
    emit: (event) => {
      const set = handlers.get(event.type);
      if (set !== undefined) {
        for (const handler of set) {
          handler(event);
        }
      }
    },
  };
}

const takeover = (ts: number): ServerToClientEvent => ({
  type: "session:takeover",
  payload: {},
  ts,
});

describe("computeManifestDiff (D38)", () => {
  it("marks missing-in-local and hash-differing paths changed, local-only paths removed", () => {
    const local = [entry("keep.ts", "h1"), entry("change.ts", "old"), entry("gone.ts", "hg")];
    const remote = [entry("keep.ts", "h1"), entry("change.ts", "new"), entry("new.ts", "hn")];

    const diff = computeManifestDiff(local, remote);

    expect(diff.changed).toEqual(["change.ts", "new.ts"]);
    expect(diff.removed).toEqual(["gone.ts"]);
  });

  it("returns an empty diff when local equals remote", () => {
    const rows = [entry("a.ts", "h1"), entry("b.ts", "h2")];

    const diff = computeManifestDiff(rows, rows);

    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("sorts changed and removed deterministically regardless of input order", () => {
    const local = [entry("z.ts", "h"), entry("a.ts", "h")];
    const remote = [entry("m.ts", "h"), entry("b.ts", "h")];

    const diff = computeManifestDiff(local, remote);

    // Neither local path is in remote (all removed); neither remote path is in
    // local (all changed) — both surfaced in sorted, deterministic order.
    expect(diff.changed).toEqual(["b.ts", "m.ts"]);
    expect(diff.removed).toEqual(["a.ts", "z.ts"]);
  });
});

describe("resyncFromManifest (SC-010)", () => {
  it("writes changed content and deletes removed paths so local converges to remote", async () => {
    const local = [entry("keep.ts", "h1"), entry("change.ts", "old"), entry("gone.ts", "hg")];
    const remote = [entry("keep.ts", "h1"), entry("change.ts", "new"), entry("new.ts", "hn")];
    const recording = createRecordingSync();
    const fetchContent = vi.fn<(path: string) => Promise<string>>((path) =>
      Promise.resolve(`content-for:${path}`),
    );

    const diff = await resyncFromManifest({
      local,
      remote,
      fetchContent,
      sync: recording.sync,
    });

    // Exact applies, in order: changed writes (sorted) then removed deletes.
    expect(recording.ops).toEqual([
      { op: "write", path: "change.ts", content: "content-for:change.ts" },
      { op: "write", path: "new.ts", content: "content-for:new.ts" },
      { op: "delete", path: "gone.ts" },
    ]);
    // Only changed paths are fetched — the unchanged `keep.ts` is not re-fetched.
    expect(fetchContent.mock.calls.map(([path]) => path)).toEqual(["change.ts", "new.ts"]);
    // The applied diff is returned to the caller.
    expect(diff).toEqual({ changed: ["change.ts", "new.ts"], removed: ["gone.ts"] });
  });

  it("does nothing when local already equals remote", async () => {
    const rows = [entry("a.ts", "h1")];
    const recording = createRecordingSync();
    const fetchContent = vi.fn<(path: string) => Promise<string>>(() => Promise.resolve(""));

    const diff = await resyncFromManifest({
      local: rows,
      remote: rows,
      fetchContent,
      sync: recording.sync,
    });

    expect(recording.ops).toEqual([]);
    expect(fetchContent).not.toHaveBeenCalled();
    expect(diff).toEqual({ changed: [], removed: [] });
  });
});

describe("createCrashPolicy (D39)", () => {
  it("reboots once on the first crash and does not surface it", async () => {
    const reboot = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const onCrashed = vi.fn<(detail?: string) => void>();
    const policy = createCrashPolicy({ reboot, onCrashed });

    await policy.crash("boom");

    expect(reboot).toHaveBeenCalledTimes(1);
    expect(onCrashed).not.toHaveBeenCalled();
  });

  it("surfaces the second crash loudly with no further reboot", async () => {
    const reboot = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const onCrashed = vi.fn<(detail?: string) => void>();
    const policy = createCrashPolicy({ reboot, onCrashed });

    await policy.crash();
    await policy.crash("second");

    expect(reboot).toHaveBeenCalledTimes(1);
    expect(onCrashed).toHaveBeenCalledTimes(1);
    expect(onCrashed).toHaveBeenCalledWith("second");
  });

  it("re-arms the one-shot after reset() so a later crash reboots again", async () => {
    const reboot = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const onCrashed = vi.fn<(detail?: string) => void>();
    const policy = createCrashPolicy({ reboot, onCrashed });

    await policy.crash();
    policy.reset();
    await policy.crash();

    expect(reboot).toHaveBeenCalledTimes(2);
    expect(onCrashed).not.toHaveBeenCalled();
  });
});

describe("subscribeTakeover (D40)", () => {
  it("invokes the callback on session:takeover and stops after unsubscribe", () => {
    const fake = createFakeBridge();
    const onTakeover = vi.fn<() => void>();

    const unsubscribe = subscribeTakeover(fake.bridge, onTakeover);
    fake.emit(takeover(1));
    expect(onTakeover).toHaveBeenCalledTimes(1);

    unsubscribe();
    fake.emit(takeover(2));
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });
});

describe("assertCrossOriginIsolated", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when crossOriginIsolated is false", () => {
    vi.stubGlobal("crossOriginIsolated", false);

    expect(() => {
      assertCrossOriginIsolated();
    }).toThrow(/crossOriginIsolated/i);
  });

  it("returns normally when crossOriginIsolated is true", () => {
    vi.stubGlobal("crossOriginIsolated", true);

    expect(() => {
      assertCrossOriginIsolated();
    }).not.toThrow();
  });
});
