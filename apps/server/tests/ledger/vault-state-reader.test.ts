/**
 * Deterministic tests for the real NyxtVault deposits-state reader (P4 Task 3b) — the
 * owner-gated {@link DepositsStateReader} that un-gates the P3 deposit-observation decode.
 *
 * The reader is a thin, DETERMINISTIC composition over two injectable SDK seams (a
 * `queryContractState` provider + a compiled-module loader) so the money-critical properties
 * are proven here with fakes, never a live chain:
 *  - decoded map keys are lowercase 64-char hex (no `0x`) and amounts are native `bigint`
 *    (a value > 2^63 proves no `Number()` truncation on the credited magnitude);
 *  - `finalized` is the VALUE the provider reports, NEVER hardcoded `true` (P3 I1) — a
 *    not-yet-final state read drives `finalized: false` end to end through the REAL
 *    `createDevnetDepositIndexerQuery` + a REAL deposit store and credits NOTHING;
 *  - provider / module-load / decode faults are promise REJECTIONS, never a fake-empty map (a
 *    stubbed reader must never look successful — the `DepositIndexerNotWiredError` discipline).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createNyxtVaultStateReader,
  VaultModuleLoadError,
  type VaultDepositsModule,
  type VaultLedgerState,
  type VaultStateProvider,
} from "../../src/ledger/vault-state-reader.js";
import { createDevnetDepositIndexerQuery } from "../../src/ledger/indexer-observation.js";
import { createDepositStore } from "../../src/ledger/deposits.js";
import type { LedgerStore } from "../../src/ledger/ledger.js";

// --- Fixtures ---------------------------------------------------------------

const VAULT = "0200vaultaddr";
const MODULE_DIR = "/srv/vault-artifacts";
/** A sentinel that must be handed to `mod.ledger()` verbatim (the serialized state `data`). */
const STATE_DATA = Symbol("contract-state-data");

/** 32 raw ref bytes whose hex has letters (proves lowercase encoding), e.g. 0xab → "ab". */
const REF_A_BYTES = new Uint8Array(32).fill(0xab);
const REF_A_HEX = "ab".repeat(32);
const REF_B_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i); // 00 01 02 … 1f
const REF_B_HEX = Array.from(REF_B_BYTES, (b) => b.toString(16).padStart(2, "0")).join("");

/** A NYXT amount strictly greater than 2^63 — proves the reader never routes it through Number. */
const HUGE_AMOUNT = 2n ** 64n - 1n; // 18_446_744_073_709_551_615

/** A fake provider resolving a fixed state (or null); records the address it was queried with. */
function fakeProvider(state: VaultLedgerState | null): VaultStateProvider {
  return vi.fn<VaultStateProvider>(() => Promise.resolve(state));
}

/** A fake compiled module whose `ledger(data)` returns the given deposit pairs. */
function fakeModule(
  pairs: readonly (readonly [Uint8Array, bigint])[],
  onLedger?: (data: unknown) => void,
): VaultDepositsModule {
  return {
    ledger(data: unknown) {
      onLedger?.(data);
      return { deposits: pairs };
    },
  };
}

// --- Decode + key/amount discipline -----------------------------------------

