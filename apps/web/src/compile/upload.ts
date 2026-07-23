/**
 * P2 — artifact upload (green full compile → server artifact routes).
 *
 * After the in-browser toolchain produces a green `full` compile, its artifacts
 * are published straight from the browser to the server's content-addressed
 * artifact prefix: one raw PUT per file, then a SINGLE manifest-last POST to
 * `/commit`. The commit's arrival is the completeness marker for the whole set
 * (verify-before-announce, mirroring the `manifest.json` completeness marker in
 * `artifacts/manifest.ts`) — so it is sent ONLY after every file PUT has
 * succeeded, and a non-2xx on any request throws before it is reached.
 *
 * `fetch` is INJECTABLE (default `globalThis.fetch`, mirroring `artifacts/
 * fetch.ts` and the ledger/wallet clients), so the whole path unit-tests against
 * a mock with no server and no browser upload. A failed request is an ERROR here
 * (unlike a compile failure, which is DATA) — the caller decides how to surface
 * it as a `compile:results` verdict.
 *
 * NOTE: the web bundle carries no zod (rule) — the committed body is a plain
 * object shaped to the §5 manifest type (`artifacts/manifest.ts`), and the
 * server's `ArtifactManifestSchema` is the wire authority that validates it.
 */
import { ARTIFACT_MANIFEST_FILENAME, type ArtifactManifest } from "@/artifacts/manifest";

/** One artifact file to upload: its prefix-relative path, raw bytes, and MIME type. */
export interface UploadArtifactFile {
  /** Prefix-relative path, e.g. `"keys/increment.prover"` (no leading slash). */
  readonly path: string;
  /** The raw file bytes — PUT verbatim as the request body. */
  readonly bytes: Uint8Array;
  /** The `Content-Type` header the file is served with (R3 object metadata). */
  readonly contentType: string;
}

/** Injectable transport for {@link uploadArtifacts}. */
export interface UploadArtifactsDeps {
  /** `fetch` implementation; defaults to `globalThis.fetch`. Tests pass a mock. */
  readonly fetch?: typeof fetch;
  /**
   * Origin the artifact routes live under. Defaults to `""` — same-origin,
   * relative URLs (`/projects/…`). A trailing slash is tolerated.
   */
  readonly baseUrl?: string;
}

/** The green full-compile outputs to publish under `sourceHash`. */
export interface UploadArtifactsArgs {
  /** Project the artifacts belong to (ownership-gated server-side). */
  readonly projectId: string;
  /** Content hash that addresses the immutable prefix (from the worker). */
  readonly sourceHash: string;
  /** The exact pinned compiler version that produced these artifacts (D6). */
  readonly compilerVersion: string;
  /** Every artifact file to PUT before the commit. */
  readonly files: readonly UploadArtifactFile[];
  /** The circuit table recorded in the manifest. */
  readonly circuits: readonly { name: string; proof: boolean }[];
}

/**
 * A failed artifact request. Thrown for a non-2xx PUT (carrying the file `path`)
 * or a non-2xx commit (carrying `manifest.json`), always with the HTTP `status`.
 * Named so the `compile:run` handler can synthesize a diagnostic from it without
 * matching on the message string.
 */
export class ArtifactUploadError extends Error {
  override readonly name = "ArtifactUploadError";
  /** The prefix-relative path (or `manifest.json`) whose request failed. */
  readonly path: string;
  /** The HTTP status of the failing response. */
  readonly status: number;

  constructor(path: string, status: number) {
    super(`artifact upload failed for ${path} (HTTP ${String(status)})`);
    this.path = path;
    this.status = status;
  }
}

/** Trim a trailing slash so the join never emits a `//`. */
function normalizeBase(baseUrl: string | undefined): string {
  return (baseUrl ?? "").replace(/\/+$/u, "");
}

/** Percent-encode each path segment independently, preserving segment slashes. */
function encodeSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Absolute URL of one artifact file under the prefix. */
function fileUrl(base: string, projectId: string, sourceHash: string, path: string): string {
  return `${base}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(
    sourceHash,
  )}/files/${encodeSegments(path)}`;
}

/** Absolute URL of the prefix's commit endpoint (the manifest-last marker). */
function commitUrl(base: string, projectId: string, sourceHash: string): string {
  return `${base}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(
    sourceHash,
  )}/commit`;
}

/** Lowercase-hex SHA-256 of the file bytes (integrity marker in the manifest). */
async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Publish `args.files` to the server's artifact prefix, then commit the §5
 * manifest LAST. Resolves once the commit succeeds. Throws {@link
 * ArtifactUploadError} on the FIRST non-2xx response — a failing file PUT stops
 * the upload and the commit is never sent, so an incomplete prefix is never
 * marked complete.
 */
export async function uploadArtifacts(
  deps: UploadArtifactsDeps,
  args: UploadArtifactsArgs,
): Promise<void> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const base = normalizeBase(deps.baseUrl);

  const manifestFiles: ArtifactManifest["files"][number][] = [];

  // PUT every file first — sequentially, so the recorded order is deterministic
  // and a failure stops the rest before the commit.
  for (const file of args.files) {
    // A fresh copy pins the bytes to a non-shared `ArrayBuffer` — which both
    // `crypto.subtle.digest` and `fetch`'s `BodyInit` require (TS narrows the
    // generic `Uint8Array<ArrayBufferLike>` away from `SharedArrayBuffer`) — and
    // keeps the exact bytes without leaking any surrounding buffer.
    const bytes = new Uint8Array(file.bytes);
    const sha256 = await sha256Hex(bytes);
    const response = await fetchImpl(fileUrl(base, args.projectId, args.sourceHash, file.path), {
      method: "PUT",
      body: bytes,
      headers: { "content-type": file.contentType },
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new ArtifactUploadError(file.path, response.status);
    }
    manifestFiles.push({
      path: file.path,
      sha256,
      bytes: file.bytes.byteLength,
      contentType: file.contentType,
    });
  }

  // Commit the manifest LAST — its arrival marks the prefix complete.
  const manifest: ArtifactManifest = {
    sourceHash: args.sourceHash,
    compilerVersion: args.compilerVersion,
    circuits: args.circuits,
    files: manifestFiles,
  };
  const response = await fetchImpl(commitUrl(base, args.projectId, args.sourceHash), {
    method: "POST",
    body: JSON.stringify(manifest),
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new ArtifactUploadError(ARTIFACT_MANIFEST_FILENAME, response.status);
  }
}
