# PoC: WebContainer boot + Lace (`window.midnight`) injection test

Validates two load-bearing assumptions for Nyx (PRD Phase 0 item c / discovery Q3):

1. A StackBlitz WebContainer can boot a **Vite + React 19 + shadcn + Tailwind v4** app
   from a locally served, cross-origin-isolated page.
2. Whether the **Lace (Midnight)** browser extension injects `window.midnight` into
   (a) a plain `localhost` page (control) and
   (b) the WebContainer-served app opened as a **top-level tab** (the real question).

## Run it

```bash
./run.sh
```

That installs host deps (`sfw pnpm install`), builds the host page, and starts the
Rust server, which opens your default browser at `http://localhost:8787`.

Prerequisites: Rust toolchain, node + pnpm + the `sfw` wrapper, a Chromium-based
browser with the Lace (Midnight) extension installed (for the wallet half of the test).

Env vars: `PORT` (default 8787), `NYX_POC_NO_OPEN=1` (do not open a browser),
`STATIC_DIR` (override host page dir), `RUST_LOG` (default is very verbose DEBUG).

## What you will see

All findings stream to the **terminal** running the server. Every browser context
reports over WebSocket (`ws://localhost:8787/ws`), with an HTTP `POST /report`
fallback. Wallet findings are printed as unmissable banners, one per origin:

```
################################################################
##            WALLET INJECTION FINDINGS                       ##
################################################################
  origin            : http://localhost:8787
  reported by       : host (via websocket, ...)
  window.midnight   : PRESENT  <<<<<<
  midnight keys     : mnLace  ->  [apiVersion, enable, isEnabled, name, ...]
  ...
```

Expected sequence in the terminal:

1. `[host] CONTROL wallet check` banner for `http://localhost:8787` — Lace's
   behaviour on a plain localhost page.
2. WebContainer boot, `npm install` and `vite dev` output relayed line by line
   (`[wc:install]`, `[wc:dev]` prefixes). Headless timings: boot ~2 s,
   install ~20 s, dev server ready ~26 s from page load.
3. `server-ready` — the host page shows a pulsing green **Open DApp in new tab**
   button. Click it. Keep the host tab open: the WebContainer lives in it.
4. The new tab briefly shows the WebContainer bootstrap, which automatically
   opens a small popup to `/webcontainer/connect/<id>` on this server (the
   "connect bridge"); once connected the tab renders the DApp. **If the tab
   says "Unable to connect", your browser blocked that popup — allow popups
   for the preview origin and reload the tab.**
5. A second findings banner for the `https://…webcontainer-api.io` preview origin,
   reported by the DApp itself — this is the answer to the real question.

## The Lace test (manual, requires the extension)

1. `./run.sh` in a browser profile with Lace (Midnight) installed.
2. Read the control banner for `localhost:8787`: is `window.midnight` present?
3. Click **Open DApp in new tab** when it appears, approve nothing — just look at
   the new tab's card UI and the terminal banner for the preview origin.
4. Use the **Re-check wallets** buttons (both pages have one) after
   interacting with the Lace extension icon, in case injection is lazy.
5. Compare the two banners. Also note the `Reported to server via` badge in the
   DApp (expected: `container-fs-relay`, see below).

## Architecture

```
pocs/webcontainer-lace/
├── run.sh              one-command runner
├── server/             Rust: axum + tokio + tracing + tower-http + open
│   └── src/main.rs     COOP/COEP on every response; /ws log relay; /report
│                       CORS fallback; serves ../host/dist; opens browser
├── host/               host page (plain TS, built with Vite)
│   ├── src/main.ts     boots WebContainer, mounts project, streams process
│   │                   output over WS, "Open DApp" button (top-level tab),
│   │                   watches nyx-reports.ndjson (container-fs relay)
│   ├── src/connect.ts  setupConnect() bridge for top-level preview tabs
│   ├── src/wallet-check.ts  shared check (host AND mounted into the DApp)
│   ├── src/relay.ts    WS relay to the Rust server
│   ├── src/wc-files.ts packs wc-app/ into a FileSystemTree (?raw imports)
│   └── wc-app/         the DApp mounted inside the WebContainer:
│                       Vite + React 19 + shadcn (button/card/badge) + Tailwind v4
└── README.md
```

Key decisions and PoC findings (verified headless):

- **COOP/COEP on every response** (`same-origin` / `require-corp`) — hard
  requirement for `SharedArrayBuffer`, which WebContainers need. Set by the Rust
  server middleware so preflights and static files get them too.
- **Top-level tab, not iframe** — extensions generally do not inject content
  scripts into cross-origin iframes; top-level injection is the entire point.
- **Top-level previews need a "connect bridge"** — a preview opened as a
  top-level tab has no link to the container (that plumbing normally flows
  through an embedded preview iframe). The preview bootstrap automatically
  opens a popup to `<host>/webcontainer/connect/<id>`; that page must call
  `setupConnect()` from `@webcontainer/api/connect` and MUST be served with
  COOP/COEP `unsafe-none` — cross-origin isolation there would sever the
  `window.opener` relay the bridge depends on (stackblitz/webcontainer-core#1725).
  The Rust server special-cases this one route.
- **The preview service worker rewrites `localhost` AND `127.0.0.1` URLs** —
  inside the preview origin, `ws://localhost:8787/ws` is rewritten to a
  container-port URL (`…--8787--….webcontainer-api.io`), so the "obvious"
  direct WebSocket/fetch from the DApp to the local server FAILS. Verified for
  both hostnames, WS and fetch. The DApp therefore falls back to a
  **container-fs relay**: it POSTs same-origin to `/__nyx-report`, a Vite
  middleware inside the container appends to `nyx-reports.ndjson`, and the
  host page (`wc.fs.watch`) relays each line to the Rust server. This is the
  transport that works (`container-fs-relay` badge). One gotcha: that file
  must be in Vite's `server.watch.ignored`, or every append triggers a
  full-page reload of the DApp and an infinite loop.
- **postMessage fallback is dead by design** — the host page's COOP severs
  `window.opener` in the DApp tab (`window.opener is null` is logged).
- The DApp sources are real files under `host/wc-app/` inlined via Vite `?raw`
  imports, so the same `wallet-check.ts` file runs on both origins.
