import { beforeEach, describe, expect, it } from "vitest";

import { NyxtVaultSimulator, ref } from "./nyxt-vault-simulator.js";

// The per-deposit mint cap: NYXT is minted with a Uint<64> value.
const MAX_MINT = (1n << 64n) - 1n; // 2^64 - 1
const MAX_UINT128 = (1n << 128n) - 1n; // 2^128 - 1 (full width of the amount param)

describe("NyxtVault.deposit", () => {
  let vault: NyxtVaultSimulator;

  beforeEach(() => {
    vault = new NyxtVaultSimulator();
  });

  describe("attribution record (deposits map)", () => {
    it("is empty before any deposit", () => {
      const { deposits } = vault.ledger();
      expect(deposits.isEmpty()).toBe(true);
      expect(deposits.size()).toBe(0n);
    });

    it("records depositRef -> amount on a successful deposit", () => {
      const r = ref("ref-1");
      vault.deposit(r, 1000n);

      const { deposits } = vault.ledger();
      expect(deposits.member(r)).toBe(true);
      expect(deposits.lookup(r)).toBe(1000n);
      expect(deposits.size()).toBe(1n);
    });

    it("accumulates multiple distinct refs, each mapped to its own amount", () => {
      vault.deposit(ref("a"), 10n);
      vault.deposit(ref("b"), 20n);
      vault.deposit(ref("c"), 30n);

      const { deposits } = vault.ledger();
      expect(deposits.size()).toBe(3n);
      expect(deposits.lookup(ref("a"))).toBe(10n);
      expect(deposits.lookup(ref("b"))).toBe(20n);
      expect(deposits.lookup(ref("c"))).toBe(30n);
    });

    it("does not report membership for a ref that was never deposited", () => {
      vault.deposit(ref("present"), 5n);
      expect(vault.ledger().deposits.member(ref("absent"))).toBe(false);
    });
  });

  describe("duplicate depositRef rejection (idempotency / anti-double-spend)", () => {
    it("rejects a second deposit that reuses a recorded ref", () => {
      const r = ref("dup");
      vault.deposit(r, 100n);
      expect(() => vault.deposit(r, 100n)).toThrow("NyxtVault: depositRef already present");
    });

    it("rejects a duplicate even when the amount differs", () => {
      const r = ref("dup-diff-amount");
      vault.deposit(r, 100n);
      expect(() => vault.deposit(r, 999n)).toThrow("NyxtVault: depositRef already present");
    });

    it("leaves the original record intact after a rejected duplicate", () => {
      const r = ref("dup-intact");
      vault.deposit(r, 100n);
      expect(() => vault.deposit(r, 200n)).toThrow();

      const { deposits } = vault.ledger();
      expect(deposits.size()).toBe(1n);
      expect(deposits.lookup(r)).toBe(100n); // first value wins; the chain is authoritative
    });

    it("still accepts a fresh ref after a duplicate was rejected", () => {
      vault.deposit(ref("first"), 100n);
      expect(() => vault.deposit(ref("first"), 100n)).toThrow();
      vault.deposit(ref("second"), 250n);

      const { deposits } = vault.ledger();
      expect(deposits.size()).toBe(2n);
      expect(deposits.lookup(ref("second"))).toBe(250n);
    });
  });

  describe("amount validation (boundaries)", () => {
    it("rejects a zero amount", () => {
      expect(() => vault.deposit(ref("zero"), 0n)).toThrow("NyxtVault: amount must be positive");
    });

    it("does not record state for a rejected zero-amount deposit", () => {
      expect(() => vault.deposit(ref("zero"), 0n)).toThrow();
      const { deposits } = vault.ledger();
      expect(deposits.member(ref("zero"))).toBe(false);
      expect(deposits.size()).toBe(0n);
    });

    it("accepts the minimum positive amount (1)", () => {
      vault.deposit(ref("min"), 1n);
      expect(vault.ledger().deposits.lookup(ref("min"))).toBe(1n);
    });

    it("accepts the maximum per-deposit amount (2^64 - 1)", () => {
      vault.deposit(ref("max"), MAX_MINT);
      expect(vault.ledger().deposits.lookup(ref("max"))).toBe(MAX_MINT);
    });

    it("rejects an amount one over the mint cap (2^64)", () => {
      expect(() => vault.deposit(ref("over"), 1n << 64n)).toThrow(
        "NyxtVault: amount exceeds per-deposit mint cap",
      );
    });

    it("rejects a full-width Uint<128> amount (2^128 - 1)", () => {
      expect(() => vault.deposit(ref("huge"), MAX_UINT128)).toThrow(
        "NyxtVault: amount exceeds per-deposit mint cap",
      );
    });
  });

  describe("NYXT mint credits the vault (1:1)", () => {
    it("mints exactly `amount` NYXT into the vault for `amount` tNIGHT received", () => {
      const effects = vault.deposit(ref("mint-1"), 1234n);
      expect(effects.tnightReceived).toBe(1234n); // tNIGHT claimed as input
      expect(effects.nyxtMinted).toBe(1234n); // NYXT created by the self-mint
      expect(effects.nyxtVaultCredited).toBe(1234n); // NYXT credited to the vault
    });

    it("does not double-count the vault credit (mint == vault credit, not 2x)", () => {
      const effects = vault.deposit(ref("no-double"), 1000n);
      expect(effects.nyxtVaultCredited).toBe(effects.nyxtMinted);
      expect(effects.nyxtVaultCredited).toBe(1000n);
    });

    it("holds the 1:1 invariant across the full accepted amount range", () => {
      for (const amount of [1n, 2n, 1000n, MAX_MINT]) {
        const isolated = new NyxtVaultSimulator();
        const effects = isolated.deposit(ref("inv"), amount);
        expect(effects.nyxtMinted).toBe(amount);
        expect(effects.nyxtVaultCredited).toBe(amount);
        expect(effects.tnightReceived).toBe(amount);
      }
    });

    it("derives a stable NYXT token color distinct from native tNIGHT", () => {
      const effects = vault.deposit(ref("color"), 5n);
      expect(effects.nyxtColor).toMatch(/^[0-9a-f]{64}$/);
      expect(effects.nyxtColor).not.toBe("0".repeat(64));
    });
  });
});
