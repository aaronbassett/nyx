# Nyx local devnet

The Midnight "integrated local node" stack (node + indexer + proof server) that Nyx
develops and validates against **until public release** (see
`specs/001-nyx-platform/design-network-profiles.md`; amends D1/D5). Pre-prod stays the
public-release target; the OpenZeppelin-simulator verification loop is unchanged.

## Ports

All three run on the ports Lace's **"Undeployed"** network pins, so a Lace wallet on
"Undeployed" and Nyx talk to the **same chain**:

| Service      | Host port | Notes                                                                                                     |
| ------------ | --------- | --------------------------------------------------------------------------------------------------------- |
| node         | `9944`    | Lace-pinned (RPC/WS)                                                                                      |
| proof server | `6300`    | Lace-pinned (local proving)                                                                               |
| indexer      | `8088`    | conventional Undeployed indexer; Lace syncs here — GraphQL at `/api/v4/graphql` (ws `/api/v4/graphql/ws`) |

Because those three are singular on the host, only **one** Midnight devnet can run at a
time. Nyx's own services (Postgres, Vite) are remapped off their defaults instead.

## Start / stop

```bash
pnpm devnet:up     # port preflight, then docker compose up
pnpm devnet:down   # docker compose down
```

`devnet:up` runs `infra/devnet/preflight.ts` first: if `9944`, `6300`, or `8088` is
already bound it **fails fast and refuses to start** — Nyx never attaches to a devnet it
did not start (which could risk deploying to or funding a foreign chain). Stop the other
process and retry.

Requires Docker (≥ ~4 GB RAM / 2 CPU; the proof server is memory-heavy).

## Lace "Undeployed" setup

Lace → Settings → **Network** → select **Undeployed** → Confirm. Its node/proof/indexer
addresses are fixed to the ports above and are not editable, which is why the devnet must
occupy them.

## Dev deploy key (genesis account)

The node's `dev` preset pre-mints all NIGHT to a genesis "master wallet" derived from the
well-known 32-byte hex seed:

```
0000000000000000000000000000000000000000000000000000000000000001
```

⚠️ **PUBLIC — LOCAL DEVNET ONLY.** Anyone running the devnet controls these funds. Never
use this seed on pre-prod, preview, or mainnet.

Server-side deploys/vault funding use this account as the dev `DEPLOY_KEY`. Note: tNIGHT
alone cannot pay fees — the account must be **registered for DUST** first (the local-dev
tooling does this for the master wallet). Exact key-derivation + DUST-registration steps
are confirmed against the toolchain at wiring, not from memory (constitution I).

## Image versions (verified via midnight-tooling:devnet — do not bump from memory)

| Image                              | Pin      | Cap / why                                               |
| ---------------------------------- | -------- | ------------------------------------------------------- |
| `midnightntwrk/midnight-node`      | `0.22.5` | keep `< 1.0.0` — `1.0.0` is the **mainnet** node        |
| `midnightntwrk/indexer-standalone` | `4.2.1`  | keep `< 4.3.0` — `4.3.0+` requires a Blockfrost API key |
| `midnightntwrk/proof-server`       | `8.1.0`  | —                                                       |

## Owner-gated (T273)

Before relying on the Lace-driven flows (US5 round-trip, US6 deposit, US9 hatch): bring
the devnet up, point Lace at "Undeployed", and confirm a real-Lace `signData` round-trip.
Confirm the exact `networkId` string Lace reports for "Undeployed" (currently `"undeployed"`,
a `TODO(verify)` in the network profiles) and whether Lace exposes an editable indexer
field or hardcodes `8088`.
