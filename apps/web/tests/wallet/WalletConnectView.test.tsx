/**
 * T034 — presentational surface for the four FR-037 states plus EC-23 / EC-26.
 * The view is pure over a ConnectState, so each state renders deterministic,
 * state-specific guidance (never a generic failure) and wires its actions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ConnectState } from "@/wallet/types";
import { WalletConnectView } from "@/wallet/WalletConnectView";

import { makeWallet } from "./fixtures";

afterEach(cleanup);

const noop = (): void => {
  /* no-op */
};

interface Handlers {
  onConnect: () => void;
  onSelectWallet: (wallet: ReturnType<typeof makeWallet>) => void;
  onRetry: () => void;
}

function renderState(state: ConnectState, handlers: Partial<Handlers> = {}): void {
  render(
    <WalletConnectView
      state={state}
      isConnecting={false}
      onConnect={handlers.onConnect ?? noop}
      onSelectWallet={handlers.onSelectWallet ?? noop}
      onRetry={handlers.onRetry ?? noop}
    />,
  );
}

describe("WalletConnectView — FR-037 state UI", () => {
  it("renders an install prompt for no-extension", () => {
    renderState({ kind: "no-extension" });
    expect(screen.getByTestId("wallet-state-no-extension")).not.toBeNull();
  });

  it("names the connector-v4 requirement for unsupported-wallet (EC-23)", () => {
    renderState({ kind: "unsupported-wallet", wallets: [makeWallet({ generation: "legacy" })] });
    expect(screen.getByTestId("wallet-state-unsupported-wallet").textContent).toMatch(/v4/i);
  });

  it("offers a Connect action for not-authorized and fires onConnect", () => {
    const onConnect = vi.fn();
    renderState({ kind: "not-authorized", wallet: makeWallet() }, { onConnect });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("renders a Lace-first picker for needs-selection and fires onSelectWallet (EC-26)", () => {
    const onSelectWallet = vi.fn();
    const lace = makeWallet({ key: "a", name: "Lace", rdns: "io.lace.wallet" });
    const other = makeWallet({ key: "b", name: "Other", rdns: "com.other.wallet" });
    renderState({ kind: "needs-selection", wallets: [other, lace] }, { onSelectWallet });
    const options = screen.getAllByTestId("wallet-picker-option");
    expect(options[0]?.textContent).toMatch(/Lace/);
    fireEvent.click(screen.getByRole("button", { name: /Lace/i }));
    expect(onSelectWallet).toHaveBeenCalledOnce();
  });

  it("shows wallet-side guidance for authorized-but-unavailable (R8)", () => {
    renderState({ kind: "authorized-but-unavailable", wallet: makeWallet() });
    expect(screen.getByTestId("wallet-state-authorized-but-unavailable")).not.toBeNull();
  });

  it("shows the expected and actual network for wrong-network", () => {
    renderState({
      kind: "wrong-network",
      wallet: makeWallet(),
      expectedNetworkId: "preprod",
      actualNetworkId: "testnet",
    });
    const el = screen.getByTestId("wallet-state-wrong-network");
    expect(el.textContent).toMatch(/preprod/);
    expect(el.textContent).toMatch(/testnet/);
  });

  it("shows the connected state with its address (T039 seam)", () => {
    renderState({
      kind: "connected",
      wallet: makeWallet(),
      networkId: "preprod",
      unshieldedAddress: "mn_addr_longaddress",
    });
    expect(screen.getByTestId("wallet-state-connected")).not.toBeNull();
  });
});
