# Design Brief: NYXT Deposit Mechanism on Midnight Pre-Prod (Q6)

**Status**: Discovery design brief — answers Q6, feeds Story 6 (token economy) and Story 10 (reconcile/settle)
**Date**: 2026-07-10
**Inputs**: PRD §13 (token economy), DECISIONS D13/D22/D25/D26, owner design intent (ERC-20-shaped, translated below)
**Method**: All Compact/SDK claims cite a midnight-expert skill, an example catalogue, or a live doc fetched 2026-07-10. Anything unconfirmable is flagged **[verify at implementation]**.

---

## 0. Executive summary

Recommend **Architecture C: a single `NyxtVault` contract with one `deposit` circuit** that, in one transaction and one signing ceremony, (a) receives the user's tNIGHT into the contract, (b) mints real on-chain NYXT directly into the contract's own vault balance, and (c) records an orchestrator-issued opaque `depositRef` in public ledger state. The orchestrator credits the Postgres NYXT ledger when the indexer's `contractActions` subscription delivers a successful, finalized `deposit` call whose decoded state contains a `depositRef` it pre-registered.

This satisfies the owner's intent (real NYXT minted on-chain for tNIGHT, custodied by Nyx) while collapsing the ERC-20-shaped two-step (mint to user, then transfer to vault) into one Midnight-native step: on Midnight the **mint recipient is a circuit parameter**, so "transfer NYXT to Nyx" becomes "mint NYXT to the vault" — no second ceremony, no user custody, no allowance machinery. NYXT is **unshielded**: the tNIGHT leg is transparent anyway (NIGHT is Midnight's unshielded native token), shielded contract tokens are archived/not-for-production upstream, and attribution — the decision that dominates this design — is only cheap and reliable when the deposit record is public state.

---

## 1. Owner intent, translated out of ERC-20 vocabulary

The owner's shape: *users pay tNIGHT to a token contract that mints NYXT; users transfer NYXT to Nyx via a second deposit/vault contract; the orchestrator observes and credits Postgres.* PRD §13 explicitly warns against porting account-model instincts. The translation table:

| ERC-20 instinct | Midnight-native reality | Source |
|---|---|---|
| One ERC-20 contract holding a `balances` mapping | Four token quadrants: shielded/unshielded × ledger(UTXO)/contract(account). A contract *mints ledger tokens* via a domain separator; token "color" = `tokenType(domainSep, contractAddress)`, deterministic and collision-resistant | compact-core:compact-tokens; token-architecture.md ("The Four Token Quadrants", "Token Colors") |
| `msg.sender` identifies the depositor | **No `msg.sender` exists.** `ownPublicKey()` is prover-supplied, *not* signer-bound — using it for identity/attribution is bypassable. Caller identity must be an explicit public parameter or a witness-derived key | compact-tokens/references/token-operations.md, "Security: ownPublicKey() is prover-supplied, not signer-bound" |
| Emit a `Deposit` event; backend listens | **Compact has no events.** "Off-chain indexing must rely on ledger state diffs" — the indexer streams contract calls with the resulting public state | token-patterns.md, Known Limitations; Midnight Indexer API v4 |
| `approve` + `transferFrom` pulls user tokens into a vault | The wallet **balances value directly into a contract-call transaction**: a circuit that calls `receiveUnshielded(...)` creates a token effect the user's wallet funds when it balances the tx. Docs: `balanceUnsealedTransaction` is "the best way to use native tokens in a DApp" for contract calls | docs.midnight.network/api-reference/dapp-connector (v4.0.1), "Balance a transaction"; compact-tokens skill |
| `payable` / `msg.value` for the tNIGHT payment | `receiveUnshielded(nativeToken(), amount)` inside the circuit; NIGHT/tNIGHT is the unshielded native token with the zero color | compact-tokens skill (unshielded ops, NIGHT & DUST); core-concepts:tokenomics ("NIGHT … Visibility: Unshielded (public)") |
| Two contracts (token + vault) | One circuit can mint, receive, and write state **atomically in one transaction**; a tx can even carry multiple contract calls | compact-core:compact-transaction-model ("Transaction Composition"; "No checkpoint = guaranteed-only") |

Two "NYXT token" interpretations exist and the choice matters:

