/**
 * P2 — the web-side `compile:run` handler (Task 4).
 *
 * The server delegates each turn's compile to the client's wasm toolchain by
 * sending `compile:run { turnId, kind }`; the client runs the compile, uploads
 * artifacts on a green `full`, and replies with `compile:results`. These tests
 * drive {@link registerCompileHandlers} against a FAKE bridge + FAKE worker + a
 * recorded `upload`, proving every path sends exactly one terminal verdict (a
 * missing reply would burn the server-side timeout): a `check` echoes the worker
 * verdict; a green `full` uploads then replies with `sourceHash`+`circuits` AFTER
 * the upload resolves; an upload failure OR a worker/getSources throw replies
 * `ok:false` with a synthesized diagnostic; and `unsubscribe` detaches the
 * listener.
 */
import { describe, expect, it } from "vitest";

import type { CompileWorkerClient } from "@/compile/client";
import { registerCompileHandlers } from "@/compile/handlers";
import type { CheckOutput, FullOutput } from "@/compile/messages";
import { ArtifactUploadError, type UploadArtifactsArgs } from "@/compile/upload";
import type { PreviewBridge, ServerEventOf, Unsubscribe } from "@/container/types";
import type { WasmSourceFile } from "@nyx/compact-wasm";
import type {
  ClientToServerEvent,
  CompileResultsPayload,
  ServerToClientEvent,
  TurnId,
} from "@nyx/protocol";

/** A recorded server→client listener the test can fire. */
type Listener = (event: ServerToClientEvent) => void;

/** A scriptable {@link PreviewBridge}: records `send`s and fires `compile:run`. */
class FakeBridge implements PreviewBridge {
  readonly sent: ClientToServerEvent[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  send(event: ClientToServerEvent): void {
    this.sent.push(event);
  }

  on<T extends ServerToClientEvent["type"]>(
    type: T,
    handler: (event: ServerEventOf<T>) => void,
  ): Unsubscribe {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(handler as Listener);
    this.listeners.set(type, set);
    return () => set.delete(handler as Listener);
  }

  /** Deliver a `compile:run` frame to every registered handler. */
  fireCompileRun(turnId: string, kind: "check" | "full"): void {
    const event: ServerEventOf<"compile:run"> = {
      type: "compile:run",
      payload: { turnId: turnId as TurnId, kind },
      ts: 1,
    };
    for (const listener of this.listeners.get("compile:run") ?? []) {
      listener(event);
    }
  }

  /** The `compile:results` verdicts sent, in order. */
  results(): CompileResultsPayload[] {
    return this.sent
      .filter((event) => event.type === "compile:results")
      .map((event) => event.payload);
  }
}

/** A scriptable {@link CompileWorkerClient}. */
class FakeWorker implements CompileWorkerClient {
  checkResult: CheckOutput | Error = {
    ok: true,
    diagnostics: [],
    compilerVersion: "0.31.1",
    durationMs: 5,
  };
  fullResult: FullOutput | Error = {
    ok: true,
    diagnostics: [],
    compilerVersion: "0.31.1",
    durationMs: 5,
  };
  readonly checkedWith: WasmSourceFile[][] = [];
  disposed = false;

  check(sources: WasmSourceFile[]): Promise<CheckOutput> {
    this.checkedWith.push(sources);
    return this.checkResult instanceof Error
      ? Promise.reject(this.checkResult)
      : Promise.resolve(this.checkResult);
  }

  compileFull(sources: WasmSourceFile[]): Promise<FullOutput> {
    this.checkedWith.push(sources);
    return this.fullResult instanceof Error
      ? Promise.reject(this.fullResult)
      : Promise.resolve(this.fullResult);
  }

