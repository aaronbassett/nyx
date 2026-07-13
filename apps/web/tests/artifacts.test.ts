/**
 * T070 — web-side artifact-fetch harness tests (US2 compile pipeline, scenario 3).
 *
 * Drives the fetch matrix over the R2 prefix layout (contract §5) and the R3
 * header rules against an injected MOCK `fetch` — no real R2 and no real
 * cross-origin-isolated browser fetch (both owner-gated). Proves: a fresh prefix
 * serves the complete set with zero 404s (SC-005/SC-007) using `mode: "cors"`
 * (R3); a 404 never passes silently; an oversized-uncached artifact raises the
 * EC-10 telemetry flag distinctly from a 404; and manifest paths resolve under
 * `urlPrefix` with a correct single-slash join.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  artifactUrl,
  fetchArtifacts,
  manifestUrl,
  planArtifactFetches,
  type ArtifactManifest,
  type ArtifactManifestFile,
} from "@/artifacts";

/** The R3 immutable header every artifact object is uploaded with (§5). */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The `Content-Type` the compile service records for keys and zkIR (§5). */
const OCTET_STREAM = "application/octet-stream";

/** A content-addressed prefix with NO trailing slash, per the §4.3 example. */
const URL_PREFIX = "https://artifacts.nyx.example/9f-uuid/e3b0c4";

/** The three artifact files a single-circuit contract publishes (§5 layout). */
const PROVER: ArtifactManifestFile = {
  path: "keys/increment.prover",
  sha256: "aa11",
  bytes: 12_345,
  contentType: OCTET_STREAM,
};
const VERIFIER: ArtifactManifestFile = {
  path: "keys/increment.verifier",
  sha256: "bb22",
  bytes: 2_048,
  contentType: OCTET_STREAM,
};
const ZKIR: ArtifactManifestFile = {
  path: "zkir/increment.bzkir",
  sha256: "cc33",
  bytes: 678,
  contentType: OCTET_STREAM,
};

/** Build a manifest (contract §5) around the given file set. */
function manifestOf(files: readonly ArtifactManifestFile[]): ArtifactManifest {
  return {
    sourceHash: "e3b0c4",
    compilerVersion: "0.31.1",
    circuits: [{ name: "increment", proof: true }],
    files,
  };
}

/** A body-less `Response` carrying only the headers under test. */
function artifactResponse(
  status: number,
  headers: { cacheControl?: string; contentType?: string } = {},
): Response {
  const responseHeaders: Record<string, string> = {};
  if (headers.cacheControl !== undefined) {
    responseHeaders["cache-control"] = headers.cacheControl;
  }
  if (headers.contentType !== undefined) {
    responseHeaders["content-type"] = headers.contentType;
  }
  return new Response(null, { status, headers: responseHeaders });
}

/** A fully-served artifact: 200 + immutable cache header + correct Content-Type. */
function servedArtifact(): Response {
  return artifactResponse(200, {
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: OCTET_STREAM,
  });
}

/** Resolve a fetch call's first argument (string | URL | Request) to a URL string. */
function callUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * A mock `fetch` that routes by absolute URL to a `Response` factory. An
 * unmapped URL rejects, so a wrong join (or an unexpected extra fetch) fails
 * loudly rather than silently 404-ing.
 */
function routingFetch(routes: Record<string, () => Response>): Mock<typeof fetch> {
  return vi.fn<typeof fetch>((input) => {
    const url = callUrl(input);
    const make = routes[url];
    if (make === undefined) {
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }
    return Promise.resolve(make());
  });
}

/** Every recorded fetch call as `{ url, init }`. */
function recordedCalls(fetchMock: Mock<typeof fetch>): { url: string; init: RequestInit }[] {
  return fetchMock.mock.calls.map(([input, init]) => ({ url: callUrl(input), init: init ?? {} }));
}

/** The absolute URL a manifest file resolves to under {@link URL_PREFIX}. */
function urlFor(file: ArtifactManifestFile): string {
  return `${URL_PREFIX}/${file.path}`;
}

