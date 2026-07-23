/**
 * Named errors for the server-side {@link ArtifactStore} (P2 — the server now stores
 * compile artifacts itself, replacing the retired Compile Service + R2-write path).
 *
 * Every store failure is a promise REJECTION carrying a DISTINCT, named error — never a
 * silent truncation or a bare `Error` — so the routes layer (Task 6) can render an
 * actionable, non-leaking rejection. Size caps, hash mismatches, and manifest gaps each
 * name the offending path/limit; a malformed id/path names what was refused. The path
 * guard reuses the project store's {@link UnsafePathError} so a stored artifact path can
 * never escape the artifact boundary (zip-slip / traversal).
 */

export { UnsafePathError } from "../projects/paths.js";

/** A single artifact file whose byte length exceeds the per-file cap. */
export class ArtifactFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly limit: number,
  ) {
    super(`artifact file exceeds size cap: ${path} (limit ${String(limit)} bytes)`);
    this.name = "ArtifactFileTooLargeError";
  }
}

/** A prefix whose cumulative uploaded bytes would exceed the bundle cap. */
export class ArtifactBundleTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`artifact bundle exceeds size cap (limit ${String(limit)} bytes)`);
    this.name = "ArtifactBundleTooLargeError";
  }
}

/**
 * A project whose total STAGED (uncommitted) footprint would exceed a per-project cap — either
 * the cumulative staged-byte budget or the max count of concurrently-staged (uncommitted)
 * prefixes. Distinct from {@link ArtifactBundleTooLargeError} (a single prefix's committed size):
 * this bounds how much a project may hold UNCOMMITTED across ALL prefixes, so an attacker cannot
 * exhaust the shared staging volume by opening unbounded distinct `sourceHash` prefixes and
 * abandoning each just under the bundle cap. Routes map it to 413 (a resource cap, like the
 * bundle/file caps).
 */
export class ArtifactStagingQuotaError extends Error {
  constructor(
    readonly kind: "bytes" | "prefixes",
    readonly limit: number,
  ) {
    super(
      kind === "bytes"
        ? `artifact staging exceeds the per-project staged-bytes cap (limit ${String(limit)} bytes)`
        : `artifact staging exceeds the per-project uncommitted-prefix cap (limit ${String(limit)})`,
    );
    this.name = "ArtifactStagingQuotaError";
  }
}

/** A committed manifest whose listed sha256 does not match the uploaded bytes. */
export class ArtifactHashMismatchError extends Error {
  constructor(readonly path: string) {
    super(`artifact hash mismatch for path: ${path}`);
    this.name = "ArtifactHashMismatchError";
  }
}

/** A manifest listing a file that was never uploaded (a half-uploaded prefix). */
export class ArtifactManifestIncompleteError extends Error {
  constructor(readonly path: string) {
    super(`artifact manifest lists a file that was never uploaded: ${path}`);
    this.name = "ArtifactManifestIncompleteError";
  }
}

/** A source hash that is not a lowercase-hex SHA-256 (`^[a-f0-9]{64}$`). */
export class InvalidSourceHashError extends Error {
  constructor(readonly sourceHash: string) {
    super(`invalid source hash: ${sourceHash}`);
    this.name = "InvalidSourceHashError";
  }
}
