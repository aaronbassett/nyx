import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { App } from "@/App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App cross-origin isolation gate", () => {
  it("renders the shell when crossOriginIsolated is true", () => {
    vi.stubGlobal("crossOriginIsolated", true);

    render(<App />);

    expect(screen.queryByTestId("app-shell")).not.toBeNull();
    expect(screen.queryByTestId("isolation-gate")).toBeNull();
  });

  it("renders the hard gate and not the shell when crossOriginIsolated is false", () => {
    vi.stubGlobal("crossOriginIsolated", false);

    render(<App />);

    expect(screen.queryByTestId("isolation-gate")).not.toBeNull();
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });
});
