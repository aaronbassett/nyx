import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { bootApp } from "@/boot";
import "./index.css";

// Demo-only (P5): the env-gated dev wallet is installed BEFORE the first render so the existing
// detection/connect/SIWE stack — a ONE-SHOT synchronous snapshot at mount — discovers it. It lives
// behind a DYNAMIC import (Opus-1) so the dev wallet and its heavy `ledger-v8` (~10 MB, sync wasm
// init) transitive dep split into a demo-only chunk a production build (flag off) never loads.
// Because detection does not poll, we must DEFER the render until that chunk imports + installs
// (Opus-2: a `.then()` that raced the render missed the one-shot snapshot). Production (flag off)
// renders synchronously and never touches the chunk. Defensive `import.meta.env` read (the web
// tsconfig omits vite/client types; mirrors `dev-wallet.ts` / `config.ts`).
const bootEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function renderApp(): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Nyx: missing #root element in index.html");
  }
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootApp({
  devWalletEnabled: bootEnv.VITE_DEV_WALLET === "1",
  installDevWallet: () => import("@/wallet/dev-wallet").then((m) => m.maybeInstallDevWallet()),
  render: renderApp,
  onError: (error: unknown) => {
    // A failed dev-wallet chunk load must not wedge the demo — warn and render without it.
    console.warn("Nyx: dev-wallet install failed; continuing without it", error);
  },
});