describe("fetchArtifacts — fresh-prefix happy path (SC-005 / SC-007)", () => {
  it("returns allOk with zero missing when every artifact serves 200 + immutable + correct type", async () => {
    const manifest = manifestOf([PROVER, VERIFIER, ZKIR]);
    const fetchMock = routingFetch({
      [urlFor(PROVER)]: servedArtifact,
      [urlFor(VERIFIER)]: servedArtifact,
      [urlFor(ZKIR)]: servedArtifact,
    });

    const report = await fetchArtifacts(URL_PREFIX, manifest, { fetch: fetchMock });

    expect(report.allOk).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.oversizedUncached).toEqual([]);
    expect(report.outcomes).toHaveLength(3);
    for (const outcome of report.outcomes) {
      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe(200);
      expect(outcome.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(outcome.contentType).toBe(OCTET_STREAM);
      expect(outcome.oversizedUncached).toBe(false);
    }
  });

  it("fetches every manifest file, in order, with mode:'cors' (R3 COEP exemption)", async () => {
    const manifest = manifestOf([PROVER, VERIFIER, ZKIR]);
    const fetchMock = routingFetch({
      [urlFor(PROVER)]: servedArtifact,
      [urlFor(VERIFIER)]: servedArtifact,
      [urlFor(ZKIR)]: servedArtifact,
    });

    await fetchArtifacts(URL_PREFIX, manifest, { fetch: fetchMock });

    const calls = recordedCalls(fetchMock);
    expect(calls.map((call) => call.url)).toEqual([urlFor(PROVER), urlFor(VERIFIER), urlFor(ZKIR)]);
    // R3: a cors-mode fetch is exempt from COEP — this is why the read works
    // under `require-corp`. Every artifact fetch must use it (and omit creds).
    for (const call of calls) {
      expect(call.init.mode).toBe("cors");
      expect(call.init.credentials).toBe("omit");
    }
  });
});

describe("fetchArtifacts — a 404 never passes silently (SC-005)", () => {
  it("marks allOk:false and reports the one missing path", async () => {
    const manifest = manifestOf([PROVER, VERIFIER, ZKIR]);
    const fetchMock = routingFetch({
      [urlFor(PROVER)]: servedArtifact,
      [urlFor(VERIFIER)]: () => artifactResponse(404),
      [urlFor(ZKIR)]: servedArtifact,
    });

    const report = await fetchArtifacts(URL_PREFIX, manifest, { fetch: fetchMock });

    expect(report.allOk).toBe(false);
    expect(report.missing).toEqual([VERIFIER.path]);
    expect(report.oversizedUncached).toEqual([]);

    const missed = report.outcomes.find((outcome) => outcome.path === VERIFIER.path);
    expect(missed?.ok).toBe(false);
    expect(missed?.status).toBe(404);
    // The sibling artifacts still succeeded — the miss is isolated, not a wipeout.
    const prover = report.outcomes.find((outcome) => outcome.path === PROVER.path);
    expect(prover?.ok).toBe(true);
  });
});

