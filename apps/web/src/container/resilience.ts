/**
 * T089 — resilience policies for the Nyx WebContainer preview host (US3).
 *
 * Four small, independently-testable policies that keep the in-browser preview
 * correct and recoverable. Each is pure orchestration over an injected seam — a
 * {@link VfsSync}, a reboot callback, a {@link PreviewBridge}, the isolation
 * reader — so all of them unit-test with no real WebContainer and no socket
 * (both owner-gated):
 *
 *  1. Manifest-diff resync (D38, SC-010). On reopen/reconnect the client fetches
 *     the server's authoritative `(path, contentHash)` manifest and reconciles
 *     the container's VFS to it: write every path that is new or whose content
 *     hash differs, delete every path the server no longer has. After the applied
 *     diff drains, local state has converged to remote.
 *  2. One-auto-reboot crash policy (D39). The dev server crashing once triggers a
 *     single automatic reboot; crashing AGAIN before it recovers is terminal and
 *     loud (surfaced to the caller, never silently re-looped). A healthy
 *     server-ready after a reboot calls {@link CrashPolicy.reset} to re-arm the
 *     one-shot so a later, independent crash reboots again.
 *  3. Last-tab-wins takeover (D40). When the server signals that another tab has
 *     taken the session (`session:takeover`), invoke a callback so the UI can show
 *     the session-moved banner and stand down.
 *  4. Cross-origin-isolation hard gate. The WebContainer needs `SharedArrayBuffer`,
 *     which requires the document to be cross-origin isolated; assert it up front
 *     with a clear, named error rather than failing deep inside boot.
 */
import { isCrossOriginIsolated } from "@/lib/isolation";

import type { VfsSync } from "./sync";
import type { PreviewBridge, Unsubscribe } from "./types";
import type { ManifestEntry } from "@nyx/protocol";

// ============================================================================
// 1. Manifest-diff resync (D38, SC-010)
// ============================================================================

/**
 * The reconciliation a resync must apply to make local match remote. `changed`
 * paths need their content (re)written; `removed` paths must be deleted. Both
 * lists are sorted so the diff — and the applies driven from it — are
 * deterministic.
 */
export interface ManifestDiff {
  /** Paths new in remote, or whose content hash differs — must be (re)written. */
  readonly changed: readonly string[];
  /** Paths present locally but absent from remote — must be deleted. */
  readonly removed: readonly string[];
}

/**
 * Compute the pure diff between two manifests (D38). A path is `changed` when it
 * is present in `remote` but absent from `local`, or present in both with a
 * differing `contentHash`; it is `removed` when present in `local` but absent
 * from `remote`. Both result lists are sorted for determinism.
 */
export function computeManifestDiff(
  local: readonly ManifestEntry[],
  remote: readonly ManifestEntry[],
): ManifestDiff {
  const localHashByPath = new Map<string, string>();
  for (const row of local) {
    localHashByPath.set(row.path, row.contentHash);
  }

  const changed: string[] = [];
  for (const row of remote) {
    // A missing local hash (undefined) and a differing hash both mean "changed".
    if (localHashByPath.get(row.path) !== row.contentHash) {
      changed.push(row.path);
    }
  }

  const remotePaths = new Set<string>();
  for (const row of remote) {
    remotePaths.add(row.path);
  }

  const removed: string[] = [];
  for (const row of local) {
    if (!remotePaths.has(row.path)) {
      removed.push(row.path);
    }
  }

  changed.sort();
  removed.sort();
  return { changed, removed };
}

/** Injectable collaborators for {@link resyncFromManifest}. */
export interface ResyncDeps {
  /** The container's current manifest (last known local state). */
  readonly local: readonly ManifestEntry[];
  /** The server's authoritative manifest (the convergence target). */
  readonly remote: readonly ManifestEntry[];
  /** Fetch the latest content for a changed path (e.g. `GET .../files/:path`). */
  readonly fetchContent: (path: string) => Promise<string>;
  /** The VFS sync the diff is applied through. */
  readonly sync: VfsSync;
}

/**
 * Reconcile the container's VFS to the server's manifest (D38, SC-010): compute
 * the diff, write every `changed` path's freshly-fetched content and delete every
 * `removed` path through the injected {@link VfsSync}, then await settlement so
 * local has converged to remote before resolving. Returns the applied diff.
 *
 * Content is fetched only for `changed` paths (unchanged files are never
 * re-fetched), and each write is enqueued after its content resolves so the
 * apply order is deterministic.
 */
