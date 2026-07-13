/**
 * US3 preview COORDINATOR tests (`createPreview`).
 *
 * `createPreview` is the testable wiring factory that fuses the already-built
 * `container/` modules into one {@link PreviewController}: it subscribes the
 * injected {@link PreviewBridge} to the server → client events (`file:write`,
 * `file:delete`, `contract:deployed`, `artifacts:ready`, `session:takeover`),
 * runs the boot pipeline on `start()`, marks the VFS mounted once boot succeeds,
 * and tears every subscription down on `dispose()`.
 *
 * These tests drive it against a FAKE {@link WebContainerHandle} (records
 * `writeFile`s; `spawn` yields a process with an already-closed output stream and
 * an immediate exit) and a controllable mock {@link PreviewBridge} that lets the
 * test emit server → client events to the registered handlers — no real
 * WebContainer, no cross-origin-isolated browser (both owner-gated), no socket.
 * `launchPreview` (the owner-gated real-`WebContainer` entry point) is not
 * exercised here.
 */
import { describe, expect, it, vi } from "vitest";

import { ZK_CONFIG_BASE_ENV_KEY } from "@/container/artifacts";
import { CONTRACT_ADDRESS_ENV_KEY } from "@/container/env";
import { ENV_LOCAL_PATH } from "@/container/env-file";
import { createPreview } from "@/container/preview";
import type {
  PreviewBridge,
  ServerEventOf,
  Unsubscribe,
  WebContainerFsHandle,
  WebContainerHandle,
  WebContainerProcessHandle,
} from "@/container/types";
import type { ContractAddress, ServerToClientEvent } from "@nyx/protocol";

/** A single recorded `.env.local` / VFS write. */
interface WriteCall {
  readonly path: string;
  readonly contents: string;
}

interface FakeHandle {
  readonly handle: WebContainerHandle;
  /** Live view of every `writeFile`, in invocation order. */
  readonly writes: readonly WriteCall[];
}

/**
 * A fake handle that records `writeFile`s. `spawn` yields a process whose
 * `output` is an already-CLOSED `ReadableStream<string>` (the drain sees `done`
 * immediately, so no console relay fires) and whose `exit` resolves `0`, so the
 * boot pipeline runs mount → install → dev → server-ready to a clean `ok:true`.
 */
function createFakeHandle(): FakeHandle {
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

  const spawnProcess = (): WebContainerProcessHandle => ({
    output: new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    }),
    exit: Promise.resolve(0),
    kill: () => undefined,
  });

  const handle: WebContainerHandle = {
    fs,
    mount: () => Promise.resolve(),
    spawn: () => Promise.resolve(spawnProcess()),
    onServerReady: (): Unsubscribe => () => undefined,
    onError: (): Unsubscribe => () => undefined,
    teardown: () => undefined,
  };

  return { handle, writes };
}

interface MockBridge {
  readonly bridge: PreviewBridge;
  /** Every client → server event the coordinator sent, in order. */
  readonly sent: readonly unknown[];
  /** Deliver a server → client event to every currently-registered handler. */
  emit(event: ServerToClientEvent): void;
}

/** A controllable {@link PreviewBridge}: records `send`, replays `emit` to `on` handlers. */
function createMockBridge(): MockBridge {
  const sent: unknown[] = [];
  const handlers = new Map<
    ServerToClientEvent["type"],
    Set<(event: ServerToClientEvent) => void>
  >();

  const bridge: PreviewBridge = {
    send(event) {
      sent.push(event);
    },
    on<T extends ServerToClientEvent["type"]>(
      type: T,
      handler: (event: ServerEventOf<T>) => void,
    ): Unsubscribe {
      // Same widening the real ws-client uses: `emit` only ever calls a stored
      // handler with an event whose `.type` equals its key, so this is sound.
      const erased = handler as (event: ServerToClientEvent) => void;
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set<(event: ServerToClientEvent) => void>();
        handlers.set(type, set);
      }
      set.add(erased);
      return () => {
        set.delete(erased);
      };
    },
  };

  return {
    bridge,
    sent,
    emit(event) {
      const set = handlers.get(event.type);
      if (set === undefined) return;
      for (const handler of set) handler(event);
    },
  };
}

