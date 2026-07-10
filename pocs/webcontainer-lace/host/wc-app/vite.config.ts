import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { appendFile } from 'node:fs/promises';

/**
 * Relay endpoint for the DApp when direct browser->localhost transports are
 * blocked/rewritten by the preview service worker. The DApp POSTs its report
 * envelope to /__nyx-report (same-origin, so nothing rewrites it); we append
 * it to nyx-reports.ndjson in the project root. The HOST page (which owns
 * this WebContainer) watches that file via webcontainer.fs.watch and relays
 * every new line to the Rust server over its own WebSocket.
 */
function nyxReportRelay(): Plugin {
  return {
    name: 'nyx-report-relay',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__nyx-report', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          void (async () => {
            try {
              await appendFile('nyx-reports.ndjson', body.replace(/\n/g, ' ') + '\n', 'utf8');
              res.statusCode = 200;
              res.setHeader('content-type', 'application/json');
              res.end('{"ok":true}');
            } catch (err) {
              res.statusCode = 500;
              res.end(String(err));
            }
          })();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), nyxReportRelay()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Inside the WebContainer; the container maps this to a preview URL.
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      // The report relay appends to this file on every DApp report; without
      // this ignore, Vite full-page-reloads the DApp on each append, and the
      // on-load report of the reloaded page loops it forever.
      ignored: ['**/nyx-reports.ndjson'],
    },
  },
});
