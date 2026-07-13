/**
 * T085 — process-stream console relay tests (US3 WebContainer preview host).
 *
 * `streamProcessConsole` drains a spawned process's merged output stream and
 * relays each chunk to the server as a `console:log` (or `console:error`) event
 * over the `PreviewBridge` (FR-007, FR-033). These tests drive it against an
 * in-memory FAKE `WebContainerProcessHandle` whose `output` is a real
 * `ReadableStream<string>` seeded from an array — no real WebContainer, no
 * cross-origin-isolated browser (both owner-gated) — and a mock `PreviewBridge`
 * that records every `send`. `now` is injected so timestamps are deterministic.
 *
 * Covers:
 *  - each chunk → an ordered `console:log` with the exact `{ message }` and the
 *    injected `ts`, and the stream lock is released once the drain completes;
 *  - a `classify` heuristic routes matching chunks to `console:error`;
 *  - an already-closed stream resolves with zero sends;
 *  - a bridge `send` failure is swallowed so the drain continues (log-and-continue).
 */
import { describe, expect, it } from "vitest";

import { streamProcessConsole } from "@/container/streams";
import type { PreviewBridge, WebContainerProcessHandle } from "@/container/types";
import type { ClientToServerEvent } from "@nyx/protocol";

/** A `PreviewBridge` whose `send` calls are recorded in invocation order. */
interface RecordingBridge {
  readonly bridge: PreviewBridge;
  /** Live view of every relayed event, in send order. */
  readonly sent: readonly ClientToServerEvent[];
}

function createRecordingBridge(): RecordingBridge {
  const sent: ClientToServerEvent[] = [];
  const bridge: PreviewBridge = {
    send: (event) => {
      sent.push(event);
    },
    on: () => () => undefined,
  };
  return { bridge, sent };
}

/**
 * A fake process whose `output` is a real `ReadableStream<string>` that enqueues
 * `chunks` then closes; `exit` resolves immediately and `kill` is a noop.
 */
function createFakeProcess(chunks: readonly string[]): WebContainerProcessHandle {
  return {
    output: new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    exit: Promise.resolve(0),
    kill: () => undefined,
  };
}

describe("streamProcessConsole", () => {
  it("relays each chunk as an ordered console:log with the injected timestamp", async () => {
    const { bridge, sent } = createRecordingBridge();
    const proc = createFakeProcess(["one", "two", "three"]);

    await streamProcessConsole(proc, bridge, { now: () => 7 });

    expect(sent).toEqual([
      { type: "console:log", payload: { message: "one" }, ts: 7 },
      { type: "console:log", payload: { message: "two" }, ts: 7 },
      { type: "console:log", payload: { message: "three" }, ts: 7 },
    ]);
    // The `finally` must always release the reader lock so the stream is reusable.
    expect(proc.output.locked).toBe(false);
  });

  it("routes chunks the classifier marks as errors to console:error", async () => {
    const { bridge, sent } = createRecordingBridge();
    const proc = createFakeProcess(["vite ready", "ERR boom", "still going"]);

    await streamProcessConsole(proc, bridge, {
      now: () => 7,
      classify: (chunk) => (chunk.includes("ERR") ? "error" : "log"),
    });

    expect(sent).toEqual([
      { type: "console:log", payload: { message: "vite ready" }, ts: 7 },
      { type: "console:error", payload: { message: "ERR boom" }, ts: 7 },
      { type: "console:log", payload: { message: "still going" }, ts: 7 },
    ]);
  });

  it("resolves with no sends when the stream is already closed", async () => {
    const { bridge, sent } = createRecordingBridge();
    const proc = createFakeProcess([]);

    await expect(streamProcessConsole(proc, bridge, { now: () => 7 })).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("swallows a bridge send failure and keeps draining the stream", async () => {
    const sent: ClientToServerEvent[] = [];
    let calls = 0;
    const bridge: PreviewBridge = {
      send: (event) => {
        calls += 1;
        if (calls === 1) throw new Error("socket down");
        sent.push(event);
      },
      on: () => () => undefined,
    };
    const proc = createFakeProcess(["first", "second"]);

    await expect(streamProcessConsole(proc, bridge, { now: () => 7 })).resolves.toBeUndefined();

    // The first send threw and was swallowed; the second was still relayed.
    expect(calls).toBe(2);
    expect(sent).toEqual([{ type: "console:log", payload: { message: "second" }, ts: 7 }]);
  });
});