/** Drain the microtask queue (and any 0ms timers) so async fs work is observable. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const TS = 0;

const fileWriteEvent = (path: string, content: string): ServerToClientEvent => ({
  type: "file:write",
  payload: { path, content },
  ts: TS,
});

const contractDeployedEvent = (address: string): ServerToClientEvent => ({
  type: "contract:deployed",
  payload: { address: address as ContractAddress },
  ts: TS,
});

const artifactsReadyEvent = (urlPrefix: string): ServerToClientEvent => ({
  type: "artifacts:ready",
  payload: { urlPrefix },
  ts: TS,
});

const takeoverEvent = (): ServerToClientEvent => ({
  type: "session:takeover",
  payload: {},
  ts: TS,
});

interface Harness {
  readonly fake: FakeHandle;
  readonly mock: MockBridge;
  readonly controller: ReturnType<typeof createPreview>;
  readonly onTakeover: ReturnType<typeof vi.fn<() => void>>;
  readonly onCrashed: ReturnType<typeof vi.fn<(detail?: string) => void>>;
  readonly restartDevServer: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly reboot: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly onRepointed: ReturnType<typeof vi.fn<(urlPrefix: string) => void>>;
}

function createHarness(): Harness {
  const fake = createFakeHandle();
  const mock = createMockBridge();
  const onTakeover = vi.fn<() => void>();
  const onCrashed = vi.fn<(detail?: string) => void>();
  const restartDevServer = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const reboot = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const onRepointed = vi.fn<(urlPrefix: string) => void>();

  const controller = createPreview(fake.handle, mock.bridge, {
    tree: {},
    onTakeover,
    onCrashed,
    restartDevServer,
    reboot,
    onRepointed,
    now: () => TS,
  });

  return { fake, mock, controller, onTakeover, onCrashed, restartDevServer, reboot, onRepointed };
}

describe("createPreview", () => {
  it("boots ok and flushes a pre-start file:write once markMounted fires", async () => {
    const { fake, mock, controller } = createHarness();

    // A write arrives BEFORE boot — the VFS sync must queue it, never touch an
    // unmounted fs, and flush it only after `start()` calls `markMounted()`.
    mock.emit(fileWriteEvent("src/App.tsx", "hi"));
    await flush();
    expect(fake.writes).toHaveLength(0);

    const result = await controller.start();
    expect(result.ok).toBe(true);
    // The boot pipeline drove the bridge (dev:status frames).
    expect(mock.sent.length).toBeGreaterThan(0);

    // markMounted flushed the queued write through to the fake fs.
    await flush();
    expect(fake.writes).toContainEqual({ path: "src/App.tsx", contents: "hi" });
  });

  it("writes VITE_CONTRACT_ADDRESS to .env.local on contract:deployed", async () => {
    const { fake, mock, restartDevServer } = createHarness();

    mock.emit(contractDeployedEvent("mn_addr_test1qcoordinator"));
    await flush();

    const envWrite = fake.writes.find((write) => write.path === ENV_LOCAL_PATH);
    expect(envWrite?.contents).toContain(`${CONTRACT_ADDRESS_ENV_KEY}=mn_addr_test1qcoordinator`);
    expect(restartDevServer).toHaveBeenCalledTimes(1);
  });

  it("sets the ZK-config base var and re-points on artifacts:ready", async () => {
    const { fake, mock, onRepointed } = createHarness();

    const prefix = "https://r2.example/artifacts/pfx-a/";
    mock.emit(artifactsReadyEvent(prefix));
    await flush();

    const envWrite = fake.writes.find((write) => write.path === ENV_LOCAL_PATH);
    expect(envWrite?.contents).toContain(`${ZK_CONFIG_BASE_ENV_KEY}=${prefix}`);
    expect(onRepointed).toHaveBeenCalledWith(prefix);
  });

  it("invokes onTakeover on session:takeover", async () => {
    const { mock, onTakeover } = createHarness();

    mock.emit(takeoverEvent());
    await flush();

    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("stops handling events after dispose()", async () => {
    const { fake, mock, controller, onTakeover } = createHarness();

    controller.dispose();

    // Every subscription is torn down: neither a takeover nor a VFS write lands.
    mock.emit(takeoverEvent());
    mock.emit(fileWriteEvent("src/After.tsx", "z"));
    await flush();

    expect(onTakeover).not.toHaveBeenCalled();
    expect(fake.writes).toHaveLength(0);
  });
});
