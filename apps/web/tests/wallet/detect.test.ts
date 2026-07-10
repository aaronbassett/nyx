/**
 * T034 — detection layer: discovery, generation tagging, Lace-preferred picker,
 * and the passive detect→classify pipeline (drives the matrix by mocking
 * `window.midnight`). EC-23 (legacy-only) and EC-26 (multi-wallet) live here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyConnectState } from "@/wallet/classify";
import {
  detectProbe,
  discoverWallets,
  isLaceWallet,
  pickWallet,
  sortWalletsForPicker,
} from "@/wallet/detect";

import { makeWallet } from "./fixtures";

/** A connector-v4 injected entry: exposes `connect()`. */
function v4Entry(name: string, rdns: string): Record<string, unknown> {
  return { rdns, name, icon: "", apiVersion: "4.0.1", connect: () => Promise.resolve({}) };
}

/** A legacy (pre-v4) injected entry: exposes `enable()`, no `connect()`. */
function legacyEntry(name: string, rdns: string): Record<string, unknown> {
  return { rdns, name, icon: "", apiVersion: "3.0.0", enable: () => Promise.resolve({}) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverWallets", () => {
  it("returns an empty list when window.midnight is absent", () => {
    expect(discoverWallets()).toEqual([]);
  });

  it("tags v4 (connect) and legacy (enable) generations from the injected shape", () => {
    vi.stubGlobal("midnight", {
      a: v4Entry("Lace", "io.lace.wallet"),
      b: legacyEntry("Old", "com.old.wallet"),
    });
    const byName = new Map(discoverWallets().map((w) => [w.name, w]));
    expect(byName.get("Lace")?.generation).toBe("v4");
    expect(byName.get("Old")?.generation).toBe("legacy");
    expect(byName.get("Lace")?.rdns).toBe("io.lace.wallet");
  });
});

describe("pickWallet — EC-26 preference + remembered choice", () => {
  const lace = makeWallet({ key: "a", name: "Lace", rdns: "io.lace.wallet" });
  const other = makeWallet({ key: "b", name: "Other", rdns: "com.other.wallet" });

  it("auto-selects the only v4 wallet", () => {
    expect(pickWallet([lace])?.key).toBe("a");
  });

  it("returns undefined for multiple v4 wallets with no remembered choice (picker needed)", () => {
    expect(pickWallet([lace, other])).toBeUndefined();
  });

  it("selects the remembered wallet when its rdns matches", () => {
    expect(pickWallet([lace, other], "com.other.wallet")?.key).toBe("b");
  });

  it("ignores legacy wallets when picking", () => {
    const legacy = makeWallet({ key: "c", generation: "legacy", rdns: "com.legacy.wallet" });
    expect(pickWallet([legacy])).toBeUndefined();
  });
});

describe("Lace preference", () => {
  it("recognises Lace by name, rdns /lace/i, or rdns /midnight/i", () => {
    expect(isLaceWallet(makeWallet({ name: "Lace", rdns: undefined }))).toBe(true);
    expect(isLaceWallet(makeWallet({ name: "X", rdns: "io.lace.wallet" }))).toBe(true);
    expect(isLaceWallet(makeWallet({ name: "X", rdns: "network.midnight.wallet" }))).toBe(true);
    expect(isLaceWallet(makeWallet({ name: "X", rdns: "com.other.wallet" }))).toBe(false);
  });

  it("sorts Lace-preferred wallets first for the picker", () => {
    const lace = makeWallet({ key: "a", name: "Lace", rdns: "io.lace.wallet" });
    const other = makeWallet({ key: "b", name: "Other", rdns: "com.other.wallet" });
    expect(sortWalletsForPicker([other, lace])[0]?.key).toBe("a");
  });
});

describe("detectProbe → classifyConnectState (passive detection, no connect)", () => {
  const detect = (): ReturnType<typeof classifyConnectState> =>
    classifyConnectState(detectProbe({ expectedNetworkId: "preprod", rememberedRdns: undefined }));

  it("no-extension when nothing is injected", () => {
    expect(detect().kind).toBe("no-extension");
  });

  it("unsupported-wallet when only a legacy connector is injected (EC-23)", () => {
    vi.stubGlobal("midnight", { b: legacyEntry("Old", "com.old.wallet") });
    expect(detect().kind).toBe("unsupported-wallet");
  });

  it("not-authorized when a single v4 wallet is injected", () => {
    vi.stubGlobal("midnight", { a: v4Entry("Lace", "io.lace.wallet") });
    expect(detect().kind).toBe("not-authorized");
  });

  it("needs-selection when multiple v4 wallets are injected (EC-26)", () => {
    vi.stubGlobal("midnight", {
      a: v4Entry("Lace", "io.lace.wallet"),
      b: v4Entry("Other", "com.other.wallet"),
    });
    expect(detect().kind).toBe("needs-selection");
  });
});
