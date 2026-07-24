/**
 * Task 3 — dev-wallet connector. Proves the env-gated dev wallet installs a
 * connector-v4-shaped entry under `window.midnight` that the EXISTING detection /
 * connect / SIWE stack (detect.ts, connect.ts, auth.ts) drives UNCHANGED.
 *
 * The load-bearing case is (e): the dev wallet runs the REAL `signIn` client flow
 * and produces a `/auth/verify` body the REAL server predicate
 * (`verifySignature` + `reconstructSignedBytes`) accepts — the end-to-end proof
 * that no Lace is needed for the demo's auth handshake.
 */
import { verifySignature } from "@midnight-ntwrk/ledger-v8";
import type { AuthVerifyRequest } from "@nyx/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signIn } from "@/wallet/auth";
import { discoverWallets, getConnectorEntry } from "@/wallet/detect";
import {
  createDevSigner,
  DEV_WALLET_ADDRESS_NETWORK,
  reconstructSignedBytes,
} from "@/wallet/dev-signer";
import { installDevWallet, maybeInstallDevWallet } from "@/wallet/dev-wallet";

/** A fixed, valid ledger-v8 signing key (hex) so tests stay deterministic. */
const SEED = "a".repeat(64);

/** The address the dev wallet derives for {@link SEED} on the devnet network. */
function expectedAddress(): string {
  return createDevSigner(SEED, DEV_WALLET_ADDRESS_NETWORK).address;
}

/** Remove any wallet the test installed on the shared global. */
afterEach(() => {
  delete (globalThis as { midnight?: unknown }).midnight;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("installDevWallet — connector-v4 shape (a)", () => {
  it("exposes exactly one v4 wallet named 'Nyx Dev Wallet' to discoverWallets", () => {
    installDevWallet({ seed: SEED, networkId: "Undeployed" });
    const wallets = discoverWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.generation).toBe("v4");
    expect(wallets[0]?.name).toBe("Nyx Dev Wallet");
  });
});

describe("getConnectorEntry — connect + probe (b)", () => {
  it("connect(networkId) yields an api reporting connected + the signer address", async () => {
    installDevWallet({ seed: SEED, networkId: "Undeployed" });
    const entry = getConnectorEntry("nyxDev");
    if (entry === undefined) {
      throw new Error("dev wallet entry was not discovered");
    }
    const api = await entry.connect("Undeployed");
    const status = await api.getConnectionStatus();
    expect(status).toEqual({ status: "connected", networkId: "Undeployed" });
    const address = await api.getUnshieldedAddress();
    expect(address.unshieldedAddress).toBe(expectedAddress());
  });
});

describe("signData — server-verifiable BIP-340 signature (c)", () => {
  it("signs { encoding: 'text', keyType: 'unshielded' } into a verifiable signature", async () => {
    installDevWallet({ seed: SEED, networkId: "Undeployed" });
    const entry = getConnectorEntry("nyxDev");
    if (entry === undefined) {
      throw new Error("dev wallet entry was not discovered");
    }
    const api = await entry.connect("Undeployed");
    const message = "nyx wants you to sign in.\n\nNonce: c-case";
    const signed = await api.signData(message, { encoding: "text", keyType: "unshielded" });
    expect(signed.data).toBe(message);
    expect(
      verifySignature(signed.verifyingKey, reconstructSignedBytes(message), signed.signature),
    ).toBe(true);
  });

  it("rejects any non-text / non-unshielded signing request (honest, not faked)", async () => {
    installDevWallet({ seed: SEED, networkId: "Undeployed" });
    const entry = getConnectorEntry("nyxDev");
    if (entry === undefined) {
      throw new Error("dev wallet entry was not discovered");
    }
    const api = await entry.connect("Undeployed");
    await expect(
      api.signData("deadbeef", { encoding: "hex", keyType: "unshielded" }),
    ).rejects.toThrow();
  });
});

describe("maybeInstallDevWallet — env gate (d)", () => {
  it("installs nothing and returns false when the env flag is absent", () => {
    expect(maybeInstallDevWallet()).toBe(false);
    expect(discoverWallets()).toEqual([]);
  });

  it("installs and returns true when VITE_DEV_WALLET=1 and a seed is present", () => {
    vi.stubEnv("VITE_DEV_WALLET", "1");
    vi.stubEnv("VITE_DEV_WALLET_SEED", SEED);
    expect(maybeInstallDevWallet()).toBe(true);
    expect(discoverWallets()).toHaveLength(1);
  });

  it("returns false when the flag is set but the seed is empty", () => {
    vi.stubEnv("VITE_DEV_WALLET", "1");
    vi.stubEnv("VITE_DEV_WALLET_SEED", "");
    expect(maybeInstallDevWallet()).toBe(false);
    expect(discoverWallets()).toEqual([]);
  });

  it("refuses to install in a production build even when the flags are set (Fable-M3)", () => {
    // Belt-and-braces: a key-holding wallet must NEVER be installed in a prod build, even if the
    // demo env flags leak in past main.tsx's dynamic-import gate.
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_DEV_WALLET", "1");
    vi.stubEnv("VITE_DEV_WALLET_SEED", SEED);
    expect(maybeInstallDevWallet()).toBe(false);
    expect(discoverWallets()).toEqual([]);
  });
});

describe("full-stack SIWE compatibility (e)", () => {
  it("drives the real signIn flow to a /auth/verify body the server predicate accepts", async () => {
    installDevWallet({ seed: SEED, networkId: "Undeployed" });
    const entry = getConnectorEntry("nyxDev");
    if (entry === undefined) {
      throw new Error("dev wallet entry was not discovered");
    }
    const api = await entry.connect("Undeployed");
    const { unshieldedAddress } = await api.getUnshieldedAddress();

    let capturedBody: AuthVerifyRequest | undefined;
    const jsonResponse = (status: number, body: unknown): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      }) as unknown as Response;

    // signIn always calls fetch with a string URL and a JSON string body.
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input as string;
      if (url.endsWith("/auth/nonce")) {
        return Promise.resolve(jsonResponse(200, { nonce: "e-case-nonce" }));
      }
      if (url.endsWith("/auth/verify")) {
        capturedBody = JSON.parse(init?.body as string) as AuthVerifyRequest;
        return Promise.resolve(jsonResponse(200, { address: capturedBody.address }));
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await signIn({ api, address: unshieldedAddress, fetch: fetchMock });
    expect(result.ok).toBe(true);

    const body = capturedBody;
    if (body === undefined) {
      throw new Error("/auth/verify was never called");
    }
    // The REAL server predicate (apps/server/src/auth/verify.ts) run over the wire body.
    expect(
      verifySignature(body.verifyingKey, reconstructSignedBytes(body.message), body.signature),
    ).toBe(true);
    expect(body.address).toBe(expectedAddress());
  });
});
