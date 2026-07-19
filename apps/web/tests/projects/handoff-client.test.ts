/**
 * US13 — handoff REST client (FR-074/FR-075/D58/D59).
 *
 * The client is the thin transport over the three read-only handoff endpoints:
 * `POST`/`DELETE /projects/:id/clone-token` and the `GET /projects/:id/archive`
 * URL. These tests prove the request shapes (same-origin, cookie-authed,
 * correctly-encoded paths), that a minted token round-trips, and that every
 * failure mode (network throw, non-2xx, malformed body) surfaces as a typed
 * `HandoffFetchError` rather than a silent default — never `Number()`, never a
 * swallowed error.
 */
import { describe, expect, it, vi } from "vitest";

import { createHttpHandoffClient, HandoffFetchError } from "@/projects/handoff-client";

/** A minimal `Response` stand-in exposing just what the client reads. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("createHttpHandoffClient.mintCloneToken", () => {
  it("POSTs the same-origin clone-token path with the session cookie and returns the token", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ cloneToken: "ct_abc123" })),
    ) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock, baseUrl: "https://api.test" });

    const result = await client.mintCloneToken("proj-1");

    expect(result.cloneToken).toBe("ct_abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/projects/proj-1/clone-token",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("percent-encodes the project id in the path", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ cloneToken: "ct_x" })),
    ) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await client.mintCloneToken("a b/c");

    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/a%20b%2Fc/clone-token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws a typed network error when fetch rejects", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.mintCloneToken("p")).rejects.toBeInstanceOf(HandoffFetchError);
    await expect(client.mintCloneToken("p")).rejects.toMatchObject({ reason: "network" });
  });

  it("throws a typed http error (carrying the status) on a non-2xx response", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({}, { ok: false, status: 401 })),
    ) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.mintCloneToken("p")).rejects.toMatchObject({ reason: "http", status: 401 });
  });

  it("throws a typed malformed error when the token is missing or not a string", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ cloneToken: 42 })),
    ) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.mintCloneToken("p")).rejects.toMatchObject({ reason: "malformed" });
  });

  it("throws a typed malformed error when the body is not valid JSON", async () => {
    const throwingResponse = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    } as unknown as Response;
    const fetchMock = vi.fn(() => Promise.resolve(throwingResponse)) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.mintCloneToken("p")).rejects.toMatchObject({ reason: "malformed" });
  });
});

describe("createHttpHandoffClient.revokeCloneToken", () => {
  it("DELETEs the clone-token path with the session cookie and resolves void", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.revokeCloneToken("proj-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/proj-1/clone-token",
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });

  it("throws a typed http error on a non-2xx revoke", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({}, { ok: false, status: 404 })),
    ) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.revokeCloneToken("p")).rejects.toMatchObject({
      reason: "http",
      status: 404,
    });
  });

  it("throws a typed network error when the revoke fetch rejects", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const client = createHttpHandoffClient({ fetch: fetchMock });

    await expect(client.revokeCloneToken("p")).rejects.toMatchObject({ reason: "network" });
  });
});

describe("createHttpHandoffClient.archiveUrl", () => {
  it("builds the relative archive href by default", () => {
    const client = createHttpHandoffClient();
    expect(client.archiveUrl("proj-1")).toBe("/projects/proj-1/archive");
  });

  it("prefixes the injected base URL and percent-encodes the id", () => {
    const client = createHttpHandoffClient({ baseUrl: "https://api.test" });
    expect(client.archiveUrl("a b")).toBe("https://api.test/projects/a%20b/archive");
  });
});