describe("fetchArtifacts — EC-10 oversized-uncached telemetry flag", () => {
  /** An oversized file: bytes over the (small, test-configured) threshold. */
  const OVERSIZED: ArtifactManifestFile = {
    path: "keys/big.prover",
    sha256: "dd44",
    bytes: 4_096,
    contentType: OCTET_STREAM,
  };
  const THRESHOLD = 1_024;

  it("flags an oversized artifact served WITHOUT the immutable header, distinctly from a 404", async () => {
    const manifest = manifestOf([PROVER, OVERSIZED]);
    const fetchMock = routingFetch({
      [urlFor(PROVER)]: servedArtifact,
      // 200, correct type, but served uncached (no immutable) because it exceeds
      // the edge-cache limit (EC-10 / R3).
      [urlFor(OVERSIZED)]: () => artifactResponse(200, { contentType: OCTET_STREAM }),
    });

    const report = await fetchArtifacts(URL_PREFIX, manifest, {
      fetch: fetchMock,
      oversizeThresholdBytes: THRESHOLD,
    });

    // Distinct from a 404: it served fine (allOk true, not in missing) but is
    // flagged for telemetry.
    expect(report.allOk).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.oversizedUncached).toEqual([OVERSIZED.path]);

    const flagged = report.outcomes.find((outcome) => outcome.path === OVERSIZED.path);
    expect(flagged?.ok).toBe(true);
    expect(flagged?.status).toBe(200);
    expect(flagged?.oversizedUncached).toBe(true);
    expect(flagged?.cacheControl).toBeNull();
  });

  it("does NOT flag an oversized artifact that still carries the immutable header", async () => {
    const manifest = manifestOf([OVERSIZED]);
    const fetchMock = routingFetch({ [urlFor(OVERSIZED)]: servedArtifact });

    const report = await fetchArtifacts(URL_PREFIX, manifest, {
      fetch: fetchMock,
      oversizeThresholdBytes: THRESHOLD,
    });

    expect(report.oversizedUncached).toEqual([]);
    expect(report.outcomes[0]?.oversizedUncached).toBe(false);
  });

  it("does NOT flag an under-threshold artifact even when served uncached", async () => {
    // PROVER (12_345 bytes) is under the default 512 MB threshold; a missing
    // immutable header alone must not trip the oversize flag.
    const manifest = manifestOf([PROVER]);
    const fetchMock = routingFetch({
      [urlFor(PROVER)]: () => artifactResponse(200, { contentType: OCTET_STREAM }),
    });

    const report = await fetchArtifacts(URL_PREFIX, manifest, { fetch: fetchMock });

    expect(report.oversizedUncached).toEqual([]);
    expect(report.allOk).toBe(true);
  });
});

describe("fetchArtifacts — a thrown fetch is a hard miss, not a silent pass", () => {
  it("records status 0 and reports the path as missing when fetch rejects", async () => {
    const manifest = manifestOf([PROVER]);
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));

    const report = await fetchArtifacts(URL_PREFIX, manifest, { fetch: fetchMock });

    expect(report.allOk).toBe(false);
    expect(report.missing).toEqual([PROVER.path]);
    expect(report.outcomes[0]?.status).toBe(0);
    expect(report.outcomes[0]?.ok).toBe(false);
  });
});

describe("URL construction — manifest paths resolve under urlPrefix (single-slash join)", () => {
  it("joins a prefix and a path with exactly one slash", () => {
    expect(artifactUrl(URL_PREFIX, "keys/increment.prover")).toBe(
      `${URL_PREFIX}/keys/increment.prover`,
    );
  });

  it("collapses a trailing slash on the prefix — no double slash", () => {
    expect(artifactUrl(`${URL_PREFIX}/`, "zkir/increment.bzkir")).toBe(
      `${URL_PREFIX}/zkir/increment.bzkir`,
    );
  });

  it("collapses a leading slash on the path — no double slash", () => {
    expect(artifactUrl(URL_PREFIX, "/keys/increment.verifier")).toBe(
      `${URL_PREFIX}/keys/increment.verifier`,
    );
  });

  it("resolves the manifest.json entry point under the prefix", () => {
    expect(manifestUrl(URL_PREFIX)).toBe(`${URL_PREFIX}/manifest.json`);
  });

  it("plans one absolute URL per manifest file, in order, and is pure", () => {
    const manifest = manifestOf([PROVER, VERIFIER, ZKIR]);

    const plan = planArtifactFetches(URL_PREFIX, manifest);

    expect(plan).toEqual([
      {
        path: PROVER.path,
        url: urlFor(PROVER),
        bytes: PROVER.bytes,
        expectedContentType: OCTET_STREAM,
      },
      {
        path: VERIFIER.path,
        url: urlFor(VERIFIER),
        bytes: VERIFIER.bytes,
        expectedContentType: OCTET_STREAM,
      },
      {
        path: ZKIR.path,
        url: urlFor(ZKIR),
        bytes: ZKIR.bytes,
        expectedContentType: OCTET_STREAM,
      },
    ]);
    // Pure: identical inputs yield a deep-equal plan.
    expect(planArtifactFetches(URL_PREFIX, manifest)).toEqual(plan);
  });
});
