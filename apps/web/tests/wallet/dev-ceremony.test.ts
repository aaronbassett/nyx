/**
 * Dev wallet deposit-ceremony ORCHESTRATION tests (P3 Task 5, Step 2).
 *
 * `createDevWalletCeremony` fills the `DepositCeremony` seam (`topup.tsx:77`):
 * build → prove → submit a NyxtVault `deposit(ref, amount)` transaction. The
 * orchestration is deterministic and unit-tested over FAKE seams — the real
 * SDK tx-build/prove/submit (owner/`DEVNET_URL`-gated) lives in `dev-ceremony-tx.ts`.
 *
 * The contract these tests pin (from `topup.tsx` `DepositCeremony`):
 *  - resolves `{ txRef }` ONLY once the deposit tx is submitted;
 *  - REJECTS (never a false "pending") on a build / prove / submit failure — the
 *    top-up state machine maps any ceremony rejection to `ceremony-rejected`;
 *  - the amount is a `bigint` end-to-end, NEVER stringified through `Number()`;
 *  - the contract address is the INJECTED config-chokepoint value, not an env read.
 */
import { describe, expect, it, vi } from "vitest";
import type { DepositRef } from "@nyx/protocol";

import {
  createDevWalletCeremony,
  DevCeremonyError,
  type CeremonyProver,
  type DepositTxBuilder,
  type DevCeremonyDeps,
  type TxSubmitter,
} from "@/wallet/dev-ceremony";
import type { DevSigner } from "@/wallet/dev-signer";

// ── Fakes ────────────────────────────────────────────────────────────────────

const DEPOSIT_REF =
  "a66b22ac00000000000000000000000000000000000000000000000000d78240" as DepositRef;
const AMOUNT = 5000n;
const VAULT_ADDRESS = "0200f1e2d3c4b5a600000000000000000000000000000000000000000000000000";
const UNPROVEN = new Uint8Array([1, 2, 3, 4]);
const PROVEN = new Uint8Array([9, 8, 7, 6, 5]);
const TX_REF = "006091968a562a4f976741f6bc620d8db3b0e7bcfdcd7ba3885d464d2929065ba3";

/** A signer double — the ceremony treats it as an opaque identity (no signing here). */
const SIGNER: DevSigner = {
  verifyingKey: "deadbeef",
  address: "mn_addr_undeployed1g9nr3mvjcey7ca8shcs5d4yjndcnmczf90rhv4nju7qqqlfg4ygs0t4ngm",
  sign: () => "sig",
};

/**
 * A `buildTx` fake that RECORDS its params and asserts the money-discipline
 * invariant (`amount` is a real `bigint`, never a `Number()`-degraded value).
 */
function fakeBuildTx(): ReturnType<typeof vi.fn<DepositTxBuilder>> {
  return vi.fn<DepositTxBuilder>((params) => {
    // Money discipline (constitution / iron rules): a bigint end-to-end.
    expect(typeof params.amount).toBe("bigint");
    return Promise.resolve({ unprovenTx: UNPROVEN });
  });
}

/** Standalone mocks (asserted as plain values — avoids `unbound-method` on object methods). */
interface Mocks {
  readonly buildTx: ReturnType<typeof vi.fn<DepositTxBuilder>>;
  readonly prove: ReturnType<typeof vi.fn<CeremonyProver["prove"]>>;
  readonly submit: ReturnType<typeof vi.fn<TxSubmitter>>;
}

function makeMocks(over: Partial<Mocks> = {}): Mocks {
  return {
    buildTx: over.buildTx ?? fakeBuildTx(),
    prove: over.prove ?? vi.fn<CeremonyProver["prove"]>(() => Promise.resolve(PROVEN)),
    submit: over.submit ?? vi.fn<TxSubmitter>(() => Promise.resolve({ txRef: TX_REF })),
  };
}

