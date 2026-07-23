# Nyx — Product Requirements & Technical Specification

> **What this is:** Nyx is a zero-trust, ultra-lean, multi-agent generative UI
> platform for **Midnight Network** developers — a purpose-built equivalent to
> Bolt, Lovable, or V0. A user connects their Midnight wallet, deposits tNIGHT
> to buy NYXT credit, and prompts a multi-agent system that scaffolds,
> compiles, tests, and previews a full DApp — a data-protecting smart contract
> written in **Compact** plus a React frontend — with contracts deployed to
> Midnight pre-prod.
>
> (Named for the Greek primordial goddess of night. The credit token ticker is
> **NYXT** throughout this doc — a placeholder ticker, swappable in one
> find-and-replace if a better one lands.)
>
> **Audience:** the agent (or engineer) picking this up to plan and build. This
> document is ground truth for decisions already made. Where something is
> deliberately deferred or unverified, it is flagged as an open question. **Do
> not silently re-decide settled questions** — if a decision looks wrong,
> surface it explicitly with reasoning rather than quietly building something
> else.

---

## 1. Critical context

1. **Production-quality code; deliberately lean feature set; pre-prod
   network.** Nyx targets Midnight **pre-prod**, where tokens (tNIGHT, tDUST,
   NYXT) carry no real-world value. That constrains exactly two things: which
   network we point at, and how large the feature set is. It is **not** a
   licence to cut corners. Everything that ships — the agents, Compact
   generation, verification, contract deployment, the token economy, the
   security boundaries — must be genuinely real and built to production
   standard: real error handling, real key hygiene, no faked flows, no
   "good enough for a demo" code. **The feature set is set by the project
   owner and only the project owner changes it.** If scope and the quality
   bar come into tension, the resolution is never lower quality and never a
   quietly dropped or hollowed-out feature — it is raising the conflict to
   the owner, who decides what (if anything) gets cut.

2. **Compact is not in any frontier model's training data.** Models
   hallucinate Compact syntax with total confidence — inventing functions,
   misremembering ledger/witness/disclose semantics, producing code that fails
   at compile time. This is *the* central technical risk, and the external
   tooling stack (§3) exists to counter it. **Rule for every agent, including
   the one building this platform: assume your instinct about Compact syntax
   is wrong until a tool confirms it.** Compile-error feedback alone is not a
   substitute for retrieval — an agent with no reference material just loops
   on compile errors, inventing new wrong syntax each round.

---

## 2. Architectural principles

- **KISS:** no heavy, stateful microVM infrastructure. Standard web protocols,
  ephemeral tasks, and browser-driven compute.
- **YAGNI:** no job queues, no distributed state machines, no persistent
  remote container clusters. The client browser and isolated MCP endpoints
  handle lifecycles naturally.
- **POLA:** all internal tool-calling is standardized on the **Model Context
  Protocol (MCP)** — the compiler, the docs layer, and the skills layer all
  present one uniform tool surface to the agents, rather than a mix of custom
  REST and AI plumbing.
- **Zero-Trust, Zero-Idle:** the expensive compute — the Node dev server for
  previews and zero-knowledge proof generation — runs on the **user's
  machine**. The backend is the agent orchestrator plus a stateless compile
  service. Nothing idles for money, and no service trusts another by default.

Lean architecture is a quality measure here, not a shortcut: fewer moving
parts means fewer failure modes to get production-right.

---

## 3. External tooling (the spine)

All three tools below are built by the project owner. Do **not** confuse them
with similarly-named projects — there is an unrelated "Tome" by Runebook and a
dead `midnight-mcp` by a third party; neither is what we use.

