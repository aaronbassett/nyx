# Verified devnet deploy recipe (P4 Task 1 — constitution-I gate for Tasks 2–3)

Every claim below cites executed evidence (a command run against the live devnet, an
installed `.d.ts`/dist source read, or upstream source at the deployed tag) — never memory.
Anything not confirmable on this stack is marked **OWNER-GATED** with what would confirm it.
Tasks 2–3 (`devnet-executor.ts` / `sdk-adapter.ts` / `balance.ts`) code against THIS document;
every SDK call in `sdk-adapter.ts` cites its element here.

**Verified on:** 2026-07-24, against the running devnet (containers never restarted or
reconfigured): `midnight-node:0.22.5` (`system_version` → `0.22.5-31b06338`, chain
`undeployed1`) on `:9944`, `indexer-standalone:4.2.1` on `:8088`
(GraphQL `/api/v4/graphql`, WS `/api/v4/graphql/ws`), `proof-server:8.1.0` on `:6300`.

## Package pins (installed into `apps/server` by this task)

All versions confirmed against npm and the executed SPIKE-2 workspace (the same matrix that
deployed on this devnet); `ledger-v8@8.1.0` was already a server dependency.

| Package                                                    | Version | Used by (element)                                                                      |
| ---------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `@midnight-ntwrk/midnight-js-contracts`                    | 4.1.1   | 1 build/deploy (`deployContract`)                                                      |
| `@midnight-ntwrk/midnight-js-types`                        | 4.1.1   | 4 (`FinalizedTxData`, `TxStatus`), provider types                                      |
| `@midnight-ntwrk/midnight-js-network-id`                   | 4.1.1   | 1/3 (`setNetworkId`)                                                                   |
| `@midnight-ntwrk/midnight-js-node-zk-config-provider`      | 4.1.1   | 1 (artifact layout → `ZKConfigProvider`)                                               |
| `@midnight-ntwrk/midnight-js-indexer-public-data-provider` | 4.1.1   | 4 (`watchForTxData`, `queryContractState`)                                             |
| `@midnight-ntwrk/midnight-js-http-client-proof-provider`   | 4.1.1   | 2 (fallback proof route)                                                               |
| `@midnight-ntwrk/midnight-js-protocol`                     | 4.1.1   | 1/5 (`CompiledContract`, `unshieldedToken`)                                            |
| `@midnight-ntwrk/testkit-js`                               | 4.1.1   | 3/5 (wallet plumbing against a RUNNING devnet)                                         |
| `@midnight-ntwrk/wallet-sdk`                               | 1.1.0   | 3 (facade; testkit's exact nested dep is also 1.1.0 — no 1.0.0 shadow in this install) |
| `@midnight-ntwrk/compact-runtime`                          | 0.16.0  | 1 (compiled-contract module runtime)                                                   |
| `@midnight-ntwrk/onchain-runtime-v3`                       | 3.0.0   | 1 (compact-runtime's onchain layer, pinned explicitly)                                 |
| `@midnight-ntwrk/ledger-v8`                                | 8.1.0   | 2/3 (`Transaction.prove` seam; already installed)                                      |
| `rxjs`                                                     | 7.8.2   | 3/5 (`firstValueFrom(wallet.state())`)                                                 |

Runtime smoke (2026-07-24, from `apps/server`): every entry point above imports cleanly
under the server's Node (`deployContract`, `findDeployedContract`, `setNetworkId`,
`NodeZkConfigProvider`, `indexerPublicDataProvider`, `httpClientProofProvider`,
`SucceedEntirely`, `unshieldedToken`, `CompiledContract.make`,
`MidnightWalletProvider.build`, `initializeMidnightProviders`).

## Evidence index

- **SPIKE-1 §5** (`docs/superpowers/plans/retros/SPIKE1_REPORT.md`): counter + NyxtVault
  deployed on this devnet via `midnight-js@4.1.1` + `NodeZkConfigProvider` layout — pins
  elements 1, 2, 3 and block-inclusion observation.
- **SPIKE-2 §C/§D/§F, §What-a-tx-needs, §Funding** (`SPIKE2_REPORT.md`): deploy +
  proof-server and wasm prove routes, wallet facade sign/submit pipeline, funding/DUST
  recipe, balance reads — pins elements 1, 2, 3, 5.
- **P3 retro** (`P3_RETRO.md`): WS relay necessity for `submitTransaction`, two network
  strings, ledger-v8 payload codecs for the `{check,prove}` proxy — element 2/3 carry-ins.
- **Merged P3 adapter** (`apps/server/src/ledger/indexer-observation.ts:212-240` and
  `:309-344`): executed `contractAction` GraphQL + `queryContractState`/`mod.ledger` decode.
- **This task, live (2026-07-24, current chain):** fresh NyxtVault deploy + finality-signal
  capture (`p4t1-deploy-confirm.mjs`), four EC-38 error probes (`p4t1-ec38-probe.mjs`),
  genesis balance reads (`p4t1-balances.mjs`), node RPC probes (`rpc_methods`,
  `chain_getFinalizedHead`, `chain_getHeader`), live indexer GraphQL introspection.
  Key outputs are quoted verbatim below; full transcript summary in
  `.superpowers/sdd/p4-task-1-report.md` (probe scripts live in the session scratchpad's
  `spike2/sdkwork/`, alongside the SPIKE-2 scripts they extend).
- **Upstream source at the deployed tag:** `midnightntwrk/midnight-indexer`
  `chain-indexer/src/infra/subxt_node.rs` at `v4.2.1`.
- **Installed `.d.ts`/dist reads:** `midnight-js-types` (`FinalizedTxData`, `TxStatus`,
  `PublicDataProvider`), `midnight-js-contracts` (`deployContract` overloads, d.ts:918-919),
  `midnight-js-indexer-public-data-provider` (`indexerPublicDataProvider` factory,
  `watchForTxData` implementation and its GraphQL documents).

Element coverage: 1–3 and 5 were pinned by the spikes and are re-confirmed live by this
task on the current chain; element 4's precise signal and the EC-38 shape were UNPINNED
before this task and are pinned below.

## Element 1 — build a deploy tx from compiled artifacts

**Status: Confirmed by execution** (SPIKE-1 §5, SPIKE-2 §C; re-executed 2026-07-24).

Artifact layout (exactly what the P2 artifact store / `NodeZkConfigProvider` serve):
`keys/<circuit>.prover|.verifier`, `zkir/<circuit>.bzkir`, `contract/index.js` (compiled by
compact 0.31.1 → `checkRuntimeVersion('0.16.0')`).

```js
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";

setNetworkId("undeployed"); // LOWERCASE — capitalized → node reject 1010/Custom 166 (SPIKE-1 risk 7)
const mod = await import(`${artifactDir}/contract/index.js`);
let cc = CompiledContract.make("NyxtVault", mod.Contract);
cc = CompiledContract.withWitnesses(cc, witnesses); // if the contract has witnesses
// providers: wallet + zkConfig + publicData + proof + privateState (see elements 2–4);
// testkit-js initializeMidnightProviders(walletProvider, env, { privateStateStoreName, zkConfigPath })
// assembles all of them against a RUNNING devnet (executed path).
const deployed = await deployContract(providers, {
  compiledContract: cc,
  privateStateId: "nyxtVaultPrivateState",
  initialPrivateState: {/* … */},
});
const { contractAddress, txId, blockHeight, status } = deployed.deployTxData.public;
```

Live result (2026-07-24, seed `…02`): `contractAddress e6fe54eb24a1ab0ed22a90e277ed4cfdb6fa0c8e56d5b29fb2ce039958294de5`,
`txId 00729fa7f1598088dca037fb079e239151bfc3c804cb8e48ee3ade0ce91ac63de1`, block 132,
`SucceedEntirely`, 20.5 s. `deployContract` signature verified from installed
`midnight-js-contracts` d.ts:918-919. Under the hood a deploy wraps
`new ContractDeploy(contractState)` (verifier keys inside `ContractState`) in an `Intent`
(SPIKE-2 §What-a-tx-needs, installed-source read); the lower-level entry
`createUnprovenDeployTxFromVerifierKeys(zkConfigProvider, coinPublicKey, options, encryptionPublicKey)`
(d.ts:1267) exists if Task 2 needs to split build from submit.

## Element 2 — prove

**Status: Confirmed by execution** (SPIKE-2 §C fallback route + §D wasm route; the
proof-server route re-executed 2026-07-24 inside the live deploy).

- The universal seam is ledger-v8's `tx.prove(provingProvider, CostModel.initialCostModel())`
  where `provingProvider` is any `{check, prove}` pair — there is no lower-level
  "splice proof bytes" API (SPIKE-2 §What-a-tx-needs).
- Proof-server route (what the executor uses): `httpClientProofProvider('http://127.0.0.1:6300', zkConfig)`
  POSTs each circuit's serialized preimage + client-supplied `{proverKey, verifierKey, ir}`
  to `/check` and `/prove` (`application/octet-stream`) — the proof server holds only
  built-in zswap/dust keys, so the CLIENT ships the contract's key material (SPIKE-2
  §Fallback decision). Through Nyx's D37 proxy this is `ProverClient.relay({ subpath: "check" | "prove", body, contentType })`
  (`prover/proxy.ts:78-86`); P3 already reuses the real ledger-v8 payload codecs
  (`createCheckPayload`/`createProvingPayload`/`parseCheckResult` — P3 retro deviation 2)
  rather than `httpClientProofProvider`'s non-injectable fetch.
