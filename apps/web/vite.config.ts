import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { isolationHeadersFor } from "./src/lib/isolation-headers";

/**
 * Vite plugin that stamps the FR-021 / R6 cross-origin isolation headers onto
 * every response, honouring the `/webcontainer/connect/*` carve-out. The same
 * middleware is applied to BOTH the dev server and the preview server so
 * `pnpm dev` and `pnpm preview` behave identically — WebContainers need the
 * strict COOP/COEP pair everywhere except the escape-hatch bridge route.
 */
function crossOriginIsolationHeaders(): Plugin {
  const applyHeaders: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "/";
    const pathname = url.split("?", 1)[0] ?? "/";
    const headers = isolationHeadersFor(pathname);
    res.setHeader("Cross-Origin-Embedder-Policy", headers["Cross-Origin-Embedder-Policy"]);
    res.setHeader("Cross-Origin-Opener-Policy", headers["Cross-Origin-Opener-Policy"]);
    next();
  };

  return {
    name: "nyx:cross-origin-isolation-headers",
    configureServer(server) {
      server.middlewares.use(applyHeaders);
    },
    configurePreviewServer(server) {
      server.middlewares.use(applyHeaders);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), crossOriginIsolationHeaders()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
  },
});
