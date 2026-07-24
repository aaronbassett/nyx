import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import "./index.css";

// Demo-only (P5): install the env-gated dev wallet BEFORE the first render so the existing
// detection/connect/SIWE stack discovers it. Gated behind a DYNAMIC import (Opus-1) so the
// dev wallet — and its heavy `ledger-v8` (~10 MB, sync wasm init) transitive dep — splits into
// a demo-only chunk that a production build (flag off) never loads. A no-op unless
// `VITE_DEV_WALLET === "1"` with a seed — production never ships a phantom wallet.
// Defensive `import.meta.env` read (the web tsconfig omits vite/client types; mirrors
// `dev-wallet.ts` / `config.ts`).
const bootEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
if (bootEnv.VITE_DEV_WALLET === "1") {
  void import("@/wallet/dev-wallet").then((m) => m.maybeInstallDevWallet());
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Nyx: missing #root element in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
