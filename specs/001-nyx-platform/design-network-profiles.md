# Design: Network profiles + local devnet

**Status:** approved (owner "lgtm", 2026-07-13) — pending written-spec review before planning
**Scope:** foundational, cross-cutting; lands before US3 consumes it
**Amends:** D1 (target pre-prod), D5 (no devnet / deployment validity via pre-prod)

## Problem

Pre-prod and its faucet are unreliable (tDUST/DUST generation intermittently broken) —
external infrastructure we don't control that will block building the on-chain paths
(US6 vault, US8 deploy, US9 escape-hatch, US10 reconcile). We need to develop and
validate against a **local devnet** so flaky pre-prod can't stall us, while keeping
pre-prod as the target for public release. That requires a first-class **network-config**
concept so switching targets is a config change, not a code change.

## Decision (amends D1 / D5)

- **Local devnet is the default target for all development AND validation** — including
  the owner-gated Independent Tests / validations — for the **entire pre-public-release
  period**.
- **"Public release" = external promotion** to users outside Midnight Foundation.
  Building in public / pushing to a public GitHub repo is **not** the release. Pre-prod
  becomes the target only at that promotion milestone.
- **Pre-prod remains a first-class profile** and the canonical realism + public-release
  target (D1 re-reads as "target pre-prod *for public release*").
- **The verification loop is unchanged** — determinism still comes from the OpenZeppelin
  Compact simulator under Vitest in the WebContainer (D5 core, FR-027). The devnet is
  **not** wired into the per-iteration validity checks; it is the target for the
  on-chain integration legs only.

This is a narrow amendment scoped to the deployment/validation target, in the spirit of
how D37 amended D8 — recorded, not silently re-decided (constitution VIII).

## Hard constraint: Lace "Undeployed" pins two ports

Lace supports an **"Undeployed"** network, but the addresses it uses are **not
configurable** (owner-confirmed from the Lace settings UI, 2026-07-13):

- Node → `http://localhost:9944`
- Proof server (Local) → `http://localhost:6300`

So any **Lace-driven** flow (US5 real-Lace `signData` round-trip, US6 deposit signing
ceremony, US9 escape-hatch) forces the devnet's node onto **9944** and a proof server
onto **6300**. These two ports are immovable; everything else is ours to place.

Consequence: you **cannot** run our Lace-usable devnet and another default-port Midnight
devnet at the same time — 9944/6300 are singular. Isolating the node itself is the one
thing that genuinely conflicts with Lace.

## Chosen approach: Option A (default node/proof, remap the rest)

Node on **9944** and proof on **6300** always; **remap everything else we control**
(indexer, the D37 interim prover `PROVER_URL`, Postgres, the Vite dev server) to
non-default ports. One coherent Midnight chain on the box at a time — and that one chain
does *everything*, including the Lace validations, so there's no split-chain / redeploy
juggling.

Rejected — Option B (dual node/proof profiles: remapped for daily work, default for Lace
runs): buys a concurrent isolated node but at the cost of two separate chains (contracts
deployed to the remapped devnet don't exist on the 9944 devnet → redeploy before every
Lace validation) plus two compose configs. Not worth it; the config abstraction lets us
add a remapped-node profile later if a real need appears.

## Components

### 1. Network-profiles module (the "concept of network configs")

A typed profile:

```
NetworkProfile = {
  id:             string   // "local-devnet" | "preprod" | ...
  networkId:      string   // what the connector reports; drives the wrong-network gate
  nodeUrl:        string
  indexerUrl:     string
  proofServerUrl: string
}
```

- Selected by **one env var**: `NYX_NETWORK` (server) / `VITE_NYX_NETWORK` (web).
- Ships with `local-devnet` (default) and `preprod` (public-release target); room for
  `test` / `staging`.
- Fail-fast on missing/invalid selection or missing fields (DS-003 boot-config pattern).
- **Server:** add `nodeUrl` / `indexerUrl` / `networkId` to `EnvSchema` + `Config` —
  **currently absent** (schema has `PROVER_URL`, `DEPLOY_KEY`, R2, MCP URLs, but no
  chain endpoints). This is surface the plan already implied (Q7 / D18 anticipated
  "pre-prod node/indexer URLs").