- Wallet fee leg (DUST spend) is proven by the wallet stack through its configured prover —
  one `POST /prove` per submission observed in the proof-server log (SPIKE-2 §E).

## Element 3 — sign + submit

**Status: Confirmed by execution** (SPIKE-2 §Funding step 3–4 + §C/§D; re-executed
2026-07-24 for both a transfer and a deploy).

Wallet facade pipeline (wallet-sdk 1.1.0 via testkit-js 4.1.1 `MidnightWalletProvider`):

```js
const recipe = await wallet.transferTransaction(
  intents,
  { shieldedSecretKeys, dustSecretKey },
  { ttl },
);
const signed = await wallet.signRecipe(recipe, (p) => unshieldedKeystore.signData(p)); // BIP-340 Schnorr
const finalized = await wallet.finalizeRecipe(signed); // proves wallet legs + binds
const txId = await wallet.submitTransaction(finalized); // node WS ws://127.0.0.1:9944
```

`deployContract` drives the same balance→sign→finalize→submit pipeline internally
(`balanceUnboundTransaction` adds NIGHT inputs + the DUST fee spend). Two load-bearing
carries: **submission uses the node WS transport** — a raw HTTP forward of proven bytes is
insufficient (P3 retro discovery 2); and the tx-encoding network id is **lowercase
`undeployed`** while the displayed/connector id is `Undeployed` (P3 retro discovery 4).
Per-wallet UTXO state races under concurrent submissions (SPIKE-2 risk 7) — the executor
must serialize `signAndSubmit` process-wide (P4 plan Task 2 Step 3).

