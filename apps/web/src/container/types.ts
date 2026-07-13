/**
 * Shared seams for the WebContainer preview host (US3).
 *
 * `WebContainerHandle` is the NARROW, mockable subset of `@webcontainer/api`'s
 * `WebContainer` that the `container/` modules use; the real API is adapted to it
 * by `createRealHandle` (real-handle.ts), which only runs under cross-origin
 * isolation and is therefore owner-gated. `PreviewBridge` is the WS seam the
 * modules use to talk to the server (`/ws`). Both are injectable, so every module
 * here is unit-testable against in-memory fakes with no browser and no socket.
 */
import type { ClientToServerEvent, ServerToClientEvent } from "@nyx/protocol";
import type { FileSystemTree } from "@webcontainer/api";

export type { FileSystemTree };

/** Removes a previously-registered handle/bridge listener. */
export type Unsubscribe = () => void;

/** A spawned process — the subset of `@webcontainer/api`'s `WebContainerProcess` we consume. */
export interface WebContainerProcessHandle {
  /** Decoded terminal output (stdout+stderr merged), already strings. */
  readonly output: ReadableStream<string>;
  /** Resolves with the process exit code. */
  readonly exit: Promise<number>;
  /** Terminate the process. */
  kill(): void;
}

/** The filesystem subset used for VFS sync and the report relay. */
export interface WebContainerFsHandle {
  writeFile(path: string, contents: string): Promise<void>;
  rm(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean },
  ): Promise<void>;
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  mkdir(path: string, options: { readonly recursive: true }): Promise<string>;
}

/**
 * The narrow WebContainer surface the modules depend on. The real booted
 * `WebContainer` is adapted to this by {@link createRealHandle}; tests pass a
 * fake. `on*` return an {@link Unsubscribe}.
 */
export interface WebContainerHandle {
  mount(tree: FileSystemTree): Promise<void>;
  spawn(command: string, args: readonly string[]): Promise<WebContainerProcessHandle>;
  readonly fs: WebContainerFsHandle;
  onServerReady(listener: (port: number, url: string) => void): Unsubscribe;
  onError(listener: (error: { readonly message: string }) => void): Unsubscribe;
  teardown(): void;
}

/** A server→client event of a specific `type`. */
export type ServerEventOf<T extends ServerToClientEvent["type"]> = Extract<
  ServerToClientEvent,
  { type: T }
>;

/**
 * The WS bridge the container uses: send client→server events (dev:status,
 * console:*, test:results, file:changed) and subscribe to server→client events
 * (file:write/delete, contract:deployed, artifacts:ready, session:takeover).
 * Implemented over a real `WebSocket` by ws-client.ts; mocked in tests.
 */
export interface PreviewBridge {
  send(event: ClientToServerEvent): void;
  on<T extends ServerToClientEvent["type"]>(
    type: T,
    handler: (event: ServerEventOf<T>) => void,
  ): Unsubscribe;
}
