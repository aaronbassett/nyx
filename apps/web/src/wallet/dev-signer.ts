/**
 * Dev wallet signing core (Task 2) — the demo's ONE wallet concession.
 *
 * A pure, connector-independent module: seed → keypair → address, plus
 * prefix-compatible message signing. The DApp frontend holds the user's signing
 * key and signs on their behalf (no Lace), so a real BIP-340 Schnorr signature
 * plus verifyingKey/address is produced entirely in-browser.
 *
 * ⚠️ LOAD-BEARING (proven by tests/wallet/dev-signer.test.ts): everything here
 * uses the EXACT ledger-v8 recipe the server's SIWE auth already accepts
 * UNMODIFIED — `sampleSigningKey` / `signatureVerifyingKey` / `addressFromKey`
 * / `signData` and the `midnight_signed_message:<byteLen>:` prefix. The signer's
 * output must verify under `apps/server/src/auth/verify.ts`
 * (`verifySignature` + `reconstructSignedBytes`) and its address must satisfy
 * that file's `verifyKeyAddressBinding` (address == SHA-256(verifyingKey)).
 *
 * Constitution I — every SDK shape below was read from the installed `.d.ts`
 * (never memory), verified against `apps/web/node_modules/`:
 *   - `@midnight-ntwrk/ledger-v8@8.1.0`:
 *       function sampleSigningKey(): SigningKey;                                  // SigningKey = string
 *       function signatureVerifyingKey(sk: SigningKey): SignatureVerifyingKey;    // = string (hex)
 *       function signData(key: SigningKey, data: Uint8Array): Signature;          // = string (hex)
 *       function addressFromKey(key: SignatureVerifyingKey): UserAddress;         // = string (32-byte hex)
 *       function verifySignature(vk, data: Uint8Array, sig): boolean;             // (used by the test)
 *     All four money/identity types are opaque hex strings — no WASM objects cross
 *     the module boundary. ledger-v8 is ESM with sync WASM init (loads under vitest
 *     node; the vite-bundle proof is the Task-2 build gate).
 *   - `@midnight-ntwrk/wallet-sdk-address-format@3.1.2`:
 *       class UnshieldedAddress { constructor(data: Buffer); get hexString(): string; }
 *       class MidnightBech32m { static encode(networkId, item): MidnightBech32m; asString(): string; }
 *     The `.d.ts` constructor demands a Node `Buffer` (no `Buffer` in the browser).
 *     BUT the encode-only path this module takes never touches a `Buffer` method:
 *     `UnshieldedAddress` only checks `data.length === 32` in its constructor and
 *     the codec serialises via `bech32m.toWords(data)` (`@scure/base`, pure
 *     Uint8Array) — verified by reading dist/index.js. So a browser-safe
 *     `Uint8Array` from the local `hexToBytes` is correct at runtime; the single
 *     `as Buffer` assertion below only satisfies the over-strict `.d.ts` type.
 *     (Decoding/`hexString` — the path the binding test exercises — DOES call
 *     `Buffer.prototype.toString`, but that runs in the test's Node env, never in
 *     this signer.)
 */
import {
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
} from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

/**
 * Bech32m network segment for local-devnet addresses (Task-2 Step 6, constitution I).
 *
 * SPIKE-2 §C records the executed value: the funded devnet wallet's address is
 * `mn_addr_undeployed1g9nr3mvjcey7ca8shcs5d4yjndcnmczf90rhv4nju7qqqlfg4ygs0t4ngm`
 * — Bech32m network segment lowercase `undeployed`. Lace merely DISPLAYS
 * "Undeployed"; the P1 retro confirms lowercase is the SDK/tx-path value.
 * See SPIKE2_REPORT.md §C. Do NOT re-derive from memory.
 */
export const DEV_WALLET_ADDRESS_NETWORK = "undeployed";

/**
 * Domain-separation prefix the server reconstructs before verifying (SPECIFICATION.md:373).
 * MUST stay byte-for-byte identical to `apps/server/src/auth/verify.ts:37`.
 */
const SIGNED_MESSAGE_PREFIX = "midnight_signed_message:";

const textEncoder = new TextEncoder();

/**
 * Reconstruct the exact byte string the server verifies for `message`:
 * `UTF8("midnight_signed_message:" + byteLength + ":") ‖ payloadBytes`, where
 * `byteLength` is the UTF-8 byte length of the payload (not the character count).
 *
 * ⚠️ Mirrors `apps/server/src/auth/verify.ts:46-53` VERBATIM — the two MUST agree
 * byte-for-byte, proven by tests/wallet/dev-signer.test.ts (a dev-wallet signature
 * is fed straight into the server's `verifySignature`). If one changes, both must.
 */
export function reconstructSignedBytes(message: string): Uint8Array {
  const payload = textEncoder.encode(message);
  const prefix = textEncoder.encode(`${SIGNED_MESSAGE_PREFIX}${String(payload.length)}:`);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

/**
 * Browser-safe hex → bytes (no Node `Buffer`). Rejects malformed hex so a bad
 * address hex fails loudly rather than silently producing a wrong-length key.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("dev-signer: hex string must have an even length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("dev-signer: hex string contains a non-hex character");
    }
    bytes[i] = byte;
  }
  return bytes;
}

/**
 * A connector-independent signer: a fixed identity (`verifyingKey` + Bech32m
 * `address`) plus a `sign` that produces a server-verifiable BIP-340 signature.
 * Task 3 (connector) and Task 5 (ceremony) consume this shape.
 */
export interface DevSigner {
  /** BIP-340 verifying key (hex) — the SIWE `verifyingKey` DTO field. */
  readonly verifyingKey: string;
  /** Bech32m unshielded address (the D43 account key) bound to `verifyingKey`. */
  readonly address: string;
  /** Sign `message` so the server's `verifyMessageSignature` accepts it. */
  sign(message: string): string;
}

/**
 * Generate a fresh dev-wallet seed. The "seed" IS a ledger-v8 signing key (hex);
 * P5's keygen phase calls this and persists it. Never log the returned value —
 * it is the raw signing key (iron rules / money-key handling).
 */
export function generateDevSeed(): string {
  return sampleSigningKey();
}

/**
 * Build a {@link DevSigner} from a seed (a ledger-v8 signing key hex) and a
 * Bech32m `network` segment (use {@link DEV_WALLET_ADDRESS_NETWORK} for devnet).
 *
 * Deterministic: the same `seed` + `network` always yields the same identity.
 * The `seed` is captured in the `sign` closure and never re-exposed.
 */
export function createDevSigner(seed: string, network: string): DevSigner {
  const verifyingKey = signatureVerifyingKey(seed);
  const addressHex = addressFromKey(verifyingKey);
  // `as Buffer`: the `.d.ts` over-specifies `Buffer`, but the encode path only
  // needs a 32-byte Uint8Array (see the file-top constitution-I note).
  const unshielded = new UnshieldedAddress(hexToBytes(addressHex) as Buffer);
  const address = MidnightBech32m.encode(network, unshielded).asString();

  return {
    verifyingKey,
    address,
    sign(message: string): string {
      return signData(seed, reconstructSignedBytes(message));
    },
  };
}
