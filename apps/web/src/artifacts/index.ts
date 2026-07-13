/**
 * T070 — artifact-fetch harness public surface (US2 compile pipeline).
 *
 * Re-exports the R2 artifact manifest types (contract §5) and the pure,
 * injectable-`fetch` harness that validates the fetch matrix against the R3
 * header rules the `FetchZkConfigProvider` relies on.
 */
export type { ArtifactCircuit, ArtifactManifest, ArtifactManifestFile } from "./manifest";
export { ARTIFACT_MANIFEST_FILENAME } from "./manifest";
export type {
  ArtifactFetchOptions,
  ArtifactFetchOutcome,
  ArtifactFetchPlanEntry,
  ArtifactFetchReport,
} from "./fetch";
export {
  artifactUrl,
  DEFAULT_OVERSIZE_THRESHOLD_BYTES,
  fetchArtifacts,
  manifestUrl,
  planArtifactFetches,
} from "./fetch";
