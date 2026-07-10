/**
 * T034 — the load-bearing four-state connect matrix (FR-037 / SC-020).
 *
 * `classifyConnectState` is a PURE decision function over a probe result, the
 * same shape the UI feeds it. These tests exercise every branch of the matrix
 * so classification is deterministic and never a generic failure (SC-020: the
 * connect surface resolves to exactly one named state in 100% of cases).
 */
import { describe, expect, it } from "vitest";

import { classifyConnectState } from "@/wallet/classify";
import type { ConnectProbe, ConnectState } from "@/wallet/types";

import { makeProbe, makeWallet } from "./fixtures";

describe("classifyConnectState — FR-037 four states", () => {
  it("no-extension when window.midnight has zero entries", () => {
    expect(classifyConnectState(makeProbe({ wallets: [] })).kind).toBe("no-extension");
  });

  it("not-authorized when a single v4 wallet is present but connect was not attempted", () => {
    const lace = makeWallet();
    const state = classifyConnectState(
      makeProbe({ wallets: [lace], selected: lace, connection: undefined }),
    );
    expect(state.kind).toBe("not-authorized");
  });

  it("not-authorized even before selection resolves, when exactly one v4 wallet exists", () => {
    const lace = makeWallet();
    expect(classifyConnectState(makeProbe({ wallets: [lace], selected: undefined })).kind).toBe(
      "not-authorized",
    );
  });

  it("not-authorized when the user rejects the connect prompt (EC-24, clean cancel)", () => {
    const lace = makeWallet();
    const state = classifyConnectState(
      makeProbe({ wallets: [lace], selected: lace, connection: { status: "rejected" } }),
    );
    expect(state.kind).toBe("not-authorized");
  });

  it("authorized-but-unavailable when connect resolved but a follow-up call fails (R8)", () => {
    const lace = makeWallet();
    const state = classifyConnectState(
      makeProbe({ wallets: [lace], selected: lace, connection: { status: "unavailable" } }),
    );
    expect(state.kind).toBe("authorized-but-unavailable");
  });

  it("wrong-network when the connected network id differs from the expected one", () => {
    const lace = makeWallet();
    const state = classifyConnectState(
      makeProbe({
        expectedNetworkId: "preprod",
        wallets: [lace],
        selected: lace,
        connection: { status: "ready", networkId: "testnet", unshieldedAddress: "mn_addr_1" },
      }),
    );
    expect(state.kind).toBe("wrong-network");
    if (state.kind === "wrong-network") {
      expect(state.expectedNetworkId).toBe("preprod");
      expect(state.actualNetworkId).toBe("testnet");
    }
  });

  it("connected when the network id matches and an unshielded address is obtained (T039 seam)", () => {
    const lace = makeWallet();
    const state = classifyConnectState(
      makeProbe({
        expectedNetworkId: "preprod",
        wallets: [lace],
        selected: lace,
        connection: { status: "ready", networkId: "preprod", unshieldedAddress: "mn_addr_abc" },
      }),
    );
    expect(state.kind).toBe("connected");
    if (state.kind === "connected") {
      expect(state.unshieldedAddress).toBe("mn_addr_abc");
    }
  });
});

describe("classifyConnectState — edge cases EC-23 / EC-26", () => {
  it("unsupported-wallet when only a legacy (enable, no connect) wallet is present (EC-23)", () => {
    const legacy = makeWallet({ generation: "legacy", name: "OldWallet", rdns: "com.old.wallet" });
    const state = classifyConnectState(makeProbe({ wallets: [legacy], selected: undefined }));
    expect(state.kind).toBe("unsupported-wallet");
  });

  it("needs-selection when multiple v4 wallets are present and none is chosen (EC-26)", () => {
    const lace = makeWallet({ key: "a", name: "Lace", rdns: "io.lace.wallet" });
    const other = makeWallet({ key: "b", name: "Other", rdns: "com.other.wallet" });
    const state = classifyConnectState(makeProbe({ wallets: [lace, other], selected: undefined }));
    expect(state.kind).toBe("needs-selection");
  });
});

describe("SC-020 — every probe classifies into exactly one named, non-generic state", () => {
  const lace = makeWallet({ key: "lace", name: "Lace", rdns: "io.lace.wallet" });
  const other = makeWallet({ key: "other", name: "Other", rdns: "com.other.wallet" });
  const legacy = makeWallet({
    key: "legacy",
    name: "Legacy",
    rdns: "com.legacy.wallet",
    generation: "legacy",
  });

  const cases: readonly { name: string; probe: ConnectProbe; expected: ConnectState["kind"] }[] = [
    { name: "absent", probe: makeProbe({ wallets: [] }), expected: "no-extension" },
    {
      name: "legacy-only",
      probe: makeProbe({ wallets: [legacy] }),
      expected: "unsupported-wallet",
    },
    { name: "multi-v4", probe: makeProbe({ wallets: [lace, other] }), expected: "needs-selection" },
    {
      name: "single-v4-idle",
      probe: makeProbe({ wallets: [lace], selected: lace }),
      expected: "not-authorized",
    },
    {
      name: "rejected",
      probe: makeProbe({ wallets: [lace], selected: lace, connection: { status: "rejected" } }),
      expected: "not-authorized",
    },
    {
      name: "unavailable",
      probe: makeProbe({ wallets: [lace], selected: lace, connection: { status: "unavailable" } }),
      expected: "authorized-but-unavailable",
    },
    {
      name: "wrong-net",
      probe: makeProbe({
        wallets: [lace],
        selected: lace,
        connection: { status: "ready", networkId: "testnet", unshieldedAddress: "a" },
      }),
      expected: "wrong-network",
    },
    {
      name: "connected",
      probe: makeProbe({
        wallets: [lace],
        selected: lace,
        connection: { status: "ready", networkId: "preprod", unshieldedAddress: "a" },
      }),
      expected: "connected",
    },
  ];

  it.each(cases)("$name → $expected", ({ probe, expected }) => {
    expect(classifyConnectState(probe).kind).toBe(expected);
  });
});
