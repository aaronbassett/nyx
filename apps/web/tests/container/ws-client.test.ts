/**
 * US3 — PreviewBridge WebSocket client tests (TDD, RED first).
 *
 * `createPreviewBridge` implements the {@link PreviewBridge} seam
 * (`src/container/types.ts`) over a real browser `WebSocket`. These tests drive
 * it against a hand-rolled fake socket injected via `socketFactory`, so there is
 * no real network and the test fully controls open/message/close timing.
 *
 * They pin the load-bearing behaviour:
 *  - an incoming `file:write` frame is decoded with `parseServerToClientEvent`
 *    and delivered to its `on("file:write", …)` handler as a TYPED event;
 *  - `send(event)` puts the exact `JSON.stringify(event)` on the socket;
 *  - a malformed (non-JSON) frame and a well-formed-but-unknown/invalid frame are
 *    DROPPED silently — never a throw, never a spurious dispatch;
 *  - an `Unsubscribe` removes exactly one handler and stops further delivery;
 *  - `close()` delegates to the socket and `closed` resolves on the close event.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createPreviewBridge,
  defaultPreviewSocketUrl,
  type WebSocketLike,
} from "@/container/ws-client";
import type { ClientToServerEvent, FileWriteEvent, ServerToClientEvent } from "@nyx/protocol";

/**
 * A controllable in-memory `WebSocket`. The bridge assigns the `on*` handler
 * properties on construction; the test fires them via the `emit*` drivers, so
 * open/message/close order is fully deterministic. Records every `send` and the
 * number of `close()` delegations.
 */
