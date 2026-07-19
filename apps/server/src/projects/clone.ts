/**
 * Clone-token management + git-HTTP handoff service (US13 / FR-075 / D58 / SC-043 / EC-55).
 *
 * A project is handed off by generating a long, unguessable clone token (persisted in the
 * `projects.clone_token` column via the store) that resolves a smart-HTTP git endpoint to
 * exactly one project. Ownership gating happens at the ROUTE; this service owns everything
 * downstream of "the caller presented a token":
 *
 *   - mint / regenerate / revoke — thin delegations to the store. Regenerate is just a fresh
 *     mint (the column is single-valued, so the previous token is replaced). Revoke nulls the
 *     column, which is why SC-043 is structural: the very next {@link CloneService.authenticate}
 *     resolves nothing and is rejected IMMEDIATELY (no TTL, no cache to wait out).
 *   - authenticate — the token → project resolution used by every git-HTTP request. It is
 *     RATE-LIMITED first (EC-55, token/IP bucket), logs every attempt, rejects a revoked or
 *     unknown token with {@link CloneTokenNotFoundError} (no id leaked), and rejects a
 *     soft-deleted project with {@link HandoffDisabledError} (handoff pauses with the project).
 *   - handleGitHttp — the smart-HTTP wire surface. `GET …/info/refs?service=git-upload-pack`
 *     returns a valid service advertisement; `POST …/git-upload-pack` returns `NAK` + a real
 *     packfile for the whole materialized repo (a fresh clone with no `have`s). The packfile
 *     and advertisement bytes are produced deterministically by `isomorphic-git` and
 *     unit-tested here.
 *
 * ⚠️ Owner-gated (Independent Test): the end-to-end `git clone` round-trip — the real
 * `git` binary negotiating over real HTTP, incremental `have`/`want` negotiation, and
 * side-band progress framing. This service emits a correct NON-side-band upload-pack
 * response (NAK + packfile), which is what a no-`have` clone needs, but the full transport
 * and the route wiring live outside this file. Route registration is the orchestrator's;
 * this module exports a clean, injectable service.
 */
import * as git from "isomorphic-git";
import type { Project } from "@nyx/protocol";
import { CloneRateLimitError, CloneTokenNotFoundError, HandoffDisabledError } from "./errors.js";
import {
  createInMemoryRepoCache,
  materializeRepo,
  type MaterializedRepo,
  type RepoCache,
} from "./git.js";
import { UnsafePathError } from "./paths.js";
import { SecretsFoundError } from "./secrets.js";
import type { ProjectStore } from "./store.js";

// ---------------------------------------------------------------------------
// Rate limiting (EC-55)
// ---------------------------------------------------------------------------

/** A per-key attempt gate. `tryConsume` returns `false` once the key is over budget. */
export interface RateLimiter {
  tryConsume(key: string): boolean;
}