| Tool | What it is | Role in our stack |
|---|---|---|
| **Midnight Expert (MNE)** | Marketplace of **Claude Code plugins** — skills, agents, commands, ~37k lines of Compact/DApp reference. Includes `compact-core`, `midnight-dapp-dev` (scaffolds Vite + React 19 + shadcn + Tailwind v4 + Lace), `compact-testing` (OpenZeppelin simulator + Vitest), `midnight-verify`, `midnight-tooling`, `midnight-status-codes`. | The "doing" layer — the agents' capability surface for writing and verifying Compact and DApp code. |
| **Tome** | Rust CLI + MCP server. Builds a **local semantic index** over Claude-Code-format plugin catalogs (SQLite + sqlite-vec + reranker) and exposes a **search-then-load** MCP flow (`search_skills` → `get_skill_info` → `get_skill`). Works across ~16 harnesses. | Projects MNE skills into our **non-Claude-Code** (Vercel AI SDK) agents, loading only the skill needed and keeping context lean. This is what makes the AI SDK choice viable. |
| **Midnight Manual (mnm)** | Cited docs Q&A over live Midnight docs + source. Every answer trust-ranked and cited. **Hosted by default** (no server to run), also available as stdio MCP. In preview. | The "knowing" layer — language semantics, network details, "how does X actually work". |

**Division of labour:** mnm answers "how does DUST work"; MNE writes and
verifies the contract that uses it; Tome routes the agent to the right MNE
skill without drowning its context.

Links:
- Tome: https://tome-mcp.com/ · https://github.com/devrelaicom/tome
- MNE: https://midnightntwrk.expert/ · https://github.com/devrelaicom/midnight-expert
- mnm: https://manual.midnightntwrk.expert/ · https://github.com/devrelaicom/midnight-manual
- Background on why the third-party `midnight-mcp` was retired: https://docs.midnight.network/blog/migrating-to-kapa-and-midnight-expert

> ⚠️ **Web search is near-useless for these tools** — they are built in the
> open but not publicised. Read the GitHub repos and docs sites directly;
> don't trust a search index's summary of them.

---

## 4. System architecture overview

```
+---------------------------------------------------------------------------------+
|                                USER'S BROWSER                                   |
|                                                                                 |
|  +---------------------------+                +-------------------------------+ |
|  |     Nyx Chat Interface    | <=WebSocket==> | StackBlitz WebContainer iframe| |
|  |                           |  (bidirectional| - In-memory VFS (Vite app)    | |
|  | - Lace Wallet Extension   |   event proto, | - npm install / vite dev / HMR| |
|  | - Token Ledger view       |   see §12)     | - Vitest + OZ simulator (§7)  | |
|  +---------------------------+                +-------------------------------+ |
|        ^   "Open Preview in New Tab" escape hatch ----+  (Lace injects here)    |
+--------|------------------------------------------------------------------------+
         |  WSS                                    ^ HTTPS (fetch zk artifacts,
         v                                         |  content-hashed URLs)
+------------------------------------+     +------------------------------+
|     MAIN APP SERVER (Fly.io)       |     |     CLOUDFLARE R2 (CDN)      |
| - Vercel AI SDK supervisor swarm   |     | - zk artifacts (prover/      |
| - WebSocket + session state        |     |   verifier keys, zkIR)       |
| - NYXT ledger (Postgres)           |     | - 1-day lifecycle; recompiled|
| - Contract deploy key (NEVER       |     |   on project open            |
|   leaves this box) → pre-prod      |     | - $0 egress                  |
+------------------------------------+     +------------------------------+
         |  Fly private 6PN mesh (.flycast — no public IP)
         v
+------------------------------------+
|  MIDNIGHT COMPILER MCP (Fly.io)    |
| - scale-to-zero machine            |
| - native compactc (pinned version) |
| - uploads artifacts to R2          |
+------------------------------------+
```

---

## 5. Agent architecture

**A custom Vercel AI SDK supervisor swarm**, with MNE skills served via Tome's
MCP, mnm as an MCP tool, and the compiler as an MCP tool. Not Claude Code
headless.

- **Why the AI SDK:** the product's selling point is model choice — bring your
  own frontier key (Anthropic, OpenAI, Gemini, or any OpenAI-compatible
  endpoint via `createOpenAICompatible`) or use our hosted mid-tier model.
  Model-swappability is the requirement, and Tome exists precisely to project
  MNE's Claude-Code-format skills into a non-Claude-Code harness.
