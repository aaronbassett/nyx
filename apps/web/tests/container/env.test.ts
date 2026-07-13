/**
 * T086 — `contract:deployed` handler tests (US3 WebContainer preview host).
 *
 * `handleContractDeployed` writes `VITE_CONTRACT_ADDRESS` into the container's
 * `.env.local` (the D10 chokepoint, via the shared {@link createContainerEnv})
 * and then restarts the dev server so Vite re-reads `import.meta.env` (FR-055).
 * The write MUST precede the restart, or the freshly-respawned dev server reads
 * a stale env.
 *
 * These tests drive the handler with the REAL `createContainerEnv` over an
 * in-memory FAKE `WebContainerFsHandle` that records each `writeFile(path,
 * contents)`, plus a `restartDevServer` spy. Both the fake's `writeFile` and the
 * spy push a marker to one shared ordering log, so "write-before-restart" is
 * asserted deterministically — no real WebContainer, no cross-origin-isolated
 * browser (both owner-gated), no dev server.
 */
import { describe, expect, it, vi } from "vitest";

import { CONTRACT_ADDRESS_ENV_KEY, handleContractDeployed } from "@/container/env";
import { createContainerEnv, ENV_LOCAL_PATH } from "@/container/env-file";
import type { WebContainerFsHandle } from "@/container/types";
import type { ContractAddress, ContractDeployedPayload } from "@nyx/protocol";

/** A single recorded `.env.local` rewrite, captured at completion time. */
interface WriteCall {
  readonly path: string;
  readonly contents: string;
}

interface Recorder {
  readonly fs: WebContainerFsHandle;
  /** Every `writeFile` call, in completion order. */
  readonly writes: readonly WriteCall[];
}

/**
 * A fake fs whose `writeFile` records the call and pushes a `"write"` marker to
 * the shared ordering log — genuinely async (resolves on a microtask) so the
 * marker lands when the write COMPLETES, proving a subsequent restart is gated
 * behind the settled write, not merely behind its invocation. The other fs
 * members are unused inert stubs.
 */
function createRecorder(order: string[]): Recorder {
  const writes: WriteCall[] = [];
  const fs: WebContainerFsHandle = {
    writeFile: async (path, contents) => {
      await Promise.resolve();
      writes.push({ path, contents });
      order.push("write");
    },
    rm: () => Promise.resolve(),
    readFile: () => Promise.resolve(""),
    mkdir: (path) => Promise.resolve(path),
  };
  return { fs, writes };
}

/** Mint a branded {@link ContractAddress} for a fixed test string. */
function contractAddress(value: string): ContractAddress {
  return value as ContractAddress;
}

describe("handleContractDeployed (T086, D10, FR-055)", () => {
  it("writes VITE_CONTRACT_ADDRESS into .env.local, then restarts the dev server", async () => {
    const order: string[] = [];
    const recorder = createRecorder(order);
    const env = createContainerEnv(recorder.fs);
    const restartDevServer = vi.fn<() => Promise<void>>(() => {
      order.push("restart");
      return Promise.resolve();
    });

    const payload: ContractDeployedPayload = {
      address: contractAddress("mn_addr_test1qexample"),
    };

    await handleContractDeployed(payload, { env, restartDevServer });

    // The .env.local rewrite carries the contract address under the Vite key.
    expect(recorder.writes).toHaveLength(1);
    const written = recorder.writes[0];
    expect(written?.path).toBe(ENV_LOCAL_PATH);
    expect(written?.contents).toContain(`${CONTRACT_ADDRESS_ENV_KEY}=mn_addr_test1qexample`);
    expect(env.snapshot()).toEqual({ [CONTRACT_ADDRESS_ENV_KEY]: "mn_addr_test1qexample" });

    // Restart happened exactly once, strictly AFTER the write completed.
    expect(restartDevServer).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["write", "restart"]);
  });

  it("overwrites the key on a second deploy so the merged file holds the latest address", async () => {
    const order: string[] = [];
    const recorder = createRecorder(order);
    const env = createContainerEnv(recorder.fs);
    const restartDevServer = vi.fn<() => Promise<void>>(() => {
      order.push("restart");
      return Promise.resolve();
    });

    await handleContractDeployed(
      { address: contractAddress("mn_addr_test1qfirst") },
      { env, restartDevServer },
    );
    await handleContractDeployed(
      { address: contractAddress("mn_addr_test1qsecond") },
      { env, restartDevServer },
    );

    // The merged env holds only the latest address (non-clobbering merge, single key).
    expect(env.snapshot()).toEqual({ [CONTRACT_ADDRESS_ENV_KEY]: "mn_addr_test1qsecond" });
    const latest = recorder.writes[recorder.writes.length - 1];
    expect(latest?.contents).toContain(`${CONTRACT_ADDRESS_ENV_KEY}=mn_addr_test1qsecond`);
    expect(latest?.contents).not.toContain("mn_addr_test1qfirst");

    // Each deploy writes then restarts, preserving per-deploy ordering.
    expect(restartDevServer).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["write", "restart", "write", "restart"]);
  });
});
