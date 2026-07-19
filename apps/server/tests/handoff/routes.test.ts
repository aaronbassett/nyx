/**
 * Handoff HTTP route tests (US13 — FR-074/075/076/077, D58/D59, SC-042/043, EC-55) — driven
 * through `app.inject()` against the REAL `buildServer` wiring with injected in-memory auth +
 * project stores (the shared `bootProjects` harness), so they are deterministic with NO
 * external Postgres, NO wallet, and NO real git binary.
 *
 * Coverage:
 *  - `GET /projects/:id/archive` — owner downloads a `application/zip`; every archived file
 *    re-hashes back to `GET …/manifest` EXACTLY (SC-042, the load-bearing guarantee); the
 *    generated README is present but absent from the manifest; a non-owner 404s (SC-027) and
 *    a soft-deleted project 410s (FR-077); a tree containing a secret is refused 500 without
 *    leaking it (belt-and-suspenders, D10).
 *  - `POST`/`DELETE /projects/:id/clone-token` — mint returns a token; revoke is immediate, so
 *    a git-HTTP request with the revoked token 404s the very next call (SC-043); a non-owner
 *    mint 404s; a soft-deleted project 410s.
 *  - `GET /git/:cloneToken/info/refs` (TOKEN-gated, NOT session-gated) — a valid token serves a
 *    smart-HTTP advertisement; an unknown token 404s; the per-IP rate limit throttles a burst
 *    (EC-55) — asserted against a dedicated server whose limiter is driven by an injected clock,
 *    so the throttle is fully deterministic.
 *
 * ⚠️ Owner-gated (Independent Test): the end-to-end `git clone` round-trip over real HTTP with a
 * real `git` binary (incremental have/want negotiation + side-band framing) — the service emits a
 * correct no-`have` NAK + packfile, but the live transport is out of scope here (see clone.ts).
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestEntry, Project } from "@nyx/protocol";
import { maskCloneToken, serverOptions } from "../../src/app.js";
import { HANDOFF_README_PATH } from "../../src/projects/archive.js";
import {
  createCloneService,
  createInMemoryRepoCache,
  createTokenBucketLimiter,
  registerGitHttpRoutes,
} from "../../src/projects/index.js";
import { computeContentHash } from "../../src/projects/store.js";
import { bootProjects, makeInMemoryStore } from "../projects/helpers.js";
import type { Clock, ProjectHarness } from "../projects/helpers.js";

const OWNER = "owner-address";
const OTHER = "other-address";

/** A small, secret-free source tree; every file fits the (generous) test caps below. */
const SOURCE_FILES = [
  { path: "README.md", content: "# demo\n" },
  { path: "src/index.ts", content: "export const answer = 42;\n" },
  { path: "contracts/counter.compact", content: "pragma language_version >= 0.16;\n" },
] as const;

let h: ProjectHarness;
let ownerCookie: string;
let otherCookie: string;

beforeEach(async () => {
  // Generous caps: the handoff routes commit real (small) source files, so the default tiny
  // quota-testing caps would reject them for the wrong reason.
  h = await bootProjects({ maxFileBytes: 1_000_000, maxProjectBytes: 10_000_000 });
  ownerCookie = await h.seedSession(OWNER);
  otherCookie = await h.seedSession(OTHER);
});

afterEach(async () => {
  await h.app.close();
});

