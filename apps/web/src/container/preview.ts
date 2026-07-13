/**
 * US3 — the WebContainer preview COORDINATOR.
 *
 * Every other `container/` module is a small, independently-tested seam (VFS
 * sync, boot pipeline, console relay, the `.env.local` writer, the
 * `contract:deployed` / `artifacts:ready` handlers, the resilience policies).
 * This module is the single place that fuses them into one live preview host and
 * exposes a {@link PreviewController} lifecycle to the UI.
 *
 * Two entry points, mirroring the split used throughout `container/`:
 *  - {@link createPreview} — the TESTABLE wiring factory. It takes an already
 *    resolved {@link WebContainerHandle} and {@link PreviewBridge}, so tests drive
 *    the whole coordinator against in-memory fakes (no real WebContainer, no
 *    socket). It constructs the shared collaborators, subscribes the bridge to the
 *    server → client events it consumes, and returns `{ start, dispose }`.
 *  - {@link launchPreview} — the OWNER-GATED thin entry point. It boots the REAL
 *    cross-origin-isolated `WebContainer` (only possible under the strict
 *    COOP/COEP pair) and opens a real preview socket, then delegates to
 *    {@link createPreview}. It is never exercised in unit tests.
 *
 * The shared `.env.local` writer ({@link createContainerEnv}) is co-owned by the
 * `contract:deployed` and `artifacts:ready` handlers so their two keys merge into
 * one file without clobbering each other (D10).
 */
import { WebContainer } from "@webcontainer/api";

import { createArtifactsRepointer } from "./artifacts";
import { runBootPipeline } from "./boot";
import type { BootResult } from "./boot";
import { handleContractDeployed } from "./env";
import { createContainerEnv } from "./env-file";
import { createRealHandle } from "./real-handle";
import { assertCrossOriginIsolated, createCrashPolicy, subscribeTakeover } from "./resilience";
import { streamProcessConsole } from "./streams";
import { createVfsSync } from "./sync";
import type { FileSystemTree, PreviewBridge, Unsubscribe, WebContainerHandle } from "./types";
import { createPreviewBridge } from "./ws-client";
import type { PreviewBridgeConnection } from "./ws-client";

/**
 * Injectable collaborators for {@link createPreview}. Every side-effecting
 * mechanic the coordinator does not own itself (dev-server restart, container
 * reboot, UI callbacks) is passed in, so the factory stays pure orchestration.
 */
