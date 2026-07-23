/**
 * Store-backed in-process `fetch` adapter (P2 — browser-compile artifact serve, Task 6).
 *
 * `ArtifactOrchestrator.verifyPrefix` (`../compile/orchestrator.ts`) reads a compiled
 * prefix over a `fetch` seam — GET `<prefix>/manifest.json` then HEAD every listed file —
 * to confirm completeness BEFORE announcing `artifacts:ready` (FR-014). When the artifacts
 * live in the server's own {@link ArtifactStore} (not R2), we need a `fetch` that resolves
 * that same shape WITHOUT a network hop: {@link storeFetchAdapter} parses the artifact URL
 * and answers straight from the store.
 *
 * It implements ONLY what `verifyPrefix` uses:
 *   - GET  `<origin>/artifacts/<projectId>/<sourceHash>/manifest.json` → 200 JSON | 404
 *   - HEAD `<origin>/artifacts/<projectId>/<sourceHash>/<path>`        → 200      | 404
 *
 * Serving is gated on completeness exactly like the public GET route: `getManifest()` must
 * be non-null (the manifest-last marker), so a half-uploaded prefix is never observable —
 * an un-committed prefix answers 404 for both the manifest and every file, which maps to the
 * orchestrator's `manifest-missing` reason. Any store rejection (a malformed id / hash /
 * path) is treated as "absent" (404), never surfaced as a throw — the adapter mirrors an
 * HTTP read where a bad address is simply not found. Real `Response` objects are returned so
 * `response.ok`/`.json()` behave exactly as against a live server.
 */
import type { ArtifactStore } from "./store.js";

/** The completeness marker served at `<prefix>/manifest.json` (mirrors the route). */
const MANIFEST_FILENAME = "manifest.json";

/** Resolve a `fetch` input to its URL string (string | URL | Request). */
function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** A parsed artifact address, or `null` when the path is not an artifact URL. */
interface ArtifactAddress {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly path: string;
}

/** Parse `/artifacts/<projectId>/<sourceHash>/<path…>`; `null` if it is not that shape. */
function parseArtifactUrl(url: string): ArtifactAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const [prefix, projectId, sourceHash, ...rest] = segments;
  if (
    prefix !== "artifacts" ||
    projectId === undefined ||
    sourceHash === undefined ||
    rest.length === 0
  ) {
    return null;
  }
  return {
    projectId: decodeURIComponent(projectId),
    sourceHash: decodeURIComponent(sourceHash),
    path: rest.map((segment) => decodeURIComponent(segment)).join("/"),
  };
}

/**
 * Build an in-process `fetch` that serves one {@link ArtifactStore}'s prefixes, answering
 * exactly the GET-manifest / HEAD-file probes `verifyPrefix` issues. Non-artifact URLs and
 * any store rejection resolve to a 404 `Response` (never a throw).
 */
export function storeFetchAdapter(artifacts: ArtifactStore): typeof fetch {
  const notFound = (): Response => new Response(null, { status: 404 });

  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const address = parseArtifactUrl(inputUrl(input));
    if (address === null) {
      return notFound();
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const isHead = method === "HEAD";

    // Verify-before-serve: nothing is observable until the manifest-last commit lands.
    let manifest;
    try {
      manifest = await artifacts.getManifest(address.projectId, address.sourceHash);
    } catch {
      return notFound();
    }
    if (manifest === null) {
      return notFound();
    }

    if (address.path === MANIFEST_FILENAME) {
      if (isHead) {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    let file;
    try {
      file = await artifacts.getFile(address.projectId, address.sourceHash, address.path);
    } catch {
      return notFound();
    }
    if (file === null) {
      return notFound();
    }
    if (isHead) {
      return new Response(null, { status: 200 });
    }
    // A fresh copy pins the bytes to a non-shared `ArrayBuffer` (a `BodyInit`); the store's
    // generic `Uint8Array<ArrayBufferLike>` is not directly assignable.
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: { "content-type": file.contentType },
    });
  };

  return adapter;
}
