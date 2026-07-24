/**
 * Ceremony selector tests (P3 Task 5, Step 7).
 *
 * `selectDepositCeremony` picks the dev-wallet ceremony under `VITE_DEV_WALLET === "1"`
 * and the owner-gated stub otherwise, composing the wasm-primary/proxy-fallback prover,
 * the config-sourced vault address, and per-wallet serialized submissions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DepositRef } from "@nyx/protocol";

import { NYXT_VAULT_ADDRESS } from "@/config";
import {
  selectDepositCeremony,
  serializeSubmissions,
  withFallback,
} from "@/wallet/ceremony-select";
import type { CeremonyProver, DepositTxBuilder, TxSubmitter } from "@/wallet/dev-ceremony";
import type { DepositCeremony } from "@/wallet/topup";
import type { DevSigner } from "@/wallet/dev-signer";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const DEPOSIT_REF =
  "a66b22ac00000000000000000000000000000000000000000000000000d78240" as DepositRef;
const AMOUNT = 5000n;
const PROVEN = new Uint8Array([9, 9, 9]);
const TX_REF = "00deadbeef";

const SIGNER: DevSigner = {
  verifyingKey: "vk",
  address: "mn_addr_undeployed1abc",
  sign: () => "sig",
};

const devEnv = { VITE_DEV_WALLET: "1" } as const;

function fakeBuildTx(): DepositTxBuilder {
  return vi.fn<DepositTxBuilder>(() => Promise.resolve({ unprovenTx: new Uint8Array([1]) }));
}
function fakeProver(bytes = PROVEN): CeremonyProver {
  return { prove: vi.fn<CeremonyProver["prove"]>(() => Promise.resolve(bytes)) };
}
function fakeSubmit(): TxSubmitter {
  return vi.fn<TxSubmitter>(() => Promise.resolve({ txRef: TX_REF }));
}

describe("selectDepositCeremony", () => {
  it("returns the owner-gated ceremony when the dev-wallet flag is off", () => {
    const marker: DepositCeremony = { runCeremony: () => Promise.reject(new Error("gated")) };
    const ownerGated = vi.fn(() => marker);

    const ceremony = selectDepositCeremony({ signer: SIGNER, env: {}, ownerGated });

    expect(ceremony).toBe(marker);
    expect(ownerGated).toHaveBeenCalledTimes(1);
  });

  it("builds a working dev ceremony from injected seams when the flag is on", async () => {
    const buildTx = fakeBuildTx();
    const submit = fakeSubmit();
    const ceremony = selectDepositCeremony({
      signer: SIGNER,
      env: devEnv,
      contractAddress: "0200vault",
      buildTx,
      prover: fakeProver(),
      submit,
    });

    const result = await ceremony.runCeremony({ depositRef: DEPOSIT_REF, amount: AMOUNT });
    expect(result).toEqual({ txRef: TX_REF });
    // The injected config-chokepoint address reaches buildTx (never an env read).
    expect(buildTx).toHaveBeenCalledWith(expect.objectContaining({ contractAddress: "0200vault" }));
  });

  it("sources the vault address from the config chokepoint when not overridden", async () => {
    // No override → the selector uses the `config.ts` chokepoint binding (never an env
    // read inside the ceremony). config.test.ts covers that the binding tracks the env;
    // here we pin the WIRING: buildTx receives exactly the config value.
    const buildTx = fakeBuildTx();
    const ceremony = selectDepositCeremony({
      signer: SIGNER,
      env: devEnv,
      buildTx,
      prover: fakeProver(),
      submit: fakeSubmit(),
    });

    await ceremony.runCeremony({ depositRef: DEPOSIT_REF, amount: AMOUNT });
    expect(buildTx).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: NYXT_VAULT_ADDRESS }),
    );
  });

  it("falls back to the proxy prover when the primary (wasm) prover fails", async () => {
    // Standalone mocks so assertions reference plain values (no `unbound-method`).
    const primaryProve = vi.fn<CeremonyProver["prove"]>(() =>
      Promise.reject(new Error("wasm oom")),
    );
    const fallbackProve = vi.fn<CeremonyProver["prove"]>(() =>
      Promise.resolve(new Uint8Array([7, 7])),
    );
    const submit = fakeSubmit();

    const ceremony = selectDepositCeremony({
      signer: SIGNER,
      env: devEnv,
      contractAddress: "0200vault",
      buildTx: fakeBuildTx(),
      prover: { prove: primaryProve },
      fallbackProver: { prove: fallbackProve },
      submit,
    });

    await ceremony.runCeremony({ depositRef: DEPOSIT_REF, amount: AMOUNT });
    expect(primaryProve).toHaveBeenCalledTimes(1);
    expect(fallbackProve).toHaveBeenCalledTimes(1);
    // The proven bytes that reach submit are the FALLBACK's output.
    expect(submit).toHaveBeenCalledWith(new Uint8Array([7, 7]));
  });
});

describe("serializeSubmissions", () => {
  it("never runs two submissions concurrently for one wallet (SPIKE-2 risk 7)", async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: (() => void)[] = [];
    const inner: TxSubmitter = () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<{ txRef: string }>((resolve) => {
        resolvers.push(() => {
          active -= 1;
          resolve({ txRef: TX_REF });
        });
      });
    };
    const serial = serializeSubmissions(inner);

    const first = serial(new Uint8Array([1]));
    const second = serial(new Uint8Array([2]));

    // Only the first submission may be in flight until it settles.
    await Promise.resolve();
    expect(maxActive).toBe(1);
    expect(resolvers).toHaveLength(1);

    resolvers[0]?.();
    await first;
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.();
    await second;

    expect(maxActive).toBe(1);
  });

  it("does not wedge the queue when a submission rejects", async () => {
    let call = 0;
    const inner: TxSubmitter = () => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("first failed"))
        : Promise.resolve({ txRef: TX_REF });
    };
    const serial = serializeSubmissions(inner);

    await expect(serial(new Uint8Array([1]))).rejects.toThrow("first failed");
    await expect(serial(new Uint8Array([2]))).resolves.toEqual({ txRef: TX_REF });
  });
});

describe("withFallback", () => {
  it("returns the primary unchanged when no fallback is given", () => {
    const primary = fakeProver();
    expect(withFallback(primary)).toBe(primary);
  });
});