/** Create a project as the owner via HTTP and return its DTO. */
async function createOwned(name = "demo"): Promise<Project> {
  const response = await h.app.inject({
    method: "POST",
    url: "/projects",
    headers: { cookie: ownerCookie },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Project>();
}

/** Create an owned project and commit {@link SOURCE_FILES} as one agent turn. */
async function createOwnedWithSource(name = "demo"): Promise<Project> {
  const project = await createOwned(name);
  await h.store.commit(project.id, { author: "agent", files: [...SOURCE_FILES] });
  return project;
}

describe("GET /projects/:id/archive (FR-074/SC-042)", () => {
  it("streams a zip whose every file re-hashes to the manifest (SC-042)", async () => {
    const project = await createOwnedWithSource("my proj");

    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/archive`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    // Name is sanitized into the Content-Disposition (spaces → `-`, no header injection).
    expect(res.headers["content-disposition"]).toBe('attachment; filename="my-proj.zip"');

    const unzipped = unzipSync(new Uint8Array(res.rawPayload));

    const manifestRes = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/manifest`,
      headers: { cookie: ownerCookie },
    });
    const manifest = manifestRes.json<ManifestEntry[]>();
    expect(manifest.length).toBe(SOURCE_FILES.length);

    // The genuine cross-check: the manifest hashes are produced independently of the archive,
    // so re-hashing the unzipped bytes and matching them proves the archive IS the manifest.
    for (const entry of manifest) {
      const bytes = unzipped[entry.path];
      if (bytes === undefined) {
        throw new Error(`archive is missing a manifest file: ${entry.path}`);
      }
      expect(computeContentHash(strFromU8(bytes))).toBe(entry.contentHash);
    }

    // The generated README is the ONLY archive member absent from the manifest.
    expect(unzipped[HANDOFF_README_PATH]).toBeDefined();
    expect(manifest.some((entry) => entry.path === HANDOFF_README_PATH)).toBe(false);
  });

  it("404s a non-owner (existence never leaks, SC-027)", async () => {
    const project = await createOwnedWithSource();
    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/archive`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401s an unauthenticated download", async () => {
    const project = await createOwnedWithSource();
    const res = await h.app.inject({ method: "GET", url: `/projects/${project.id}/archive` });
    expect(res.statusCode).toBe(401);
  });

  it("410s a soft-deleted project (handoff paused, FR-077/D49)", async () => {
    const project = await createOwnedWithSource();
    await h.store.softDeleteProject(project.id);

    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/archive`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json<{ error: string }>().error).toBe("handoff disabled");
  });

  it("refuses (500) an archive whose tree contains a secret, without leaking it (FR-077)", async () => {
    const project = await createOwned("leaky");
    // A stray PEM private key marker — by design (D10) this never happens, but the archive's
    // internal `assertNoSecrets` MUST refuse it rather than ship it.
    await h.store.commit(project.id, {
      author: "agent",
      files: [
        {
          path: "secret.pem",
          content: "-----BEGIN PRIVATE KEY-----\nMIIBVQ\n-----END PRIVATE KEY-----\n",
        },
      ],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/archive`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("archive blocked: secrets detected");
    // The response NEVER carries the secret bytes.
    expect(res.body).not.toContain("BEGIN PRIVATE KEY");
  });

  it("refuses (500) an archive with a zip-slip path, non-leaking (FIX 4/FIX 6)", async () => {
    const project = await createOwned("slip");
    // A traversal path in the stored tree (by design D26 never happens) must be refused with an
    // actionable, non-leaking message — not a bare Fastify 500.
    await h.store.commit(project.id, {
      author: "agent",
      files: [{ path: "../../etc/x", content: "x\n" }],
    });

    const res = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/archive`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: string }>().error).toBe("archive blocked: unsafe file path");
  });
});

describe("clone-token mint/revoke (D58/SC-043)", () => {
  it("POST mints a non-empty token; DELETE revokes it", async () => {
    const project = await createOwnedWithSource();

    const mint = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });
    expect(mint.statusCode).toBe(200);
    const { cloneToken } = mint.json<{ cloneToken: string }>();
    expect(typeof cloneToken).toBe("string");
    expect(cloneToken.length).toBeGreaterThan(0);

    const revoke = await h.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({});
  });

  it("SC-043: a git-HTTP request with a revoked token 404s IMMEDIATELY", async () => {
    const project = await createOwnedWithSource();
    const mint = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });
    const { cloneToken } = mint.json<{ cloneToken: string }>();

    // The token resolves a valid advertisement before revocation…
    const before = await h.app.inject({
      method: "GET",
      url: `/git/${cloneToken}/info/refs?service=git-upload-pack`,
    });
    expect(before.statusCode).toBe(200);

    await h.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });

    // …and 404s the very next attempt — no TTL, no cache to wait out.
    const after = await h.app.inject({
      method: "GET",
      url: `/git/${cloneToken}/info/refs?service=git-upload-pack`,
    });
    expect(after.statusCode).toBe(404);
  });

  it("404s a non-owner mint (SC-027)", async () => {
    const project = await createOwnedWithSource();
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("410s a mint against a soft-deleted project (FR-077)", async () => {
    const project = await createOwnedWithSource();
    await h.store.softDeleteProject(project.id);
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json<{ error: string }>().error).toBe("handoff disabled");
  });
});

