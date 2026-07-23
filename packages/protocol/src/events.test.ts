import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ClientToServerEventSchema,
  encodeTurnSettledEvent,
  parseClientToServerEvent,
  parseEvent,
  parseServerToClientEvent,
  ProjectIdSchema,
  ServerToClientEventSchema,
  TurnIdSchema,
  TurnSettledEventSchema,
  type ClientToServerEvent,
  type PromptSubmitEvent,
  type ServerToClientEvent,
  type TurnSettledEvent,
} from "./index.js";

const ts = 1_752_000_000_000;

interface Fixture {
  name: string;
  event: unknown;
}

const serverToClientFixtures: Fixture[] = [
  {
    name: "file:write",
    event: { type: "file:write", payload: { path: "src/App.tsx", content: "export {};" }, ts },
  },
  {
    name: "file:delete",
    event: { type: "file:delete", payload: { path: "src/App.tsx" }, ts },
  },
  {
    name: "contract:deployed",
    event: { type: "contract:deployed", payload: { address: "mn_addr_test1qexample" }, ts },
  },
  {
    name: "artifacts:ready",
    event: {
      type: "artifacts:ready",
      payload: { urlPrefix: "https://artifacts.nyx.example/abc123/" },
      ts,
    },
  },
  {
    name: "turn:activity",
    event: {
      type: "turn:activity",
      payload: { turnId: "turn-1", agent: "supervisor", phase: "planning", detail: "cycle 1/3" },
      ts,
    },
  },
  {
    name: "turn:settled (negative balance allowed on overage)",
    event: {
      type: "turn:settled",
      payload: { turnId: "turn-1", consumed: "250", balance: "-50" },
      ts,
    },
  },
  {
    name: "session:takeover",
    event: { type: "session:takeover", payload: {}, ts },
  },
  {
    name: "turn:message",
    event: {
      type: "turn:message",
      payload: { turnId: "turn-1", role: "assistant", delta: "Sure — " },
      ts,
    },
  },
  {
    name: "verify:run",
    event: { type: "verify:run", payload: { turnId: "turn-1" }, ts },
  },
  {
    name: "deploy:status (optional detail omitted)",
    event: { type: "deploy:status", payload: { requestId: "req-1", phase: "proving" }, ts },
  },
  {
    name: "deploy:status (failed with detail)",
    event: {
      type: "deploy:status",
      payload: { requestId: "req-1", phase: "failed", detail: "proof rejected" },
      ts,
    },
  },
  {
    name: "ledger:update",
    event: {
      type: "ledger:update",
      payload: {
        entry: {
          id: "42",
          accountAddress: "mn_addr_test1qexample",
          kind: "deposit_credit",
          amount: "1000",
          ref: "dep-1",
        },
        available: "1000",
        reserved: "0",
      },
      ts,
    },
  },
];

const clientToServerFixtures: Fixture[] = [
  {
    name: "prompt:submit",
    event: {
      type: "prompt:submit",
      payload: { projectId: "proj-1", text: "Add a counter contract" },
      ts,
    },
  },
  {
    name: "test:results (green)",
    event: { type: "test:results", payload: { turnId: "turn-1", pass: true, failures: [] }, ts },
  },
  {
    name: "test:results (red with failures)",
    event: {
      type: "test:results",
      payload: {
        turnId: "turn-1",
        pass: false,
        failures: [{ name: "counter > increments", message: "expected 1, received 0" }],
      },
      ts,
    },
  },
  {
    name: "console:log",
    event: { type: "console:log", payload: { message: "vite ready in 312ms" }, ts },
  },
  {
    name: "console:error",
    event: { type: "console:error", payload: { message: "Uncaught TypeError" }, ts },
  },
  {
    name: "dev:status (booting with phase)",
    event: { type: "dev:status", payload: { state: "booting", phase: "install" }, ts },
  },
  {
    name: "dev:status (ready, optionals omitted)",
    event: { type: "dev:status", payload: { state: "ready" }, ts },
  },
  {
    name: "deploy:request",
    event: { type: "deploy:request", payload: {}, ts },
  },
  {
    name: "file:changed",
    event: {
      type: "file:changed",
      payload: { path: "src/App.tsx", content: "export {};" },
      ts,
    },
  },
];

