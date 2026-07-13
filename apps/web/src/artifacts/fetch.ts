/**
 * T070 — web-side artifact-fetch harness (US2 compile pipeline, scenario 3).
 *
 * After a green full compile, the Compile Service publishes proving artifacts to
 * a content-hashed R2 prefix and Nyx emits `artifacts:ready { urlPrefix }`. The
 * browser preview's `FetchZkConfigProvider` then reads those artifacts from R2
 * under a cross-origin-isolated (`COEP: require-corp`) context. This module is
 * the pure, injectable-`fetch` core of that read path: it turns a `urlPrefix`
 * plus the parsed `manifest.json` (contract §5) into a fetch plan, runs it, and
 * returns a structured, deterministic report over the fetch matrix.
 *
 * Two facts from R3 shape it:
 *  - a `mode: "cors"` fetch is EXEMPT from COEP, which is why these cross-origin
 *    reads succeed under `require-corp` — every artifact fetch uses `cors`;
 *  - each object is served with `Cache-Control: public, max-age=31536000,
 *    immutable`. EC-10 is the exception: a file over the ~512 MB edge-cache limit
 *    is served from R2 UNCACHED (no `immutable`), which the report flags for
 *    telemetry rather than treating as a failure.
 *
 * `fetch` is INJECTABLE (default `globalThis.fetch`) so tests drive the whole
 * matrix against a mock — no real R2, no real cross-origin-isolated browser fetch
 * (both stay owner-gated). Nothing here reads the DOM or the clock; identical
 * inputs yield an identical plan.
 */
import { ARTIFACT_MANIFEST_FILENAME, type ArtifactManifest } from "./manifest";

/**
 * The fixed `RequestInit` for every artifact read. `mode: "cors"` is load-bearing
 * (R3: a cors-mode fetch is exempt from COEP, so the read works under
 * `require-corp`); `credentials: "omit"` keeps the session cookie off the public
 * R2 read domain (constitution III — creds never cross that boundary).
 */
const ARTIFACT_FETCH_INIT: RequestInit = {
  mode: "cors",
  credentials: "omit",
};

/** EC-10 threshold: Cloudflare's ~512 MB edge-cache object limit, in bytes. */
export const DEFAULT_OVERSIZE_THRESHOLD_BYTES = 512 * 1024 * 1024;

/** Injectable dependencies and tunables for {@link fetchArtifacts}. */
export interface ArtifactFetchOptions {
  /** `fetch` implementation; defaults to `globalThis.fetch`. Tests pass a mock. */
  readonly fetch?: typeof fetch;
  /**
   * Byte size above which a file served WITHOUT the immutable cache header is
   * flagged as oversized-uncached (EC-10). Defaults to
   * {@link DEFAULT_OVERSIZE_THRESHOLD_BYTES}.
   */
  readonly oversizeThresholdBytes?: number;
}

/** One planned fetch: the absolute URL plus the manifest metadata it is judged against. */
export interface ArtifactFetchPlanEntry {
  /** Prefix-relative manifest path this entry fetches. */
  readonly path: string;
  /** Absolute URL under `urlPrefix` (single-slash join). */
  readonly url: string;
  /** Expected size from the manifest — the EC-10 oversize input. */
  readonly bytes: number;
  /** Expected `Content-Type` from the manifest (R3 object metadata). */
  readonly expectedContentType: string;
}

/** The observed result of fetching one artifact. */
export interface ArtifactFetchOutcome {
  /** Prefix-relative manifest path. */
  readonly path: string;
  /** The absolute URL that was fetched. */
  readonly url: string;
  /** HTTP status; `0` means `fetch` itself threw (no response — DNS/TLS/CORS block). */
  readonly status: number;
  /** `response.ok` — a 2xx read. `false` for a 404 or a thrown fetch. */
  readonly ok: boolean;
  /** The response `Cache-Control`, or `null` when absent. */
  readonly cacheControl: string | null;
  /** The response `Content-Type`, or `null` when absent. */
  readonly contentType: string | null;
  /**
   * EC-10: served OK, but the manifest size exceeds the threshold AND the
   * response carries no `immutable` cache directive (served uncached). Orthogonal
   * to `ok` — a 404 is never flagged here, only reported as missing.
   */
  readonly oversizedUncached: boolean;
}

