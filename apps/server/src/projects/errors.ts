/**
 * Named persistence errors for the project store (T051/T054).
 *
 * Size-cap and quota violations surface as DISTINCT error types — never a silent
 * truncation (US7 scenario 6) — each carrying the offending path/limit so the route
 * layer can render an actionable, named rejection. Missing/corrupt reads FAIL LOUDLY
 * naming the project id (EC-34) rather than returning an empty tree.
 */

/** A project id that resolved to nothing (missing, purged, or malformed). */
export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

/** A single file whose byte length exceeds `maxFileBytes` (D49). */
export class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(`file exceeds size cap: ${path} is ${String(size)} bytes (limit ${String(limit)})`);
    this.name = "FileTooLargeError";
  }
}

/** A commit whose resulting project total would exceed `maxProjectBytes` (D49). */
export class ProjectQuotaExceededError extends Error {
  constructor(
    readonly projectId: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(
      `project exceeds size quota: ${projectId} would be ${String(size)} bytes (limit ${String(limit)})`,
    );
    this.name = "ProjectQuotaExceededError";
  }
}

/** A create that would push the account past `projectQuotaPerAccount` (D49). */
export class ProjectCountQuotaExceededError extends Error {
  constructor(
    readonly ownerAddress: string,
    readonly limit: number,
  ) {
    super(`account project quota exceeded (limit ${String(limit)})`);
    this.name = "ProjectCountQuotaExceededError";
  }
}

/** A restore attempted after the 30-day recovery window has elapsed (D49). */
export class RestoreWindowExpiredError extends Error {
  constructor(readonly projectId: string) {
    super(`restore window expired: ${projectId}`);
    this.name = "RestoreWindowExpiredError";
  }
}

/**
 * Handoff was attempted for a soft-deleted project (US13/D58). A deleted project's
 * clone token is still resolvable, so this is a distinct DISABLED signal rather than a
 * not-found — the route can tell the owner their handoff paused with the project.
 */
export class HandoffDisabledError extends Error {
  constructor(readonly projectId: string) {
    super(`handoff disabled for deleted project: ${projectId}`);
    this.name = "HandoffDisabledError";
  }
}

/**
 * A clone token that resolved to nothing — never minted, or REVOKED (D58/SC-043).
 * Carries no project id so a probing attacker learns nothing beyond "no such token";
 * revocation takes effect the instant the token column is nulled.
 */
export class CloneTokenNotFoundError extends Error {
  constructor() {
    super("clone token not found");
    this.name = "CloneTokenNotFoundError";
  }
}

/** Too many clone-auth attempts for one token/IP within the window (EC-55). */
export class CloneRateLimitError extends Error {
  constructor(readonly clientKey: string) {
    super("clone rate limit exceeded");
    this.name = "CloneRateLimitError";
  }
}
