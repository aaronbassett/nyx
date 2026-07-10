/**
 * T039 — client SIWE sign-in flow. Drives `requestNonce → buildSiweMessage →
 * signData → POST /auth/verify` plus `resumeSession` / `logout` against an
 * injected mock `fetch` and a fake `ConnectedAPI.signData`, so the whole
 * handshake is exercised deterministically with no live wallet or backend.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";

import {
  buildSiweMessage,
  logout,
  requestNonce,
  resumeSession,
  signIn,
  type WalletSigner,
} from "@/wallet/auth";

/** The exact nonce parser the server uses (`apps/server/src/auth/verify.ts`). */
const SERVER_NONCE_REGEX = /(?:^|\n)Nonce:[ \t]*(\S+)/;

/** A JSON `Response` with the given status, matching what the endpoints return. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A mock `fetch`, typed so calls carry the real `fetch` argument tuple. */
function mockFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>();
}

/** A `signData` that echoes the signed text back as `data`, like the wallet does. */
function resolvingSigner(signature: string, verifyingKey: string): WalletSigner {
  return {
    signData: vi.fn<ConnectedAPI["signData"]>((data) =>
      Promise.resolve({ data, signature, verifyingKey }),
    ),
  };
}

/** A `signData` that rejects, modelling the user declining the prompt (EC-24). */
function rejectingSigner(): WalletSigner {
  return {
    signData: vi.fn<ConnectedAPI["signData"]>(() =>
      Promise.reject(new Error("User rejected signature")),
    ),
  };
}

/** Resolve a fetch call's first argument (string | URL | Request) to a URL string. */
function callUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/** Extract the Nth recorded fetch call as `{ url, init }`, or throw. */
function requireCall(
  fetchMock: Mock<typeof fetch>,
  index: number,
): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`expected a fetch call at index ${String(index)}`);
  }
  const [input, init] = call;
  return { url: callUrl(input), init: init ?? {} };
}

describe("buildSiweMessage — pure, server-parseable message", () => {
  const params = {
    domain: "nyx.example",
    nonce: "nonce-abc123",
    statement: "Sign in to Nyx.",
    issuedAt: "2026-07-10T00:00:00.000Z",
  };

  it("carries a `Nonce: <nonce>` line the server regex matches", () => {
    const message = buildSiweMessage(params);
    const match = SERVER_NONCE_REGEX.exec(message);
    expect(match?.[1]).toBe("nonce-abc123");
  });

  it("renders the domain, statement, nonce and issuedAt in the fixed shape", () => {
    expect(buildSiweMessage(params)).toBe(
      [
        "nyx.example wants you to sign in with your Midnight account.",
        "",
        "Sign in to Nyx.",
        "",
        "Nonce: nonce-abc123",
        "Issued At: 2026-07-10T00:00:00.000Z",
      ].join("\n"),
    );
  });

  it("is stable: identical inputs yield an identical string", () => {
    expect(buildSiweMessage(params)).toBe(buildSiweMessage(params));
  });
});

describe("requestNonce — POST /auth/nonce", () => {
  it("posts to /auth/nonce with credentials and returns the nonce DTO", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ nonce: "nonce-1", expiresAt: 1234 }));

    const result = await requestNonce({ fetch: fetchMock });

    expect(result).toEqual({ nonce: "nonce-1", expiresAt: 1234 });
    const { url, init } = requireCall(fetchMock, 0);
    expect(url).toBe("/auth/nonce");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("throws on a non-2xx nonce response", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    await expect(requestNonce({ fetch: fetchMock })).rejects.toThrow(/nonce request failed/);
  });
});

