#!/usr/bin/env bash
# One-command runner for the WebContainer + Lace PoC.
# Installs host deps (via sfw pnpm), builds the host page, then starts the
# Rust server (which opens your default browser at the host page).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> installing host dependencies (sfw pnpm install)"
(cd host && sfw pnpm install)

echo "==> building host page (pnpm build)"
(cd host && pnpm build)

echo "==> starting Rust server (cargo run)"
exec cargo run --manifest-path server/Cargo.toml