function depsFrom(mocks: Mocks): DevCeremonyDeps {
  return {
    signer: SIGNER,
    buildTx: mocks.buildTx,
    prover: { prove: mocks.prove },
    submit: mocks.submit,
    contractAddress: VAULT_ADDRESS,
  };
}

async function runToFailure(deps: DevCeremonyDeps): Promise<unknown> {
  return createDevWalletCeremony(deps)
    .runCeremony({ depositRef: DEPOSIT_REF, amount: AMOUNT })
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createDevWalletCeremony", () => {
  it("pipes build → prove → submit and resolves the submitted txRef (happy path)", async () => {
    const mocks = makeMocks();
    const ceremony = createDevWalletCeremony(depsFrom(mocks));

    const result = await ceremony.runCeremony({ depositRef: DEPOSIT_REF, amount: AMOUNT });

    expect(result).toEqual({ txRef: TX_REF });

    // (a)/(e): buildTx got the EXACT ref + amount + the injected contract address.
    expect(mocks.buildTx).toHaveBeenCalledTimes(1);
    expect(mocks.buildTx).toHaveBeenCalledWith({
      depositRef: DEPOSIT_REF,
      amount: AMOUNT,
      contractAddress: VAULT_ADDRESS,
    });

    // The unproven bytes flow into the prover; the proven bytes flow into submit.
    expect(mocks.prove).toHaveBeenCalledTimes(1);
    expect(mocks.prove).toHaveBeenCalledWith(UNPROVEN);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith(PROVEN);
  });

  it("passes the amount as a bigint end-to-end (never Number())", async () => {
    // The buildTx fake asserts `typeof amount === "bigint"`; a large value that
    // would lose precision as a JS number makes the guarantee load-bearing.
    const big = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    const mocks = makeMocks();
    const ceremony = createDevWalletCeremony(depsFrom(mocks));

    await ceremony.runCeremony({ depositRef: DEPOSIT_REF, amount: big });

    expect(mocks.buildTx).toHaveBeenCalledWith(expect.objectContaining({ amount: big }));
  });

  it("rejects (never a false pending) with a build-stage error when buildTx fails", async () => {
    const cause = new Error("assemble failed");
    const mocks = makeMocks({ buildTx: vi.fn<DepositTxBuilder>(() => Promise.reject(cause)) });

    const failure = await runToFailure(depsFrom(mocks));

    expect(failure).toBeInstanceOf(DevCeremonyError);
    expect((failure as DevCeremonyError).stage).toBe("build");
    expect((failure as DevCeremonyError).cause).toBe(cause);
    // Prove and submit are never reached.
    expect(mocks.prove).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects with a prove-stage error when the prover fails, without submitting", async () => {
    const cause = new Error("proving rejected");
    const mocks = makeMocks({ prove: vi.fn<CeremonyProver["prove"]>(() => Promise.reject(cause)) });

    const failure = await runToFailure(depsFrom(mocks));

    expect(failure).toBeInstanceOf(DevCeremonyError);
    expect((failure as DevCeremonyError).stage).toBe("prove");
    expect((failure as DevCeremonyError).cause).toBe(cause);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects with a submit-stage error when submission fails", async () => {
    const cause = new Error("node rejected");
    const mocks = makeMocks({ submit: vi.fn<TxSubmitter>(() => Promise.reject(cause)) });

    const failure = await runToFailure(depsFrom(mocks));

    expect(failure).toBeInstanceOf(DevCeremonyError);
    expect((failure as DevCeremonyError).stage).toBe("submit");
    expect((failure as DevCeremonyError).cause).toBe(cause);
  });

  it("carries the signer's account address on the error for diagnostics", async () => {
    const mocks = makeMocks({ submit: vi.fn<TxSubmitter>(() => Promise.reject(new Error("x"))) });

    const failure = (await runToFailure(depsFrom(mocks))) as DevCeremonyError;

    expect(failure.address).toBe(SIGNER.address);
  });
});
