/**
 * Host page (control origin: http://localhost:<port>).
 *
 * 1. Connects a WebSocket to the Rust server and relays everything it does.
 * 2. Runs the wallet-injection CONTROL check on the localhost origin.
 * 3. Boots a WebContainer, mounts a Vite + React 19 + shadcn + Tailwind v4
 *    project, runs `npm install` + `npm run dev` inside it, and streams ALL
 *    process output to the terminal via the WebSocket.
 * 4. When the inner dev server is ready, shows an "Open DApp" button that
 *    opens the preview URL in a NEW TOP-LEVEL TAB (not an iframe — extensions
 *    generally do not inject into cross-origin iframes; top-level injection
 *    is the entire point of this PoC).
 */

import { WebContainer } from '@webcontainer/api';
import { connectRelay, log, send, sendRaw, onPageLog } from './relay';
import { runWalletCheck } from './wallet-check';
import { makeProjectFiles } from './wc-files';

/**
 * Watches nyx-reports.ndjson inside the container and relays every new line
 * to the Rust server. This is the guaranteed fallback path for the DApp when
 * the preview service worker rewrites direct browser->localhost requests.
 */
function watchContainerReports(wc: WebContainer): void {
  const fileName = 'nyx-reports.ndjson';
  let processed = 0;
  const drain = async () => {
    let content: string;
    try {
      content = (await wc.fs.readFile(fileName, 'utf-8')) as string;
    } catch {
      return;
    }
    if (content.length <= processed) return;
    const fresh = content.slice(processed);
    processed = content.length;
    for (const line of fresh.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        parsed.source = `${String(parsed.source ?? 'dapp')} (via container-fs relay)`;
        sendRaw(parsed);
        onPageLog(`[host] relayed container-fs report: kind=${String(parsed.kind)}`);
      } catch {
        send('log', { text: `unparseable container report line: ${line}`, level: 'warn' });
      }
    }
  };
  wc.fs.watch(fileName, () => {
    void drain();
  });
  // Also poll as a safety net (fs.watch semantics inside the container can vary).
  setInterval(() => {
    void drain();
  }, 2000);
  log('watching nyx-reports.ndjson inside the container (fallback relay path)');
}

const statusEl = document.getElementById('status')!;
const openBtn = document.getElementById('open-dapp') as HTMLButtonElement;
const recheckBtn = document.getElementById('recheck') as HTMLButtonElement;
const previewUrlEl = document.getElementById('preview-url')!;
const warningEl = document.getElementById('warning')!;

function setStatus(text: string) {
  statusEl.textContent = text;
  log(`status: ${text}`);
}

function controlWalletCheck(trigger: string) {
  const result = runWalletCheck();
  send('wallet-check', { ...result, trigger, transport: 'websocket(host)' });
  onPageLog(
    `[host] CONTROL wallet check (${trigger}): midnight=${result.midnightPresent} ` +
      `cardano=${result.cardanoPresent} others=[${result.otherWalletGlobals.join(', ')}]`,
  );
}

async function pipeProcessOutput(
  stream: ReadableStream<string>,
  label: string,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      send('process-output', { stream: label, chunk: value }, 'webcontainer');
    }
  } finally {
    reader.releaseLock();
  }
}

async function bootWebContainer(): Promise<void> {
  const t0 = performance.now();

  if (!crossOriginIsolated) {
    log(
      'window.crossOriginIsolated is FALSE — SharedArrayBuffer unavailable, WebContainer cannot boot. ' +
        'Check that COOP/COEP headers are being served.',
      'error',
    );
    setStatus('FAILED: page is not cross-origin isolated');
    return;
  }
  log(`crossOriginIsolated=true, SharedArrayBuffer=${typeof SharedArrayBuffer !== 'undefined'}`);

  setStatus('booting WebContainer…');
  const wc = await WebContainer.boot();
  log(`WebContainer booted in ${Math.round(performance.now() - t0)}ms (workdir: ${wc.workdir})`);

  wc.on('error', (err) => {
    log(`WebContainer error: ${err.message}`, 'error');
  });
  wc.on('port', (port, type, url) => {
    log(`WebContainer port event: port=${port} type=${type} url=${url}`);
  });

  setStatus('mounting Vite + React 19 + shadcn + Tailwind v4 project…');
  await wc.mount(makeProjectFiles(location.port || '80'));
  log('project files mounted');

  setStatus('running `npm install` inside the container…');
  const tInstall = performance.now();
  const install = await wc.spawn('npm', ['install']);
  void pipeProcessOutput(install.output, 'install');
  const installExit = await install.exit;
  log(
    `npm install exited with code ${installExit} after ${Math.round(
      (performance.now() - tInstall) / 1000,
    )}s`,
    installExit === 0 ? 'info' : 'error',
  );
  if (installExit !== 0) {
    setStatus('FAILED: npm install failed inside the WebContainer');
    return;
  }

  watchContainerReports(wc);

  setStatus('starting `npm run dev` (Vite) inside the container…');
  const dev = await wc.spawn('npm', ['run', 'dev']);
  void pipeProcessOutput(dev.output, 'dev');
  void dev.exit.then((code) => {
    log(`vite dev process exited with code ${code}`, code === 0 ? 'info' : 'warn');
  });

  wc.on('server-ready', (port, url) => {
    log(`server-ready: inner Vite dev server is up at ${url} (container port ${port})`);
    setStatus(`inner dev server READY at ${url}`);
    previewUrlEl.textContent = url;
    openBtn.dataset.url = url;
    openBtn.hidden = false;
    warningEl.hidden = false;

    const warning =
      'WARNING: keep THIS tab open — the WebContainer (and the DApp dev server) live in this ' +
      'tab and die if it closes. The DApp must be opened as a NEW TOP-LEVEL TAB, not an ' +
      'iframe: extensions generally do not inject into cross-origin iframes, and top-level ' +
      'injection is what this PoC tests. Note: this page is served with COOP: same-origin ' +
      '(required for SharedArrayBuffer), which severs window.opener in the new tab, so the ' +
      'DApp reports back over a direct WebSocket to localhost instead.';
    log(warning, 'warn');
  });
}

function main(): void {
  connectRelay();
  log(`host page loaded: ${location.href}`);
  log(`userAgent: ${navigator.userAgent}`);

  // Relay any postMessage traffic (the DApp's last-resort fallback path).
  window.addEventListener('message', (ev) => {
    const data = ev.data as { nyxPocRelay?: string } | undefined;
    if (data && typeof data.nyxPocRelay === 'string') {
      log(`relaying postMessage from ${ev.origin} (fallback path WAS reachable)`);
      // Forward the raw envelope; mark that it travelled via postMessage.
      try {
        const parsed = JSON.parse(data.nyxPocRelay) as Record<string, unknown>;
        send(String(parsed.kind ?? 'log'), parsed.data, `dapp(postMessage via host)`);
      } catch {
        send('log', { text: `unparseable postMessage relay: ${data.nyxPocRelay}`, level: 'warn' });
      }
    }
  });

  recheckBtn.addEventListener('click', () => controlWalletCheck('manual re-check'));

  openBtn.addEventListener('click', () => {
    const url = openBtn.dataset.url;
    if (!url) return;
    log(`opening DApp in a new top-level tab: ${url}`);
    window.open(url, '_blank');
  });

  // Give extension content-scripts a moment to inject, then run the control.
  window.addEventListener('load', () => {
    setTimeout(() => controlWalletCheck('initial (host control origin)'), 800);
  });

  bootWebContainer().catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    log(`WebContainer boot flow failed: ${msg}`, 'error');
    setStatus('FAILED: see log');
  });
}

main();