describe("GET /git/:cloneToken/info/refs (token-gated, FR-076)", () => {
  it("serves a smart-HTTP advertisement for a valid token", async () => {
    const project = await createOwnedWithSource();
    const mint = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });
    const { cloneToken } = mint.json<{ cloneToken: string }>();

    // No session cookie — the git surface is TOKEN-gated, not session-gated.
    const res = await h.app.inject({
      method: "GET",
      url: `/git/${cloneToken}/info/refs?service=git-upload-pack`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
    expect(res.body).toContain("# service=git-upload-pack");
    expect(res.body).toContain("refs/heads/main");
  });

  it("404s an unknown/never-minted token", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/git/not-a-real-token/info/refs?service=git-upload-pack`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("500s (non-leaking) a git clone whose HISTORY carries a secret (FIX 1)", async () => {
    const project = await createOwned("leaky-history");
    // A secret at the first commit, overwritten clean at the second: the current tree is clean,
    // but the clone serves full history, so it must be refused (SC-044/FR-077).
    await h.store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/k.ts", content: 'const KEY = "AKIAIOSFODNN7EXAMPLE";\n' }],
    });
    await h.store.commit(project.id, {
      author: "user",
      files: [{ path: "src/k.ts", content: "const KEY = env();\n" }],
    });
    const mint = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/clone-token`,
      headers: { cookie: ownerCookie },
    });
    const { cloneToken } = mint.json<{ cloneToken: string }>();

    const res = await h.app.inject({
      method: "GET",
      url: `/git/${cloneToken}/info/refs?service=git-upload-pack`,
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("repository blocked: secrets detected");
    expect(res.body).not.toContain("AKIA");
  });

  it("EC-55: throttles a burst past the configured capacity (deterministic clock)", async () => {
    // A dedicated, minimal server: the git surface needs NO auth, so we register just it with a
    // tiny, injected-clock rate limiter to make the throttle boundary exact and time-independent.
    const clock: Clock = { now: 5_000_000 };
    const store = makeInMemoryStore(clock);
    const project = await store.createProject(OWNER, "burst");
    const cloneService = createCloneService({
      store,
      rateLimiter: createTokenBucketLimiter({
        capacity: 2,
        refillTokens: 0, // fixed clock ⇒ no refill; the bucket empties after two attempts
        intervalMs: 60_000,
        clock: () => clock.now,
      }),
      cache: createInMemoryRepoCache(),
      clock: () => clock.now,
    });
    const token = await cloneService.mint(project.id);

    const app: FastifyInstance = Fastify();
    registerGitHttpRoutes(app, { cloneService });
    await app.ready();
    try {
      const url = `/git/${token}/info/refs?service=git-upload-pack`;
      // All requests share one IP (light-my-request default), so they share one bucket.
      const first = await app.inject({ method: "GET", url });
      const second = await app.inject({ method: "GET", url });
      // Capacity exhausted, no refill under the frozen clock → throttled.
      const third = await app.inject({ method: "GET", url });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe("server hardening (FIX 5)", () => {
  it("trusts the proxy so request.ip reflects X-Forwarded-For (EC-55 per-IP bucket)", () => {
    // Behind Fly's trusted edge, `request.ip` must be the real client (X-Forwarded-For), else the
    // per-IP clone rate bucket collapses to one global bucket.
    expect(serverOptions.trustProxy).toBe(true);
  });

  it("masks the clone-token path segment in logged request URLs (bearer-in-URL)", () => {
    expect(maskCloneToken("/git/supersecrettoken/info/refs?service=git-upload-pack")).toBe(
      "/git/***/info/refs?service=git-upload-pack",
    );
    expect(maskCloneToken("/git/abc123/git-upload-pack")).toBe("/git/***/git-upload-pack");
    // Non-git URLs pass through untouched.
    expect(maskCloneToken("/projects/123/archive")).toBe("/projects/123/archive");
  });
});
