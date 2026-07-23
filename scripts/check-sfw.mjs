#!/usr/bin/env node
// Supply-chain gate: every host-side pnpm invocation must run through Socket
// Firewall (`sfw pnpm …`). This check fails fast when sfw is not installed so
// hooks and the demo preflight surface the gap before any install runs.
import { spawnSync } from "node:child_process";

const result = spawnSync("sfw", ["--version"], { stdio: "ignore", shell: false });

if (result.error || result.status !== 0) {
  console.error(
    [
      "sfw (Socket Firewall) is required but was not found on PATH.",
      "Install it per https://docs.socket.dev/docs/socket-firewall-free :",
      "  npm i -g sfw",
      "Then re-run. All host-side installs/builds MUST use `sfw pnpm …`.",
    ].join("\n"),
  );
  process.exit(1);
}
process.exit(0);
