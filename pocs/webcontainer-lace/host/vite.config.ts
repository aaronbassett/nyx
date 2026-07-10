import { defineConfig } from 'vite';

// COOP/COEP here only matter for `pnpm dev` (debugging the host page without
// the Rust server). In the real flow the Rust server serves ./dist and sets
// these headers itself.
const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'index.html',
        connect: 'connect.html',
      },
    },
  },
});