- **Ledger token** (UTXO, minted via `mintUnshieldedToken`): a first-class on-chain asset with a color, visible in wallets/indexer, transferable as plain UTXOs. Midnight-native fungible token.
- **Contract token** (OpenZeppelin-Compact `FungibleToken` module: account-model `Map` of balances inside contract state): closest literal ERC-20 port, but every transfer is a circuit call + proof, and balances are keyed by witness-derived identities. compact-examples:code-examples → references/modules.md (FungibleToken).

Because D13 forbids per-prompt (indeed per-anything routine) user signatures and users never spend NYXT on-chain, NYXT needs no user-facing transfer machinery at all. The ledger-token mint is the right artifact: real, visible, supply-auditable, nearly free to implement.

---

## 2. Ground truth (verified constraints the design rests on)

1. **tNIGHT is unshielded.** NIGHT is the unshielded native utility token; the faucet pays tNIGHT to the wallet's unshielded address (`mn_addr_...`); fees are paid in tDUST generated from tNIGHT. [core-concepts:tokenomics; compact-tokens skill "NIGHT & DUST"; docs.midnight.network glossary via search]
2. **Contracts mint fungible tokens with a parametric recipient.** `mintUnshieldedToken(domainSep, value: Uint<64>, recipient: Either<ContractAddress, UserAddress>)` mints to a contract (incl. `kernel.self()` + `receiveUnshielded`) or straight to a user address. Shielded variant `mintShieldedToken` exists with nonce-evolution requirements. [compact-tokens skill + token-operations.md]
3. **A circuit with no `kernel.checkpoint()` executes entirely in the guaranteed phase** — all effects (coin receipt, mint, state writes) land atomically or the tx is rejected outright; no partial-success ambiguity. [compact-core:compact-transaction-model, "Checkpoint Rules"]
4. **The indexer exposes exactly what attribution needs.** GraphQL v4: `contractActions(address)` subscription streams every `ContractCall` with `entryPoint`, hex-encoded `state`, `zswapState`, `unshieldedBalances`, and the containing `transaction` (with `transactionResult.status ∈ {SUCCESS, PARTIAL_SUCCESS, FAILURE}`, `unshieldedCreatedOutputs`/`unshieldedSpentOutputs` each carrying `owner`, `value`, `tokenType`); plus `unshieldedTransactions(address)` streaming UTXO events per address. [docs.midnight.network/api-reference/midnight-indexer, fetched 2026-07-10]
5. **Finality is deterministic (GRANDPA).** AURA block production + GRANDPA finality; testnet block time 6 s, finality typically 1–2 blocks (~≤18 s). Pre-prod figures assumed equal **[verify at implementation]**. [docs.midnight.network/concepts/network-architecture/consensus via search 2026-07-10]
6. **Shielded contract tokens are off the table.** OpenZeppelin archived ShieldedERC20 ("DO NOT USE IN PRODUCTION"): no post-issuance spend enforcement, supply tracking breakable by direct burns to `shieldedBurnAddress()`. [token-architecture.md warning; token-patterns.md "Supply Tracking Caveat"; compact-examples tokens.md]
7. **Wallet flow for a contract call with value** (matches D8 Lace-delegated proving): build unproven call tx → prove via `connected.getProvingProvider(new FetchZkConfigProvider(...))` → `balanceUnsealedTransaction` (wallet adds tNIGHT inputs + DUST fees) → `submitTransaction`. [docs.midnight.network/api-reference/dapp-connector, "Delegate proving" example]

---

## 3. Candidate architectures

### A — PRD §13 literal: lock tNIGHT, NYXT exists only in Postgres

One contract, one circuit `deposit(depositRef, amount)`: `receiveUnshielded(nativeToken(), amount)` + write `depositRef → amount` to public ledger state. No NYXT on chain at all. Admin-gated `withdraw` releases accumulated tNIGHT to the Nyx treasury address.

- ✅ Smallest possible contract; 1 signing ceremony; attribution identical to C.
- ❌ **Fails the PRD's own scope line**: "deposit contract **and real NYXT minting** are Phase 1 scope — the platform's own dogfood moment" (PRD §13). No on-chain NYXT artifact to point at, no supply to reconcile against, settle (Story 10) has nothing token-shaped to burn.

### B — Owner's literal shape: mint NYXT to user, user transfers NYXT to a vault

