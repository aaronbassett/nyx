/**
 * Reports findings from the DApp (running on the WebContainer preview origin)
 * back to the Rust server on localhost.
 *
 * IMPORTANT PoC FINDING: the WebContainer preview's service worker REWRITES
 * requests to `localhost:<port>` (and possibly `127.0.0.1:<port>`) into
 * container-port preview URLs — inside the preview, "localhost" means the
 * container, not your machine. So the "obvious" direct
 * `ws://localhost:<port>` path may be hijacked. We therefore try, in order:
 *
 *  1. WebSocket to ws://127.0.0.1:<port>/ws
 *  2. WebSocket to ws://localhost:<port>/ws
 *  3. HTTP POST to http://127.0.0.1:<port>/report (CORS-open)
 *  4. HTTP POST to http://localhost:<port>/report
 *  5. Same-origin POST /__nyx-report — a Vite middleware inside the container
 *     appends it to nyx-reports.ndjson; the HOST page watches that file via
 *     webcontainer.fs.watch and relays to the server ("container-fs relay").
 *  6. postMessage to window.opener (expected unavailable: the host page's
 *     COOP: same-origin severs the opener chain).
 *
 * Whichever path works first is reported so the terminal shows it.
 *
 * `__HOST_PORT__` is replaced with the real port by the host page when it
 * mounts this file into the WebContainer.
 */

const HOST_PORT = '__HOST_PORT__';

export type Transport =
  | 'websocket(127.0.0.1)'
  | 'websocket(localhost)'
  | 'http-post(127.0.0.1)'
  | 'http-post(localhost)'
  | 'container-fs-relay'
  | 'postMessage'
  | 'none';

let openSocket: WebSocket | null = null;
let openSocketTransport: Transport | null = null;

function tryWebSocket(url: string, timeoutMs = 2500): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function tryPost(url: string, payload: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function envelope(kind: string, data: unknown): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    origin: location.origin,
    source: 'dapp',
    kind,
    data,
  });
}

async function ensureSocket(): Promise<void> {
  if (openSocket && openSocket.readyState === WebSocket.OPEN) return;
  openSocket = null;
  openSocketTransport = null;
  const candidates: Array<[Transport, string]> = [
    ['websocket(127.0.0.1)', 'ws://127.0.0.1:' + HOST_PORT + '/ws'],
    ['websocket(localhost)', 'ws://localhost:' + HOST_PORT + '/ws'],
  ];
  for (const [transport, url] of candidates) {
    const ws = await tryWebSocket(url);
    if (ws) {
      openSocket = ws;
      openSocketTransport = transport;
      ws.addEventListener('close', () => {
        openSocket = null;
        openSocketTransport = null;
      });
      return;
    }
  }
}

/**
 * Send a message to the Rust server, trying each transport in order.
 * Returns which transport worked.
 */
export async function report(kind: string, data: unknown): Promise<Transport> {
  const payload = envelope(kind, data);

  // 1-2. Direct WebSocket.
  await ensureSocket();
  if (openSocket && openSocketTransport) {
    try {
      openSocket.send(payload);
      return openSocketTransport;
    } catch {
      /* fall through */
    }
  }

  // 3-4. Direct HTTP POST (CORS).
  if (await tryPost('http://127.0.0.1:' + HOST_PORT + '/report', payload)) {
    return 'http-post(127.0.0.1)';
  }
  if (await tryPost('http://localhost:' + HOST_PORT + '/report', payload)) {
    return 'http-post(localhost)';
  }

  // 5. Same-origin POST to the Vite middleware inside the container; the host
  //    page watches the file it writes and relays to the server.
  if (await tryPost('/__nyx-report', payload, 5000)) {
    return 'container-fs-relay';
  }

  // 6. postMessage to opener (expected unavailable: COOP severs it).
  if (window.opener) {
    try {
      (window.opener as Window).postMessage({ nyxPocRelay: payload }, '*');
      return 'postMessage';
    } catch {
      /* fall through */
    }
  }

  return 'none';
}

export function describeOpener(): string {
  return window.opener
    ? 'window.opener PRESENT (COOP did not sever it)'
    : 'window.opener is null (expected: host COOP same-origin severs cross-origin opener)';
}
