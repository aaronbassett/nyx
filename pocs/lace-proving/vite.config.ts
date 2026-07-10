import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";

// The Midnight SDK is WASM-backed (ledger-v8, onchain-runtime-v3) and assumes a
// few Node globals (Buffer, process). vite-plugin-wasm + top-level-await load
// the WASM; vite-plugin-node-polyfills supplies Buffer/process/global.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({ include: ["buffer", "process", "util", "stream", "events"], globals: { Buffer: true, global: true, process: true } }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    // Only the raw-WASM packages must stay out of esbuild pre-bundling
    // (vite-plugin-wasm handles their .wasm imports at runtime).
    exclude: ["@midnight-ntwrk/ledger-v8", "@midnight-ntwrk/onchain-runtime-v3"],
    // Pre-bundle compact-runtime so esbuild resolves its `import inspect from
    // 'object-inspect'` (a CJS default import) with proper interop. If served
    // raw it fails in the browser with "does not provide an export named
    // 'default'". (onchain-runtime-v3 is a direct dep so this optimized chunk's
    // external import of it resolves.)
    include: ["@midnight-ntwrk/compact-runtime"],
  },
  server: {
    port: 5173,
    fs: { allow: [".."] },
  },
});