describe("createNyxtVaultStateReader — decode discipline", () => {
  it("decodes deposits to lowercase 64-char hex keys with native bigint amounts (no Number())", async () => {
    let seenData: unknown;
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      loadModule: () =>
        Promise.resolve(
          fakeModule(
            [
              [REF_A_BYTES, HUGE_AMOUNT],
              [REF_B_BYTES, 5_000n],
            ],
            (data) => {
              seenData = data;
            },
          ),
        ),
    });

    const map = await reader(VAULT);

    // The serialized state `data` is handed to `mod.ledger()` VERBATIM (SPIKE-2 recipe).
    expect(seenData).toBe(STATE_DATA);
    // Keys are lowercase hex, 64 chars, no `0x` (the randomDepositRef format, M4).
    for (const key of map.keys()) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
    const entryA = map.get(REF_A_HEX);
    const entryB = map.get(REF_B_HEX);
    expect(entryA?.amount).toBe(HUGE_AMOUNT);
    expect(entryB?.amount).toBe(5_000n);
    // Money discipline: the amount stays a bigint end to end — never coerced through Number().
    expect(typeof entryA?.amount).toBe("bigint");
    // A > 2^63 amount survives exactly (Number() would round it — 2^64-1 is not representable).
    expect(entryA?.amount).not.toBe(BigInt(Number(HUGE_AMOUNT)));
  });

  it("loads the compiled module from the configured vaultModuleDir", async () => {
    const loadModule = vi.fn(() => Promise.resolve(fakeModule([])));
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      loadModule,
    });

    await reader(VAULT);
    expect(loadModule).toHaveBeenCalledWith(MODULE_DIR);
  });

  it("queries the provider with the vault address", async () => {
    const provider = fakeProvider({ data: STATE_DATA, finalized: true });
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider,
      loadModule: () => Promise.resolve(fakeModule([])),
    });

    await reader(VAULT);
    expect(provider).toHaveBeenCalledWith(VAULT);
  });
});

// --- Finality is a propagated VALUE, never hardcoded (P3 I1) -----------------

describe("createNyxtVaultStateReader — finality flag", () => {
  it("propagates a finalized:true provider read onto every entry", async () => {
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      loadModule: () => Promise.resolve(fakeModule([[REF_A_BYTES, 5_000n]])),
    });

    const map = await reader(VAULT);
    expect(map.get(REF_A_HEX)?.finalized).toBe(true);
  });

  it("propagates a NOT-yet-final provider read as finalized:false — never hardcodes true (I1)", async () => {
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      // The provider reports the state is not yet finalized — the reader must surface that
      // VALUE so the store's SC-021 gate can fire (off-chain-mint backbone).
      provider: fakeProvider({ data: STATE_DATA, finalized: false }),
      loadModule: () =>
        Promise.resolve(
          fakeModule([
            [REF_A_BYTES, 5_000n],
            [REF_B_BYTES, 9_000n],
          ]),
        ),
    });

    const map = await reader(VAULT);
    expect(map.get(REF_A_HEX)?.finalized).toBe(false);
    expect(map.get(REF_B_HEX)?.finalized).toBe(false);
  });
});

// --- No-state vs. faults: an empty map is ONLY a legit no-state read ---------

describe("createNyxtVaultStateReader — no-state vs. faults", () => {
  it("returns an empty map when the provider reports no on-chain state (null)", async () => {
    const loadModule = vi.fn(() => Promise.resolve(fakeModule([])));
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider(null),
      loadModule,
    });

    const map = await reader(VAULT);
    expect(map.size).toBe(0);
    // A null (no-state) read must not even reach the decode seam.
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("REJECTS on a provider fault — never a fake-empty map", async () => {
    const boom = new Error("indexer unreachable");
    const loadModule = vi.fn(() => Promise.resolve(fakeModule([])));
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: vi.fn<VaultStateProvider>(() => Promise.reject(boom)),
      loadModule,
    });

    await expect(reader(VAULT)).rejects.toBe(boom);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("REJECTS on a module-load fault — never a fake-empty map", async () => {
    const boom = new Error("compiled module missing");
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      loadModule: () => Promise.reject(boom),
    });

    await expect(reader(VAULT)).rejects.toBe(boom);
  });

  it("REJECTS on a decode fault (mod.ledger throws) — never a fake-empty map", async () => {
    const boom = new Error("malformed state data");
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      loadModule: () =>
        Promise.resolve({
          ledger() {
            throw boom;
          },
        }),
    });

    await expect(reader(VAULT)).rejects.toBe(boom);
  });

  // --- M1: a malformed decode fails LOUD, never flows a bad magnitude/key into the store --------

  it("M1: REJECTS a non-bigint decoded amount — credits NOTHING (never a non-bigint magnitude)", async () => {
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      // A malformed decode: the amount is a NUMBER, not the promised bigint.
      loadModule: () => Promise.resolve(fakeModule([[REF_A_BYTES, 5_000 as unknown as bigint]])),
    });

    // The reader throws BEFORE returning any map, so nothing flows downstream to be credited.
    await expect(reader(VAULT)).rejects.toBeInstanceOf(VaultModuleLoadError);
  });

  it("M1: REJECTS a wrong-length decoded ref key (malformed decode)", async () => {
    const reader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      // A 31-byte key (not the required 32) — a malformed decode must fail loud.
      loadModule: () => Promise.resolve(fakeModule([[new Uint8Array(31), 5_000n]])),
    });

    await expect(reader(VAULT)).rejects.toBeInstanceOf(VaultModuleLoadError);
  });
});

