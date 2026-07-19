/**
 * Clone-token + git-HTTP service contract tests (US13 / FR-075 / D58 / SC-043 / EC-55)
 * — deterministic, in-memory, NO Postgres and NO real `git` binary.
 *
 * These drive {@link createCloneService} over the in-memory {@link InMemoryProjectStore}
 * with an injected deterministic token generator, clock, and rate limiter to pin:
 *  - mint / regenerate / revoke delegate to the store; regenerate replaces the token;
 *  - SC-043 — a REVOKED token is rejected IMMEDIATELY by `authenticate` (no TTL wait);
 *  - EC-55 — clone-auth attempts are rate-limited (token bucket) and every attempt logged;
 *  - a soft-deleted project raises {@link HandoffDisabledError} (handoff disabled);
 *  - the smart-HTTP surface: a valid `info/refs` advertisement and a `NAK` + real packfile
 *    upload-pack result, plus the 404/410/429 status mapping.
 *
 * The full `git clone` E2E (the real `git` binary over real HTTP, `have`/`want`
 * negotiation, side-band framing) is OWNER-GATED, like the codebase's other real-infra
 * seams; these tests pin the deterministic bytes the handler produces.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloneRateLimitError,
  CloneTokenNotFoundError,
  createCloneService,
  createTokenBucketLimiter,
  HandoffDisabledError,
  materializeRepo,
} from "../../src/projects/index.js";
import type {
  CloneAuthAttempt,
  CloneAuthLogger,
  CloneService,
  FileAuthor,
  RateLimiter,
} from "../../src/projects/index.js";
import { makeInMemoryStore } from "../projects/helpers.js";
import type { Clock, InMemoryProjectStore } from "../projects/helpers.js";

const OWNER = "owner-address";

/** A deterministic token generator: token-1, token-2, … */
function counterTokens(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `token-${String(n)}`;
  };
}

/** An always-allow rate limiter for tests that aren't exercising EC-55. */
const ALLOW_ALL: RateLimiter = { tryConsume: () => true };

/** A recording logger so we can assert on logged attempts (EC-55). */
function recordingLogger(): CloneAuthLogger & { readonly attempts: CloneAuthAttempt[] } {
  const attempts: CloneAuthAttempt[] = [];
  return {
    attempts,
    record: (attempt) => {
      attempts.push(attempt);
    },
  };
}

interface SeedCommit {
  readonly author: FileAuthor;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

async function seedProject(
  store: InMemoryProjectStore,
  clock: Clock,
  commits: readonly SeedCommit[],
): Promise<string> {
  const project = await store.createProject(OWNER, "demo");
  for (const commit of commits) {
    clock.now += 1_000;
    await store.commit(project.id, { author: commit.author, files: [...commit.files] });
  }
  return project.id;
}

const SEED: readonly SeedCommit[] = [
  {
    author: "agent",
    files: [
      { path: "README.md", content: "# demo\n" },
      { path: "src/index.ts", content: "1\n" },
    ],
  },
  { author: "user", files: [{ path: "src/index.ts", content: "2\n" }] },
];

let clock: Clock;
let store: InMemoryProjectStore;

beforeEach(() => {
  clock = { now: 1_000_000 };
  store = makeInMemoryStore(clock, { tokenGenerator: counterTokens() });
});

describe("token management (D58)", () => {
  it("mints a token that resolves the project", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    const projectId = await seedProject(store, clock, SEED);

    const token = await service.mint(projectId);
    expect(token).toBe("token-1");
    const project = await store.getProjectByCloneToken(token);
    expect(project?.id).toBe(projectId);
  });

  it("regenerate replaces the previous token", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    const projectId = await seedProject(store, clock, SEED);

    const first = await service.mint(projectId);
    const second = await service.regenerate(projectId);
    expect(second).not.toBe(first);
    // The old token no longer resolves; only the new one does.
    expect(await store.getProjectByCloneToken(first)).toBeNull();
    expect((await store.getProjectByCloneToken(second))?.id).toBe(projectId);
  });

