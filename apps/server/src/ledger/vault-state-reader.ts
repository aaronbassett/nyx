/**
 * The real NyxtVault deposits-state reader (P4 Task 3b) — the {@link DepositsStateReader}
 * implementation that un-gates the P3 deposit-observation decode. Injected into
 * {@link createDevnetDepositIndexerQuery} at boot (Task 4) so the poller's per-ref amount decode
 * finally resolves instead of rejecting {@link DepositIndexerNotWiredError} every tick.
 *
 * MONEY-CRITICAL: this is the on-chain→off-chain amount-decode leg. Two rules govern it, mirroring
 * the seam contract on {@link DepositsStateReader} (`indexer-observation.ts:205-240`):
 *  1. `amount` is a NATIVE `bigint` end to end — read straight from the compiled contract's
 *     generated decoder (`decoded.deposits` yields `[Uint8Array, bigint]`), NEVER `Number()`.
 *  2. `finalized` is a per-read VALUE surfaced from the {@link VaultStateProvider}, NEVER a
 *     reader-side literal `true` (P3 I1: a `finalized:true` shortcut makes the store's SC-021
 *     gate vacuous → off-chain-mint risk). The store credits on this flag directly.
 *
 * ⚠️ CONSTITUTION I / III — SDK ISOLATION. The two `@midnight-ntwrk/*` touchpoints (the indexer
 * `queryContractState` read + the compiled-module `ledger()` decode) live ONLY behind the two
 * injectable seams below ({@link VaultStateProvider} + {@link VaultModuleLoader}); their real
 * defaults ({@link createIndexerVaultStateProvider} / {@link loadCompiledVaultModule}) lazy
 * `import()` the SDK / the compiled module so this module loads (and unit-tests) without pulling
 * either. The real path is OWNER-GATED: it needs a live indexer, a deployed vault, and the
 * compiled NyxtVault module (`contract/index.js`) that P5 copies into `config.vaultArtifactsDir`.
 * Deterministic tests inject fakes for both seams. No credential ever reaches this module.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DepositStateEntry, DepositsStateReader } from "./indexer-observation.js";

// --- The two injectable SDK seams -------------------------------------------

/**
 * One indexer contract-state read: the serialized ledger `data` (fed verbatim to the compiled
 * module's `ledger()` decoder) plus whether that state is FINALIZED. `null` means the contract
 * has no on-chain state yet (a legit no-results read — distinct from a fault, which REJECTS).
 *
 * FINALITY (I1): `finalized` reflects the ONE finality definition `sdk-adapter.ts` `queryFinality`
 * uses — a state SERVED BY the indexer is in a GRANDPA-finalized block (indexer-standalone 4.2.1
 * never ingests a non-finalized block; `sdk-recipe.md` Element 4). It is surfaced as a VALUE (the
 * reader propagates it, never hardcodes) so the store's SC-021 gate stays live: a provider that
 * ever reported non-final state would set `false` and block crediting.
 */
export interface VaultLedgerState {
  /** The serialized on-chain ledger state (`queryContractState(addr).data`). */
  readonly data: unknown;
  /** Whether this state is finalized (the indexer-served signal — never a reader literal). */
  readonly finalized: boolean;
}

/**
 * Read the vault's current on-chain ledger state for `vaultAddress`, or `null` when the contract
 * has no state yet. A transport / indexer fault MUST reject (never resolve `null` — the store
 * must never mistake an outage for "no deposits"). The real default is
 * {@link createIndexerVaultStateProvider}; tests inject a fake.
 */
export type VaultStateProvider = (vaultAddress: string) => Promise<VaultLedgerState | null>;

/**
 * The decoded ledger surface the reader needs from the compiled NyxtVault module: the `deposits`
 * map, iterable as `[refBytes, amountBaseUnits]`. Matches the compiled contract's generated type
 * (`build/nyxt-vault/contract/index.d.ts` — `deposits: { [Symbol.iterator](): Iterator<[Uint8Array,
 * bigint]> }`); the amount is a native `bigint` (`Uint<128>` decoded).
 */
export interface VaultDepositsLedger {
  readonly deposits: Iterable<readonly [Uint8Array, bigint]>;
}