  dispose(): void {
    this.disposed = true;
  }
}

const SOURCES: WasmSourceFile[] = [{ path: "main.compact", content: "circuit foo() {}" }];
const PROJECT_ID = "proj-1";

/** Flush pending microtasks (the fire-and-forget async handler). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registerCompileHandlers", () => {
  it("runs a check and echoes the worker verdict back as compile:results", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();
    worker.checkResult = {
      ok: false,
      diagnostics: [{ severity: "error", source: "compactp", message: "boom" }],
      compilerVersion: "0.31.1",
      durationMs: 12,
    };

    registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.resolve(SOURCES),
    });
    bridge.fireCompileRun("turn-1", "check");
    await flush();

    expect(worker.checkedWith).toEqual([SOURCES]);
    const [verdict] = bridge.results();
    expect(verdict).toEqual({
      turnId: "turn-1",
      kind: "check",
      ok: false,
      diagnostics: [{ severity: "error", source: "compactp", message: "boom" }],
      compilerVersion: "0.31.1",
      durationMs: 12,
    });
  });

  it("uploads a green full compile then replies with sourceHash + circuits", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();
    const files = [
      { path: "contract/index.cjs", bytes: new Uint8Array([1]), contentType: "text/javascript" },
    ];
    const circuits = [{ name: "increment", proof: true }];
    worker.fullResult = {
      ok: true,
      diagnostics: [],
      compilerVersion: "0.31.1",
      durationMs: 40,
      sourceHash: "b".repeat(64),
      circuits,
      files,
    };

    let uploadResolved = false;
    const uploadCalls: UploadArtifactsArgs[] = [];
    const upload = (
      _deps: { fetch?: typeof fetch; baseUrl?: string },
      args: UploadArtifactsArgs,
    ): Promise<void> => {
      uploadCalls.push(args);
      return Promise.resolve().then(() => {
        uploadResolved = true;
      });
    };

    registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.resolve(SOURCES),
      upload,
    });
    bridge.fireCompileRun("turn-2", "full");
    await flush();

    // Upload got the worker outputs under the project.
    expect(uploadCalls).toEqual([
      {
        projectId: PROJECT_ID,
        sourceHash: "b".repeat(64),
        compilerVersion: "0.31.1",
        files,
        circuits,
      },
    ]);
    // The verdict is sent only AFTER upload resolves, carrying the hash + table.
    expect(uploadResolved).toBe(true);
    const [verdict] = bridge.results();
    expect(verdict).toMatchObject({
      turnId: "turn-2",
      kind: "full",
      ok: true,
      sourceHash: "b".repeat(64),
      circuits,
    });
  });

  it("replies ok:false with a synthesized diagnostic when the upload fails", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();
    worker.fullResult = {
      ok: true,
      diagnostics: [],
      compilerVersion: "0.31.1",
      durationMs: 40,
      sourceHash: "c".repeat(64),
      circuits: [],
      files: [{ path: "a.txt", bytes: new Uint8Array([1]), contentType: "text/plain" }],
    };
    const upload = (): Promise<void> => Promise.reject(new ArtifactUploadError("a.txt", 413));

    registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.resolve(SOURCES),
      upload,
    });
    bridge.fireCompileRun("turn-3", "full");
    await flush();

    const [verdict] = bridge.results();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.kind).toBe("full");
    // A failed upload must NOT advertise a sourceHash (the server would treat the
    // artifacts as complete).
    expect(verdict?.sourceHash).toBeUndefined();
    expect(verdict?.diagnostics.length).toBe(1);
    expect(verdict?.diagnostics[0]?.message).toContain("a.txt");
  });

  it("replies ok:false with a synthesized diagnostic when the worker throws", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();
    worker.checkResult = new Error("wasm module failed to load");

    registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.resolve(SOURCES),
    });
    bridge.fireCompileRun("turn-4", "check");
    await flush();

    const [verdict] = bridge.results();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.kind).toBe("check");
    expect(verdict?.diagnostics[0]?.message).toContain("wasm module failed to load");
    // A synthesized-error verdict still carries a schema-valid compilerVersion.
    expect(verdict?.compilerVersion.length).toBeGreaterThan(0);
  });

  it("replies ok:false when getSources throws", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();

    registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.reject(new Error("no project loaded")),
    });
    bridge.fireCompileRun("turn-5", "full");
    await flush();

    const [verdict] = bridge.results();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.diagnostics[0]?.message).toContain("no project loaded");
  });

  it("does not advertise a sourceHash for a failing (non-green) full compile", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();
    worker.fullResult = {
      ok: false,
      diagnostics: [{ severity: "error", source: "compactc", message: "type error" }],
      compilerVersion: "0.31.1",
      durationMs: 30,
    };
    let uploaded = false;
    const upload = (): Promise<void> => {
      uploaded = true;
      return Promise.resolve();
    };

    registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.resolve(SOURCES),
      upload,
    });
    bridge.fireCompileRun("turn-6", "full");
    await flush();

    expect(uploaded).toBe(false);
    const [verdict] = bridge.results();
    expect(verdict?.ok).toBe(false);
    expect(verdict?.sourceHash).toBeUndefined();
  });

  it("detaches the listener on unsubscribe", async () => {
    const bridge = new FakeBridge();
    const worker = new FakeWorker();
    const unsubscribe = registerCompileHandlers({
      bridge,
      worker,
      projectId: PROJECT_ID,
      getSources: () => Promise.resolve(SOURCES),
    });

    unsubscribe();
    bridge.fireCompileRun("turn-7", "check");
    await flush();

    expect(bridge.results()).toEqual([]);
    expect(worker.checkedWith).toEqual([]);
  });
});