  it("revoke nulls the token", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    const projectId = await seedProject(store, clock, SEED);
    const token = await service.mint(projectId);

    await service.revoke(projectId);
    expect(await store.getProjectByCloneToken(token)).toBeNull();
  });
});

describe("authenticate — revocation & soft-delete", () => {
  it("SC-043: a revoked token is rejected IMMEDIATELY", async () => {
    const logger = recordingLogger();
    const service = createCloneService({
      store,
      rateLimiter: ALLOW_ALL,
      logger,
      clock: () => clock.now,
    });
    const projectId = await seedProject(store, clock, SEED);
    const token = await service.mint(projectId);

    // Valid before revocation.
    await expect(service.authenticate(token)).resolves.toMatchObject({ id: projectId });

    await service.revoke(projectId);

    // Rejected the very next attempt — no TTL, no cache to wait out.
    await expect(service.authenticate(token)).rejects.toBeInstanceOf(CloneTokenNotFoundError);
    expect(logger.attempts.at(-1)?.outcome).toBe("not-found");
  });

  it("rejects a soft-deleted project's handoff with HandoffDisabledError", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    const projectId = await seedProject(store, clock, SEED);
    const token = await service.mint(projectId);

    await store.softDeleteProject(projectId);

    await expect(service.authenticate(token)).rejects.toBeInstanceOf(HandoffDisabledError);
  });

  it("rejects an unknown token with CloneTokenNotFoundError", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    await expect(service.authenticate("never-minted")).rejects.toBeInstanceOf(
      CloneTokenNotFoundError,
    );
  });
});

describe("authenticate — rate limiting (EC-55)", () => {
  it("throttles once the bucket is empty and refills over time", async () => {
    const logger = recordingLogger();
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillTokens: 1,
      intervalMs: 60_000,
      clock: () => clock.now,
    });
    const service = createCloneService({
      store,
      rateLimiter: limiter,
      logger,
      clock: () => clock.now,
    });
    const projectId = await seedProject(store, clock, SEED);
    const token = await service.mint(projectId);

    // Capacity 2: two attempts pass, the third is throttled at the same instant.
    await expect(service.authenticate(token, "1.2.3.4")).resolves.toMatchObject({ id: projectId });
    await expect(service.authenticate(token, "1.2.3.4")).resolves.toMatchObject({ id: projectId });
    await expect(service.authenticate(token, "1.2.3.4")).rejects.toBeInstanceOf(
      CloneRateLimitError,
    );
    expect(logger.attempts.at(-1)?.outcome).toBe("rate-limited");

    // Advancing one interval refills one token → allowed again.
    clock.now += 60_000;
    await expect(service.authenticate(token, "1.2.3.4")).resolves.toMatchObject({ id: projectId });
  });

  it("buckets are per-key so a second IP is unaffected", async () => {
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillTokens: 0,
      intervalMs: 60_000,
      clock: () => clock.now,
    });
    const service = createCloneService({ store, rateLimiter: limiter, clock: () => clock.now });
    const projectId = await seedProject(store, clock, SEED);
    const token = await service.mint(projectId);

    await expect(service.authenticate(token, "ip-a")).resolves.toMatchObject({ id: projectId });
    await expect(service.authenticate(token, "ip-a")).rejects.toBeInstanceOf(CloneRateLimitError);
    // A different key has its own full bucket.
    await expect(service.authenticate(token, "ip-b")).resolves.toMatchObject({ id: projectId });
  });
});