Contract 1 mints NYXT (ledger token *or* OZ `FungibleToken` contract token) to the payer in exchange for tNIGHT; the user then moves NYXT to Nyx — as a plain unshielded UTXO transfer to a Nyx-held address (`makeTransfer` with `tokenType: nyxtColor`), or as a second `depositIntoVault` circuit call.

- ❌ **Two signing ceremonies per top-up** with current tooling (mint call, then transfer). Midnight *transactions* can carry multiple contract calls (compact-transaction-model, "Transaction Composition"), so a one-tx composition is theoretically possible, but midnight-js/connector support for composing two user-signed calls in one tx is unverified **[verify at implementation]** — and even if it works, it is just Architecture C with extra steps.
- ❌ Attribution splits across two legs (which mint belongs to which vault transfer?), user custody of NYXT invites transfers to third parties that mean nothing to the Postgres ledger, and the OZ FungibleToken variant drags in witness-derived-identity keying (modules.md) that Nyx doesn't need.
- ✅ Only advantage: the user briefly *holds* NYXT in Lace. Cosmetic; see §9 open item 7 for a cheaper way to get that.

### C — Combined single contract: mint + deposit in one circuit (RECOMMENDED)

One `NyxtVault` contract, one user-facing circuit, no checkpoint (fully guaranteed-phase, atomic):

```compact
// SKETCH ONLY — signatures per compact-tokens skill; compile-verify in Story 6
pragma language_version >= 0.22;
import CompactStandardLibrary;

export ledger deposits: Map<Bytes<32>, Uint<128>>;   // depositRef -> stars paid
export ledger depositCount: Counter;
export ledger totalMinted: Uint<128>;                 // see conflict note, §8
// + admin: AdminPublicKey pinned at deploy (witness-derived Identity/Ownable pattern)

export circuit deposit(depositRef: Bytes<32>, amount: Uint<64>): [] {
  assert(!deposits.member(disclose(depositRef)), "ref already used");
  // 1. pull the user's tNIGHT into the contract (wallet funds this on balance)
  receiveUnshielded(nativeToken(), disclose(amount) as Uint<128>);
  // 2. mint NYXT straight into the vault (contract's own balance)
  const color = mintUnshieldedToken(pad(32, "nyxt:v1"), disclose(amount),
      left<ContractAddress, UserAddress>(kernel.self()));
  receiveUnshielded(color, disclose(amount) as Uint<128>);
  // 3. public, append-only attribution record
  deposits.insert(disclose(depositRef), disclose(amount) as Uint<128>);
  depositCount.increment(1);
  totalMinted = disclose(totalMinted + (amount as Uint<128>)) as Uint<128>;
}
```

Feasibility of the combination is grounded, not assumed: a single circuit may perform multiple token operations plus state writes, all mapped to one transaction/one proof (compact-transaction-model); the mint-to-self + `receiveUnshielded` pairing is the documented "Unshielded Mint to Self" pattern (token-patterns.md); `receiveUnshielded(nativeToken(), …)` funded by the user's wallet at balancing time is the documented native-token-into-contract path (dapp-connector docs, "Balance a transaction"). End-to-end wallet balancing of a *contract's* native-token receive on pre-prod is the one link to prove in a spike **[verify at implementation]** — it is also exactly the Phase-0-style de-risk PoC this story needs.

- ✅ One ceremony. Real NYXT minted on-chain (dogfood satisfied). Vault custody from birth — the owner's "transfer to Nyx" intent, achieved by making the vault the mint recipient. Attribution is one public map entry. Atomic: tNIGHT received ⇔ NYXT minted ⇔ record written.
- ✅ On-chain invariant for Story 10: vault NYXT balance = Σ deposits − Σ settled; contract tNIGHT balance backs it 1:1.
- ❌ Slightly more contract surface than A (mint + settle circuits); shared `totalMinted` accumulator needs a concurrency decision (§8).

### D — Midnight-native contract-free variant (documented, not recommended as primary)

No contract: Nyx derives a **unique unshielded deposit address per user** from a server-held HD seed (wallet-sdk supports HD derivation; midnight-wallet plugin skills cover derivation and address watching). User does a plain `makeTransfer` of tNIGHT to their personal address — one popup, no proof, no DUST-for-proving subtleties. Attribution = the address itself, via the indexer's `unshieldedTransactions(address)` subscription (`createdUtxos.owner/value/tokenType`).

