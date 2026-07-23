# Contributing

## Commits

Conventional Commits, enforced by commitlint (`@commitlint/config-conventional`):

- `type(scope): subject` — subject **lowercase** (no leading acronym/uppercase word), header ≤ 72 chars.
- Types in use: `feat`, `fix`, `build`, `ci`, `docs`, `test`, `refactor`, `chore`.
- Never `--no-verify`.

## Toolchain (supply-chain rules)

- Host-side: **always `sfw pnpm …`** (Socket Firewall), never bare `pnpm`, never `npm`.
  `node scripts/check-sfw.mjs` verifies sfw is installed.
- New dependency versions are quarantined by a minimum release age (see
  `pnpm-workspace.yaml`); dependency lifecycle scripts are blocked except the
  audited `onlyBuiltDependencies` allowlist — additions need a justified, reviewed PR.
- Inside the user-facing WebContainer runtime only: plain `npm`.

## Gates

`sfw pnpm lint && sfw pnpm format:check && sfw pnpm typecheck && sfw pnpm test`
must pass with **zero warnings** before any push (pre-push hook enforces; CI mirrors).
