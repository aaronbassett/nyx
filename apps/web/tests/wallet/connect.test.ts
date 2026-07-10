/**
 * T034 — active connect flow (T038). Drives the connector-v4 `connect()` +
 * follow-up probe (`getConnectionStatus` / `getUnshieldedAddress`) and asserts
 * the resulting observation classifies into the right FR-037 state, including
 * R8's hard lesson: authorization can succeed while the wallet is unusable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";

import { classifyConnectState } from "@/wallet/classify";
import { connectWallet } from "@/wallet/connect";
import type { ConnectionObservation } from "@/wallet/types";

import { makeProbe, makeWallet } from "./fixtures";

const lace = makeWallet();

/** An injected v4 entry whose connect() resolves to the given (faked) ConnectedAPI. */
function entryConnectingTo(api: unknown): InitialAPI {
  return {
    rdns: "io.lace.wallet",
    name: "Lace",
    icon: "",
    apiVersion: "4.0.1",
    connect: () => Promise.resolve(api),
  } as unknown as InitialAPI;
}

/** An injected v4 entry whose connect() rejects (EC-24 user cancel / decline). */
function rejectingEntry(error: Error): InitialAPI {
  return {
    rdns: "io.lace.wallet",
    name: "Lace",
    icon: "",
    apiVersion: "4.0.1",
    connect: () => Promise.reject(error),
  };
}

/** A healthy connected wallet reporting the given network id and address. */
function connectedApi(networkId: string, address = "mn_addr_1"): ConnectedAPI {
  return {
    getConnectionStatus: () => Promise.resolve({ status: "connected", networkId }),
    getUnshieldedAddress: () => Promise.resolve({ unshieldedAddress: address }),
  } as unknown as ConnectedAPI;
}

/** Classify an observation as if it belonged to the single selected Lace wallet. */
function classify(observation: ConnectionObservation): ReturnType<typeof classifyConnectState> {
  return classifyConnectState(
    makeProbe({
      expectedNetworkId: "preprod",
      wallets: [lace],
      selected: lace,
      connection: observation,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("connectWallet — T038 active connect", () => {
  it("ready + live api when connect resolves and probes succeed → connected", async () => {
    const outcome = await connectWallet(entryConnectingTo(connectedApi("preprod")), "preprod");
    expect(outcome.observation.status).toBe("ready");
    expect(outcome.api).toBeDefined(); // seam: the live ConnectedAPI T039 consumes
    if (outcome.observation.status === "ready") {
      expect(outcome.observation.unshieldedAddress).toBe("mn_addr_1");
    }
    expect(classify(outcome.observation).kind).toBe("connected");
  });

  it("carries the actual network id → wrong-network when it differs from expected", async () => {
    const outcome = await connectWallet(entryConnectingTo(connectedApi("testnet")), "preprod");
    expect(classify(outcome.observation).kind).toBe("wrong-network");
  });

  it("unavailable when connect resolves but getUnshieldedAddress throws (R8)", async () => {
    const brokenApi = {
      getConnectionStatus: () => Promise.resolve({ status: "connected", networkId: "preprod" }),
      getUnshieldedAddress: () => Promise.reject(new Error("wallet locked")),
    } as unknown as ConnectedAPI;
    const outcome = await connectWallet(entryConnectingTo(brokenApi), "preprod");
    expect(outcome.observation.status).toBe("unavailable");
    expect(outcome.api).toBeDefined(); // authorization succeeded; the handle exists but is broken
    expect(classify(outcome.observation).kind).toBe("authorized-but-unavailable");
  });

  it("unavailable when the wallet reports disconnected immediately after connect", async () => {
    const api = {
      getConnectionStatus: () => Promise.resolve({ status: "disconnected" }),
      getUnshieldedAddress: () => Promise.resolve({ unshieldedAddress: "x" }),
    } as unknown as ConnectedAPI;
    const outcome = await connectWallet(entryConnectingTo(api), "preprod");
    expect(outcome.observation.status).toBe("unavailable");
  });

  it("rejected + no api when the user cancels the connect prompt (EC-24)", async () => {
    const outcome = await connectWallet(rejectingEntry(new Error("User rejected")), "preprod");
    expect(outcome.observation.status).toBe("rejected");
    expect(outcome.api).toBeUndefined();
    expect(classify(outcome.observation).kind).toBe("not-authorized");
  });

  it("unavailable when a follow-up call hangs past the timeout (R8 hang)", async () => {
    vi.useFakeTimers();
    const hangingApi = {
      getConnectionStatus: () => Promise.resolve({ status: "connected", networkId: "preprod" }),
      getUnshieldedAddress: () =>
        new Promise<{ unshieldedAddress: string }>(() => {
          /* never resolves */
        }),
    } as unknown as ConnectedAPI;
    const pending = connectWallet(entryConnectingTo(hangingApi), "preprod", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await pending;
    expect(outcome.observation.status).toBe("unavailable");
  });
});
