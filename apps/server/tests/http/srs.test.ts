/**
 * SRS pre-fetch cache serve route tests (P2 — `GET /srs/*`).
 *
 * Deterministic: seeds a temp cache dir, registers {@link registerSrsRoutes} on a bare Fastify
 * instance, and drives it with `app.inject()`. Proves: 200 for a seeded file (bytes verbatim),
 * 404 for a missing file, and 400 for a traversal that would escape the cache root.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSrsRoutes } from "../../src/http/srs.js";

describe("registerSrsRoutes — GET /srs/*", () => {
  let cacheDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "nyx-srs-"));
    await writeFile(join(cacheDir, "bls_filecoin_2p19"), Buffer.from([1, 2, 3, 4]));
    app = Fastify();
    registerSrsRoutes(app, { cacheDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("serves a seeded SRS file (200, bytes verbatim)", async () => {
    const response = await app.inject({ method: "GET", url: "/srs/bls_filecoin_2p19" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect([...response.rawPayload]).toEqual([1, 2, 3, 4]);
  });

  it("404s a missing SRS file", async () => {
    const response = await app.inject({ method: "GET", url: "/srs/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });

  it("400s a path traversal that would escape the cache root", async () => {
    const response = await app.inject({ method: "GET", url: "/srs/..%2f..%2fetc%2fpasswd" });
    expect(response.statusCode).toBe(400);
  });
});
