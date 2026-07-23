/**
 * P2 — `CompileWorkerClient` request/response correlation (Task 3).
 *
 * The client is a promise-map over a `postMessage` transport to a compile
 * worker. These tests drive it against a FAKE `WorkerLike` (the real worker
 * boots the vendored wasm compiler and is browser-only, exercised by the P5
 * demo smoke, not here). They prove: two concurrent requests correlate to their
 * own callers by `id`; an `error` response rejects only its matching call; a
 * `full` compile round-trips file bytes; and `dispose()` terminates the worker
 * and rejects anything still in flight.
 */
import { describe, expect, it } from "vitest";

import { createCompileWorkerClient } from "@/compile/client";
import type { WorkerLike } from "@/compile/client";
import type { CompileWorkerRequest, CompileWorkerResponse, CheckOutput } from "@/compile/messages";
import type { WasmSourceFile } from "@nyx/compact-wasm";

/**
 * A scriptable `WorkerLike` double: it records every posted request and lets the
 * test push responses back through `onmessage` in any order.
 */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly posted: CompileWorkerRequest[] = [];
  terminated = false;

  postMessage(msg: unknown): void {
    this.posted.push(msg as CompileWorkerRequest);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a scripted response to the client. */
  emit(response: CompileWorkerResponse): void {
    this.onmessage?.({ data: response });
  }
}

const SOURCES: WasmSourceFile[] = [{ path: "main.compact", content: "circuit foo() {}" }];

function makeCheck(ok: boolean): CheckOutput {
  return { ok, diagnostics: [], compilerVersion: "0.31.1", durationMs: 1 };
}

/** Read the two recorded requests, failing the test if fewer were posted. */
function twoRequests(worker: FakeWorker): [CompileWorkerRequest, CompileWorkerRequest] {
  const [first, second] = worker.posted;
  if (!first || !second) {
    throw new Error(`expected two posted requests, saw ${String(worker.posted.length)}`);
  }
  return [first, second];
}

describe("createCompileWorkerClient", () => {
  it("posts a check request with monotonically increasing ids", () => {
    const worker = new FakeWorker();
    const client = createCompileWorkerClient({ worker });

    void client.check(SOURCES);
    void client.check(SOURCES);

    const [first, second] = twoRequests(worker);
    expect(first.op).toBe("check");
    expect(second.op).toBe("check");
    expect(first.id).not.toBe(second.id);
  });

  it("correlates two in-flight checks to their own callers, resolved out of order", async () => {
    const worker = new FakeWorker();
    const client = createCompileWorkerClient({ worker });

    const p1 = client.check(SOURCES);
    const p2 = client.check(SOURCES);
    const [first, second] = twoRequests(worker);

    // Respond to the SECOND request first — correlation is by id, not arrival.
    worker.emit({ id: second.id, result: makeCheck(true) });
    worker.emit({ id: first.id, result: makeCheck(false) });

    await expect(p1).resolves.toMatchObject({ ok: false });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("rejects only the call whose id carries an error response", async () => {
    const worker = new FakeWorker();
    const client = createCompileWorkerClient({ worker });

    const p1 = client.check(SOURCES);
    const p2 = client.check(SOURCES);
    const [first, second] = twoRequests(worker);

    worker.emit({ id: first.id, error: "compiler exploded" });
    await expect(p1).rejects.toThrow("compiler exploded");

    // The sibling call is untouched and still resolves normally.
    worker.emit({ id: second.id, result: makeCheck(true) });
    await expect(p2).resolves.toMatchObject({ ok: true });
  });

  it("round-trips a full-compile result including file bytes and circuits", async () => {
    const worker = new FakeWorker();
    const client = createCompileWorkerClient({ worker });

    const promise = client.compileFull(SOURCES);
    const [request] = worker.posted;
    if (!request) throw new Error("expected a posted request");
    expect(request.op).toBe("full");

    const bytes = new Uint8Array([1, 2, 3]);
    worker.emit({
      id: request.id,
      result: {
        ok: true,
        diagnostics: [],
        compilerVersion: "0.31.1",
        durationMs: 5,
        sourceHash: "deadbeef",
        circuits: [{ name: "foo", proof: true }],
        files: [{ path: "foo.js", bytes, contentType: "application/javascript" }],
      },
    });

    const result = await promise;
    expect(result.sourceHash).toBe("deadbeef");
    expect(result.circuits).toEqual([{ name: "foo", proof: true }]);
    expect(result.files?.[0]?.bytes).toEqual(bytes);
  });

  it("ignores a response whose id has no pending call", async () => {
    const worker = new FakeWorker();
    const client = createCompileWorkerClient({ worker });

    const p1 = client.check(SOURCES);
    const [request] = worker.posted;
    if (!request) throw new Error("expected a posted request");

    // Stray/duplicate id — must not throw or corrupt the pending map.
    worker.emit({ id: request.id + 999, result: makeCheck(true) });
    worker.emit({ id: request.id, result: makeCheck(false) });

    await expect(p1).resolves.toMatchObject({ ok: false });
  });

  it("dispose() terminates the worker and rejects in-flight calls", async () => {
    const worker = new FakeWorker();
    const client = createCompileWorkerClient({ worker });

    const pending = client.check(SOURCES);
    client.dispose();

    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow(/disposed/);
  });
});