// --- End-to-end through the REAL indexer query + REAL deposit store ----------

describe("createNyxtVaultStateReader — wired through the real observation pipeline", () => {
  const REF = REF_A_HEX;

  /** A fake `fetch` returning the canned `contractAction` envelope (verified SPIKE-2 shape). */
  function contractActionFetch(): typeof fetch {
    return vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              contractAction: {
                __typename: "ContractCall",
                address: VAULT,
                unshieldedBalances: [{ tokenType: "0100dead", amount: "5000" }],
                transaction: { hash: "0xdeadbeef", block: { height: 218 } },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  }

  it("a finalized read credits — a not-yet-final read credits NOTHING (I1 through the real reader)", async () => {
    // The REAL reader over a fake provider that reports the deposit as NOT yet finalized.
    const notFinalReader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: false }),
      loadModule: () => Promise.resolve(fakeModule([[REF_A_BYTES, 5_000n]])),
    });

    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: contractActionFetch(),
      readDepositsState: notFinalReader,
    });

    const observations = await query.findDeposits([REF]);
    const observation = observations[0];
    expect(observation?.finalized).toBe(false);
    if (observation === undefined) {
      throw new Error("expected an observation for the on-chain ref");
    }
    // Feed it through a REAL deposit store whose db + ledger THROW if touched: the finality gate
    // must short-circuit to `ignored-unfinalized` BEFORE any credit work (NO off-chain mint).
    const creditDeposit = vi.fn(() =>
      Promise.reject(new Error("must not credit an unfinalized deposit")),
    );
    const dbQuery = vi.fn(() =>
      Promise.reject(new Error("must not query for an unfinalized deposit")),
    );
    const store = createDepositStore({ query: dbQuery }, {
      creditDeposit,
    } as unknown as LedgerStore);

    const outcome = await store.observeFinalized(observation);
    expect(outcome).toEqual({ kind: "ignored-unfinalized", ref: REF });
    expect(creditDeposit).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("a finalized read surfaces a success observation carrying the native bigint amount", async () => {
    const finalReader = createNyxtVaultStateReader({
      indexerUrl: "http://localhost:8088",
      vaultModuleDir: MODULE_DIR,
      provider: fakeProvider({ data: STATE_DATA, finalized: true }),
      loadModule: () => Promise.resolve(fakeModule([[REF_A_BYTES, HUGE_AMOUNT]])),
    });

    const query = createDevnetDepositIndexerQuery({
      indexerUrl: "http://localhost:8088",
      vaultAddress: VAULT,
      fetch: contractActionFetch(),
      readDepositsState: finalReader,
    });

    const observations = await query.findDeposits([REF]);
    expect(observations).toEqual([
      {
        ref: REF,
        amount: HUGE_AMOUNT,
        txRef: "0xdeadbeef",
        outcome: "success",
        finalized: true,
      },
    ]);
    expect(typeof observations[0]?.amount).toBe("bigint");
  });
});
