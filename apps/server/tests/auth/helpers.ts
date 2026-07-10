/**
 * Shared test doubles for the auth layer (T033).
 *
 * Two pieces the auth tests reuse:
 *  - a SYNTHETIC BIP-340 Schnorr keypair built with ledger-v8's own primitives,
 *    so signature verification is proven by real cryptographic execution with no
 *    live wallet (the real-Lace prefix match is owner-gated; see verify.test.ts);
 *  - an in-memory {@link SessionAuthStore} that models the `auth_nonces`,
 *    `accounts`, and `sessions` rows with an INJECTED clock, honouring the exact
 *    atomic single-use-burn + sliding-expiry semantics the Postgres store expresses
 *    in SQL. This keeps endpoint tests deterministic with no external Postgres.
 */
import {
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
} from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { reconstructSignedBytes } from "../../src/auth/verify.js";
import type {
  AuthNonce,
  IssueRequest,
  IssueResult,
  SessionAuthStore,
} from "../../src/auth/store.js";
import type { Session } from "../../src/protocol/index.js";

/** A synthetic wallet identity: signing key, its verifying key, and Bech32m address. */
export interface TestIdentity {
  readonly signingKey: string;
  readonly verifyingKey: string;
  /** Bech32m unshielded address (the D43 account key) bound to `verifyingKey`. */
  readonly address: string;
}

/** Network segment used for the synthetic Bech32m addresses in tests. */
export const TEST_NETWORK = "preprod";

/** Build a fresh synthetic identity whose address is SHA-256(verifyingKey) (D43 binding). */
export function makeIdentity(network: string = TEST_NETWORK): TestIdentity {
  const signingKey = sampleSigningKey();
  const verifyingKey = signatureVerifyingKey(signingKey);
  const addressHex = addressFromKey(verifyingKey);
  const unshielded = new UnshieldedAddress(Buffer.from(addressHex, "hex"));
  const address = MidnightBech32m.encode(network, unshielded).asString();
  return { signingKey, verifyingKey, address };
}

/**
 * Sign `message` exactly as the server reconstructs it (prefix ‖ payload), so a
 * synthetic signature round-trips through the server's verifier. This mirrors what
 * Lace is BELIEVED to do; the real-Lace byte match is owner-gated and unverified.
 */
export function signMessage(signingKey: string, message: string): string {
  return signData(signingKey, reconstructSignedBytes(message));
}

/** Build a SIWE-style domain-bound message carrying `nonce` on its own line. */
export function siweMessage(nonce: string): string {
  return [
    "nyx.example wants you to sign in with your Midnight account.",
    "",
    "Sign in to Nyx.",
    "",
    `Nonce: ${nonce}`,
    "Issued At: 2026-07-10T00:00:00.000Z",
  ].join("\n");
}

interface NonceRow {
  expiresAt: number;
  consumed: boolean;
}

interface SessionRow {
  accountAddress: string;
  expiresAt: number;
  revoked: boolean;
}

export interface InMemoryAuthStoreOptions {
  readonly clock: () => number;
  readonly sessionLifetimeMs: number;
  readonly nonceTtlMs: number;
  /** Deterministic nonce source; defaults to a monotonic counter. */
  readonly generateNonce?: () => string;
}

/**
 * In-memory {@link SessionAuthStore} modelling the Postgres semantics with an
 * injected clock. Exposes call counters so tests can prove, e.g., that a session
 * resume touches only the session store and never the signing path (SC-019).
 */
export class InMemoryAuthStore implements SessionAuthStore {
  private readonly nonces = new Map<string, NonceRow>();
  private readonly sessions = new Map<string, SessionRow>();
  readonly accounts = new Set<string>();

  /** How many times the verify+issue path ran (the ONLY path that runs signature checks). */
  issueCalls = 0;
  /** How many times a session was resumed+slid. */
  slideCalls = 0;
  /** How many times a session was revoked. */
  revokeCalls = 0;

  private seq = 0;

  constructor(private readonly opts: InMemoryAuthStoreOptions) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq)}`;
  }

  issueNonce(): Promise<AuthNonce> {
    const nonce = this.opts.generateNonce?.() ?? this.nextId("nonce");
    const expiresAt = this.opts.clock() + this.opts.nonceTtlMs;
    this.nonces.set(nonce, { expiresAt, consumed: false });
    return Promise.resolve({ nonce, expiresAt });
  }

  issue(request: IssueRequest): Promise<IssueResult> {
    this.issueCalls += 1;
    const row = this.nonces.get(request.nonce);
    // Atomic single-use burn (compare-and-swap): unknown / consumed / expired → reject.
    if (row === undefined || row.consumed || row.expiresAt <= this.opts.clock()) {
      return Promise.resolve({ ok: false, reason: "nonce" });
    }
    row.consumed = true; // Burned on ANY attempt (FR-039): persists even if verify fails below.
    if (!request.verify()) {
      return Promise.resolve({ ok: false, reason: "signature" });
    }
    this.accounts.add(request.accountAddress); // Account auto-create on first sign-in (D43).
    const sessionId = this.nextId("sess");
    this.sessions.set(sessionId, {
      accountAddress: request.accountAddress,
      expiresAt: this.opts.clock() + this.opts.sessionLifetimeMs,
      revoked: false,
    });
    return Promise.resolve({ ok: true, sessionId });
  }

  get(sessionId: string): Promise<Session | null> {
    const row = this.sessions.get(sessionId);
    if (row === undefined || row.revoked || row.expiresAt <= this.opts.clock()) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ accountAddress: row.accountAddress });
  }

  slide(sessionId: string): Promise<Session | null> {
    this.slideCalls += 1;
    const row = this.sessions.get(sessionId);
    if (row === undefined || row.revoked || row.expiresAt <= this.opts.clock()) {
      return Promise.resolve(null);
    }
    row.expiresAt = this.opts.clock() + this.opts.sessionLifetimeMs; // Sliding renewal (D44).
    return Promise.resolve({ accountAddress: row.accountAddress });
  }

  revoke(sessionId: string): Promise<void> {
    this.revokeCalls += 1;
    const row = this.sessions.get(sessionId);
    if (row !== undefined) {
      row.revoked = true;
    }
    return Promise.resolve();
  }

  /** Test helper: is a session currently live under the injected clock? */
  isLive(sessionId: string): boolean {
    const row = this.sessions.get(sessionId);
    return row !== undefined && !row.revoked && row.expiresAt > this.opts.clock();
  }
}
