/**
 * T082 — WebContainer boot-pipeline tests (US3 preview host).
 *
 * Exercises the TESTABLE core `runBootPipeline` against an in-memory fake
 * `WebContainerHandle` (mount/spawn resolve to seeded fakes; the server-ready
 * and error callbacks are captured so the test can fire them) and a recording
 * `PreviewBridge`. The real `WebContainer` (booted by `bootPreview`) never runs
 * here — it only boots under cross-origin isolation and is owner-gated.
 *
 * `now` is injected as `() => 1` so every emitted `dev:status.ts` is
 * deterministic. Coverage: the happy-path boot sequence
 * (mount → install → dev) plus the deferred `ready` on server-ready; a failed
 * `npm install` short-circuits to `install-failed` without spawning dev; and a
 * handle error surfaces a single `crashed` status.
 */
import { describe, expect, it, vi } from "vitest";

import { runBootPipeline } from "@/container/boot";
import type {
  FileSystemTree,
  PreviewBridge,
  Unsubscribe,
  WebContainerFsHandle,
  WebContainerHandle,
  WebContainerProcessHandle,
} from "@/container/types";
import type { ClientToServerEvent } from "@nyx/protocol";

/** A minimal, valid mount tree (a bare package.json). */
const TREE: FileSystemTree = {
  "package.json": { file: { contents: "{}" } },
};

type DevStatusEvent = Extract<ClientToServerEvent, { type: "dev:status" }>;

/** Extracts the ordered `dev:status` payloads from what the bridge recorded. */
function devStatuses(sent: readonly ClientToServerEvent[]): DevStatusEvent["payload"][] {
  return sent.filter((e): e is DevStatusEvent => e.type === "dev:status").map((e) => e.payload);
}

