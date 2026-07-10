/**
 * Wallet signature verification for SIWE-style sign-in (T035).
 *
 * SECURITY-CRITICAL (constitution III, NON-NEGOTIABLE): a bug here is an
 * authentication bypass. Every SDK shape used below was verified against the
 * installed `.d.ts` and by executing the real primitives (constitution I) — never
 * from memory.
 *
 * Scheme: BIP-340 Schnorr over secp256k1 (`k256::schnorr`). The wallet's verifying
 * key, the unshielded address, and the signature are all hex strings.
 *
 * Two independent checks make a sign-in trustworthy:
 *   1. {@link verifyMessageSignature} — the signature is valid for the verifying
 *      key over the exact bytes the wallet signed.
 *   2. {@link verifyKeyAddressBinding} — the submitted unshielded address really is
 *      SHA-256(verifyingKey). Without this a caller could present a valid signature
 *      under their OWN key while claiming SOMEONE ELSE'S address — a key-substitution
 *      auth bypass. The address is a hash of the key, which is exactly why the
 *      verify DTO must carry `verifyingKey`.
 */
import { addressFromKey, verifySignature } from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

/**
 * Domain-separation prefix the wallet applies before signing (SPECIFICATION.md:373).
 *
 * ⚠️ OWNER-GATED / UNVERIFIED: the wallet (Lace) is believed to sign
 * `UTF8("midnight_signed_message:" + byteLength + ":") ‖ payloadBytes`, where
 * `payloadBytes` is the UTF-8 of the message signed with `encoding: 'text'`. The
 * exact pre-/post-normalisation byte counting — and whether Lace's `signData`
 * echoes raw vs prefixed bytes — is NOT pinned by spec and Lace is closed-source.
 * This MUST be confirmed by an empirical round-trip against a real Lace `signData`
 * response (needs a live Lace browser) before it can be trusted against a real
 * wallet. Unit tests prove only that this reconstruction is INTERNALLY consistent
 * with a synthetic ledger-v8 keypair.
 */
const SIGNED_MESSAGE_PREFIX = "midnight_signed_message:";

const textEncoder = new TextEncoder();

/**
 * Reconstruct the exact byte string the wallet signed for `message`:
 * `UTF8("midnight_signed_message:" + byteLength + ":") ‖ payloadBytes`.
 * `byteLength` is the UTF-8 byte length of the payload (not the character count).
 */
export function reconstructSignedBytes(message: string): Uint8Array {
  const payload = textEncoder.encode(message);
  const prefix = textEncoder.encode(`${SIGNED_MESSAGE_PREFIX}${String(payload.length)}:`);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix, 0);
  out.set(payload, prefix.length);
  return out;
}

/** Inputs to {@link verifyMessageSignature}. */
export interface MessageSignatureInput {
  /** BIP-340 verifying key (hex). */
  readonly verifyingKey: string;
  /** The domain-bound message the wallet signed (encoding: 'text'). */
  readonly message: string;
  /** BIP-340 signature (hex). */
  readonly signature: string;
}

/**
 * Verify that `signature` is a valid signature of the reconstructed bytes of
 * `message` under `verifyingKey`. Returns `false` (never throws) for malformed
 * hex or a bad signature, so hostile input cannot crash the process (DoS-safe).
 */
export function verifyMessageSignature(input: MessageSignatureInput): boolean {
  try {
    return verifySignature(
      input.verifyingKey,
      reconstructSignedBytes(input.message),
      input.signature,
    );
  } catch {
    // Malformed key/signature hex throws inside the WASM decoder; treat as invalid.
    return false;
  }
}

/** Inputs to {@link verifyKeyAddressBinding}. */
export interface KeyAddressBindingInput {
  /** BIP-340 verifying key (hex). */
  readonly verifyingKey: string;
  /** The Bech32m unshielded address the caller claims (the D43 account key). */
  readonly address: string;
}

/**
 * Verify the submitted unshielded `address` is really SHA-256(verifyingKey).
 *
 * `addressFromKey(verifyingKey)` yields the canonical 32-byte address hex (verified
 * empirically to equal SHA-256 of the verifying-key bytes). The submitted Bech32m
 * address is decoded to its 32-byte hex and the two are compared. The address is
 * decoded with ITS OWN embedded network id (the codec rejects a network mismatch),
 * so this is network-agnostic; wrong-network handling is a client-side connect
 * concern (US5 four-state UX). Returns `false` (never throws) on any malformed or
 * non-unshielded-address input.
 */
export function verifyKeyAddressBinding(input: KeyAddressBindingInput): boolean {
  try {
    const fromKey = addressFromKey(input.verifyingKey).toLowerCase();
    const parsed = MidnightBech32m.parse(input.address);
    const decoded = parsed.decode(UnshieldedAddress, parsed.network);
    return decoded.hexString.toLowerCase() === fromKey;
  } catch {
    // Not a valid Bech32m unshielded address, or a malformed verifying key.
    return false;
  }
}

/** Matches the SIWE `Nonce:` line and captures the nonce token. */
const NONCE_LINE = /(?:^|\n)Nonce:[ \t]*(\S+)/;

/**
 * Extract the server-issued nonce embedded in the SIWE message (`Nonce: <value>`
 * line). The extracted nonce is the one the server atomically burns, and the
 * signature — which covers the whole message — cryptographically binds it. Returns
 * `undefined` when the message carries no nonce line (nothing to burn → reject).
 */
export function extractNonce(message: string): string | undefined {
  const match = NONCE_LINE.exec(message);
  return match?.[1];
}
