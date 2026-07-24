/**
 * Boot-ordering tests (P3 demo) — the `bootApp` helper extracted from `main.tsx`.
 *
 * The load-bearing guarantee (Opus-2 re-review): with the dev-wallet flag SET, the render is
 * DEFERRED until the dev-wallet install has settled — because wallet detection is a one-shot
 * synchronous snapshot at mount, a render that fired before the install would miss it. With the
 * flag UNSET, the dev-wallet chunk is never imported and the render is synchronous.
 */
import { describe, expect, it, vi } from "vitest";

import { bootApp } from "@/boot";

describe("bootApp — dev-wallet flag SET", () => {
  it("installs the dev wallet BEFORE it renders (defers past the install)", async () => {
    const order: string[] = [];
    const installDevWallet = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          // Resolve on a later microtask so a render that raced the install would be caught.
          queueMicrotask(() => {
            order.push("install");
            resolve(true);
          });
        }),
    );
    const render = vi.fn(() => {
      order.push("render");
    });

    await bootApp({ devWalletEnabled: true, installDevWallet, render });

    expect(installDevWallet).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["install", "render"]); // install strictly precedes render
  });

  it("still renders (and reports) when the dev-wallet chunk fails to load", async () => {
    const boom = new Error("chunk load failed");
    const installDevWallet = vi.fn(() => Promise.reject(boom));
    const render = vi.fn();
    const onError = vi.fn();

    // Must not reject — a failed install is swallowed into onError, never an unhandled rejection.
    await expect(
      bootApp({ devWalletEnabled: true, installDevWallet, render, onError }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(boom);
    expect(render).toHaveBeenCalledTimes(1); // the app still comes up, degraded
  });
});

describe("bootApp — dev-wallet flag UNSET", () => {
  it("renders synchronously and never imports the dev-wallet chunk", () => {
    const installDevWallet = vi.fn(() => Promise.resolve(false));
    const render = vi.fn();

    // No await: render must have happened synchronously by the time bootApp returns.
    void bootApp({ devWalletEnabled: false, installDevWallet, render });

    expect(render).toHaveBeenCalledTimes(1);
    expect(installDevWallet).not.toHaveBeenCalled(); // the ~10 MB chunk is never loaded in prod
  });
});
