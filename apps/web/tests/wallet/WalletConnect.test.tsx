/**
 * T034 — container smoke test: with no wallet injected, the connect surface
 * resolves to the no-extension state on first paint (no network, no async).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { WalletConnect } from "@/wallet/WalletConnect";

afterEach(cleanup);

describe("WalletConnect container", () => {
  it("renders the no-extension state when window.midnight is absent", () => {
    render(<WalletConnect />);
    expect(screen.getByTestId("wallet-state-no-extension")).not.toBeNull();
  });
});