- **Swarm shape:** a **supervisor agent** routes work to specialized
  sub-agents — **Scaffolding, Planning, Implementation, Review**. Cheap models
  (Haiku-class) handle intent classification and scaffolding mechanics;
  high-reasoning models (Sonnet-class and up) write Compact and drive the
  verification loop.
- **Cold start:** there is no template system. The Scaffolding sub-agent
  orients itself at project birth via Tome (`search_skills` →
  `midnight-dapp-dev`, `compact-core`, etc.) and mnm. This makes Tome
  retrieval quality load-bearing — it is a Phase 0 de-risk item (§15).
- **Boundary:** we call MNE verify/tooling capabilities as **discrete MCP tool
  calls**. Do NOT attempt to reimplement MNE's internal multi-agent
  orchestration (e.g. `midnight-verify`'s agent swarm) inside our supervisor.
- **BYOK** is a settings-page CRUD feature (encrypt keys at rest) dressed up
  as AI infrastructure — it is the easiest item in the plan and lands last
  (Phase 3).

---

## 6. Execution environment: WebContainers

**StackBlitz WebContainers running in an `<iframe>`** execute the generated
app entirely in the user's browser: in-memory virtual filesystem,
`npm install`, `vite dev`, hot-module reload.

- **Generated app stack: Vite + React 19 + shadcn + Tailwind v4** — matching
  MNE's `midnight-dapp-dev` scaffold, and light enough to boot quickly inside
  a WebContainer.
- **Why WebContainers:** zero server-side runtime cost (no per-minute cloud
  sandbox billing), no user-inspectable shell on our infrastructure (backend
  prompts and configuration never enter the execution environment), and a
  natural lifecycle — tab closes, compute stops.
- **Cross-origin isolation:** WebContainers need `SharedArrayBuffer`, so the
  main app must send:

  ```http
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Opener-Policy: same-origin
  ```

  Consequence: any third-party asset loaded in the preview — including our R2
  artifacts (§9) — must respond with permissive CORS/CORP headers, or the
  fetch dies silently.
- **⚠️ Licensing:** the WebContainer API requires a **commercial license** for
  production/for-profit use. Confirm pricing and terms before building on it
  (open question, §14).
- **The wallet escape hatch:** sandboxed iframes block browser-extension
  injection, so `window.midnight` never appears inside the preview iframe.
  Nyx therefore shows a prominent **"Open Preview in New Tab"** button that
  opens the preview top-level, where the Lace extension can inject and the
  user can sign real pre-prod transactions. Two caveats: the WebContainer
  process lives in the *original* tab (closing it kills the preview), and
  Lace injecting into the WebContainer preview origin is an **assumption to
  verify in Phase 0**, not an established fact.
- **Accepted implication:** the agent's execution and test environment is the
  user's browser tab, so agent work requires an active session. This is
  acceptable for a chat-driven product — the user prompting *is* the tab
  being open — but long-running agent turns need the tab alive, and the UI
  must communicate this state explicitly rather than fail mysteriously.

---

## 7. The verification loop

**There is no local devnet — not per-project, not shared.** Determinism comes
from the simulator; realism comes from actual pre-prod deploys.

- **Static validity (every agent iteration):** compile via the **compiler MCP**
  (§8) — server-side, agent-driven, independent of the browser.
- **Behavioural validity (every agent iteration):** the **OpenZeppelin Compact
  simulator under Vitest, running inside the WebContainer**
  (`@openzeppelin-compact/contracts-simulator` / `createSimulator()`, per
  MNE's `compact-testing` skill). In-process, deterministic, no chain. Test
  results and runtime errors stream back to the agent over the WebSocket
  event protocol (§12). **Tests must be deterministic — flakiness is
  unacceptable.**
- **Deployment validity (on redeploy):** an actual contract deploy to shared
  **pre-prod** — real proofs, real indexer. This catches "passes tests but
  won't deploy".

---

## 8. Isolated compiler service

A standalone **MCP server wrapping the native Midnight compiler (`compactc`)**,
deployed as its own Fly.io app. It exposes a `compile` tool to the agents.

- **Private by construction:** the app has **no public IP**. It is reachable
  only over Fly's private WireGuard mesh (6PN) at
  `http://midnight-compiler-mcp.flycast`. There are no auth tokens to leak
  because there is no public surface.
- **Scale-to-zero:** Fly's proxy stops the machine when idle ($0 compute) and
  wakes it in milliseconds on the next compile tool call.
- **Stateless:** takes Compact source, returns diagnostics plus artifact URLs.
  It uploads prover keys, verifier keys, and zkIR to R2 — the compiler service
  holds the R2 **write** credentials; browsers only ever read.
- **Pin the Compact compiler version and surface it to the agents.** Compact
  syntax drifts between compiler versions; version skew is a real failure
  mode.
- **Sizing:** proving-key generation is the heavy part of compilation. Size
  the machine and tool-call timeouts for it, and define behaviour under
  concurrent compile requests (queue inside the MCP vs. multiple machines) —
  open question (§14).

---

## 9. Artifact storage: Cloudflare R2

Ephemeral host for compilation artifacts (prover keys, verifier keys, zkIR),
fronted at `https://artifacts.nyx.example/` (placeholder — final domain is an
open question, §14).

- **Zero egress fees:** prover keys are large and fetched repeatedly by
  browsers during proof generation. On S3 that is a bandwidth bill; on R2 it
  is $0.
- **Ephemerality:** 1-day Object Lifecycle Rules plus deletion on project
  close keep time-weighted storage inside R2's 10GB free tier. **Artifacts
  are recompiled on project open** — the compiler MCP repopulates R2 from the
  persisted project source (§11).
- **Cache strategy:** artifact paths are **content-hashed per compile** (e.g.
  `artifacts.nyx.example/<project-id>/<content-hash>/prover.key`) and served
  with immutable, long-lived `Cache-Control`. A new compile produces new
  URLs, so stale-edge-cache problems cannot occur and repeat fetches are
  CDN-fast.
- **Headers:** the R2 bucket/custom domain must serve CORS/CORP headers
  compatible with the cross-origin-isolated preview (§6), or artifact fetches
  fail silently.

---

## 10. The cryptographic proving layer

Generated apps are scaffolded with this Midnight JS SDK provider suite:

- **Proof + wallet:** `dappConnectorProofProvider` hooked into
  `window.midnight` — delegates zero-knowledge proving and transaction
  signing to the user's Lace wallet extension. We run **no proof servers**
  on our infrastructure: remote proving would degrade under load and blow the
  budget.
- **ZK config:** `FetchZkConfigProvider` pointed at the R2 URL prefix
  (content-hashed paths per §9).
- **Private state:** `levelPrivateStateProvider` backed by the browser's
  IndexedDB — private transaction state never leaves the user's machine.

> ⚠️ **Verify with mnm before building on this:** confirm that current Lace
> performs proving in-wallet, making `dappConnectorProofProvider` fully
> self-contained. If Lace instead delegates to a **local proof server** the
> user must run themselves, the UX story changes materially. This is exactly
> the kind of API-shape fact the standing rules (§16) say never to trust from
> training-data memory. Resolve in Phase 0.

---

## 11. Contract deployment, address handling, and persistence

### Contract deploys
- Contracts are deployed to **pre-prod** by the **orchestrator, using a
  server-held deploy key**. The key lives only in the main app server and
  **never reaches the browser or the WebContainer**. The client/agent
  *requests* a deploy over the WebSocket; the orchestrator executes it and
  emits `contract:deployed { address }`.
- Superseded contract versions are torn down on redeploy (cleanup job).
- **Frontends are never hosted.** The WebContainer preview (plus the
  escape-hatch tab) is the only frontend runtime. There is no frontend deploy
  pipeline.

### Contract address handling
- The contract address is **runtime config, never hardcoded in source**.
- On `contract:deployed`, the client writes the address into the WebContainer
  VFS env (`.env.local` → `VITE_CONTRACT_ADDRESS`) and the dev server picks it
  up. **The `VITE_` prefix is mandatory** — it is Vite's guardrail against
  leaking secrets into the bundle; a var without it is silently `undefined`
  in the browser.
- Before the first deploy, the app renders a graceful **"deploy your contract
  first"** state instead of white-screening (a five-line guard).
- **Single chokepoint:** the client reads the address in exactly one module —
  `client/src/lib/config.ts` (`getContractAddress()` /
  `isContractDeployed()`). Nothing else touches `import.meta.env` directly,
  and the Implementation agent is steered to route all address access through
  this module.

### Project persistence
- Project source files are **persisted server-side as the authoritative
  copy** *and* mirrored into the WebContainer VFS. On project open, the VFS
  is rehydrated from the store and artifacts are recompiled (§9). Projects
  survive the user closing the tab.
- The persistence store (Postgres rows vs. a non-expiring R2 prefix vs.
  other) is an **open question** (§14) — decide before Phase 1 code, as it
  shapes the file-event handlers.

---

## 12. Synchronization protocol

The chat-interface ↔ WebContainer WebSocket protocol is **bidirectional** —
the agent's verification loop and error visibility depend on the return path.

**Server → client:**

| Event | Payload | Client action |
|---|---|---|
| `file:write` | `{ path, content }` | `await webcontainerInstance.fs.writeFile(path, content)` → HMR |
| `file:delete` | `{ path }` | remove from VFS |
| `contract:deployed` | `{ address }` | write `VITE_CONTRACT_ADDRESS` to `.env.local`, restart dev server |
| `artifacts:ready` | `{ urlPrefix }` | point `FetchZkConfigProvider` at the new content-hashed prefix |

**Client → server:**

| Event | Payload | Purpose |
|---|---|---|
| `test:results` | `{ pass, failures[] }` | agent's behavioural-verify feedback |
| `console:log` / `console:error` | streamed | agent sees runtime errors, not just compile errors |
| `dev:status` | `{ booting \| ready \| crashed }` | agent + UI know the preview state |
| `deploy:request` | `{}` | user/agent asks orchestrator to deploy the contract |
| `file:changed` | `{ path, content }` | user edits (if in-browser editing lands — §14) |

---

## 13. Token economy

Economic loop: connect Lace (pre-prod) → deposit **tNIGHT** into the **Nyx
deposit contract** (one on-chain transaction) → mint an off-chain **NYXT**
balance in Postgres → prompts decrement the Postgres ledger → lazy on-chain
reconcile/settle.

- **The chain is the top-up rail, not the metering rail.** **No on-chain
  write ever sits in the per-prompt path** — a signed wallet transaction per
  message is UX death. Per-prompt metering is a standard Postgres ledger
  decrement, keeping interaction instant.
- The deposit contract and real NYXT minting are **Phase 1 scope** — this is
  the platform's own dogfood moment: a real, working Compact contract on our
  critical path, built with the same MNE/mnm stack the product gives users,
  to the same standard we expect of user-facing output.
- **Design the token for Midnight's shielded/UTXO model.** "ERC20" is
  Ethereum vocabulary; Midnight is Compact plus a UTXO/shielded-state model,
  not an EVM account balance. Ask mnm; do not port account-model instincts.
- Wallet auth: SIWE-style nonce → Lace signature → session, on pre-prod.

---

## 14. Open questions (rough priority order)

1. **Persistence store for project source** (§11) — Postgres vs. non-expiring
   R2 prefix vs. other. Blocks Phase 1 file-event handler design.
2. **Lace proving verification** (§10) — does `dappConnectorProofProvider`
   prove in-wallet today, or is a local proof server still required? Via mnm.
3. **Escape-hatch verification** (§6) — does Lace inject into the
   WebContainer preview origin in a top-level tab, and what is preview
   lifetime while the original tab stays open?
4. **WebContainer commercial license** — pricing and terms for a for-profit
   product.
5. **Tome retrieval sanity** — does `search_skills` reliably surface the
   right MNE skills for the Scaffolding sub-agent's cold start?
6. **NYXT deposit contract design** — shielded/UTXO-appropriate token and
   deposit/lock mechanics on pre-prod. Via mnm.
7. **Midnight toolchain specifics** — exact `compactc` invocation and
   artifact layout, contract deploy API, pre-prod node/indexer URLs. Via mnm
   + MNE, never memory.
8. **Compiler MCP concurrency and sizing** (§8).
9. **Naming sweep** — lock the Nyx domain (all `nyx.example` placeholders in
   this doc), npm scope, GitHub org, and a trademark sniff; confirm the NYXT
   ticker (note: "Nyxt" is an existing open-source browser — ticker-only use
   is likely fine, but check).
10. **Project handoff** — should users be able to take their code home
    (archive download and/or read-only clone URL)? Scope decision.
11. **In-browser code editor** — is a Monaco-based editor with Compact
    syntax highlighting in scope? If yes, a Monarch tokenizer hand-ported
    from the LFDT-Minokawa TextMate grammar
    (`github.com/LFDT-Minokawa/compact` →
    `editor-support/vsc/compact/syntaxes/compact.tmLanguage.json`) is the
    pragmatic path; `monaco-textmate` + `vscode-oniguruma` (WASM) is the
    high-fidelity path.

---

## 15. Phasing (each phase ends shippable)

Phases bound the **feature set**, never the quality bar. A phase is done when
its features are production-quality — tested, handling failure modes, secure —
not when they happen to work on the happy path. The phase contents below are
the project owner's scope decisions; building agents execute them, they do
not trim them.

**Phase 0 — de-risk (before app code):** cheaply prove the five load-bearing
assumptions: (a) Tome surfaces the right MNE skills for a cold "build me a
counter DApp" prompt; (b) mnm's hosted MCP is reachable from the server; (c) a
WebContainer boots the Vite + React 19 stack and the escape-hatch tab gets
`window.midnight` from Lace; (d) the Lace proving story is confirmed (§10);
(e) the compile round trip works end-to-end: source → compiler MCP → R2 →
`FetchZkConfigProvider` fetch from a browser.

**Phase 1 — vertical slice:** wallet connect (nonce → Lace signature →
session) · **deposit contract + real NYXT mint + Postgres ledger decrement
per prompt** · chat UI + supervisor swarm (AI SDK + Tome + mnm) ·
WebContainer preview with the file-sync protocol · compile via the compiler
MCP · Vitest/simulator verify loop with results streaming back to the agent.
Output: a prompt produces a generated, *compiling*, *tested* Compact contract
plus a running Vite preview. This slice alone is a legitimate product and
proves the genuinely novel part.

**Phase 2 — deploy loop:** orchestrator server-key contract deploys to
pre-prod · `contract:deployed` → address injection → preview reload · teardown
of superseded contract versions · ledger reconcile/settle · escape-hatch tab
polished so users sign real pre-prod transactions end-to-end.

**Phase 3 — extended features:** BYOK model management (encrypt at rest,
`createOpenAICompatible` for the OpenAI-compatible long tail — the easiest
item, lands last) · token ledger UI polish · project handoff and in-browser
editor if confirmed in scope (§14, items 10–11).

---

## 16. Standing rules for the agent building this

- **Quality is not a variable, and scope is not yours to change.** Never ship
  a weaker, untested, or insecure version of a feature to save time or
  tokens, and never quietly drop or hollow out a feature that is in scope.
  If you believe the scope cannot be delivered at the quality bar, **stop and
  raise it with the project owner** — descoping decisions belong to the owner
  alone.
- **Never hand-write Compact from memory.** Tool-confirm via mnm/MNE. If a
  Midnight API misbehaves, ask mnm — don't invent a workaround.
- **The server deploy key and R2 write credentials never reach the browser or
  the WebContainer.** The client requests; the orchestrator executes.
- **The contract address is never hardcoded** — always via `config.ts`
  (`VITE_`-prefixed env var, single chokepoint module).
- **No secrets in generated project files** or in anything synced to the
  client.
- **Tests must be deterministic** — simulator, not chain; no devnet.
- **No on-chain write in the per-prompt path** — the chain is the top-up
  rail, not the metering rail.
- **Build integrations against LIVE docs** (Midnight SDK, Compact CLI,
  WebContainer API, R2) — never trust training-data memory for API shapes.
- **Don't re-litigate settled decisions silently** — disagree out loud, with
  reasoning.
