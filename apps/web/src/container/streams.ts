/**
 * T085 — process-stream console relay for the WebContainer preview host (US3).
 *
 * Drains a spawned process's output and relays every chunk to the server as a
 * `console:log` (or `console:error`) event over the injected {@link PreviewBridge},
 * so the runtime feedback from `npm install` / `npm run dev` / test runs surfaces
 * in the turn (FR-007, FR-033). The module is pure orchestration over the
 * {@link WebContainerProcessHandle} and {@link PreviewBridge} seams — no DOM, no
 * socket, no `@webcontainer/api` import — so it unit-tests against in-memory fakes.
 *
 * WebContainer merges stdout and stderr into a single already-decoded
 * `ReadableStream<string>`, so stderr cannot be distinguished at the source. The
 * default therefore classifies EVERY chunk as `console:log`; a caller that has a
 * heuristic (e.g. a Vite error banner) can pass `classify` to route matching
 * chunks to `console:error`.
 *
 * The stream is drained through a `getReader()` loop inside `try/finally` so the
 * reader lock is ALWAYS released, even if the loop throws. A `bridge.send`
 * failure is swallowed (log-and-continue): a transient relay error must never
 * abort the drain and strand the rest of the process output.
 */
import type { ClientToServerEvent } from "@nyx/protocol";

import type { PreviewBridge, WebContainerProcessHandle } from "./types";

/** How a single output chunk is routed: normal log vs. error. */
export type ConsoleClassification = "log" | "error";

/** Tunables for {@link streamProcessConsole}; both are injectable for tests. */
export interface StreamProcessConsoleOptions {
  /** Timestamp source for the emitted frames. Defaults to {@link Date.now}. */
  readonly now?: () => number;
  /**
   * Classifies a chunk as a normal log or an error. Defaults to log-only, since
   * WebContainer merges stderr into stdout and cannot separate them at source.
   */
  readonly classify?: (chunk: string) => ConsoleClassification;
}

/** Default classifier: every chunk is a normal `console:log`. */
const classifyAsLog = (): ConsoleClassification => "log";

/**
 * Drains `proc.output` and relays each chunk to `bridge` as a `console:log`
 * (or `console:error` when `options.classify` returns `"error"`). Resolves when
 * the stream closes (`done`). Never rejects on a relay error — a failed
 * `bridge.send` is swallowed so the drain always runs to completion.
 */
export async function streamProcessConsole(
  proc: WebContainerProcessHandle,
  bridge: PreviewBridge,
  options?: StreamProcessConsoleOptions,
): Promise<void> {
  const now = options?.now ?? Date.now;
  const classify = options?.classify ?? classifyAsLog;

  const reader = proc.output.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      relayChunk(bridge, value, classify(value), now());
    }
  } finally {
    reader.releaseLock();
  }
}

/** Builds the typed console event for `chunk` and sends it, swallowing send errors. */
function relayChunk(
  bridge: PreviewBridge,
  chunk: string,
  classification: ConsoleClassification,
  ts: number,
): void {
  const event: ClientToServerEvent =
    classification === "error"
      ? { type: "console:error", payload: { message: chunk }, ts }
      : { type: "console:log", payload: { message: chunk }, ts };

  try {
    bridge.send(event);
  } catch {
    // Log-and-continue: a relay failure (e.g. a closed socket) must not abort
    // the drain and strand the remaining process output.
  }
}
