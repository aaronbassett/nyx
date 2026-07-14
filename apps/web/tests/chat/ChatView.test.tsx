/**
 * T143 — chat presentational surface (US1, D20).
 *
 * These are pure views over a {@link TurnState}: the message list, the
 * collapsible per-sub-agent activity feed with verify-cycle counts, the
 * persistent tab-alive indicator (D20/FR-006), the input (locked per D24), and
 * the display-only balance (FR-070). All side effects arrive as callbacks, so
 * the views render deterministically off props with no bridge and no hook.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ActivityFeed } from "@/chat/ActivityFeed";
import { BalanceDisplay } from "@/chat/BalanceDisplay";
import { ChatView } from "@/chat/ChatView";
import { PromptInput } from "@/chat/PromptInput";
import { initialTurnState } from "@/chat/turn-state";
import type { AgentActivityGroup, BalanceView, DisplayMessage, TurnState } from "@/chat/types";
import type { TurnId } from "@nyx/protocol";

afterEach(cleanup);

const TURN = "turn-1" as TurnId;

function makeMessage(
  overrides: Partial<DisplayMessage> & Pick<DisplayMessage, "id" | "kind">,
): DisplayMessage {
  return {
    content: "",
    turnId: undefined,
    streaming: false,
    ts: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<TurnState> = {}): TurnState {
  return { ...initialTurnState, ...overrides };
}

const noop = (): void => {
  /* no-op */
};

// --- tab-alive indicator (D20 / FR-006) -------------------------------------

describe("ChatView — tab-alive indicator (FR-006)", () => {
  it("always renders the persistent tab-alive indicator at idle", () => {
    render(<ChatView state={makeState()} onSubmit={noop} />);
    expect(screen.getByTestId("chat-tab-alive")).not.toBeNull();
  });

  it("keeps the tab-alive indicator present during an active turn", () => {
    render(
      <ChatView state={makeState({ phase: "active", inputDisabled: true })} onSubmit={noop} />,
    );
    expect(screen.getByTestId("chat-tab-alive")).not.toBeNull();
  });
});

// --- message list -----------------------------------------------------------

describe("ChatView — message list", () => {
  it("renders user, assistant and supervisor messages with role-specific test ids", () => {
    const state = makeState({
      messages: [
        makeMessage({ id: "u1", kind: "user", content: "build it" }),
        makeMessage({
          id: "a1",
          kind: "assistant",
          content: "on it",
          turnId: TURN,
          streaming: true,
        }),
        makeMessage({ id: "s1", kind: "supervisor", content: "planning", turnId: TURN }),
      ],
    });
    render(<ChatView state={state} onSubmit={noop} />);
    expect(screen.getByTestId("chat-message-user").textContent).toContain("build it");
    expect(screen.getByTestId("chat-message-assistant").textContent).toContain("on it");
    expect(screen.getByTestId("chat-message-supervisor").textContent).toContain("planning");
  });

  it("renders a decline message distinctly (not an error)", () => {
    const state = makeState({
      messages: [
        makeMessage({ id: "d1", kind: "decline", content: "Nyx builds DApps.", turnId: TURN }),
      ],
      lastOutcome: "declined",
    });
    render(<ChatView state={state} onSubmit={noop} />);
    expect(screen.getByTestId("chat-message-decline").textContent).toContain("Nyx builds DApps.");
    // The decline is never surfaced as a failure.
    expect(screen.queryByTestId("chat-message-error")).toBeNull();
  });

  it("renders the interrupted-turn recovery notice when present", () => {
    const state = makeState({
      recovery: {
        lostPromptContent: "add tests",
        message: "That turn's result was lost. Re-send to continue.",
      },
    });
    render(<ChatView state={state} onSubmit={noop} />);
    expect(screen.getByTestId("chat-recovery").textContent).toContain("Re-send");
  });
});

// --- activity feed (D20) ----------------------------------------------------

describe("ActivityFeed — collapsible per-sub-agent feed (D20)", () => {
  const groups: AgentActivityGroup[] = [
    { agent: "scaffolding", entries: [{ phase: "init", detail: "package.json", ts: 1 }] },
    { agent: "review", entries: [{ phase: "verdict", detail: "green", ts: 2 }] },
  ];

  it("renders one group per sub-agent with its phase/detail", () => {
    render(<ActivityFeed groups={groups} cyclesCompleted={1} />);
    expect(screen.getByTestId("chat-activity-group-scaffolding")).not.toBeNull();
    expect(screen.getByTestId("chat-activity-group-review").textContent).toContain("green");
  });

  it("shows the verify-cycle count", () => {
    render(<ActivityFeed groups={groups} cyclesCompleted={3} />);
    expect(screen.getByTestId("chat-activity-cycles").textContent).toContain("3");
  });

  it("collapses and expands the feed on toggle", () => {
    render(<ActivityFeed groups={groups} cyclesCompleted={1} />);
    expect(screen.getByTestId("chat-activity-content")).not.toBeNull();
    fireEvent.click(screen.getByTestId("chat-activity-toggle"));
    expect(screen.queryByTestId("chat-activity-content")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-activity-toggle"));
    expect(screen.getByTestId("chat-activity-content")).not.toBeNull();
  });

  it("renders nothing when there is no activity", () => {
    const { container } = render(<ActivityFeed groups={[]} cyclesCompleted={0} />);
    expect(container.firstChild).toBeNull();
  });
});

// --- prompt input (D24) -----------------------------------------------------

describe("PromptInput — input lock (D24)", () => {
  it("submits trimmed text and clears the field", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={false} onSubmit={onSubmit} />);
    const input = screen.getByTestId<HTMLTextAreaElement>("chat-input");
    fireEvent.change(input, { target: { value: "  build a counter  " } });
    fireEvent.submit(screen.getByTestId("chat-form"));
    expect(onSubmit).toHaveBeenCalledWith("build a counter");
    expect(input.value).toBe("");
  });

  it("disables the field and never submits while a turn is active", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled onSubmit={onSubmit} />);
    const input = screen.getByTestId<HTMLTextAreaElement>("chat-input");
    expect(input.disabled).toBe(true);
    fireEvent.submit(screen.getByTestId("chat-form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit empty/whitespace text", () => {
    const onSubmit = vi.fn();
    render(<PromptInput disabled={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "   " } });
    fireEvent.submit(screen.getByTestId("chat-form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// --- balance display (FR-070) -----------------------------------------------

describe("BalanceDisplay — display-only balances (FR-070)", () => {
  it("renders the server-provided bigint balances verbatim as strings", () => {
    const balance: BalanceView = { available: 70n, reserved: 30n, lastConsumed: 12n };
    render(<BalanceDisplay balance={balance} />);
    expect(screen.getByTestId("chat-balance-available").textContent).toBe("70");
    expect(screen.getByTestId("chat-balance-reserved").textContent).toBe("30");
    // Never a client-computed figure such as available - reserved.
    expect(screen.getByTestId("chat-balance").textContent).not.toContain("40");
  });

  it("renders nothing before any balance has arrived", () => {
    const { container } = render(<BalanceDisplay balance={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