export async function resyncFromManifest(deps: ResyncDeps): Promise<ManifestDiff> {
  const diff = computeManifestDiff(deps.local, deps.remote);

  for (const path of diff.changed) {
    const content = await deps.fetchContent(path);
    deps.sync.applyWrite({ path, content });
  }
  for (const path of diff.removed) {
    deps.sync.applyDelete({ path });
  }

  // `applyWrite`/`applyDelete` are fire-and-forget onto per-path chains; awaiting
  // `idle` blocks until every enqueued op has drained — the convergence point.
  await deps.sync.idle;
  return diff;
}

// ============================================================================
// 2. One-auto-reboot crash policy (D39)
// ============================================================================

/** Injectable collaborators for {@link createCrashPolicy}. */
export interface CrashPolicyDeps {
  /** Perform the single automatic reboot triggered by the first crash. */
  readonly reboot: () => Promise<void>;
  /** Surface a terminal crash loudly (a second crash before recovery). */
  readonly onCrashed: (detail?: string) => void;
}

/** The crash-policy handle: report crashes, and reset after a healthy recovery. */
export interface CrashPolicy {
  /**
   * Report a dev-server crash. The first call reboots once; a second call before
   * {@link reset} surfaces the crash via `onCrashed` with no further reboot;
   * further calls in the terminal state are ignored.
   */
  crash(detail?: string): Promise<void>;
  /** Re-arm the one-shot after a healthy server-ready following a reboot. */
  reset(): void;
}

/**
 * States of the one-auto-reboot machine (D39):
 *  - `healthy`  — initial / post-reset; the next crash reboots.
 *  - `rebooted` — one automatic reboot spent; the next crash is terminal.
 *  - `terminal` — surfaced loudly; further crashes are ignored until `reset`.
 */
type CrashState = "healthy" | "rebooted" | "terminal";

/**
 * Create a {@link CrashPolicy}. The returned handle closes over a single
 * {@link CrashState}: `crash` advances `healthy → rebooted → terminal`, `reset`
 * returns it to `healthy`. State is advanced BEFORE awaiting `reboot()`, so a
 * crash arriving while a reboot is in flight is treated as the terminal second
 * crash rather than a second reboot.
 */
export function createCrashPolicy(deps: CrashPolicyDeps): CrashPolicy {
  let state: CrashState = "healthy";

  return {
    async crash(detail?: string): Promise<void> {
      if (state === "healthy") {
        state = "rebooted";
        await deps.reboot();
        return;
      }
      if (state === "rebooted") {
        state = "terminal";
        deps.onCrashed(detail);
        return;
      }
      // terminal: already surfaced loudly — no further reboot, no re-fire.
    },
    reset(): void {
      state = "healthy";
    },
  };
}

// ============================================================================
// 3. Last-tab-wins takeover (D40)
// ============================================================================

/**
 * Subscribe to the server's `session:takeover` signal (D40): when another tab
 * takes the session, invoke `onTakeover` (e.g. to show the session-moved banner).
 * Returns the bridge {@link Unsubscribe} so the caller can detach on teardown.
 */
export function subscribeTakeover(bridge: PreviewBridge, onTakeover: () => void): Unsubscribe {
  return bridge.on("session:takeover", () => {
    onTakeover();
  });
}

// ============================================================================
// 4. Cross-origin-isolation hard gate
// ============================================================================

/** Thrown by {@link assertCrossOriginIsolated} when the document is not isolated. */
export class CrossOriginIsolationError extends Error {
  constructor() {
    super(
      "crossOriginIsolated is false: the WebContainer preview cannot boot without " +
        "cross-origin isolation (the strict COOP/COEP header pair that enables " +
        "SharedArrayBuffer).",
    );
    this.name = "CrossOriginIsolationError";
  }
}

/**
 * Assert the document is cross-origin isolated before booting the preview, so
 * failure is a clear, named error at the gate rather than an opaque one deep in
 * WebContainer boot. Reuses the shared {@link isCrossOriginIsolated} reader.
 */
export function assertCrossOriginIsolated(): void {
  if (!isCrossOriginIsolated()) {
    throw new CrossOriginIsolationError();
  }
}
