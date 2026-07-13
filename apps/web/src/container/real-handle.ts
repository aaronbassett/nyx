/**
 * Adapter from a real booted `@webcontainer/api` `WebContainer` to the narrow
 * {@link WebContainerHandle} seam.
 *
 * OWNER-GATED: this is the only module that touches the real API, and the real
 * `WebContainer` only boots under cross-origin isolation (SharedArrayBuffer +
 * COOP/COEP), so this glue is exercised in a real browser, not in unit tests —
 * every other `container/` module tests against a fake handle. Kept deliberately
 * thin (structural pass-through) so there is little here that can be wrong.
 */
import type { WebContainer } from "@webcontainer/api";
import type {
  FileSystemTree,
  Unsubscribe,
  WebContainerHandle,
  WebContainerProcessHandle,
} from "./types";

/** Wrap a booted `WebContainer` in the {@link WebContainerHandle} seam. */
export function createRealHandle(wc: WebContainer): WebContainerHandle {
  return {
    mount: (tree: FileSystemTree): Promise<void> => wc.mount(tree),
    spawn: async (command: string, args: readonly string[]): Promise<WebContainerProcessHandle> => {
      const proc = await wc.spawn(command, [...args]);
      return {
        output: proc.output,
        exit: proc.exit,
        kill: (): void => {
          proc.kill();
        },
      };
    },
    fs: {
      writeFile: (path: string, contents: string): Promise<void> => wc.fs.writeFile(path, contents),
      rm: (
        path: string,
        options?: { readonly recursive?: boolean; readonly force?: boolean },
      ): Promise<void> => wc.fs.rm(path, options),
      readFile: (path: string, encoding: "utf-8"): Promise<string> =>
        wc.fs.readFile(path, encoding),
      mkdir: (path: string, options: { readonly recursive: true }): Promise<string> =>
        wc.fs.mkdir(path, options),
    },
    onServerReady: (listener: (port: number, url: string) => void): Unsubscribe =>
      wc.on("server-ready", listener),
    onError: (listener: (error: { readonly message: string }) => void): Unsubscribe =>
      wc.on("error", listener),
    teardown: (): void => {
      wc.teardown();
    },
  };
}