## Element 4 — finality query (SC-029: "finalized strictly past reorg depth")

**Status: signal Confirmed by source + live execution; fork-behavior residue OWNER-GATED.**

**The signal: a transaction visible via indexer-standalone 4.2.1 is in a GRANDPA-finalized
block.** GRANDPA finality is absolute — a finalized block cannot be reorged — so
"visible in the indexer" IS "finalized strictly past reorg depth". Chain of evidence:

1. **Source (tag `v4.2.1`)**: `midnightntwrk/midnight-indexer`
   `chain-indexer/src/infra/subxt_node.rs` — block ingestion is
   `subscribe_finalized_blocks` / `Node::finalized_blocks` (error variant
   `SubscribeFinalizedBlocks`); the catch-up path's own comment: "Blocks older than
   `FINALIZATION_SAFETY_MARGIN` from the finalized tip are guaranteed to be finalized by an
   earlier GRANDPA round … blocks within the safety margin are fetched by hash … to avoid
   any risk of ingesting non-canonical blocks near the tip." The indexer never ingests a
   non-finalized block.
2. **Live invariant (2026-07-24, repeated samples)**: indexer `{ block { height hash } }`
   always equals-or-trails the node's `chain_getFinalizedHead` height and NEVER exceeds it,
   while the node's best head runs 2–3 blocks ahead. Samples:
   `indexer=43/45/46/167` vs `finalized=44/45/46/167` vs `best=46/47/48/169`.