/**
 * The compiled NyxtVault module's generated `ledger()` decoder — the ONLY entry the reader calls.
 * `ledger(state.data)` turns the serialized on-chain state into the typed ledger surface. Loaded
 * from the compiled module by {@link loadCompiledVaultModule}; tests inject a fake.
 */
export interface VaultDepositsModule {
  ledger(data: unknown): VaultDepositsLedger;
}

/** Load the compiled NyxtVault module from `vaultModuleDir`. Real default: {@link loadCompiledVaultModule}. */
export type VaultModuleLoader = (vaultModuleDir: string) => Promise<VaultDepositsModule>;

/** Construction deps for {@link createNyxtVaultStateReader}. */
export interface NyxtVaultStateReaderDeps {
  /** The devnet indexer URL — base (`http://localhost:8088`) or full GraphQL endpoint. */
  readonly indexerUrl: string;
  /**
   * The dir holding the compiled NyxtVault module (`<vaultModuleDir>/contract/index.js`) — the
   * config chokepoint value (`config.artifacts.vaultArtifactsDir`), populated by P5.
   */
  readonly vaultModuleDir: string;
  /** Contract-state read seam; defaults to {@link createIndexerVaultStateProvider}. Injected in tests. */
  readonly provider?: VaultStateProvider;
  /** Compiled-module loader seam; defaults to {@link loadCompiledVaultModule}. Injected in tests. */
  readonly loadModule?: VaultModuleLoader;
}

// --- The reader -------------------------------------------------------------

/** The indexer GraphQL path (`:8088`) [`sdk-recipe.md` Element 4 verified: `/api/v4/graphql`]. */
const INDEXER_GRAPHQL_PATH = "/api/v4/graphql";
/** The indexer GraphQL WS path — `indexerPublicDataProvider` requires a subscription URL. */
const INDEXER_GRAPHQL_WS_PATH = "/api/v4/graphql/ws";

/** Resolve a base indexer URL to its GraphQL query endpoint (append the path when absent). */
function graphqlQueryUrl(indexerUrl: string): string {
  const trimmed = indexerUrl.replace(/\/+$/, "");
  return trimmed.endsWith(INDEXER_GRAPHQL_PATH) ? trimmed : `${trimmed}${INDEXER_GRAPHQL_PATH}`;
}

/** Resolve a base indexer URL to its GraphQL WS subscription endpoint. */
function graphqlWsUrl(indexerUrl: string): string {
  const query = graphqlQueryUrl(indexerUrl);
  const ws = query.replace(/^http/, "ws");
  return ws.endsWith(INDEXER_GRAPHQL_WS_PATH) ? ws : `${ws.replace(/\/ws$/, "")}/ws`;
}

/** Encode raw ref bytes to the seam's key format: lowercase hex, no `0x`, 64 chars (M4). */
function refHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Build the real NyxtVault deposits-state reader. It:
 *   1. reads the vault's on-chain state via {@link VaultStateProvider} (`null` → empty map, a
 *      fault → REJECTS, never a fake-empty map);
 *   2. loads the compiled NyxtVault module and decodes `state.data` via its generated `ledger()`;
 *   3. maps every `deposits` entry to `refHex → { amount, finalized }` — the amount native
 *      `bigint`, `finalized` the provider's per-read VALUE (I1, never hardcoded).
 */
