/**
 * T034 — EC-26 per-browser persistence of the chosen wallet's rdns, so a user
 * with multiple wallets is not re-prompted with the picker on every visit.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  forgetRememberedWallet,
  loadRememberedWalletRdns,
  rememberWalletRdns,
} from "@/wallet/remember";

afterEach(() => {
  localStorage.clear();
});

describe("remembered wallet choice", () => {
  it("returns undefined when nothing has been remembered", () => {
    expect(loadRememberedWalletRdns()).toBeUndefined();
  });

  it("round-trips a remembered rdns", () => {
    rememberWalletRdns("io.lace.wallet");
    expect(loadRememberedWalletRdns()).toBe("io.lace.wallet");
  });

  it("forgets a remembered rdns", () => {
    rememberWalletRdns("io.lace.wallet");
    forgetRememberedWallet();
    expect(loadRememberedWalletRdns()).toBeUndefined();
  });
});
