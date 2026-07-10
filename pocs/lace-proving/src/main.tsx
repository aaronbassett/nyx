import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { log } from "@/lib/logger";

// Surface uncaught errors and promise rejections in the on-page log too, so a
// failure inside the SDK's async internals is never invisible.
window.addEventListener("error", (e) => {
  log.error("window", `Uncaught error: ${e.message}`, e.error ?? e);
});
window.addEventListener("unhandledrejection", (e) => {
  log.error("window", "Unhandled promise rejection", e.reason);
});

// Default to dark; the SDK log console reads better dark.
document.documentElement.classList.add("dark");

log.info("app", "PoC booted. Build target: browser + Lace dapp connector.");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
