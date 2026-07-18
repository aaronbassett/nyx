/**
 * US12 — LowBalanceNudge (FR-073).
 *
 * The banner renders only when `visible`; dismiss and top-up forward their
 * intents. The "once per session" latch is the reducer's job (see state.test);
 * this component is a pure reflection of the `visible` flag.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { LowBalanceNudge } from "@/ledger/LowBalanceNudge";

afterEach(cleanup);

describe("LowBalanceNudge", () => {
  it("renders nothing when not visible", () => {
    render(<LowBalanceNudge visible={false} threshold={100n} onDismiss={() => undefined} />);
    expect(screen.queryByTestId("ledger-nudge")).toBeNull();
  });

  it("shows the threshold and forwards dismiss + top-up when visible", () => {
    const onDismiss = vi.fn();
    const onTopUp = vi.fn();
    render(<LowBalanceNudge visible threshold={1000n} onDismiss={onDismiss} onTopUp={onTopUp} />);
    expect(screen.getByTestId("ledger-nudge").textContent).toContain("1,000 NYXT");

    fireEvent.click(screen.getByTestId("ledger-nudge-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("ledger-nudge-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