/** Token-bucket tuning; the clock is injected so the limiter is fully deterministic. */
export interface TokenBucketOptions {
  /** Bucket size — the burst of attempts allowed before throttling. */
  readonly capacity: number;
  /** Tokens replenished per {@link intervalMs}. */
  readonly refillTokens: number;
  /** The window over which {@link refillTokens} are added, in ms. */
  readonly intervalMs: number;
  /** Monotonic clock (epoch-ms); NEVER `Date.now()` in logic. */
  readonly clock: () => number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * A deterministic token-bucket {@link RateLimiter} keyed by token/IP. Refill is a pure
 * function of elapsed injected-clock time, so the same sequence of attempts at the same
 * timestamps always yields the same allow/deny decisions (EC-55).
 */
export function createTokenBucketLimiter(options: TokenBucketOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    tryConsume(key) {
      const now = options.clock();
      const bucket = buckets.get(key) ?? { tokens: options.capacity, last: now };
      const elapsed = Math.max(0, now - bucket.last);
      const refill = (elapsed / options.intervalMs) * options.refillTokens;
      bucket.tokens = Math.min(options.capacity, bucket.tokens + refill);
      bucket.last = now;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        buckets.set(key, bucket);
        return true;
      }
      buckets.set(key, bucket);
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Attempt logging
// ---------------------------------------------------------------------------

/** The outcome of one clone-auth attempt, for the audit log. */
export type CloneAuthOutcome = "allowed" | "rate-limited" | "not-found" | "disabled";

/** One logged clone-auth attempt (EC-55 — attempts are logged). */
export interface CloneAuthAttempt {
  readonly clientKey: string;
  readonly outcome: CloneAuthOutcome;
  /** Epoch-ms from the injected clock. */
  readonly at: number;
}

/** Sink for {@link CloneAuthAttempt}s. Defaults to a silent no-op if none is injected. */
export interface CloneAuthLogger {
  record(attempt: CloneAuthAttempt): void;
}

// ---------------------------------------------------------------------------
// git-HTTP wire types
// ---------------------------------------------------------------------------

/** A parsed smart-HTTP request routed to {@link CloneService.handleGitHttp}. */
export interface GitHttpRequest {
  /** The clone token from the URL. */
  readonly token: string;
  /** The git sub-path, e.g. `/info/refs` or `/git-upload-pack`. */
  readonly path: string;
  /** Parsed query params, e.g. `{ service: "git-upload-pack" }`. */
  readonly query?: Readonly<Record<string, string>>;
  /** The POST body for `git-upload-pack` (the `want`/`have` negotiation). */
  readonly body?: Uint8Array;
  /** Rate-limit bucket key (IP preferred); falls back to the token. */
  readonly clientKey?: string;
}

/** A framework-agnostic HTTP response the orchestrator's route serializes. */
export interface GitHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The store surface the clone service needs — a structural subset of {@link ProjectStore}. */
export type CloneStore = Pick<
  ProjectStore,
  | "mintCloneToken"
  | "revokeCloneToken"
  | "getProjectByCloneToken"
  | "getVersionHistory"
  | "setCloneMaterializedVersion"
>;

/** Dependencies for {@link createCloneService}; every impure input is injected. */
export interface CloneServiceDeps {
  readonly store: CloneStore;
  /** Attempt gate for clone-token auth (EC-55). */
  readonly rateLimiter: RateLimiter;
  /** Audit sink for auth attempts; defaults to a no-op. */
  readonly logger?: CloneAuthLogger;
  /** Repo materialization cache (EC-56); defaults to a fresh in-memory cache. */
  readonly cache?: RepoCache;
  /** Clock for attempt timestamps (epoch-ms); defaults to `Date.now` (logging only). */
  readonly clock?: () => number;
}

/** The clone/handoff service surface consumed by the (orchestrator-owned) routes. */
export interface CloneService {
  /** Mint a fresh clone token for a project (D58); the store generates it. */
  mint(projectId: string): Promise<string>;
  /** Revoke immediately — the next {@link authenticate} fails (SC-043). */
  revoke(projectId: string): Promise<void>;
  /** Replace the token with a fresh one (mint again). */
  regenerate(projectId: string): Promise<string>;
  /** Resolve a token → project, enforcing rate limit, revocation, and soft-delete. */
  authenticate(token: string, clientKey?: string): Promise<Project>;
  /** Serve a smart-HTTP git request for a token-addressed repo. */
  handleGitHttp(request: GitHttpRequest): Promise<GitHttpResponse>;
}

const NOOP_LOGGER: CloneAuthLogger = { record: () => undefined };

const ADVERTISEMENT_CONTENT_TYPE = "application/x-git-upload-pack-advertisement";
const RESULT_CONTENT_TYPE = "application/x-git-upload-pack-result";
const UPLOAD_PACK_SERVICE = "git-upload-pack";
// No side-band advertised: this service emits the plain NAK + packfile a no-`have` clone
// needs. Fuller negotiation/side-band framing rides with the owner-gated E2E clone.
const CAPABILITIES = "multi_ack_detailed thin-pack ofs-delta agent=nyx-git/1.0";

/** Encode one git pkt-line: a 4-hex length prefix (including the 4 bytes) + payload. */
function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const length = data.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([prefix, data]);
}

/** The git flush-pkt terminator. */
const FLUSH_PKT = Buffer.from("0000", "ascii");

/** Build the `info/refs` service advertisement for a fresh clone (smart HTTP). */
function infoRefsBody(repo: MaterializedRepo): Buffer {
  return Buffer.concat([
    pktLine(`# service=${UPLOAD_PACK_SERVICE}\n`),
    FLUSH_PKT,
    // The first ref line carries the capability list after a NUL.
    pktLine(`${repo.headOid} HEAD\0${CAPABILITIES}\n`),
    pktLine(`${repo.headOid} refs/heads/${repo.defaultBranch}\n`),
    FLUSH_PKT,
  ]);
}

/** Build the `git-upload-pack` result: `NAK` then a packfile of the whole repo. */
async function uploadPackBody(repo: MaterializedRepo): Promise<Buffer> {
  const pack = await git.packObjects({
    fs: repo.fs,
    gitdir: repo.gitdir,
    oids: [...repo.objectOids],
    write: false,
  });
  if (pack.packfile === undefined) {
    throw new Error("packObjects returned no packfile");
  }
  return Buffer.concat([pktLine("NAK\n"), Buffer.from(pack.packfile)]);
}

function textResponse(status: number, message: string): GitHttpResponse {
  return {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    body: Buffer.from(message, "utf8"),
  };
}

type GitOp = "info/refs" | "upload-pack" | null;

/** Classify the git sub-path/query into a supported smart-HTTP operation. */
function classifyOp(request: GitHttpRequest): GitOp {
  if (request.path.endsWith("/info/refs") || request.path === "info/refs") {
    return request.query?.service === UPLOAD_PACK_SERVICE ? "info/refs" : null;
  }
  if (request.path.endsWith(`/${UPLOAD_PACK_SERVICE}`) || request.path === UPLOAD_PACK_SERVICE) {
    return "upload-pack";
  }
  return null;
}

/**
 * Build the clone/handoff {@link CloneService}. All impure inputs (store, rate limiter,
 * clock, cache, logger) are injected, so the service is deterministic under test.
 */
export function createCloneService(deps: CloneServiceDeps): CloneService {
  const logger = deps.logger ?? NOOP_LOGGER;
  const cache = deps.cache ?? createInMemoryRepoCache();
  const clock = deps.clock ?? (() => Date.now());

  const authenticate = async (token: string, clientKey?: string): Promise<Project> => {
    const key = clientKey ?? token;
    // Rate-limit BEFORE touching the store so brute-forcing a token is throttled cheaply.
    if (!deps.rateLimiter.tryConsume(key)) {
      logger.record({ clientKey: key, outcome: "rate-limited", at: clock() });
      throw new CloneRateLimitError(key);
    }
    const project = await deps.store.getProjectByCloneToken(token);
    if (project === null) {
      // Covers both never-minted and REVOKED tokens — revocation is immediate (SC-043).
      logger.record({ clientKey: key, outcome: "not-found", at: clock() });
      throw new CloneTokenNotFoundError();
    }
    if (project.deletedAt !== undefined) {
      logger.record({ clientKey: key, outcome: "disabled", at: clock() });
      throw new HandoffDisabledError(project.id);
    }
    logger.record({ clientKey: key, outcome: "allowed", at: clock() });
    return project;
  };

  const handleGitHttp = async (request: GitHttpRequest): Promise<GitHttpResponse> => {
    // NEVER throws — the encapsulated route scope serializes this response verbatim, so every
    // path (auth faults, materialize/pack errors, a secrets/unsafe-path finding) must resolve to
    // a typed `{status,headers,body}`. The outer catch is the backstop that honours that contract.
    try {
      let project: Project;
      try {
        project = await authenticate(request.token, request.clientKey);
      } catch (error) {
        if (error instanceof CloneRateLimitError) return textResponse(429, "rate limit exceeded");
        if (error instanceof CloneTokenNotFoundError) return textResponse(404, "not found");
        if (error instanceof HandoffDisabledError) return textResponse(410, "handoff disabled");
        throw error;
      }

      const op = classifyOp(request);
      if (op === null) {
        return textResponse(404, "not found");
      }

      const repo = await materializeRepo(deps.store, project.id, { cache });
      if (op === "info/refs") {
        return {
          status: 200,
          headers: { "Content-Type": ADVERTISEMENT_CONTENT_TYPE, "Cache-Control": "no-cache" },
          body: infoRefsBody(repo),
        };
      }
      return {
        status: 200,
        headers: { "Content-Type": RESULT_CONTENT_TYPE, "Cache-Control": "no-cache" },
        body: await uploadPackBody(repo),
      };
    } catch (error) {
      // A secrets finding or an unsafe stored path refuses the repo WITHOUT leaking the finding
      // (symmetric with the archive route); any other materialize/pack fault is a generic 500.
      if (error instanceof SecretsFoundError) {
        return textResponse(500, "repository blocked: secrets detected");
      }
      if (error instanceof UnsafePathError) {
        return textResponse(500, "repository blocked: unsafe path");
      }
      return textResponse(500, "internal error");
    }
  };

  return {
    mint: (projectId) => deps.store.mintCloneToken(projectId),
    revoke: (projectId) => deps.store.revokeCloneToken(projectId),
    regenerate: (projectId) => deps.store.mintCloneToken(projectId),
    authenticate,
    handleGitHttp,
  };
}
