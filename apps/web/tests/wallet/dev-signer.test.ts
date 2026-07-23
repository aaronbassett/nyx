import { addressFromKey, verifySignature } from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { describe, expect, it } from "vitest";
import {
  createDevSigner,
  generateDevSeed,
  reconstructSignedBytes,
} from "../../src/wallet/dev-signer";

describe("dev signer", () => {
  it("produces a signature the server-side verify recipe accepts", () => {
    const seed = generateDevSeed();
    const signer = createDevSigner(seed, "undeployed");
    const message = "nyx.example wants you to sign in.\n\nNonce: abc123";
    const signature = signer.sign(message);
    // EXACTLY what apps/server/src/auth/verify.ts:70-81 executes:
    expect(verifySignature(signer.verifyingKey, reconstructSignedBytes(message), signature)).toBe(
      true,
    );
  });

  it("binds address = SHA-256(verifyingKey) exactly as verifyKeyAddressBinding checks", () => {
    const signer = createDevSigner(generateDevSeed(), "undeployed");
    const fromKey = addressFromKey(signer.verifyingKey).toLowerCase();
    const parsed = MidnightBech32m.parse(signer.address);
    const decoded = parsed.decode(UnshieldedAddress, parsed.network);
    expect(decoded.hexString.toLowerCase()).toBe(fromKey);
  });

  it("is deterministic for a fixed seed", () => {
    const seed = generateDevSeed();
    const a = createDevSigner(seed, "undeployed");
    const b = createDevSigner(seed, "undeployed");
    expect(a.address).toBe(b.address);
    expect(a.verifyingKey).toBe(b.verifyingKey);
  });
});
