/**
 * Server artifact store public surface (P2 — the server stores compile artifacts itself,
 * replacing the retired Compile Service + R2-write path). Staged `putFile` → manifest-last
 * `commit` → `getManifest` / `getFile`, as a local-disk impl and an in-memory double, with
 * named-error rejections and content-hash-addressed, immutable prefixes.
 */
export {
  ArtifactBundleTooLargeError,
  ArtifactFileTooLargeError,
  ArtifactHashMismatchError,
  ArtifactManifestIncompleteError,
  InvalidSourceHashError,
  UnsafePathError,
} from "./errors.js";
export { createInMemoryArtifactStore, createLocalArtifactStore } from "./store.js";
export type { ArtifactStore, StoredArtifactFile } from "./store.js";