/** The structured, deterministic report over the whole fetch matrix. */
export interface ArtifactFetchReport {
  /** The prefix these artifacts were fetched from. */
  readonly urlPrefix: string;
  /** One outcome per manifest file, in manifest order. */
  readonly outcomes: readonly ArtifactFetchOutcome[];
  /**
   * True iff every file returned a 2xx. A FRESH prefix MUST be `allOk` with an
   * empty {@link ArtifactFetchReport.missing} — zero 404s (SC-005, SC-007).
   */
  readonly allOk: boolean;
  /** Paths that did not return a 2xx (404 or thrown fetch) — never a silent pass. */
  readonly missing: readonly string[];
  /** EC-10 telemetry: paths that were served OK but oversized-and-uncached. */
  readonly oversizedUncached: readonly string[];
}

/** Resolve the `fetch` to use — the injected one, else the global. */
function resolveFetch(options: ArtifactFetchOptions | undefined): typeof fetch {
  return options?.fetch ?? globalThis.fetch;
}

/**
 * Join `path` onto `urlPrefix` with exactly one separating slash. Tolerates a
 * trailing slash on the prefix and a leading slash on the path, and never emits
 * a `//` in the joined path. Deliberately NOT `new URL(path, prefix)`, which
 * resolves `path` relative to the prefix's last segment and would drop the
 * content hash from a hash-addressed prefix.
 */
export function artifactUrl(urlPrefix: string, path: string): string {
  const base = urlPrefix.replace(/\/+$/u, "");
  const suffix = path.replace(/^\/+/u, "");
  return `${base}/${suffix}`;
}

/** The absolute URL of the prefix's `manifest.json` — the read path's entry point. */
export function manifestUrl(urlPrefix: string): string {
  return artifactUrl(urlPrefix, ARTIFACT_MANIFEST_FILENAME);
}

/**
 * Build the fetch plan: the absolute URL for every file in the manifest, paired
 * with the manifest metadata each fetch is judged against. PURE and total —
 * identical inputs yield an identical plan, in manifest order.
 */
export function planArtifactFetches(
  urlPrefix: string,
  manifest: ArtifactManifest,
): readonly ArtifactFetchPlanEntry[] {
  return manifest.files.map((file) => ({
    path: file.path,
    url: artifactUrl(urlPrefix, file.path),
    bytes: file.bytes,
    expectedContentType: file.contentType,
  }));
}

/**
 * True when `cacheControl` carries the `immutable` directive. The immutable
 * response is the R3 default; its ABSENCE on an oversized object is the EC-10
 * uncached signal.
 */
function hasImmutableDirective(cacheControl: string | null): boolean {
  if (cacheControl === null) {
    return false;
  }
  return cacheControl
    .split(",")
    .some((directive) => directive.trim().toLowerCase() === "immutable");
}

/** Fetch one artifact and judge it against its manifest entry. Never throws. */
async function fetchOne(
  fetchImpl: typeof fetch,
  entry: ArtifactFetchPlanEntry,
  thresholdBytes: number,
): Promise<ArtifactFetchOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(entry.url, ARTIFACT_FETCH_INIT);
  } catch {
    // A thrown fetch (DNS/TLS/connection/opaque CORS block) is a hard miss:
    // report it as `status: 0` and let the aggregate count it — never a silent
    // pass.
    return {
      path: entry.path,
      url: entry.url,
      status: 0,
      ok: false,
      cacheControl: null,
      contentType: null,
      oversizedUncached: false,
    };
  }

  const cacheControl = response.headers.get("cache-control");
  const contentType = response.headers.get("content-type");
  const oversizedUncached =
    response.ok && entry.bytes > thresholdBytes && !hasImmutableDirective(cacheControl);

  return {
    path: entry.path,
    url: entry.url,
    status: response.status,
    ok: response.ok,
    cacheControl,
    contentType,
    oversizedUncached,
  };
}

/**
 * Execute the fetch plan for `manifest` under `urlPrefix` against the injected
 * `fetch`, returning the structured report. Every fetch uses `mode: "cors"`
 * (R3). Fetches run concurrently; `outcomes` stay in manifest order regardless of
 * resolution order, so the report is deterministic.
 */
export async function fetchArtifacts(
  urlPrefix: string,
  manifest: ArtifactManifest,
  options?: ArtifactFetchOptions,
): Promise<ArtifactFetchReport> {
  const fetchImpl = resolveFetch(options);
  const thresholdBytes = options?.oversizeThresholdBytes ?? DEFAULT_OVERSIZE_THRESHOLD_BYTES;
  const plan = planArtifactFetches(urlPrefix, manifest);

  const outcomes = await Promise.all(
    plan.map((entry) => fetchOne(fetchImpl, entry, thresholdBytes)),
  );

  const missing = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.path);
  const oversizedUncached = outcomes
    .filter((outcome) => outcome.oversizedUncached)
    .map((outcome) => outcome.path);

  return {
    urlPrefix,
    outcomes,
    allOk: missing.length === 0,
    missing,
    oversizedUncached,
  };
}
