/**
 * WebContainer boot pipeline for the Nyx preview host (US3, T082).
 *
 * Ports the proven PoC boot SEQUENCE onto the mockable {@link WebContainerHandle}
 * seam and the `dev:status` protocol:
 *
 *   mount → `npm install` (drained) → `npm run dev` → server-ready
 *
 * The pipeline emits `dev:status` at each phase over the {@link PreviewBridge}
 * so the server (and UI) can follow boot progress (FR-024, D39). `now` is an
 * injected dep defaulting to `Date.now`, so the event `ts` is deterministic
 * under test.
 *
 * Two entry points:
 *  - {@link bootPreview} — OWNER-GATED thin wrapper that boots the REAL
 *    `WebContainer` (only possible under cross-origin isolation) and adapts it to
 *    the seam. Never exercised in unit tests.
 *  - {@link runBootPipeline} — the testable core, driven against a fake handle.
 */
import { WebContainer } from "@webcontainer/api";

import { createRealHandle } from "./real-handle";
import type {
  FileSystemTree,
  PreviewBridge,
  WebContainerHandle,
  WebContainerProcessHandle,
} from "./types";
import type { DevStatusPayload } from "@nyx/protocol";

/** Injectable, deterministic hooks for the boot pipeline. */
export interface BootPipelineDeps {
  /** Clock for `dev:status.ts`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Called once per drained output chunk of a spawned process, so a caller can
   * relay terminal output. When omitted, output is drained and discarded (the
   * drain itself is mandatory — it prevents the process blocking on backpressure).
   */
  readonly onOutput?: (proc: WebContainerProcessHandle, label: string) => void;
}

/** Options for the owner-gated {@link bootPreview} entry point. */
export interface BootPreviewOptions {
  readonly bridge: PreviewBridge;
  readonly tree: FileSystemTree;
  readonly deps?: BootPipelineDeps;
}

/**
 * The outcome of a boot attempt.
 *
 * `ok: true` means the dev process was spawned and the server-ready listener is
 * wired (the `ready` `dev:status` fires later, over the bridge, when the inner
 * dev server comes up). `install-failed` is a clean, expected result — a
 * non-zero `npm install`; `error` wraps an unexpected rejection from the handle
 * (e.g. `mount`/`spawn`).
 */
export type BootResult =
  | { readonly ok: true; readonly devProcess: WebContainerProcessHandle }
  | { readonly ok: false; readonly reason: "install-failed"; readonly exitCode: number }
  | { readonly ok: false; readonly reason: "error"; readonly message: string };

/**
 * OWNER-GATED. Boots the real cross-origin-isolated `WebContainer`, adapts it to
 * the {@link WebContainerHandle} seam, and runs the pipeline. Kept to a few lines
 * so there is little here the unit tests cannot cover via {@link runBootPipeline}.
 */
export async function bootPreview(opts: BootPreviewOptions): Promise<BootResult> {
  const wc = await WebContainer.boot({ coep: "require-corp" });
  return runBootPipeline(createRealHandle(wc), opts.bridge, opts.tree, opts.deps);
}

/**
 * Fully drains a process's output stream via a reader loop — essential so the
 * process never stalls on stdout backpressure — forwarding each chunk to
 * `onOutput` (if provided) and otherwise discarding it. Resolves when the stream
 * closes, which happens as the process ends.
 */
async function drainOutput(
  proc: WebContainerProcessHandle,
  label: string,
  onOutput: BootPipelineDeps["onOutput"],
): Promise<void> {
  const reader = proc.output.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      onOutput?.(proc, label);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The testable boot core. Drives {@link WebContainerHandle} through the boot
 * sequence, emitting `dev:status` over the {@link PreviewBridge} at each phase.
 * Resolves once the dev process is spawned and the server-ready listener is
 * wired; the `ready` status is emitted later when that listener fires.
 */
export async function runBootPipeline(
  handle: WebContainerHandle,
  bridge: PreviewBridge,
  tree: FileSystemTree,
  deps: BootPipelineDeps = {},
): Promise<BootResult> {
  const now = deps.now ?? Date.now;
  const { onOutput } = deps;

  const emit = (payload: DevStatusPayload): void => {
    bridge.send({ type: "dev:status", payload, ts: now() });
  };

  // `crashed` is emitted at most once — whichever of the handle-error listener,
  // the install-failure branch, or the catch-all reaches it first wins.
  let crashed = false;
  const emitCrashed = (detail: string): void => {
    if (crashed) return;
    crashed = true;
    emit({ state: "crashed", detail });
  };

  handle.onError((error) => {
    emitCrashed(error.message);
  });

  try {
    emit({ state: "booting", phase: "mount" });
    await handle.mount(tree);

    emit({ state: "booting", phase: "install" });
    const install = await handle.spawn("npm", ["install"]);
    await drainOutput(install, "install", onOutput);
    const code = await install.exit;
    if (code !== 0) {
      emitCrashed(`npm install exited ${String(code)}`);
      return { ok: false, reason: "install-failed", exitCode: code };
    }

    emit({ state: "booting", phase: "dev" });
    const dev = await handle.spawn("npm", ["run", "dev"]);
    handle.onServerReady((_port, url) => {
      emit({ state: "ready", detail: url });
    });

    return { ok: true, devProcess: dev };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitCrashed(message);
    return { ok: false, reason: "error", message };
  }
}