describe("signIn — full SIWE handshake", () => {
  it("posts the right /auth/verify body (incl. verifyingKey) with credentials, then resolves ok", async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ nonce: "nonce-xyz", expiresAt: 9_999 }))
      .mockResolvedValueOnce(jsonResponse({ address: "mn_addr_1" }));
    const signer = resolvingSigner("sig-hex", "vk-hex");

    const result = await signIn({
      api: signer,
      address: "mn_addr_1",
      domain: "nyx.example",
      issuedAt: "2026-07-10T00:00:00.000Z",
      fetch: fetchMock,
    });

    expect(result).toEqual({ ok: true, address: "mn_addr_1" });

    // First call: nonce. Second call: verify.
    expect(requireCall(fetchMock, 0).url).toBe("/auth/nonce");
    const verify = requireCall(fetchMock, 1);
    expect(verify.url).toBe("/auth/verify");
    expect(verify.init.method).toBe("POST");
    expect(verify.init.credentials).toBe("include");

    const rawBody = verify.init.body;
    if (typeof rawBody !== "string") {
      throw new Error("expected a string request body");
    }
    const body = JSON.parse(rawBody) as {
      address: string;
      message: string;
      signature: string;
      verifyingKey: string;
    };
    expect(body.address).toBe("mn_addr_1");
    expect(body.signature).toBe("sig-hex");
    expect(body.verifyingKey).toBe("vk-hex"); // carried through from signData
    // The signed message the server receives contains the nonce it can parse.
    expect(SERVER_NONCE_REGEX.exec(body.message)?.[1]).toBe("nonce-xyz");

    // The wallet was asked to sign as UTF-8 text with the unshielded key.
    expect(signer.signData).toHaveBeenCalledWith(body.message, {
      encoding: "text",
      keyType: "unshielded",
    });
  });

  it("maps a declined wallet prompt (EC-24) to { ok: false, reason: 'rejected' }", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ nonce: "nonce-1", expiresAt: 1 }));

    const result = await signIn({
      api: rejectingSigner(),
      address: "mn_addr_1",
      fetch: fetchMock,
    });

    expect(result).toEqual({ ok: false, reason: "rejected" });
    // Never reached the verify POST — only the nonce call was made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps verify 401 to { ok: false, reason: 'unauthenticated' }", async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ nonce: "nonce-1", expiresAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ error: "unauthenticated" }, 401));

    const result = await signIn({
      api: resolvingSigner("sig", "vk"),
      address: "mn_addr_1",
      fetch: fetchMock,
    });

    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("maps verify 400 (malformed body) to 'unauthenticated'", async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ nonce: "nonce-1", expiresAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ error: "invalid request" }, 400));

    const result = await signIn({
      api: resolvingSigner("sig", "vk"),
      address: "mn_addr_1",
      fetch: fetchMock,
    });

    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("maps a thrown fetch (network error) to { ok: false, reason: 'network' }", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await signIn({
      api: resolvingSigner("sig", "vk"),
      address: "mn_addr_1",
      fetch: fetchMock,
    });

    expect(result).toEqual({ ok: false, reason: "network" });
  });
});

describe("resumeSession — GET /auth/session (SC-019, no wallet)", () => {
  it("returns the account on 200 and calls /auth/session with credentials", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ address: "mn_addr_9" }));

    const account = await resumeSession({ fetch: fetchMock });

    expect(account).toEqual({ address: "mn_addr_9" });
    const { url, init } = requireCall(fetchMock, 0);
    expect(url).toBe("/auth/session");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
  });

  it("returns null on 401 (no live session)", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthenticated" }, 401));

    expect(await resumeSession({ fetch: fetchMock })).toBeNull();
  });
});

describe("logout — POST /auth/logout", () => {
  it("posts to /auth/logout with credentials", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await logout({ fetch: fetchMock });

    const { url, init } = requireCall(fetchMock, 0);
    expect(url).toBe("/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });
});

describe("baseUrl injection", () => {
  it("prefixes the configured base URL onto the relative path", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ nonce: "n", expiresAt: 0 }));

    await requestNonce({ fetch: fetchMock, baseUrl: "https://api.nyx.example" });

    expect(requireCall(fetchMock, 0).url).toBe("https://api.nyx.example/auth/nonce");
  });
});
