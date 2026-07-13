/**
 * T070 — R2 artifact manifest types (US2 compile pipeline, contract §5).
 *
 * `manifest.json` is the integrity manifest the Compile Service uploads LAST to
 * the content-addressed R2 prefix — its presence is the completeness marker for
 * the whole artifact set (verify-before-announce, FR-014). The browser preview's
 * `FetchZkConfigProvider` reads it first, then fetches every file it lists under
 * the same `urlPrefix`.
 *
 * These are TYPES ONLY. The manifest is not a Nyx wire-protocol DTO — the WS
 * protocol carries only `artifacts:ready { urlPrefix }` (D12) — so its shape
 * lives here rather than in `@nyx/protocol`. It mirrors `infra/compile-service/
 * API.md` §5 verbatim; the harness consumes an already-parsed manifest and never
 * re-decides that shape.
 */

/** One circuit in the compiled contract, as recorded in the manifest. */
export interface ArtifactCircuit {
  /** Circuit name, e.g. `"increment"`. */
  readonly name: string;
  /** Whether a proving key was generated for this circuit. */
  readonly proof: boolean;
}

/**
 * One artifact file entry: its prefix-relative path plus the integrity and
 * serving metadata the Compile Service recorded at upload time (R3).
 */
export interface ArtifactManifestFile {
  /** Prefix-relative path, e.g. `"keys/increment.prover"` (no leading slash). */
  readonly path: string;
  /** Lowercase-hex SHA-256 of the file bytes (integrity marker; not checked here). */
  readonly sha256: string;
  /** Size in bytes — the input to the EC-10 oversize check. */
  readonly bytes: number;
  /** The `Content-Type` the object was uploaded with (R3 object metadata). */
  readonly contentType: string;
}

/**
 * The integrity manifest at `<urlPrefix>/manifest.json` (contract §5). It
 * addresses a single content-hashed, immutable prefix: a compiler bump or a
 * source change yields a *new* prefix, never a mutation of this one.
 */
export interface ArtifactManifest {
  /** Content hash that addresses the prefix (folds in compiler version + flags). */
  readonly sourceHash: string;
  /** The exact pinned compiler version that produced these artifacts (D6). */
  readonly compilerVersion: string;
  /** Circuits compiled from the source. */
  readonly circuits: readonly ArtifactCircuit[];
  /** Every artifact file under the prefix, excluding `manifest.json` itself. */
  readonly files: readonly ArtifactManifestFile[];
}

/** The manifest's own prefix-relative filename (uploaded last = completeness marker). */
export const ARTIFACT_MANIFEST_FILENAME = "manifest.json";
