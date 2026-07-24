import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { maybeInstallDevWallet } from "@/wallet/dev-wallet";
import "./index.css";

// Demo-only (P5): install the env-gated dev wallet BEFORE the first render so the
// existing detection/connect/SIWE stack discovers it. A no-op unless
// `VITE_DEV_WALLET === "1"` with a seed — production never sees a phantom wallet.
maybeInstallDevWallet();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Nyx: missing #root element in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
