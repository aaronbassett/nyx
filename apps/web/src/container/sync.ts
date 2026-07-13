/**
 * T083 — VFS sync for the WebContainer preview host (US3).
 *
 * Applies the server→client `file:write` / `file:delete` events to a booted
 * WebContainer's filesystem so edits made server-side (agent turns, user edits)
 * are reflected in the live preview and picked up by HMR (FR-019). The module is
 * pure orchestration over the injected {@link WebContainerHandle} seam — no DOM,
 * no socket — so it unit-tests against an in-memory fake.
 *
 * Three ordering/safety rules shape it:
 *  - **Per-path ordering (FR-019, D26):** operations on the SAME path apply
 *    strictly in received order, serialized through a promise chain keyed by
 *    path; operations on different paths may run concurrently.
 *  - **Queue-during-mount (EC-14):** events received before the container is
 *    mounted are queued in order and applied only after {@link VfsSync.markMounted},
 *    never against an unmounted fs.
 *  - **Exclusions (D26):** paths under `node_modules/` or the compiled-artifact
 *    dir are never written or deleted — see {@link isExcluded}.
 *
 * `idle` lets callers (and tests) await settlement: it resolves once every
 * in-flight and queued operation has drained, and is recomputed as new work is
 * enqueued.
 */
import type { FileDeletePayload, FileWritePayload } from "@nyx/protocol";

import type { WebContainerHandle } from "./types";

/**
 * The VFS sync surface: enqueue applies (fire-and-forget, void), gate the queue
 * on mount, and await settlement. `applyWrite`/`applyDelete` return `void` — the
 * work runs on the internal per-path chains and is observed via {@link idle}.
 */
export interface VfsSync {
  /** Enqueue a `file:write`; mkdir-p's the parent then writes. Excluded paths are dropped. */
  applyWrite(payload: FileWritePayload): void;
  /** Enqueue a `file:delete`; `rm -rf` (tolerates missing). Excluded paths are dropped. */
  applyDelete(payload: FileDeletePayload): void;
  /** Mark the container mounted and flush any events queued beforehand, in order. */
  markMounted(): void;
  /** Resolves when all in-flight + queued operations have drained; recomputed as work is enqueued. */
  readonly idle: Promise<void>;
}

/**
 * Path segments that must never be written or deleted (D26). `node_modules` is
 * managed by the container's own install; `.nyx` is the compiled-artifact dir.
 *
 * NOTE: the exact artifact path set may extend as the toolchain evolves (extra
 * compiled-output locations, lockfiles, etc.); add segments here.
 */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", ".nyx"]);

/**
 * True when `path` must be excluded from VFS sync (D26): any path segment equal
 * to `node_modules`, or any path under the `.nyx/` artifact dir. A leading slash
 * is ignored so `/node_modules/x` and `node_modules/x` are treated alike.
 */
export function isExcluded(path: string): boolean {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/** The parent directory of `path`, or `null` when it has no parent to mkdir-p. */
function parentDir(path: string): string | null {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return path.slice(0, lastSlash);
}

/** A unit of fs work bound to a path, deferred while unmounted. */
interface Task {
  readonly path: string;
  readonly run: () => Promise<void>;
}

/** Wire a {@link VfsSync} over a (real or fake) {@link WebContainerHandle}. */
export function createVfsSync(handle: WebContainerHandle): VfsSync {
  let mounted = false;
  const preMount: Task[] = [];
  /** Per-path chain tail: the next op on a path waits on its predecessor. */
  const chains = new Map<string, Promise<void>>();

  // idle tracking: a fresh promise opens when work begins from rest and resolves
  // when the outstanding count returns to zero.
  let pending = 0;
  let resolveIdle: (() => void) | undefined;
  let idlePromise: Promise<void> = Promise.resolve();

  function beginWork(): void {
    if (pending === 0) {
      idlePromise = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
    }
    pending += 1;
  }

  function endWork(): void {
    pending -= 1;
    if (pending === 0) {
      resolveIdle?.();
      resolveIdle = undefined;
    }
  }

  /** Append `run` to `path`'s chain so it runs after any prior op on that path. */
  function dispatch(task: Task): void {
    const previous = chains.get(task.path) ?? Promise.resolve();
    // `.then(run, run)`: run regardless of whether the predecessor settled or
    // failed. The trailing handlers swallow this task's own failure so the chain
    // never rejects (no unhandled rejection; the next op still runs).
    const settled = previous.then(task.run, task.run).then(
      () => {
        endWork();
      },
      () => {
        endWork();
      },
    );
    chains.set(task.path, settled);
  }

  /** Count the work, then dispatch now (mounted) or hold in order (unmounted). */
  function submit(task: Task): void {
    beginWork();
    if (mounted) {
      dispatch(task);
    } else {
      preMount.push(task);
    }
  }

  /** mkdir-p the parent (when there is one), then write the file. */
  async function doWrite(path: string, content: string): Promise<void> {
    const dir = parentDir(path);
    if (dir !== null) {
      await handle.fs.mkdir(dir, { recursive: true });
    }
    await handle.fs.writeFile(path, content);
  }

  function applyWrite(payload: FileWritePayload): void {
    if (isExcluded(payload.path)) return;
    const { path, content } = payload;
    submit({ path, run: () => doWrite(path, content) });
  }

  function applyDelete(payload: FileDeletePayload): void {
    if (isExcluded(payload.path)) return;
    const { path } = payload;
    submit({ path, run: () => handle.fs.rm(path, { recursive: true, force: true }) });
  }

  function markMounted(): void {
    if (mounted) return;
    mounted = true;
    const queued = preMount.splice(0);
    for (const task of queued) {
      dispatch(task);
    }
  }

  return {
    applyWrite,
    applyDelete,
    markMounted,
    get idle(): Promise<void> {
      return idlePromise;
    },
  };
}