describe("handleGitHttp — smart-HTTP wire", () => {
  let service: CloneService;
  let token: string;
  let expectedHead: string;

  beforeEach(async () => {
    service = createCloneService({ store, rateLimiter: ALLOW_ALL, clock: () => clock.now });
    const projectId = await seedProject(store, clock, SEED);
    token = await service.mint(projectId);
    // Deterministic: the same history builds the same head SHA the handler will advertise.
    const repo = await materializeRepo(store, projectId, { persistWatermark: false });
    expectedHead = repo.headOid;
  });

  it("serves a valid info/refs service advertisement", async () => {
    const res = await service.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-upload-pack" },
      clientKey: "1.2.3.4",
    });

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/x-git-upload-pack-advertisement");
    const body = Buffer.from(res.body).toString("utf8");
    // First pkt-line announces the service; the advertisement lists HEAD + refs/heads/main.
    expect(body.startsWith("001e# service=git-upload-pack\n")).toBe(true);
    expect(body).toContain("# service=git-upload-pack");
    expect(body).toContain(`${expectedHead} HEAD`);
    expect(body).toContain(`${expectedHead} refs/heads/main`);
    expect(body.endsWith("0000")).toBe(true);
  });

  it("serves a NAK + a real packfile for upload-pack", async () => {
    const res = await service.handleGitHttp({
      token,
      path: "/git-upload-pack",
      body: Buffer.from(`0032want ${expectedHead}\n00000009done\n`, "utf8"),
      clientKey: "1.2.3.4",
    });

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/x-git-upload-pack-result");
    const body = Buffer.from(res.body);
    // "0008NAK\n" is the 8-byte NAK pkt-line, then the packfile begins with the PACK magic.
    expect(body.subarray(0, 8).toString("utf8")).toBe("0008NAK\n");
    expect(body.subarray(8, 12).toString("utf8")).toBe("PACK");
    // The packfile header's object count is non-zero (blobs + trees + commits).
    expect(body.readUInt32BE(16)).toBeGreaterThan(0);
  });

  it("maps a revoked token to 404", async () => {
    const projectId = (await store.getProjectByCloneToken(token))?.id ?? "";
    await service.revoke(projectId);
    const res = await service.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-upload-pack" },
    });
    expect(res.status).toBe(404);
  });

  it("maps a soft-deleted project to 410", async () => {
    const projectId = (await store.getProjectByCloneToken(token))?.id ?? "";
    await store.softDeleteProject(projectId);
    const res = await service.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-upload-pack" },
    });
    expect(res.status).toBe(410);
  });

  it("maps a rate-limited attempt to 429", async () => {
    const limiter = createTokenBucketLimiter({
      capacity: 0,
      refillTokens: 0,
      intervalMs: 1,
      clock: () => clock.now,
    });
    const limited = createCloneService({ store, rateLimiter: limiter, clock: () => clock.now });
    const res = await limited.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-upload-pack" },
    });
    expect(res.status).toBe(429);
  });

  it("404s an unsupported git operation", async () => {
    const res = await service.handleGitHttp({ token, path: "/git-receive-pack" });
    expect(res.status).toBe(404);
    // info/refs without the upload-pack service is also unsupported.
    const res2 = await service.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-receive-pack" },
    });
    expect(res2.status).toBe(404);
  });
});

describe("handleGitHttp — history secrets scan (FIX 1)", () => {
  it("refuses (500) a clone whose HISTORY contains a secret, without leaking it", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    const project = await store.createProject(OWNER, "leaky");
    // A secret at v1, overwritten clean at v2: the current tree is clean, but `git log` exposes
    // the secret — so the clone (which serves full history) must be refused, never served.
    clock.now += 1_000;
    await store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/k.ts", content: 'const KEY = "AKIAIOSFODNN7EXAMPLE";\n' }],
    });
    clock.now += 1_000;
    await store.commit(project.id, {
      author: "user",
      files: [{ path: "src/k.ts", content: "const KEY = env();\n" }],
    });
    const token = await service.mint(project.id);

    const res = await service.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-upload-pack" },
      clientKey: "1.2.3.4",
    });
    expect(res.status).toBe(500);
    const body = Buffer.from(res.body).toString("utf8");
    expect(body).toBe("repository blocked: secrets detected");
    // The response NEVER carries the finding (no secret bytes leak).
    expect(body).not.toContain("AKIA");
  });

  it("serves a clean history normally (no false refusal)", async () => {
    const service = createCloneService({ store, rateLimiter: ALLOW_ALL });
    const projectId = await seedProject(store, clock, SEED);
    const token = await service.mint(projectId);
    const res = await service.handleGitHttp({
      token,
      path: "/info/refs",
      query: { service: "git-upload-pack" },
      clientKey: "1.2.3.4",
    });
    expect(res.status).toBe(200);
  });
});
