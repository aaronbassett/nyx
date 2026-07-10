/**
 * WebSocket relay from the host page to the Rust server.
 * Everything the host page does is mirrored to the terminal.
 */

type Kind = 'log' | 'process-output' | 'wallet-check' | string;

const wsUrl = `ws://${location.host}/ws`;
let socket: WebSocket | null = null;
const queue: string[] = [];

const logEl = () => document.getElementById('log');

export function onPageLog(line: string, cssClass = ''): void {
  const el = logEl();
  if (!el) return;
  const div = document.createElement('div');
  div.textContent = line;
  if (cssClass) div.className = cssClass;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function flush(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (queue.length > 0) {
    socket.send(queue.shift()!);
  }
}

export function connectRelay(): void {
  socket = new WebSocket(wsUrl);
  socket.addEventListener('open', () => {
    onPageLog(`[relay] WebSocket connected to ${wsUrl}`);
    flush();
  });
  socket.addEventListener('close', () => {
    onPageLog('[relay] WebSocket closed — retrying in 2s');
    setTimeout(connectRelay, 2000);
  });
  socket.addEventListener('error', () => {
    onPageLog('[relay] WebSocket error');
  });
}

export function send(kind: Kind, data: unknown, source = 'host'): void {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    origin: location.origin,
    source,
    kind,
    data,
  });
  queue.push(payload);
  flush();
}

/** Forward an already-built envelope (e.g. relayed from the DApp) as-is. */
export function sendRaw(envelope: Record<string, unknown>): void {
  queue.push(JSON.stringify(envelope));
  flush();
}

/** Log to page + terminal at once. */
export function log(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  onPageLog(`[host] ${level}: ${text}`, level);
  send('log', { text, level });
}