/** A `ReadableStream<string>` that emits the given chunks then closes. */
function streamFromChunks(chunks: readonly string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A fake spawned process with seeded output and a chosen exit code. */
function fakeProcess(chunks: readonly string[], exitCode: number): WebContainerProcessHandle {
  return {
    output: streamFromChunks(chunks),
    exit: Promise.resolve(exitCode),
    kill: vi.fn(),
  };
}

interface HandleHarness {
  readonly handle: WebContainerHandle;
  readonly installProcess: WebContainerProcessHandle;
  readonly devProcess: WebContainerProcessHandle;
  readonly spawnCalls: { command: string; args: readonly string[] }[];
  readonly fireServerReady: (port: number, url: string) => void;
  readonly fireError: (message: string) => void;
}

/**
 * Builds a fake {@link WebContainerHandle}: `spawn("npm", ["install"])` returns
 * the install process, any other spawn returns the dev process, and the
 * server-ready / error listeners are captured for the test to fire.
 */
function makeHandle(
  opts: { installExitCode?: number; installChunks?: readonly string[] } = {},
): HandleHarness {
  const installProcess = fakeProcess(opts.installChunks ?? [], opts.installExitCode ?? 0);
  const devProcess = fakeProcess([], 0);
  const spawnCalls: { command: string; args: readonly string[] }[] = [];
  let serverReady: ((port: number, url: string) => void) | undefined;
  let onError: ((error: { readonly message: string }) => void) | undefined;

  const fs: WebContainerFsHandle = {
    writeFile: vi.fn((): Promise<void> => Promise.resolve()),
    rm: vi.fn((): Promise<void> => Promise.resolve()),
    readFile: vi.fn((): Promise<string> => Promise.resolve("")),
    mkdir: vi.fn((): Promise<string> => Promise.resolve("")),
  };

  const handle: WebContainerHandle = {
    mount: vi.fn((): Promise<void> => Promise.resolve()),
    spawn: vi.fn((command: string, args: readonly string[]): Promise<WebContainerProcessHandle> => {
      spawnCalls.push({ command, args });
      return Promise.resolve(args[0] === "install" ? installProcess : devProcess);
    }),
    fs,
    onServerReady: vi.fn((listener: (port: number, url: string) => void): Unsubscribe => {
      serverReady = listener;
      return vi.fn();
    }),
    onError: vi.fn((listener: (error: { readonly message: string }) => void): Unsubscribe => {
      onError = listener;
      return vi.fn();
    }),
    teardown: vi.fn(),
  };

  return {
    handle,
    installProcess,
    devProcess,
    spawnCalls,
    fireServerReady: (port, url) => serverReady?.(port, url),
    fireError: (message) => onError?.({ message }),
  };
}

/** A recording {@link PreviewBridge}. */
function makeBridge(): { bridge: PreviewBridge; sent: ClientToServerEvent[] } {
  const sent: ClientToServerEvent[] = [];
  const bridge: PreviewBridge = {
    send: (event) => {
      sent.push(event);
    },
    on: vi.fn(() => vi.fn()),
  };
  return { bridge, sent };
}

describe("runBootPipeline", () => {
  it("emits booting mount → install → dev, resolves ok, and defers ready to server-ready", async () => {
    const harness = makeHandle({
      installExitCode: 0,
      installChunks: ["> npm install\n", "added 42 packages\n"],
    });
    const { bridge, sent } = makeBridge();
    const onOutput = vi.fn();

    const result = await runBootPipeline(harness.handle, bridge, TREE, { now: () => 1, onOutput });

    // The booting sequence, in order, before dev is spawned.
    expect(devStatuses(sent)).toEqual([
      { state: "booting", phase: "mount" },
      { state: "booting", phase: "install" },
      { state: "booting", phase: "dev" },
    ]);
    // Every emitted event is a dev:status carrying the injected deterministic ts.
    expect(sent.every((e) => e.type === "dev:status" && e.ts === 1)).toBe(true);

    // npm install, then npm run dev — in that order.
    expect(harness.spawnCalls).toEqual([
      { command: "npm", args: ["install"] },
      { command: "npm", args: ["run", "dev"] },
    ]);

    // Each install-output chunk was forwarded to onOutput as (install, "install").
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenNthCalledWith(1, harness.installProcess, "install");
    expect(onOutput).toHaveBeenNthCalledWith(2, harness.installProcess, "install");

    // Resolves ok with the dev process; ready is NOT emitted yet.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.devProcess).toBe(harness.devProcess);
    expect(devStatuses(sent).some((p) => p.state === "ready")).toBe(false);

    // Firing the captured server-ready callback emits ready with the URL.
    harness.fireServerReady(5173, "https://preview.example");
    expect(sent.at(-1)).toEqual({
      type: "dev:status",
      payload: { state: "ready", detail: "https://preview.example" },
      ts: 1,
    });
  });

  it("emits crashed and returns install-failed when npm install exits non-zero, never spawning dev", async () => {
    const harness = makeHandle({ installExitCode: 1 });
    const { bridge, sent } = makeBridge();

    const result = await runBootPipeline(harness.handle, bridge, TREE, { now: () => 1 });

    expect(result).toEqual({ ok: false, reason: "install-failed", exitCode: 1 });

    // Crashed status carries the exit code and is the last thing emitted.
    expect(sent.at(-1)).toEqual({
      type: "dev:status",
      payload: { state: "crashed", detail: "npm install exited 1" },
      ts: 1,
    });

    // Dev was never spawned; only the install spawn happened.
    expect(harness.spawnCalls).toEqual([{ command: "npm", args: ["install"] }]);
    expect(devStatuses(sent).some((p) => p.phase === "dev")).toBe(false);
  });

  it("emits a single crashed status when the handle reports an error", async () => {
    const harness = makeHandle({ installExitCode: 0 });
    const { bridge, sent } = makeBridge();

    await runBootPipeline(harness.handle, bridge, TREE, { now: () => 1 });
    const before = sent.length;

    harness.fireError("WebContainer boom");
    expect(sent.at(-1)).toEqual({
      type: "dev:status",
      payload: { state: "crashed", detail: "WebContainer boom" },
      ts: 1,
    });
    expect(sent.length).toBe(before + 1);

    // A repeated error does not emit a second crashed status (emit-at-most-once).
    harness.fireError("second boom");
    const crashedCount = devStatuses(sent).filter((p) => p.state === "crashed").length;
    expect(crashedCount).toBe(1);
  });
});
