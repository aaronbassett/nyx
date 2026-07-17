import { beforeEach, describe, expect, it } from "vitest";

import {
  ABSENT_ORCHESTRATOR_SECRET,
  DEFAULT_ORCHESTRATOR_SECRET,
  NyxtVaultSimulator,
  nyxtTokenColor,
  ref,
} from "./nyxt-vault-simulator.js";

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

describe("NyxtVault.burn", () => {
  // A comfortable seeded NYXT balance for happy-path burns. On-chain this is what
  // the vault's persistent unshielded balance would be after prior deposits; the
  // simulator seeds it because the balance guard reads kernel.balance at the start
  // of the transaction, which the runtime does not carry across separate calls.
  const VAULT_BALANCE = 10_000n;

  describe("orchestrator-only authorization (the core security gate)", () => {
    it("accepts a burn from the pinned orchestrator secret", () => {
      const vault = new NyxtVaultSimulator(); // pinned to DEFAULT_ORCHESTRATOR_SECRET
      const effects = vault.burn(300n, ref("w-ok"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(effects.nyxtBurned).toBe(300n);
      expect(vault.ledger().burnedWatermarks.member(ref("w-ok"))).toBe(true);
    });

    it("rejects a burn from a WRONG orchestrator secret", () => {
      const vault = new NyxtVaultSimulator();
      const wrong = new Uint8Array(32).fill(0x99);
      expect(() =>
        vault.burn(300n, ref("w-wrong"), {
          proverSecret: wrong,
          vaultNyxtBalance: VAULT_BALANCE,
        }),
      ).toThrow("NyxtVault: caller is not the orchestrator");
    });

    it("rejects a burn from an ABSENT (all-zero) secret at the witness weak-key guard (M1)", () => {
      const vault = new NyxtVaultSimulator();
      // The all-zero secret is refused by the witness BEFORE the circuit auth assert — a
      // stronger, earlier rejection than a wrong-but-valid secret (security review M1: an
      // all-zero default secret would otherwise be a publicly-reproducible known preimage).
      expect(() =>
        vault.burn(300n, ref("w-absent"), {
          proverSecret: ABSENT_ORCHESTRATOR_SECRET,
          vaultNyxtBalance: VAULT_BALANCE,
        }),
      ).toThrow(/refusing all-zero\/default secret/);
    });

    it("refuses to CONSTRUCT with an all-zero orchestrator secret (M1)", () => {
      // The witness guard also fires at construction (the constructor pins the authority from
      // the secret), so a vault can never be deployed with the weak default secret.
      expect(() => new NyxtVaultSimulator(ABSENT_ORCHESTRATOR_SECRET)).toThrow(
        /refusing all-zero\/default secret/,
      );
    });

    it("binds authorization to the secret pinned at construction, not a fixed key", () => {
      const secretB = new Uint8Array(32).fill(0x22);
      const vault = new NyxtVaultSimulator(secretB); // authority pinned to secretB
      // The DEFAULT secret cannot burn this vault…
      expect(() =>
        vault.burn(300n, ref("w-bind"), {
          proverSecret: DEFAULT_ORCHESTRATOR_SECRET,
          vaultNyxtBalance: VAULT_BALANCE,
        }),
      ).toThrow("NyxtVault: caller is not the orchestrator");
      // …but secretB (the pinned one) can.
      const effects = vault.burn(300n, ref("w-bind"), {
        proverSecret: secretB,
        vaultNyxtBalance: VAULT_BALANCE,
      });
      expect(effects.nyxtBurned).toBe(300n);
    });

    it("does not record a watermark for an unauthorized burn", () => {
      const vault = new NyxtVaultSimulator();
      const wrong = new Uint8Array(32).fill(0x99);
      expect(() =>
        vault.burn(300n, ref("w-unauth"), {
          proverSecret: wrong,
          vaultNyxtBalance: VAULT_BALANCE,
        }),
      ).toThrow();
      expect(vault.ledger().burnedWatermarks.member(ref("w-unauth"))).toBe(false);
      expect(vault.ledger().burnedWatermarks.isEmpty()).toBe(true);
    });
  });

  describe("burn reduces the vault balance", () => {
    it("removes exactly `amount` NYXT from the vault (unshielded output)", () => {
      const vault = new NyxtVaultSimulator();
      const effects = vault.burn(2500n, ref("w-amt"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(effects.nyxtBurned).toBe(2500n);
      expect(effects.nyxtColor).toBe(nyxtTokenColor());
    });

    it("burns the NYXT color, never native tNIGHT", () => {
      const vault = new NyxtVaultSimulator();
      const effects = vault.burn(1n, ref("w-color"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(effects.nyxtColor).toMatch(/^[0-9a-f]{64}$/);
      expect(effects.nyxtColor).not.toBe("0".repeat(64));
    });
  });

  describe("balance guard (reject burning more than the vault holds)", () => {
    it("rejects a burn against a zero-balance vault", () => {
      const vault = new NyxtVaultSimulator();
      expect(() => vault.burn(1n, ref("w-zero-bal"))).toThrow(
        "NyxtVault: burn exceeds vault balance",
      );
    });

    it("rejects a burn one unit over the vault balance", () => {
      const vault = new NyxtVaultSimulator();
      expect(() => vault.burn(1001n, ref("w-over"), { vaultNyxtBalance: 1000n })).toThrow(
        "NyxtVault: burn exceeds vault balance",
      );
    });

    it("accepts a burn of exactly the vault balance (boundary)", () => {
      const vault = new NyxtVaultSimulator();
      const effects = vault.burn(1000n, ref("w-exact"), { vaultNyxtBalance: 1000n });
      expect(effects.nyxtBurned).toBe(1000n);
    });

    it("does not record a watermark for an over-balance burn", () => {
      const vault = new NyxtVaultSimulator();
      expect(() => vault.burn(1001n, ref("w-over2"), { vaultNyxtBalance: 1000n })).toThrow();
      expect(vault.ledger().burnedWatermarks.member(ref("w-over2"))).toBe(false);
    });
  });

  describe("amount validation", () => {
    it("rejects a zero-amount burn", () => {
      const vault = new NyxtVaultSimulator();
      expect(() => vault.burn(0n, ref("w-zero"), { vaultNyxtBalance: VAULT_BALANCE })).toThrow(
        "NyxtVault: amount must be positive",
      );
    });
  });

  describe("watermark idempotency (exactly-once per watermark)", () => {
    it("rejects a second burn that reuses a recorded watermark", () => {
      const vault = new NyxtVaultSimulator();
      vault.burn(100n, ref("w-dup"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(() => vault.burn(100n, ref("w-dup"), { vaultNyxtBalance: VAULT_BALANCE })).toThrow(
        "NyxtVault: watermark already burned",
      );
    });

    it("rejects a duplicate even when the amount differs", () => {
      const vault = new NyxtVaultSimulator();
      vault.burn(100n, ref("w-dup-amt"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(() => vault.burn(250n, ref("w-dup-amt"), { vaultNyxtBalance: VAULT_BALANCE })).toThrow(
        "NyxtVault: watermark already burned",
      );
    });

    it("still accepts a fresh watermark after a duplicate was rejected", () => {
      const vault = new NyxtVaultSimulator();
      vault.burn(100n, ref("w-first"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(() => vault.burn(100n, ref("w-first"), { vaultNyxtBalance: VAULT_BALANCE })).toThrow();
      const effects = vault.burn(200n, ref("w-second"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(effects.nyxtBurned).toBe(200n);
      expect(vault.ledger().burnedWatermarks.size()).toBe(2n);
    });

    it("accumulates distinct burned watermarks", () => {
      const vault = new NyxtVaultSimulator();
      vault.burn(10n, ref("w-a"), { vaultNyxtBalance: VAULT_BALANCE });
      vault.burn(20n, ref("w-b"), { vaultNyxtBalance: VAULT_BALANCE });
      vault.burn(30n, ref("w-c"), { vaultNyxtBalance: VAULT_BALANCE });
      const { burnedWatermarks } = vault.ledger();
      expect(burnedWatermarks.size()).toBe(3n);
      expect(burnedWatermarks.member(ref("w-a"))).toBe(true);
      expect(burnedWatermarks.member(ref("w-b"))).toBe(true);
      expect(burnedWatermarks.member(ref("w-c"))).toBe(true);
    });
  });

  describe("construction pins a stable orchestrator authority", () => {
    it("exposes a non-zero orchestrator authority commitment", () => {
      const vault = new NyxtVaultSimulator();
      const auth = vault.ledger().orchestratorAuthority.bytes;
      expect(auth.length).toBe(32);
      expect(Buffer.from(auth).toString("hex")).not.toBe("0".repeat(64));
    });

    it("pins distinct commitments for distinct secrets", () => {
      const a = new NyxtVaultSimulator(new Uint8Array(32).fill(0x11));
      const b = new NyxtVaultSimulator(new Uint8Array(32).fill(0x22));
      const ha = Buffer.from(a.ledger().orchestratorAuthority.bytes).toString("hex");
      const hb = Buffer.from(b.ledger().orchestratorAuthority.bytes).toString("hex");
      expect(ha).not.toBe(hb);
    });
  });

  describe("deposit and burn coexist (deposit path unchanged)", () => {
    it("records + mints a deposit unchanged after burn was added", () => {
      const vault = new NyxtVaultSimulator();
      const dep = vault.deposit(ref("coexist"), 4242n);
      expect(dep.nyxtMinted).toBe(4242n);
      expect(dep.nyxtVaultCredited).toBe(4242n);
      expect(vault.ledger().deposits.lookup(ref("coexist"))).toBe(4242n);
    });

    it("keeps deposit refs and burn watermarks as independent namespaces", () => {
      const vault = new NyxtVaultSimulator();
      vault.deposit(ref("shared"), 500n);
      // The same 32-byte label used as a watermark is NOT a duplicate — the deposits
      // Map and the burnedWatermarks Set are separate ledger fields.
      const effects = vault.burn(100n, ref("shared"), { vaultNyxtBalance: VAULT_BALANCE });
      expect(effects.nyxtBurned).toBe(100n);
      expect(vault.ledger().deposits.member(ref("shared"))).toBe(true);
      expect(vault.ledger().burnedWatermarks.member(ref("shared"))).toBe(true);
    });
  });
});