3. **Deploy-time capture**: at the moment `watchForTxData` resolved for the live deploy,
   tx block = 132, node finalized head = 132, node best = 134, and the indexer's latest
   block hash equaled the finalized block hash (`c0ad01bd…`) — the tx surfaced exactly at
   finalization, two blocks behind best.
4. **SDK mechanics (installed dist read)**: `indexerPublicDataProvider(queryURL, subscriptionURL, ws?)`
   → `PublicDataProvider.watchForTxData(txId): Promise<FinalizedTxData>` polls the GraphQL
   `transactions(offset: { identifier: txId })` query (`TX_ID_QUERY`, apollo `watchQuery`,
   `no-cache`) until non-empty, then maps `transactionResult` → `status` and block fields.
   `FinalizedTxData` (midnight-js-types) carries `status: TxStatus`
   (`SucceedEntirely | FailFallible | FailEntirely`), `txId`, `txHash`, `blockHeight`,
   `blockHash`, `blockTimestamp`, `fees`.

**Executor recipe (`awaitFinality`)**: poll the indexer for the txRef —
`watchForTxData(txId)` or the raw bound-variable `transactions(offset:{identifier:$txId})`
query (the P3 `indexer-observation.ts` transport pattern) — with the pipeline's injected
`delay`/`now` bound by `timeoutMs` (EC-39). Resolution ⇒ finalized. Then map:
`SucceedEntirely` → `{ outcome: "finalized", address }` (address from
`deployTxData.public.contractAddress` / the deploy's `contractAction`);
`FailEntirely`/`FailFallible` → `failed`. A belt-and-braces node-side cross-check is
available and live-probed: `chain_getFinalizedHead` + `chain_getHeader` (both in the node's
`rpc_methods`) to assert `tx.blockHeight <= finalizedHeight`.

**The `reorged` outcome can never be produced by this signal** — the indexer never serves a
block that later reorgs. Keep the pipeline's `reorged` mapping as dead-defensive code, or
reserve it for the node-side cross-check disagreeing (log-loud).

**OWNER-GATED residue (do not claim further):** actual fork/reorg behavior — a single-node
aura/GRANDPA devnet cannot fork, so "a tx seen on an abandoned fork never surfaces via the
indexer" and the `FINALIZATION_SAFETY_MARGIN` near-tip path are source-read, not
empirically exercised. What would confirm: a multi-node devnet partition test (or preprod
observation) showing indexer behavior across a real reorg. This is the same boundary the
task brief pre-declared.

**Shared-finality note (Task 3b):** the `DepositsStateReader`'s per-ref `finalized` flag
derives from this same signal — contract state read via `queryContractState` (the
`CONTRACT_STATE_QUERY` / `contractAction` document) is indexer-served and therefore
finalized state; one finality definition, two consumers (deploy `awaitFinality` + deposit
crediting). The P3 I1 rule stands: the reader returns the VALUE, never a hardcoded `true`.

## Element 5 — tDUST balance read (deploy wallet)

**Status: Confirmed by execution** (SPIKE-2 §Funding step 6; re-executed 2026-07-24 for
four seeds on the current chain).

```js
import * as Rx from "rxjs";
import { unshieldedToken } from "@midnight-ntwrk/midnight-js-protocol/ledger";

const state = await Rx.firstValueFrom(wallet.state());
const dust = state.dust.balance(new Date()); // bigint — fee capacity; TIME-DEPENDENT (accrues)
const night = state.unshielded.balances[unshieldedToken().raw] ?? 0n; // bigint — generation capacity
const registered = state.unshielded.availableCoins.filter(
  (c) => c.meta?.registeredForDustGeneration,
);
```

Fees are spent in DUST, so **`assertCanDeploy`'s floor gates on the DUST read**; NIGHT +
registration status are the diagnostic explanation when DUST is low (unregistered NIGHT
generates nothing). `dust.balance(t)` takes the evaluation instant — inject the clock
(Task 3). Both reads are native `bigint` — never `Number()`.

Live results (2026-07-24, fresh chain): seeds `0x…01`/`…02`/`…03` each
`NIGHT=250000000000000`, 5 UTXOs all `registeredForDustGeneration`,
`DUST=1250000000000000000000000`. **Seed `0x…04` is EMPTY (`NIGHT=0`, `DUST=0`) — SPIKE-2
§Funding's "seeds 01–04" overstates; only 01–03 are genesis-funded on this devnet.** Seed
partitioning now: `…01` SPIKE-1, `…03` SPIKE-2, `…02` this task's live runs; there is no
fourth funded seed — new consumers fund child wallets from a genesis seed (SPIKE-2
§Funding steps 3–5).

## EC-38 discriminator — "deploy wallet out of tDUST", verbatim

**Status: Confirmed by execution** (four probes, 2026-07-24; throwing source read from the
installed dists).

**The failure is CLIENT-SIDE, at wallet balancing — the tx never reaches the node.** Every
probe failed before submission (balancing precedes `submitTransaction`), so there is no
node-level "out of funds" rejection reachable via this SDK path; a node-side error contract
for an underfunded-but-submitted tx stays OWNER-GATED (would require hand-crafting a tx
that bypasses the facade's balancing).

All four probes threw an Effect `FiberFailure` wrapping a tagged wallet error:

| Probe | Wallet state          | Operation | `error.message` (verbatim)                   | thrown from                                                                           |
| ----- | --------------------- | --------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1     | no NIGHT, no DUST     | transfer  | `Insufficient funds`                         | `wallet-sdk-unshielded-wallet@3.1.0` `#balanceSegment` (`dist/v1/Transacting.js:289`) |
| 2     | no NIGHT, no DUST     | DEPLOY    | `Insufficient Funds: could not balance dust` | `wallet-sdk-dust-wallet@4.1.0` (`dist/v1/Transacting.js:279`)                         |
| 3     | NIGHT, DUST=0 (unreg) | transfer  | `Insufficient Funds: could not balance dust` | dust-wallet, same site                                                                |
| 4     | NIGHT, DUST=0 (unreg) | DEPLOY    | `Insufficient Funds: could not balance dust` | dust-wallet, same site                                                                |

Shape (captured verbatim, both probes): outer `e.constructor.name === 'FiberFailureImpl'`,
`e.name === '(FiberFailure) Wallet.InsufficientFunds'`; inner cause error has
`_tag: 'Wallet.InsufficientFunds'` and `tokenType: 'dust'` for the dust case (the
unshielded case carries the NIGHT token type + an `amount`). Both throwing sites construct
`InsufficientFundsError` from `BalancingInsufficientFundsError` (installed-source read).

**Executor classification (`signAndSubmit` → `SubmitOutcome`):**

```ts
// EC-38: wallet cannot fund the fee leg — thrown CLIENT-SIDE by wallet balancing
// (FiberFailure name is stable across empty-wallet and dust-less probes 1–4).
function isInsufficientTdust(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return typeof name === "string" && name.includes("Wallet.InsufficientFunds");
}
```

matching on the tagged-error name (`Wallet.InsufficientFunds`), not the message —
`insufficient-tdust` covers both message variants (a deploy wallet with no NIGHT at all is
equally "out of funds"). Any other submit-path throw → `cause: "rejected"`.

## Gotchas carried for Tasks 2–3

- Wallet sync against the devnet takes ~30 s (`MidnightWalletProvider.build` + `start`);
  the deploy itself ~20 s (k≈13 proving dominates). Budget executor timeouts accordingly
  (EC-39 `timeoutMs` must exceed sync+prove+finality, not just finality).
- `MidnightWalletProvider.start()` auto-registers NIGHT for DUST when dust = 0; the
  lower-level `wallet.start(zswapSecretKeys, dustSecretKey)` + `syncWallet` path does NOT
  (how the probes kept a wallet dust-less). The deploy wallet must be dust-registered once
  (genesis seeds already are).
- pnpm ignored build scripts on install (`classic-level@3.0.0` among them). All entry
  points import cleanly, but the level-backed private-state store may need
  `pnpm approve-builds` for `classic-level` if its native binding is exercised at runtime —
  surface loudly in Task 2's devnet-gated test if it bites; do NOT lower the supply-chain
  gate silently.
- The indexer WS endpoint is `/api/v4/graphql/ws` (405 on the http path) — needed by
  `indexerPublicDataProvider`'s subscription URL argument even when only queries are used.