describe("ServerToClientEventSchema", () => {
  it.each(serverToClientFixtures)("parses $name", ({ event }) => {
    const result = ServerToClientEventSchema.safeParse(event);
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const result = ServerToClientEventSchema.safeParse({
      type: "file:rename",
      payload: { path: "a", to: "b" },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload missing a required field", () => {
    const result = ServerToClientEventSchema.safeParse({
      type: "file:write",
      payload: { path: "src/App.tsx" },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects monetary amounts sent as JSON numbers", () => {
    const result = ServerToClientEventSchema.safeParse({
      type: "turn:settled",
      payload: { turnId: "turn-1", consumed: 250, balance: 750 },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a verify:run missing its turnId", () => {
    const result = ServerToClientEventSchema.safeParse({
      type: "verify:run",
      payload: {},
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid deploy:status phase", () => {
    const result = ServerToClientEventSchema.safeParse({
      type: "deploy:status",
      payload: { requestId: "req-1", phase: "finalized" },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric ts", () => {
    const result = ServerToClientEventSchema.safeParse({
      type: "session:takeover",
      payload: {},
      ts: "2026-07-10T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects client → server events (direction separation)", () => {
    for (const { event } of clientToServerFixtures) {
      expect(ServerToClientEventSchema.safeParse(event).success).toBe(false);
    }
  });
});

describe("ClientToServerEventSchema", () => {
  it.each(clientToServerFixtures)("parses $name", ({ event }) => {
    const result = ClientToServerEventSchema.safeParse(event);
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  it("rejects an empty prompt", () => {
    const result = ClientToServerEventSchema.safeParse({
      type: "prompt:submit",
      payload: { projectId: "proj-1", text: "" },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unstructured test failures", () => {
    const result = ClientToServerEventSchema.safeParse({
      type: "test:results",
      payload: { turnId: "turn-1", pass: false, failures: ["it broke"] },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid dev:status state", () => {
    const result = ClientToServerEventSchema.safeParse({
      type: "dev:status",
      payload: { state: "restarting" },
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects server → client events (direction separation)", () => {
    for (const { event } of serverToClientFixtures) {
      expect(ClientToServerEventSchema.safeParse(event).success).toBe(false);
    }
  });
});

describe("compile:run / compile:results (P2 browser compile)", () => {
  const turnId = "turn-1";

  it("accepts a server->client compile:run frame", () => {
    const parsed = parseServerToClientEvent({
      type: "compile:run",
      payload: { turnId, kind: "check" },
      ts: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects compile:run with an unknown kind", () => {
    const parsed = parseServerToClientEvent({
      type: "compile:run",
      payload: { turnId, kind: "half" },
      ts: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a failing check compile:results with diagnostics", () => {
    const parsed = parseClientToServerEvent({
      type: "compile:results",
      payload: {
        turnId,
        kind: "check",
        ok: false,
        diagnostics: [
          {
            severity: "error",
            source: "compactc",
            message: "undeclared identifier",
            file: "contract.compact",
            span: { start: { line: 3, column: 7 } },
          },
        ],
        compilerVersion: "0.31.1",
        durationMs: 812,
      },
      ts: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a green full compile:results carrying sourceHash + circuits", () => {
    const parsed = parseClientToServerEvent({
      type: "compile:results",
      payload: {
        turnId,
        kind: "full",
        ok: true,
        diagnostics: [],
        compilerVersion: "0.31.1",
        durationMs: 4021,
        sourceHash: "a".repeat(64),
        circuits: [{ name: "deposit", proof: true }],
      },
      ts: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a green full compile:results WITHOUT sourceHash", () => {
    const parsed = parseClientToServerEvent({
      type: "compile:results",
      payload: {
        turnId,
        kind: "full",
        ok: true,
        diagnostics: [],
        compilerVersion: "0.31.1",
        durationMs: 4021,
      },
      ts: 1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("parse helpers", () => {
  const promptSubmit: unknown = {
    type: "prompt:submit",
    payload: { projectId: "proj-1", text: "hello" },
    ts,
  };
  const fileWrite: unknown = {
    type: "file:write",
    payload: { path: "src/App.tsx", content: "export {};" },
    ts,
  };

  it("parseEvent routes by direction", () => {
    expect(parseEvent("client-to-server", promptSubmit).success).toBe(true);
    expect(parseEvent("server-to-client", promptSubmit).success).toBe(false);
    expect(parseEvent("server-to-client", fileWrite).success).toBe(true);
    expect(parseEvent("client-to-server", fileWrite).success).toBe(false);
  });

  it("parseEvent narrows to the direction's union type", () => {
    const result = parseEvent("client-to-server", promptSubmit);
    expect(result.success).toBe(true);
    if (result.success) {
      expectTypeOf(result.data).toEqualTypeOf<ClientToServerEvent>();
      expect(result.data.type).toBe("prompt:submit");
    }
  });

  it("direction-specific helpers agree with the schemas", () => {
    expect(parseServerToClientEvent(fileWrite).success).toBe(true);
    expect(parseClientToServerEvent(promptSubmit).success).toBe(true);
    expect(parseServerToClientEvent(null).success).toBe(false);
    expect(parseClientToServerEvent("not an event").success).toBe(false);
  });
});

describe("type inference round-trip", () => {
  it("a bigint-typed event encodes, serializes, and decodes back to bigints", () => {
    // The decode schema takes string money on the wire but yields `bigint` in code,
    // so a domain-typed event cannot be `.parse()`d directly — it must be encoded first.
    const event: TurnSettledEvent = {
      type: "turn:settled",
      payload: { turnId: TurnIdSchema.parse("turn-1"), consumed: 5n, balance: 10n },
      ts,
    };
    const parsed = TurnSettledEventSchema.parse(
      JSON.parse(JSON.stringify(encodeTurnSettledEvent(event))),
    );
    expectTypeOf(parsed).toEqualTypeOf<TurnSettledEvent>();
    expect(parsed.payload.consumed).toBe(5n);
    expect(parsed.payload.balance).toBe(10n);
  });

  it("individual event types are assignable to their direction's union only", () => {
    const promptSubmit: PromptSubmitEvent = {
      type: "prompt:submit",
      payload: { projectId: ProjectIdSchema.parse("proj-1"), text: "hello" },
      ts,
    };
    const asUnion: ClientToServerEvent = promptSubmit;
    expect(asUnion.type).toBe("prompt:submit");
    expectTypeOf<PromptSubmitEvent>().not.toEqualTypeOf<ServerToClientEvent>();
    expectTypeOf<ServerToClientEvent["type"]>().not.toEqualTypeOf<ClientToServerEvent["type"]>();
  });
});