class FakeWebSocket implements WebSocketLike {
  public readonly sent: string[] = [];
  public closeCount = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    // A real socket fires `close` asynchronously after the server acks; the test
    // drives `emitClose` explicitly, so here we only record the delegation.
    this.closeCount += 1;
  }

  public emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  public emitText(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  public emitClose(code: number, reason: string): void {
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

/** Spin up a bridge over a fresh fake socket with a fixed URL. */
function setup(): { fake: FakeWebSocket; bridge: ReturnType<typeof createPreviewBridge> } {
  const fake = new FakeWebSocket();
  const bridge = createPreviewBridge({
    projectId: "proj-1",
    url: "ws://localhost/ws?projectId=proj-1",
    socketFactory: () => fake,
  });
  return { fake, bridge };
}

/** A canonical, schema-valid `file:write` server → client event. */
function fileWriteEvent(): FileWriteEvent {
  return {
    type: "file:write",
    payload: { path: "src/index.ts", content: "export const x = 1;" },
    ts: 1234,
  };
}

describe("createPreviewBridge — incoming frame decoding and dispatch", () => {
  it("delivers an incoming file:write frame to its handler as a typed event", () => {
    const { fake, bridge } = setup();
    const received: FileWriteEvent[] = [];
    bridge.on("file:write", (event) => {
      // `event` is narrowed to FileWriteEvent — typed payload access compiles.
      received.push(event);
    });

    const frame = fileWriteEvent();
    fake.emitText(JSON.stringify(frame));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(frame);
    expect(received[0]?.payload.path).toBe("src/index.ts");
    expect(received[0]?.payload.content).toBe("export const x = 1;");
  });

  it("dispatches only to handlers registered for the frame's type", () => {
    const { fake, bridge } = setup();
    const onWrite = vi.fn<(event: ServerToClientEvent) => void>();
    const onDelete = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", onWrite);
    bridge.on("file:delete", onDelete);

    fake.emitText(JSON.stringify(fileWriteEvent()));

    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("delivers to every handler registered for the same type", () => {
    const { fake, bridge } = setup();
    const first = vi.fn<(event: ServerToClientEvent) => void>();
    const second = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", first);
    bridge.on("file:write", second);

    fake.emitText(JSON.stringify(fileWriteEvent()));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("createPreviewBridge — malformed and unknown frames are dropped silently", () => {
  it("drops a non-JSON frame without throwing or dispatching", () => {
    const { fake, bridge } = setup();
    const handler = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", handler);

    expect(() => {
      fake.emitText("{bad");
    }).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops a well-formed frame of an unknown type without dispatching", () => {
    const { fake, bridge } = setup();
    const handler = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", handler);

    const bogus = JSON.stringify({ type: "does:not:exist", payload: {}, ts: 1 });
    expect(() => {
      fake.emitText(bogus);
    }).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops a known-type frame with an invalid payload (schema miss)", () => {
    const { fake, bridge } = setup();
    const handler = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", handler);

    // `file:write` requires `content: string`; omit it → schema rejects.
    const invalid = JSON.stringify({ type: "file:write", payload: { path: "a" }, ts: 1 });
    expect(() => {
      fake.emitText(invalid);
    }).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops non-string socket data without throwing", () => {
    const { fake, bridge } = setup();
    const handler = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", handler);

    expect(() => {
      // Binary/other data is never JSON text; the bridge ignores it.
      fake.onmessage?.(new MessageEvent("message", { data: new ArrayBuffer(4) }));
    }).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createPreviewBridge — Unsubscribe", () => {
  it("stops delivering to a handler after its Unsubscribe is called", () => {
    const { fake, bridge } = setup();
    const handler = vi.fn<(event: ServerToClientEvent) => void>();
    const unsubscribe = bridge.on("file:delete", handler);

    const frame = JSON.stringify({
      type: "file:delete",
      payload: { path: "src/old.ts" },
      ts: 2,
    } satisfies ServerToClientEvent);

    fake.emitText(frame);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    fake.emitText(frame);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("removes exactly one handler, leaving siblings on the same type intact", () => {
    const { fake, bridge } = setup();
    const kept = vi.fn<(event: ServerToClientEvent) => void>();
    const removed = vi.fn<(event: ServerToClientEvent) => void>();
    bridge.on("file:write", kept);
    const unsubscribe = bridge.on("file:write", removed);

    unsubscribe();
    fake.emitText(JSON.stringify(fileWriteEvent()));

    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });
});

describe("createPreviewBridge — outgoing send", () => {
  it("serializes send(event) to the socket as exact JSON", () => {
    const { fake, bridge } = setup();
    const event: ClientToServerEvent = {
      type: "dev:status",
      payload: { state: "ready" },
      ts: 1,
    };

    bridge.send(event);

    expect(fake.sent).toEqual(['{"type":"dev:status","payload":{"state":"ready"},"ts":1}']);
  });

  it("round-trips a client event's JSON back to a deep-equal object", () => {
    const { fake, bridge } = setup();
    const event: ClientToServerEvent = {
      type: "file:changed",
      payload: { path: "src/app.ts", content: "const y = 2;" },
      ts: 9,
    };

    bridge.send(event);

    expect(fake.sent).toHaveLength(1);
    expect(JSON.parse(fake.sent[0] ?? "")).toEqual(event);
  });
});

describe("createPreviewBridge — lifecycle", () => {
  it("invokes onOpen when the socket opens", () => {
    const fake = new FakeWebSocket();
    const onOpen = vi.fn<() => void>();
    createPreviewBridge({
      projectId: "proj-1",
      url: "ws://localhost/ws?projectId=proj-1",
      socketFactory: () => fake,
      onOpen,
    });

    fake.emitOpen();

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("delegates close() to the socket and resolves `closed` with the close info", async () => {
    const fake = new FakeWebSocket();
    const onClose = vi.fn<(info: { code: number; reason: string }) => void>();
    const bridge = createPreviewBridge({
      projectId: "proj-1",
      url: "ws://localhost/ws?projectId=proj-1",
      socketFactory: () => fake,
      onClose,
    });

    bridge.close();
    expect(fake.closeCount).toBe(1);

    fake.emitClose(1000, "normal");

    await expect(bridge.closed).resolves.toEqual({ code: 1000, reason: "normal" });
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: "normal" });
  });
});

describe("defaultPreviewSocketUrl", () => {
  it("derives a ws:// URL from an http origin and encodes the projectId", () => {
    expect(defaultPreviewSocketUrl("proj 1", "http://localhost:5173")).toBe(
      "ws://localhost:5173/ws?projectId=proj%201",
    );
  });

  it("derives a wss:// URL from an https origin", () => {
    expect(defaultPreviewSocketUrl("abc", "https://nyx.example")).toBe(
      "wss://nyx.example/ws?projectId=abc",
    );
  });
});
