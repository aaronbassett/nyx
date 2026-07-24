/**
 * Vault key-material serve route tests (P3 Task 4 — `GET /vault-artifacts/*`).
 *
 * The browser ceremony prover fetches the NyxtVault `{proverKey, verifierKey, ir}` (native
 * compact toolchain output — SPIKE-2 §B) same-origin from this route. Cloned from the
 * `GET /srs/*` route (session-less, read-only, resolved-prefix path safety); these tests
 * mirror `srs.test.ts`: 200 verbatim, 404 missing, 400 traversal, 4xx NUL byte, and the
 * nested `keys/`/`zkir/` layout the key-material provider requests.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerVaultArtifactsRoutes } from "../../src/http/vault-artifacts.js";

describe("registerVaultArtifactsRoutes — GET /vault-artifacts/*", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nyx-vault-artifacts-"));
    await mkdir(join(dir, "keys"), { recursive: true });
    await mkdir(join(dir, "zkir"), { recursive: true });
    await writeFile(join(dir, "keys", "deposit.prover"), Buffer.from([9, 8, 7, 6]));
    await writeFile(join(dir, "keys", "deposit.verifier"), Buffer.from([1, 1, 2, 3]));
    await writeFile(join(dir, "zkir", "deposit.bzkir"), Buffer.from([0xaa, 0xbb]));
    app = Fastify();
    registerVaultArtifactsRoutes(app, { dir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a nested prover key (200, bytes verbatim, octet-stream)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vault-artifacts/keys/deposit.prover",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect([...response.rawPayload]).toEqual([9, 8, 7, 6]);
  });

  it("serves a nested bzkir IR (200, bytes verbatim)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vault-artifacts/zkir/deposit.bzkir",
    });
    expect(response.statusCode).toBe(200);
    expect([...response.rawPayload]).toEqual([0xaa, 0xbb]);
  });

  it("404s a missing artifact", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vault-artifacts/keys/missing.prover",
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a path traversal that would escape the artifacts root", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vault-artifacts/..%2f..%2fetc%2fpasswd",
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a NUL byte in the path with a 4xx, never a 500", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vault-artifacts/keys/poison%00.prover",
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});
