/**
 * WebContainer "connect bridge" page, served at /webcontainer/connect/<id>.
 *
 * When the preview URL is opened as a top-level tab, the tab has no
 * MessagePort to the container (that plumbing normally flows through a
 * preview iframe embedded in the host page). The preview tab's bootstrap
 * page automatically window.open()s THIS page on the host origin;
 * setupConnect() then relays MessagePorts between the preview tab
 * (window.opener) and a hidden StackBlitz iframe that can reach the
 * container. Once connected, the runtime tells this popup to close itself.
 *
 * CRITICAL: this route must be served WITHOUT cross-origin isolation
 * (COOP/COEP: unsafe-none). COOP: same-origin would sever window.opener and
 * setupConnect() would throw "This page must have an opener".
 * See stackblitz/webcontainer-core#1725.
 */

import { setupConnect } from '@webcontainer/api/connect';

const msg = document.getElementById('msg')!;

function tellServer(text: string, level = 'info'): void {
  try {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          ts: new Date().toISOString(),
          origin: location.origin,
          source: 'connect-bridge',
          kind: 'log',
          data: { text, level },
        }),
      );
      setTimeout(() => ws.close(), 250);
    });
  } catch {
    /* logging only */
  }
}

try {
  setupConnect();
  msg.textContent = 'Connect bridge active — relaying preview tab to the WebContainer. This tab closes itself when done.';
  tellServer(`connect bridge active at ${location.pathname} (opener present: ${String(!!window.opener)})`);
} catch (err) {
  const text = err instanceof Error ? err.message : String(err);
  msg.textContent = `Connect bridge FAILED: ${text}`;
  tellServer(`connect bridge FAILED at ${location.pathname}: ${text}`, 'error');
}
