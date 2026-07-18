/**
 * US12 — BalanceCard (FR-070, scenario 1 / D34).
 *
 * Available and reserved render distinctly and verbatim; a negative available
 * balance switches to the "prompts blocked" panel with a top-up CTA.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BalanceCard } from "@/ledger/BalanceCard";

afterEach(cleanup);

describe("BalanceCard", () => {
  it("renders available and reserved distinctly and verbatim (FR-070)", () => {
    render(<BalanceCard available={12345n} reserved={678n} />);
    expect(screen.getByTestId("ledger-available").textContent).toBe("12,345 NYXT");
    expect(screen.getByTestId("ledger-reserved").textContent).toBe("678 NYXT");
    expect(screen.queryByTestId("ledger-blocked")).toBeNull();
  });

  it("shows a prompts-blocked panel and top-up CTA when available is negative (D34)", () => {
    const onTopUp = vi.fn();
    render(<BalanceCard available={-50n} reserved={0n} onTopUp={onTopUp} />);

    expect(screen.getByTestId("ledger-blocked")).not.toBeNull();
    expect(screen.getByTestId("ledger-available").textContent).toBe("-50 NYXT");

    fireEvent.click(screen.getByTestId("ledger-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("offers a plain top-up button when the balance is healthy", () => {
    const onTopUp = vi.fn();
    render(<BalanceCard available={1000n} reserved={0n} onTopUp={onTopUp} />);
    expect(screen.queryByTestId("ledger-blocked")).toBeNull();
    fireEvent.click(screen.getByTestId("ledger-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("renders a placeholder before any balance is known", () => {
    render(<BalanceCard available={undefined} reserved={undefined} />);
    expect(screen.getByTestId("ledger-available").textContent).toBe("—");
  });

  it("shows the last-turn consumption when known, verbatim (FR-072)", () => {
    render(<BalanceCard available={1000n} reserved={0n} lastConsumed={42n} />);
    expect(screen.getByTestId("ledger-last-consumed").textContent).toContain("42 NYXT");
  });

  it("omits the last-consumed line when none is known", () => {
    render(<BalanceCard available={1000n} reserved={0n} />);
    expect(screen.queryByTestId("ledger-last-consumed")).toBeNull();
  });
});