- ✅ Simplest and most robust attribution on the menu (exchange-style); fewest moving parts; zero contract risk.
- ❌ **Fails D13's dogfood requirement outright** — no Compact contract, no NYXT mint. Keep it in the back pocket as (a) the fallback if the C spike hits a wall in wallet balancing of contract-bound native tokens, and (b) a useful mental model: C's attribution should be *at least* as deterministic as D's.

---

## 4. The attribution problem (first-class)

**When a deposit arrives, how does the orchestrator know WHICH user to credit?** There is no `msg.sender`, no events, and no documented free-text memo field on Midnight transactions — the public contract state **is** the memo channel (token-patterns.md Known Limitations: indexing rides on ledger state diffs).

### 4.1 What the indexer can and cannot see

| Signal | Unshielded (tNIGHT leg, unshielded NYXT) | Shielded (hypothetical shielded NYXT) |
|---|---|---|
| Contract called + which entry point | ✅ `ContractCall.entryPoint` | ✅ same — contract involvement is always visible (token-architecture.md) |
| Resulting public contract state | ✅ `ContractCall.state` (hex; decode with the compiled contract's generated ledger reader — token-operations.md "TypeScript Touchpoints") | ✅ public ledger fields still visible; *witness data* is not |
| Who paid | ✅ `transaction.unshieldedSpentOutputs[].owner` (Bech32m address) | ❌ sender hidden (commitments/nullifiers unlinkable — core-concepts:data-models) |
| How much | ✅ `unshieldedSpentOutputs[].value`, `ContractCall.unshieldedBalances` | ❌ value hidden |
| Token type | ✅ `tokenType` visible | ❌ hidden |
| Tx success | ✅ `transactionResult.status` (+ per-segment results) | ✅ same |

[All indexer fields: docs.midnight.network/api-reference/midnight-indexer, v4.]

### 4.2 Candidate attribution mechanisms

1. **Depositor-supplied public identifier in ledger state (recommended).** The deposit circuit takes `depositRef: Bytes<32>` as a *public* parameter and records it. **Can a contract do this? Yes** — that is an ordinary public-ledger `Map` insert of a circuit parameter (compact-core:compact-ledger domain; the disclosure rules only bite witness-derived values, and `depositRef` is a public input). The orchestrator mints a random 32-byte ref when the user clicks "top up", stores it against the user row, injects it into the call, and matches it when the indexer event arrives. Deterministic, replay-proof (unique-ref assert + Postgres unique constraint), and works even if the user pays from an unexpected wallet.
2. **Sender-address attribution.** Match `unshieldedSpentOutputs[].owner` against the unshielded address captured at wallet-connect (S5 session; DApp connector `getUnshieldedAddress`). Works today because the connector exposes a single unshielded address per wallet — but it is a *heuristic*: multi-address wallets, address rotation, or paying from a different wallet silently break it. Use as a defence-in-depth cross-check on top of (1), never as the primary key, and never as authorization.
3. **`ownPublicKey()` as identity — forbidden.** It is prover-supplied and not cryptographically bound to the signer; any attribution or authorization built on it is spoofable (token-operations.md security note; every modern example in compact-examples uses witness-derived identities instead — modules.md, applications.md).
4. **Memo-equivalents outside contract state.** None documented at the transaction level; `Transaction.identifiers` exist but are protocol identifiers, not free-form **[verify at implementation if ever needed]**. The `depositRef` ledger record *is* Midnight's memo.

### 4.3 Privacy trade-offs — and why this settles shielded-vs-unshielded

- The tNIGHT leg is **public no matter what**: payer address, amount, and contract are on the transparent ledger (NIGHT is unshielded). Shielding NYXT therefore hides almost nothing about a top-up that the funding leg doesn't already reveal.
- Shielded NYXT would actively hurt: attribution would have to move into witness-supplied data and bespoke disclosure, the vault would juggle `QualifiedShieldedCoinInfo`/`mt_index`/nonce evolution with a single hot coin (a concurrency chokepoint), mint amounts cap at `Uint<64>`, `sendShielded` doesn't create recipient ciphertexts, and supply accounting is unfixably unreliable (token-operations.md; token-patterns.md; ShieldedERC20 archived).
- The remaining leak to minimize: **don't put stable user identifiers on-chain.** `depositRef` must be a fresh random value per top-up (not a user ID, session key, or Lace address), so the public map is a set of opaque one-time receipts; only Nyx's Postgres links refs to accounts. A public observer still sees "address X topped up N tNIGHT at time T" — acceptable on pre-prod and inherent to unshielded NIGHT.

**Conclusion: unshielded NYXT + opaque per-top-up `depositRef` in public contract state.** Attribution requirements dominate, and they point the same way as implementation simplicity.

---

## 5. User signing UX per architecture

Per D13 the budget is **one signing ceremony per top-up**. "Ceremony" = one transaction the user approves; Lace may render one or several dialogs for prove/balance/submit of that single tx — the exact popup count is empirical **[verify at implementation]** (fold into the Q2 Lace-proving PoC; D8 already routes proving through `getProvingProvider(FetchZkConfigProvider)`).

| Arch | Ceremonies | What the user signs |
|---|---|---|
| A | **1** | One contract-call tx: `deposit(ref, amount)`; wallet balancing attaches `amount` tNIGHT + tDUST fees (`balanceUnsealedTransaction` → `submitTransaction`) |
| B | **2** (composition to 1 unproven) | Tx 1: mint call funded with tNIGHT. Tx 2: NYXT transfer to Nyx (`makeTransfer` with `tokenType: nyxtColor`) or second circuit call |
| C | **1** | One contract-call tx: `deposit(ref, amount)` that simultaneously pays tNIGHT in and mints vault NYXT — same wallet flow as A |
| D | **1** (lightest: plain `makeTransfer`, no circuit proof) | tNIGHT transfer to the user's personal deposit address |

[Wallet flow primitives: docs.midnight.network/api-reference/dapp-connector v4.0.1.]

---

## 6. Credit evidence & finality

The orchestrator credits Postgres only when **all** of the following hold:

1. **Indexer event**: `contractActions(vaultAddress)` WebSocket subscription (resumable via `offset` after reconnects) delivers a `ContractCall` with `entryPoint == "deposit"`.
2. **Success**: the containing `transaction.transactionResult.status == SUCCESS`. With a checkpoint-free circuit there is no `PARTIAL_SUCCESS` window for the deposit itself — inclusion implies all three effects landed (compact-transaction-model). Treat `PARTIAL_SUCCESS`/`FAILURE` as no-credit.
3. **State match**: decode `ContractCall.state` with the compiled contract's generated ledger reader and confirm `deposits[depositRef] == amount` for a `depositRef` that exists in Postgres as a *pending* top-up intent. Credit the **on-chain amount**, not the intent amount (a mismatch means the user edited the call; the chain wins). Exact decode API for indexer-returned hex state **[verify at implementation]**.
4. **Cross-check (soft)**: some `unshieldedSpentOutputs[].owner` equals the session's registered unshielded address; log-and-alert on mismatch, don't block (it's a donation, not an attack — the ref holder gets the credit).
5. **Finality gate**: the containing block is GRANDPA-finalized. Testnet: 6 s blocks, finality ~1–2 blocks — a top-up confirms in well under a minute. Whether the indexer already serves only finalized blocks is **not stated** in the indexer docs/README (checked 2026-07-10) **[verify at implementation]**; until confirmed, gate on `block.height ≤ finalized head` (node RPC) or a fixed 2-block depth. Because GRANDPA finality is deterministic, there is no probabilistic-reorg tail to model once finalized; the DApp-connector transaction history also distinguishes pending/confirmed/finalized/discarded as a secondary signal.

**Idempotency & lifecycle**: `depositRef` is single-use on-chain (assert) and unique-keyed in Postgres — duplicate indexer deliveries, replays, and subscription resumes are all no-ops. Pending intents expire after a TTL; a late-arriving on-chain deposit for an expired ref still credits (evidence outranks TTL). Pre-prod resets wipe contract state — record the deployment (address + genesis hash) with each credit row so a reset is detected rather than silently reconciled against a fresh chain.

---

## 7. Reconcile & settle hooks (Story 10, D22)

- **Per-prompt metering, credit-backs (D22 refunds), and declined-prompt non-charges (D25) never touch the chain.** They are Postgres ledger rows (D26). Consequence: on-chain NYXT is **gross**, not net — vault NYXT tracks total minted minus total settled, never the sum of live user balances. That asymmetry is by design (D13: chain = top-up rail).
- **Lazy settle** (orchestrator-only, admin-gated, witness-derived admin identity — never `ownPublicKey()`): periodically compute consumed NYXT (Σ decrements − Σ credit-backs since last settle) and call `settle(amount)`, which (a) asserts vault NYXT ≥ amount via `unshieldedBalanceGte` (the comparison intrinsics, not exact-read `unshieldedBalance`, per the stale-read caveat — token-operations.md), (b) retires `amount` NYXT, (c) `sendUnshielded(nativeToken(), amount, treasury)` releases the matching tNIGHT to the Nyx treasury address. Unconsumed user balances stay 1:1 backed by locked tNIGHT — which keeps a future "withdraw unspent NYXT to chain" story possible without redesign.
- **Burn mechanics for unshielded NYXT are an open detail**: the documented burn path (`shieldedBurnAddress()`) is a shielded-send construct; for vault-held unshielded NYXT the options are sending to a provably unspendable `UserAddress`, or simply keeping retired NYXT in the vault behind a `totalSettled` ledger counter (economically equivalent — only this contract can mint the color). **[verify at implementation]** — Story 6/10 decides; the counter variant is the safe default.
- **Per-architecture**: A has nothing to burn (settle = tNIGHT withdrawal only; supply reconciliation lives entirely in Postgres). B must first *recover* user-held NYXT before settling — another reason it fights the grain. C's settle is two stdlib calls plus a counter. D settles by plain treasury sweep of deposit addresses.
- **Reconciliation invariant** (worth a scheduled job + Story 12 display): `totalMinted − totalSettled == vault NYXT balance` (indexer `unshieldedBalances` on the contract) and `totalMinted == Σ deposits map` — any drift is a bug alarm, and it's checkable from public state alone. This is the dogfood dividend of C over A.

---

## 8. Compact implementation complexity per architecture

Building blocks all come from the stacks the platform itself dogfoods (MNE modules via compact-examples; stdlib via compact-core) — no novel cryptography anywhere on the recommended path.

| | Existing blocks (cite) | Custom | Risk |
|---|---|---|---|
| **A** | `Initializable`, `Ownable`+`Identity` (witness-derived admin) — compact-examples modules.md; `receiveUnshielded`/`sendUnshielded` stdlib — compact-tokens | deposit-log map + withdraw circuit (~40 lines) | **Low**, but fails PRD §13 scope |
| **B** | `FungibleToken`+`Identity` modules (modules.md) or ledger-token mint (token-patterns.md); `AccessControlledToken` / `FungibleTokenMintablePausableOwnable` as near-templates (tokens.md) | mint-for-tNIGHT circuit, vault contract or transfer-watching, cross-leg attribution matching | **Medium-high** — 2 ceremonies, split attribution, user custody edge cases; no payoff |
| **C** | Everything in A + documented "Unshielded Mint to Self" pattern (token-patterns.md) | `deposit` (~15 lines beyond A), `settle` (~10 lines), `totalMinted/totalSettled` accounting | **Low-medium** |
| **D** | wallet-sdk HD derivation + indexer address subscription (midnight-wallet skills; indexer docs) | none on-chain; server-side key mgmt for deposit addresses | **Lowest technically; fails dogfood** |

C's residual risks, named:

1. **Wallet balancing of a contract-bound native-token receive** — the documented path (dapp-connector "Balance a transaction") but the single link not yet exercised by this team on pre-prod. Mitigation: 1-day spike before Story 6 design freezes (also derisks A).
2. **State-conflict window on shared accumulators.** Concurrent deposits touch distinct `deposits` keys (fine) and `depositCount` (a `Counter` — increment-friendly, the conflict-minimizing ADT the transaction-model skill recommends), but `totalMinted: Uint<128>` is read-modify-write shared state: two deposits proven against the same pre-state can conflict, failing the second (compact-transaction-model, "Concurrency and Conflicts"). Options: drop `totalMinted` (derive it off-chain from the map / vault balance) or accept client-side retry. Deposits are rare (one per top-up, D24 keeps per-project traffic serial), so either is fine — decide in Story 6.
3. **Disclosure hygiene**: all deposit inputs are public parameters, so `disclose()` placement is mechanical; the admin path must use the witness-derived identity pattern (compact-core:compact-security; the `ownPublicKey()` anti-pattern).
4. Standard mint-function type traps caught by review tooling: mint amount `Uint<64>` vs send/receive `Uint<128>` casts; **reversed `Either` recipient order** between shielded and unshielded functions (token-operations.md "Common Mistakes").

---

## 9. Recommendation

**Adopt Architecture C** — single `NyxtVault` contract; one guaranteed-phase `deposit(depositRef, amount)` circuit that receives tNIGHT, mints unshielded NYXT to itself, and records an opaque per-top-up ref in public state; orchestrator credits Postgres on a finalized, successful, state-matched `contractActions` event.

Decisive reasons:

1. **One signing ceremony** — the only shape (with A/D) that honors D13's hard UX constraint; B structurally needs two.
2. **Honors the owner's full intent where A doesn't**: real NYXT minted on-chain (PRD §13 Phase 1 dogfood), Nyx-custodied, with a public supply invariant Story 10 and Story 12 can reconcile against.
3. **Attribution is solved in the same stroke** — the depositRef record is the Midnight-native memo, deterministic and replay-safe, with sender-address as a soft cross-check; no reliance on the spoofable `ownPublicKey()`.
4. **Unshielded is the right privacy posture**: the funding leg is transparent by protocol design; shielded NYXT would add cost and break supply accounting while hiding nothing that matters.
5. **Minimal custom Compact** on top of catalogued MNE/OpenZeppelin-Compact blocks — a credible, review-friendly dogfood contract rather than a sprawling one.

### Open items Story 6's deep-dive must settle

1. **Spike (blocking)**: end-to-end pre-prod PoC — Lace: prove → `balanceUnsealedTransaction` funding `receiveUnshielded(nativeToken(), …)` → submit; count actual popups (merge with Q2 PoC).
2. Indexer finality semantics (finalized-only vs best-chain) and the concrete finality gate; pre-prod block/finality timings.
3. Exact decode path for indexer hex `state` (generated ledger reader vs midnight-js helper) and the orchestrator subscription/recovery design (offsets, missed-event replay via `contractAction(address, offset)` queries).
4. Unshielded NYXT retirement at settle: unspendable-address burn vs `totalSettled` counter.
5. `totalMinted` accumulator: keep (accept conflicts/retries) or derive off-chain.
6. NYXT:tNIGHT rate — fix 1 star : 1 NYXT-unit in-circuit vs contract-parameterized; decimals/denomination for Story 12 display.
7. Optional user-visible NYXT "receipt" minted to the payer's address (`mintUnshieldedToken` right-recipient) — Lace-visible balance vs confusion with the authoritative Postgres balance. Default: no.
8. `depositRef` lifecycle: TTL, amount-mismatch policy (chain wins — confirm), late-arrival crediting.
9. Admin/settle key management: witness-derived admin secret custody in the orchestrator (relates to D9 server-held deploy key).
10. Pre-prod reset runbook: detect chain reset (genesis hash), redeploy vault, mark Postgres credits as legacy-backed.
11. Confirm current Compact/stdlib signatures at build time against the pinned toolchain (this brief cites skill-documented signatures as of compiler ~0.29 / language ≥ 0.22; the platform pins via D30's toolchain MCP).

---

### Source index

- **Skills (primary)**: compact-core:compact-tokens (+ references/token-architecture.md, token-operations.md, token-patterns.md); compact-core:compact-transaction-model; core-concepts:data-models; core-concepts:tokenomics; compact-examples:code-examples (references/modules.md, tokens.md, applications.md); compact-core:compact-security (via token-operations security notes).
- **Live docs (fetched 2026-07-10 via Rover/search)**: Midnight Indexer API v4 — docs.midnight.network/api-reference/midnight-indexer (schema source of truth: `indexer-api/graphql/schema-v4.graphql`); Midnight DApp connector API v4.0.1 — docs.midnight.network/api-reference/dapp-connector; Consensus — docs.midnight.network/concepts/network-architecture/consensus; midnight-indexer README — github.com/midnightntwrk/midnight-indexer.
- **Project inputs**: `.sdd/PRD.initial.md` §13/§14; `discovery/archive/DECISIONS.md` D8, D9, D13, D22, D24, D25, D26, D30; `discovery/OPEN_QUESTIONS.md` Q6; `discovery/STATE.md` story landscape.