export function createNyxtVaultStateReader(deps: NyxtVaultStateReaderDeps): DepositsStateReader {
  const provider = deps.provider ?? createIndexerVaultStateProvider(deps.indexerUrl);
  const loadModule = deps.loadModule ?? loadCompiledVaultModule;

  return async (vaultAddress: string): Promise<ReadonlyMap<string, DepositStateEntry>> => {
    const state = await provider(vaultAddress);
    if (state === null) {
      // Legit no-state read: the contract has no ledger yet. Distinct from a fault (which
      // rejected above) — an empty map means "nothing landed", never "the read failed".
      return new Map<string, DepositStateEntry>();
    }

    const mod = await loadModule(deps.vaultModuleDir);
    const decoded = mod.ledger(state.data);

    const out = new Map<string, DepositStateEntry>();
    // Iterate the decoder output as UNTRUSTED (widened to `unknown` elements): the compiled
    // module's generated iterator TYPE promises `[Uint8Array(32), bigint]`, but a malformed decode
    // must fail LOUD, never flow a non-bigint magnitude / wrong-length ref into the credit store
    // (M1 — money-critical). Guards below re-narrow after validating at this trust boundary.
    for (const [keyBytes, amount] of decoded.deposits as Iterable<readonly [unknown, unknown]>) {
      if (typeof amount !== "bigint") {
        throw new VaultModuleLoadError(
          `decoded deposit amount is not a bigint (got ${typeof amount}) — refusing to credit a non-bigint magnitude`,
        );
      }
      if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
        const shape =
          keyBytes instanceof Uint8Array ? `${String(keyBytes.length)} bytes` : typeof keyBytes;
        throw new VaultModuleLoadError(
          `decoded deposit ref is not a 32-byte key (got ${shape}) — malformed decode`,
        );
      }
      // amount: native bigint from the compiled decoder (Uint<128>) — never Number().
      // finalized: the provider's per-read VALUE — never a reader-side literal (I1).
      out.set(refHex(keyBytes), { amount, finalized: state.finalized });
    }
    return out;
  };
}

// --- The real (owner-gated) SDK-backed default seams ------------------------

/** The compiled NyxtVault module at `<dir>/contract/index.js` lacks a `ledger()` export. */
export class VaultModuleLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultModuleLoadError";
  }
}

/**
 * The real {@link VaultStateProvider} over the indexer public-data provider [`sdk-recipe.md`
 * Element 4, SPIKE-2 `sdkwork/deposit-common.mjs`, executed 2026-07-23 against indexer 4.2.1]:
 *
 *   const pdp   = indexerPublicDataProvider(queryUrl, wsUrl);           // @…/midnight-js-indexer-public-data-provider@4.1.1
 *   const state = await pdp.queryContractState(vaultAddress);           // ContractState | null (indexer-served)
 *   // → { data: state.data, finalized: true }  (indexer only serves GRANDPA-finalized blocks)
 *
 * OWNER-GATED: it needs a reachable indexer. The SDK is `import()`-ed lazily so this module loads
 * without it. FINALITY: an indexer-served `ContractState` is finalized (Element 4 — the ONE
 * definition `queryFinality` uses); returned as a `finalized: true` VALUE the reader propagates,
 * NOT a reader-side hardcode. The stricter node-`chain_getFinalizedHead` cross-check is the same
 * owner-gated hardening residue `sdk-adapter.ts` documents; wire it here if a stricter signal is
 * ever required (the seam already carries `finalized` per read, so it is a body-only change).
 */
export function createIndexerVaultStateProvider(indexerUrl: string): VaultStateProvider {
  const queryUrl = graphqlQueryUrl(indexerUrl);
  const wsUrl = graphqlWsUrl(indexerUrl);
  return async (vaultAddress: string): Promise<VaultLedgerState | null> => {
    const { indexerPublicDataProvider } =
      await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
    const pdp = indexerPublicDataProvider(queryUrl, wsUrl);
    const state = await pdp.queryContractState(vaultAddress);
    if (state === null) {
      return null;
    }
    return { data: state.data, finalized: true };
  };
}

/**
 * The real {@link VaultModuleLoader}: dynamic-`import()` the compiled NyxtVault module from
 * `<vaultModuleDir>/contract/index.js` (the layout the native `compact:build` produces and P5
 * copies into `config.vaultArtifactsDir`; SPIKE-2 `env.mjs` `loadVaultContract`). OWNER-GATED on
 * the compiled module's presence. Rejects {@link VaultModuleLoadError} if `ledger()` is missing.
 */
export async function loadCompiledVaultModule(
  vaultModuleDir: string,
): Promise<VaultDepositsModule> {
  const entry = pathToFileURL(join(vaultModuleDir, "contract", "index.js")).href;
  const mod: unknown = await import(entry);
  if (
    typeof mod !== "object" ||
    mod === null ||
    typeof (mod as { ledger?: unknown }).ledger !== "function"
  ) {
    throw new VaultModuleLoadError(
      `compiled NyxtVault module at ${entry} has no ledger() export (is vaultArtifactsDir/contract populated?)`,
    );
  }
  return mod as VaultDepositsModule;
}
