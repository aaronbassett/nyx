/**
 * Typed event router tests (T022).
 *
 * Deterministic and transport-free: dispatch is driven with raw text frames and
 * a fake {@link ConnectionContext}, so no socket is required. Proves a valid
 * frame reaches its typed handler, that malformed JSON / schema misses / missing
 * handlers are reported (never thrown), and that {@link sendEvent} validates and
 * serializes outbound events (including `bigint` amounts).
 */
import { describe, expect, it, vi } from "vitest";
import { TurnIdSchema } from "@nyx/protocol";
import type { ServerToClientEvent } from "@nyx/protocol";
import { createEventRouter, sendEvent, serializeEvent } from "./router.js";
import type { ConnectionContext, Sendable } from "./router.js";

function fakeContext(): { ctx: ConnectionContext; sent: ServerToClientEvent[] } {
  const sent: ServerToClientEvent[] = [];
  const ctx: ConnectionContext = {
    session: { accountAddress: "addr_test" },
    projectId: "proj_test",
    send: (event) => {
      sent.push(event);
    },
    close: () => undefined,
  };
  return { ctx, sent };
}

function frame(event: unknown): string {
  return JSON.stringify(event);
}

describe("EventRouter.dispatch", () => {
  it("routes a valid frame to the handler registered for its type", () => {
    const handler = vi.fn();
    const router = createEventRouter().on("console:log", handler);
    const { ctx } = fakeContext();

    const outcome = router.dispatch(
      frame({ type: "console:log", payload: { message: "hello" }, ts: 1 }),
      ctx,
    );

    expect(outcome).toEqual({ status: "dispatched", type: "console:log" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { type: "console:log", payload: { message: "hello" }, ts: 1 },
      ctx,
    );
  });

  it("hands the handler a correctly-typed payload it can act on", () => {
    let seen: string | undefined;
    const router = createEventRouter().on("console:log", (event, context) => {
      seen = event.payload.message;
      context.send({
        type: "deploy:status",
        payload: { requestId: "r1", phase: "proving" },
        ts: 1,
      });
    });
    const { ctx, sent } = fakeContext();

    router.dispatch(frame({ type: "console:log", payload: { message: "ping" }, ts: 2 }), ctx);

    expect(seen).toBe("ping");
    expect(sent).toEqual([
      { type: "deploy:status", payload: { requestId: "r1", phase: "proving" }, ts: 1 },
    ]);
  });

  it("reports malformed JSON without throwing", () => {
    const { ctx } = fakeContext();
    expect(createEventRouter().dispatch("{ not json", ctx)).toEqual({ status: "invalid-json" });
  });

  it("reports a schema-invalid event without throwing", () => {
    const { ctx } = fakeContext();
    // console:log requires payload.message; omit it.
    const outcome = createEventRouter().dispatch(
      frame({ type: "console:log", payload: {}, ts: 1 }),
      ctx,
    );
    expect(outcome.status).toBe("invalid-event");
  });

  it("reports a valid event with no registered handler", () => {
    const { ctx } = fakeContext();
    const outcome = createEventRouter().dispatch(
      frame({ type: "prompt:submit", payload: { projectId: "p1", text: "hi" }, ts: 1 }),
      ctx,
    );
    expect(outcome).toEqual({ status: "unhandled", type: "prompt:submit" });
  });

  it("does not let a throwing handler crash dispatch", () => {
    const router = createEventRouter().on("console:log", () => {
      throw new Error("boom");
    });
    const { ctx } = fakeContext();
    const outcome = router.dispatch(
      frame({ type: "console:log", payload: { message: "x" }, ts: 1 }),
      ctx,
    );
    expect(outcome).toEqual({ status: "handler-error", type: "console:log" });
  });
});

describe("sendEvent / serializeEvent", () => {
  it("validates and serializes a server → client event", () => {
    const captured: string[] = [];
    const socket: Sendable = { send: (data) => captured.push(data) };

    const ok = sendEvent(socket, {
      type: "deploy:status",
      payload: { requestId: "r1", phase: "submitting" },
      ts: 5,
    });

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    const decoded: unknown = JSON.parse(captured[0] ?? "");
    expect(decoded).toEqual({
      type: "deploy:status",
      payload: { requestId: "r1", phase: "submitting" },
      ts: 5,
    });
  });

  it("encodes bigint NYXT amounts as decimal strings (never throws)", () => {
    const event: ServerToClientEvent = {
      type: "turn:settled",
      payload: { turnId: TurnIdSchema.parse("turn-1"), consumed: 100n, balance: -25n },
      ts: 9,
    };
    const decoded: unknown = JSON.parse(serializeEvent(event));
    expect(decoded).toEqual({
      type: "turn:settled",
      payload: { turnId: "turn-1", consumed: "100", balance: "-25" },
      ts: 9,
    });
  });
});
