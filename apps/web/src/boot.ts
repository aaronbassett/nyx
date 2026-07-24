/**
 * Boot ordering (P3 demo) — sequences the optional dev-wallet install ahead of the first React
 * render, extracted from `main.tsx` so the ordering is unit-testable without a DOM/render harness.
 *
 * WHY DEFER (Opus-2 re-review — demo-breaking regression the prior fix introduced): the dev wallet
 * is discovered by a ONE-SHOT synchronous snapshot at mount (`useWalletConnect` → `detectProbe`
 * reads `window.midnight` once, no polling). A `void import(...).then(install)` that RACES the
 * render resolves the ~10 MB `ledger-v8` chunk AFTER first mount, so the dev wallet is missing on
 * the first (and only) detection pass — P5 auto-detect silently breaks. So when the flag is set we
 * DEFER the render until the dev-wallet chunk has imported AND installed; production (flag off)
 * renders SYNCHRONOUSLY and never touches the chunk.
 *
 * A failed chunk load must never become an unhandled rejection: it is reported to `onError` and the
 * app still renders (degraded — no dev wallet — but alive).
 */

/** Injectable seams for {@link bootApp} (keeps it DOM- and import-free for tests). */
export interface BootDeps {
  /** Whether the env opted the dev wallet in (`VITE_DEV_WALLET === "1"`). */
  readonly devWalletEnabled: boolean;
  /**
   * Dynamically import + install the dev wallet. Called ONLY when {@link devWalletEnabled} is true,
   * so the heavy `ledger-v8` chunk it pulls in is never loaded in a production build. Its resolved
   * value is discarded — the install's side effect (the `window.midnight` entry) is what matters.
   */
  readonly installDevWallet: () => Promise<unknown>;
  /** Render the React tree. Called exactly once, AFTER any dev-wallet install settles. */
  readonly render: () => void;
  /** Reports a dev-wallet chunk-load / install failure. The app still renders. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Boot the app: install the dev wallet FIRST (when enabled) so the one-shot mount-time detection
 * snapshot sees it, then render. When the dev wallet is disabled, render synchronously and never
 * import the chunk. Always resolves once the render has been invoked.
 */
export function bootApp(deps: BootDeps): Promise<void> {
  if (!deps.devWalletEnabled) {
    // Production path: render synchronously; the dev-wallet chunk is never imported.
    deps.render();
    return Promise.resolve();
  }
  return deps
    .installDevWallet()
    .then(() => undefined)
    .catch((error: unknown) => {
      // A failed chunk load / install must not be an unhandled rejection — log and still render.
      (deps.onError ?? (() => undefined))(error);
    })
    .finally(deps.render);
}