- **Web:** generalize the existing `VITE_MIDNIGHT_NETWORK_ID` (`apps/web/src/wallet/config.ts`)
  into the profile, read through the `config.ts` chokepoint (D10, constitution VII).
  US5 is already network-parameterized (`connect()` takes a network-id hint;
  `classify.ts` compares connected vs expected) — only the default value changes.

`local-devnet` port plan:

| Service         | Port     | Why                                                      |
|-----------------|----------|----------------------------------------------------------|
| Node            | **9944** | Lace "Undeployed" pins it (immovable)                    |
| Proof server    | **6300** | Lace "Undeployed" pins it; Nyx `PROVER_URL` also points here locally (one stateless proof server serves both actors) |
| Indexer         | remapped | not pinned by Lace                                       |
| Postgres        | remapped | Nyx metering rail                                        |
| Vite dev server | remapped | web app                                                  |

Specific remapped port numbers are chosen at implementation (a fixed offset from the
defaults); the design only requires they be non-default. Only 9944 + 6300 are fixed.

### 2. Devnet stack (`infra/`)

A compose / `iln` setup running node@9944 + proof@6300 + indexer@remapped, plus a
**pre-funded genesis account** whose key becomes the dev `DEPLOY_KEY` (server-side deploy
and vault funding work without needing a faucet). Start/stop scripts + docs, including the
Lace "Undeployed" setup steps.

- Image tag and real service ports **verified via the `midnight-tooling:iln` skill**,
  never from memory (constitution I). `infra/prover/fly.toml` already references
  `midnightntwrk/iln` via that skill.
- The dev `DEPLOY_KEY` is still a **server-only secret** handled exactly like the prod
  deploy key (never crosses the server boundary, constitution III) even though it guards
  a valueless local chain.

### 3. Fail-fast port preflight

Before the devnet boots, probe the required host ports (9944, 6300, and our remapped
ones). If **any** is already bound → **abort with a named error**, e.g.:

> `port 9944 in use — another Midnight node/devnet may be running; Nyx will not reuse it.
> Stop it and retry.`

**Never attach to a devnet we didn't start** (closes the footgun of deploying to /
funding a foreign chain sitting on the default ports). Docker's bind failure is the
backstop; the preflight makes it friendly and explicit.

- **Optional stronger guard:** after boot, assert the node's chain/genesis id matches our
  expected devnet identity, so we never operate against a foreign chain even when it's on
  the right ports.

## Impact on existing plans

- **US5 (built):** light touch — already network-parameterized; change the default from
  `preprod` to the devnet profile and confirm the `networkId` string Lace reports for
  "Undeployed" (resolves the existing `TODO(verify)` in `wallet/config.ts`).
- **US7 / US2 (built):** untouched (no network coupling; R2 is content-addressed storage).
- **US3 (next):** consumes the profile for `contract:deployed → .env.local → config.ts`
  (D10) and the generated app's providers. Not *blocked* on it, but this lands first so
  US3 reads the profile instead of hardcoding.
- **US1 (MVP):** the network profile is the natural neighbour of the already-flagged
  `COMPILE_SERVICE_TOKEN` / `COMPILE_SERVICE_URL` config seam — same place, same
  fail-fast pattern.
- **US6 / US8 / US10:** the heavy network consumers; the devnet is what de-risks building
  them.
- **Owner-gated re-pointing:** US5 Lace round-trip, US6 funding spike, and US9 hatch all
  now validate against the 9944/6300 devnet with Lace on "Undeployed." Non-network
  owner-gated items (real Compile Service + R2) are unaffected by devnet-vs-pre-prod.

## Sequencing & ownership

- Foundational; **lands before US3**.
- **I build both** the config module and the devnet stack — unlike the Compile Service,
  this is local-only dev tooling with no zero-trust boundary to hand off, and it's tightly
  coupled to the config being written.

## Verify at implementation (constitution I — never memory)

1. The exact `networkId` string Lace reports for "Undeployed."
2. Whether Lace's Undeployed mode also expects a fixed **indexer** endpoint (the settings
   UI pinned only node + proof).
3. The real `iln` image tag and the actual default ports of node / indexer / proof server
   (via `midnight-tooling:iln`).
4. How the pre-funded genesis account / dev deploy key is provisioned on the `iln` devnet.

## Deferred / out of scope

- A remapped-node profile for running two live Midnight chains simultaneously (add later
  only if a real clash bites).
- `test` / `staging` profiles beyond leaving room for them in the schema.
