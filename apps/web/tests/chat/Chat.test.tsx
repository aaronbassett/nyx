/**
 * T143/T144 — Chat container integration (US1, D20/D23/D24/D25).
 *
 * Drives the real {@link Chat} container against an in-memory {@link ChatBridge}
 * fake (no socket) and a faked history seam (no network). Asserts the full turn
 * lifecycle end-to-end: submit → `prompt:submit` sent + input locked → streamed
 * narration renders → `turn:settled` unlocks; a supervisor decline surfaces the
 * decline state and returns to idle; interrupted history rehydrates a recovery
 * notice; and the tab-alive indicator is always present.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Chat } from "@/chat/Chat";
import type { ChatBridge, Clock, DeclinePredicate } from "@/chat/types";
import type {
  ChatMessage,
  ClientToServerEvent,
  ProjectId,
  ServerToClientEvent,
  TurnId,
} from "@nyx/protocol";

afterEach(cleanup);

const TURN = "turn-1" as TurnId;
const PROJECT = "proj-1" as ProjectId;
const clock: Clock = { now: () => 42 };

type AnyServerHandler = (event: ServerToClientEvent) => void;

interface FakeBridge {
  readonly bridge: ChatBridge;
  readonly sent: ClientToServerEvent[];
  emit(event: ServerToClientEvent): void;
}

function createFakeBridge(): FakeBridge {
  const handlers = new Map<string, Set<AnyServerHandler>>();
  const sent: ClientToServerEvent[] = [];
  const bridge: ChatBridge = {
    send: (event) => {
      sent.push(event);
    },
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set<AnyServerHandler>();
      set.add(handler as AnyServerHandler);
      handlers.set(type, set);
      return () => {
        set.delete(handler as AnyServerHandler);
      };
    },
  };
  function emit(event: ServerToClientEvent): void {
    for (const handler of handlers.get(event.type) ?? []) {
      handler(event);
    }
  }
  return { bridge, sent, emit };
}

const emptyHistory: () => Promise<ChatMessage[]> = () => Promise.resolve([]);

async function renderChat(
  fake: FakeBridge,
  opts: { loadHistory?: () => Promise<ChatMessage[]>; isDecline?: DeclinePredicate } = {},
): Promise<void> {
  render(
    <Chat
      bridge={fake.bridge}
      projectId={PROJECT}
      loadHistory={opts.loadHistory ?? emptyHistory}
      clock={clock}
      isDecline={opts.isDecline}
    />,
  );
  await waitFor(() => {
    expect(screen.getByTestId("chat-tab-alive")).not.toBeNull();
  });
}

describe("Chat container — turn lifecycle", () => {
  it("submits prompt:submit, locks input, streams narration, and unlocks on settle", async () => {
    const fake = createFakeBridge();
    await renderChat(fake);

    const input = screen.getByTestId<HTMLTextAreaElement>("chat-input");
    fireEvent.change(input, { target: { value: "build a counter DApp" } });
    fireEvent.submit(screen.getByTestId("chat-form"));

    // prompt:submit went out over the bridge (D62 entry point).
    expect(fake.sent).toEqual([
      {
        type: "prompt:submit",
        payload: { projectId: PROJECT, text: "build a counter DApp" },
        ts: 42,
      },
    ]);
    // Input is locked while the turn is active (D24).
    expect(screen.getByTestId<HTMLTextAreaElement>("chat-input").disabled).toBe(true);

    // Streamed assistant deltas accumulate into one growing message (D20).
    act(() => {
      fake.emit({
        type: "turn:message",
        payload: { turnId: TURN, role: "assistant", delta: "Scaffolding " },
        ts: 2,
      });
    });
    act(() => {
      fake.emit({
        type: "turn:message",
        payload: { turnId: TURN, role: "assistant", delta: "the project…" },
        ts: 3,
      });
    });
    expect(screen.getByTestId("chat-message-assistant").textContent).toContain(
      "Scaffolding the project…",
    );

    // turn:settled unlocks the input (D24) and surfaces the balance (FR-070/FR-071).
    act(() => {
      fake.emit({
        type: "turn:settled",
        payload: { turnId: TURN, consumed: 5n, balance: 95n },
        ts: 4,
      });
    });
    expect(screen.getByTestId<HTMLTextAreaElement>("chat-input").disabled).toBe(false);
    expect(screen.getByTestId("chat-balance-available").textContent).toBe("95");
  });

  it("renders per-sub-agent activity with a verify-cycle count (D20)", async () => {
    const fake = createFakeBridge();
    await renderChat(fake);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "go" } });
    fireEvent.submit(screen.getByTestId("chat-form"));

    act(() => {
      fake.emit({
        type: "turn:activity",
        payload: { turnId: TURN, agent: "implementation", phase: "write", detail: "src/App.tsx" },
        ts: 2,
      });
    });
    act(() => {
      fake.emit({
        type: "turn:activity",
        payload: { turnId: TURN, agent: "review", phase: "verdict", detail: "green" },
        ts: 3,
      });
    });

    expect(screen.getByTestId("chat-activity-group-implementation")).not.toBeNull();
    expect(screen.getByTestId("chat-activity-cycles").textContent).toContain("1");
  });

  it("surfaces a supervisor decline as a distinct state and returns to idle (D25)", async () => {
    const fake = createFakeBridge();
    const isDecline: DeclinePredicate = (payload) => payload.role === "supervisor";
    await renderChat(fake, { isDecline });

    fireEvent.change(screen.getByTestId("chat-input"), {
      target: { value: "what's the weather?" },
    });
    fireEvent.submit(screen.getByTestId("chat-form"));
    expect(screen.getByTestId<HTMLTextAreaElement>("chat-input").disabled).toBe(true);

    act(() => {
      fake.emit({
        type: "turn:message",
        payload: {
          turnId: TURN,
          role: "supervisor",
          delta: "Nyx builds Midnight DApps from prompts.",
        },
        ts: 2,
      });
    });

    expect(screen.getByTestId("chat-message-decline").textContent).toContain(
      "Nyx builds Midnight DApps",
    );
    // Returns to idle with input re-enabled — a decline is not a failure (D25).
    expect(screen.getByTestId<HTMLTextAreaElement>("chat-input").disabled).toBe(false);
  });

  it("rehydrates history and shows the interrupted-turn recovery notice (D20/D23)", async () => {
    const fake = createFakeBridge();
    const loadHistory = vi.fn((): Promise<ChatMessage[]> =>
      Promise.resolve([
        { seq: 0, role: "user", content: "build it", createdAt: 0 },
        { seq: 1, role: "assistant", content: "done", createdAt: 1 },
        { seq: 2, role: "user", content: "now add a test", createdAt: 2 },
      ]),
    );
    render(
      <Chat bridge={fake.bridge} projectId={PROJECT} loadHistory={loadHistory} clock={clock} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("chat-recovery")).not.toBeNull();
    });
    expect(loadHistory).toHaveBeenCalledWith(PROJECT);
    expect(screen.getByTestId("chat-recovery").textContent).toContain("now add a test");
    // Input stays enabled so the lost turn can be re-sent.
    expect(screen.getByTestId<HTMLTextAreaElement>("chat-input").disabled).toBe(false);
  });
});