export interface CreatePreviewDeps {
  /** The project file tree mounted at boot. */
  readonly tree: FileSystemTree;
  /** Invoked when another tab takes the session (D40) — show the moved banner. */
  readonly onTakeover: () => void;
  /** Surface a terminal crash loudly (a second crash before recovery, D39). */
  readonly onCrashed: (detail?: string) => void;
  /** Kill + respawn the dev server so Vite re-reads `.env.local` (FR-055). */
  readonly restartDevServer: () => Promise<void>;
  /** Perform the single automatic reboot triggered by the first crash (D39). */
  readonly reboot: () => Promise<void>;
  /** Trigger the re-point/reload after the ZK-config base var is rewritten (FR-014). */
  readonly onRepointed?: (urlPrefix: string) => void | Promise<void>;
  /** Clock for emitted event timestamps; defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/** The preview lifecycle handle returned by {@link createPreview}. */
export interface PreviewController {
  /**
   * Run the boot pipeline (mount → install → dev → server-ready), relaying each
   * process's console output over the bridge. On a successful boot the VFS sync
   * is marked mounted so any writes queued during boot flush in order. Resolves
   * with the {@link BootResult}.
   */
  start(): Promise<BootResult>;
  /** Tear down every bridge/handle subscription this coordinator registered. */
  dispose(): void;
}

/**
 * Wire the `container/` modules into a {@link PreviewController} over an injected
 * handle and bridge. Constructs the shared `.env.local` writer, the VFS sync, the
 * `artifacts:ready` re-pointer and the crash policy, then subscribes the bridge to
 * the server → client events the preview consumes. Every subscription's
 * {@link Unsubscribe} is retained and released by {@link PreviewController.dispose}.
 */
export function createPreview(
  handle: WebContainerHandle,
  bridge: PreviewBridge,
  deps: CreatePreviewDeps,
): PreviewController {
  const now = deps.now ?? Date.now;

  const env = createContainerEnv(handle.fs);
  const sync = createVfsSync(handle);
  const repointer = createArtifactsRepointer(
    deps.onRepointed !== undefined ? { env, onRepointed: deps.onRepointed } : { env },
  );
  const crashPolicy = createCrashPolicy({ reboot: deps.reboot, onCrashed: deps.onCrashed });

  const subscriptions: readonly Unsubscribe[] = [
    bridge.on("file:write", (event) => {
      sync.applyWrite(event.payload);
    }),
    bridge.on("file:delete", (event) => {
      sync.applyDelete(event.payload);
    }),
    bridge.on("contract:deployed", (event) => {
      void handleContractDeployed(event.payload, {
        env,
        restartDevServer: deps.restartDevServer,
      });
    }),
    bridge.on("artifacts:ready", (event) => {
      void repointer.handleArtifactsReady(event.payload);
    }),
    subscribeTakeover(bridge, deps.onTakeover),
    // The container's own error signal drives the one-auto-reboot policy (D39):
    // the first error reboots once, a second before recovery is terminal.
    handle.onError((error) => {
      void crashPolicy.crash(error.message);
    }),
  ];

  return {
    async start(): Promise<BootResult> {
      const result = await runBootPipeline(handle, bridge, deps.tree, {
        now,
        onOutput: (proc) => {
          void streamProcessConsole(proc, bridge, { now });
        },
      });
      if (result.ok) {
        // Boot succeeded: release the VFS queue so writes received during boot
        // (EC-14) apply in order.
        sync.markMounted();
      }
      return result;
    },
    dispose(): void {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    },
  };
}

/** Options for the owner-gated {@link launchPreview} entry point. */
export interface LaunchPreviewOptions {
  /** The project this preview (and its socket) is scoped to. */
  readonly projectId: string;
  /** The project file tree mounted at boot. */
  readonly tree: FileSystemTree;
  /** Invoked when another tab takes the session (D40). */
  readonly onTakeover: () => void;
  /** Surface a terminal crash loudly (D39). */
  readonly onCrashed: (detail?: string) => void;
  /** Kill + respawn the dev server so Vite re-reads `.env.local` (FR-055). */
  readonly restartDevServer: () => Promise<void>;
  /** Perform the single automatic reboot triggered by the first crash (D39). */
  readonly reboot: () => Promise<void>;
  /** Trigger the re-point/reload after the ZK-config base var is rewritten (FR-014). */
  readonly onRepointed?: (urlPrefix: string) => void | Promise<void>;
  /** Clock for emitted event timestamps; defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/** The live preview assembled by {@link launchPreview}. */
export interface LaunchPreviewResult {
  /** The lifecycle handle for the running preview. */
  readonly controller: PreviewController;
  /** The open preview socket connection (for `close()` / `closed`). */
  readonly bridge: PreviewBridgeConnection;
  /** The outcome of the initial boot. */
  readonly result: BootResult;
}

/**
 * OWNER-GATED. Boot the real cross-origin-isolated `WebContainer`, open a real
 * preview socket, wire them through {@link createPreview}, and run the initial
 * boot. Kept to a few straight-line steps so there is little here the unit tests
 * (which cover {@link createPreview}) cannot reach; the only unit adds is the real
 * `WebContainer.boot` + `createRealHandle` + `createPreviewBridge` glue, exercised
 * in a real cross-origin-isolated browser.
 */
export async function launchPreview(options: LaunchPreviewOptions): Promise<LaunchPreviewResult> {
  assertCrossOriginIsolated();
  const wc = await WebContainer.boot({ coep: "require-corp" });
  const handle = createRealHandle(wc);
  const bridge = createPreviewBridge({ projectId: options.projectId });
  const controller = createPreview(handle, bridge, options);
  const result = await controller.start();
  return { controller, bridge, result };
}
