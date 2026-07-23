/**
 * P2 — `uploadArtifacts` (Task 4).
 *
 * The web side publishes a green full compile's artifacts to the server's
 * artifact routes (Task 5/6 contract) directly from the browser: one raw PUT per
 * file, then a single manifest-last POST to `/commit` whose presence marks the
 * whole set complete. These tests drive it against an injected `fetch` double —
 * no real server, no R2 — and prove: every request targets the per-segment
 * percent-encoded URL; the file PUTs all precede the commit POST; the committed
 * body matches the §5 manifest shape (asserted structurally against the type-only
 * `ArtifactManifest`, since the web bundle carries no zod); and a non-2xx on any
 * request throws a named {@link ArtifactUploadError} with `path`/`status` and
 * suppresses the commit.
 */
import { describe, expect, it } from "vitest";

import { ArtifactUploadError, uploadArtifacts } from "@/compile/upload";
import type { ArtifactManifest } from "@/artifacts/manifest";

/** One recorded fetch call: the URL and the (normalized) init. */
interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly contentType: string | null;
  readonly credentials: RequestCredentials | undefined;
}

/**
 * A scriptable `fetch` double. Records every call and returns a status scripted
 * per-URL-substring (default 200). The `body` is captured verbatim so a PUT's raw
 * bytes and the commit's JSON string can both be inspected.
 */
class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private readonly statusFor: (url: string) => number;

  constructor(statusFor: (url: string) => number = () => 200) {
    this.statusFor = statusFor;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    this.calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body,
      contentType: headers.get("content-type"),
      credentials: init?.credentials,
    });
    const status = this.statusFor(url);
    return Promise.resolve(new Response(null, { status }));
  };
}

/** Compute the lowercase-hex SHA-256 of bytes, independently of the SUT. */
async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PROJECT_ID = "proj-1";
const SOURCE_HASH = "a".repeat(64);

/** Two files, one nested under a subdirectory, for per-segment encoding coverage. */
function sampleFiles(): { path: string; bytes: Uint8Array; contentType: string }[] {
  return [
    {
      path: "contract/index.cjs",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "text/javascript",
    },
    {
      path: "keys/increment.prover",
      bytes: new Uint8Array([9, 8, 7, 6]),
      contentType: "application/octet-stream",
    },
  ];
}

const CIRCUITS = [{ name: "increment", proof: true }];

describe("uploadArtifacts", () => {
  it("PUTs each file to its per-segment encoded URL before committing the manifest", async () => {
    const fake = new FakeFetch();
    await uploadArtifacts(
      { fetch: fake.fetch },
      {
        projectId: PROJECT_ID,
        sourceHash: SOURCE_HASH,
        compilerVersion: "0.31.1",
        files: sampleFiles(),
        circuits: CIRCUITS,
      },
    );

    // Three calls: two PUTs then the commit POST, in that order (manifest last).
    expect(fake.calls.map((c) => c.method)).toEqual(["PUT", "PUT", "POST"]);
    expect(fake.calls[0]?.url).toBe(
      `/projects/${PROJECT_ID}/artifacts/${SOURCE_HASH}/files/contract/index.cjs`,
    );
    expect(fake.calls[1]?.url).toBe(
      `/projects/${PROJECT_ID}/artifacts/${SOURCE_HASH}/files/keys/increment.prover`,
    );
    expect(fake.calls[2]?.url).toBe(`/projects/${PROJECT_ID}/artifacts/${SOURCE_HASH}/commit`);

    // Every request is same-origin credentialed; PUTs carry the per-file content
    // type; the commit is JSON.
    expect(fake.calls.every((c) => c.credentials === "same-origin")).toBe(true);
    expect(fake.calls[0]?.contentType).toBe("text/javascript");
    expect(fake.calls[1]?.contentType).toBe("application/octet-stream");
    expect(fake.calls[2]?.contentType).toBe("application/json");

    // Raw bytes are PUT verbatim (not JSON-wrapped).
    expect(fake.calls[0]?.body).toBeInstanceOf(Uint8Array);
  });

  it("percent-encodes each path segment (not the whole path) so slashes survive", async () => {
    const fake = new FakeFetch();
    await uploadArtifacts(
      { fetch: fake.fetch },
      {
        projectId: PROJECT_ID,
        sourceHash: SOURCE_HASH,
        compilerVersion: "0.31.1",
        files: [
          {
            path: "zk config/my key.prover",
            bytes: new Uint8Array([0]),
            contentType: "application/octet-stream",
          },
        ],
        circuits: [],
      },
    );

    // Space in each segment is encoded; the segment slash is preserved.
    expect(fake.calls[0]?.url).toBe(
      `/projects/${PROJECT_ID}/artifacts/${SOURCE_HASH}/files/zk%20config/my%20key.prover`,
    );
  });

  it("commits a §5 manifest whose per-file sha256/bytes match the uploaded bytes", async () => {
    const fake = new FakeFetch();
    const files = sampleFiles();
    const [first, second] = files;
    if (!first || !second) throw new Error("expected two sample files");
    await uploadArtifacts(
      { fetch: fake.fetch },
      {
        projectId: PROJECT_ID,
        sourceHash: SOURCE_HASH,
        compilerVersion: "0.31.1",
        files,
        circuits: CIRCUITS,
      },
    );

    const commit = fake.calls.at(-1);
    expect(commit?.method).toBe("POST");
    const manifest = JSON.parse(String(commit?.body)) as ArtifactManifest;

    expect(manifest.sourceHash).toBe(SOURCE_HASH);
    expect(manifest.compilerVersion).toBe("0.31.1");
    expect(manifest.circuits).toEqual(CIRCUITS);
    expect(manifest.files).toEqual([
      {
        path: "contract/index.cjs",
        sha256: await sha256Hex(new Uint8Array(first.bytes)),
        bytes: 3,
        contentType: "text/javascript",
      },
      {
        path: "keys/increment.prover",
        sha256: await sha256Hex(new Uint8Array(second.bytes)),
        bytes: 4,
        contentType: "application/octet-stream",
      },
    ]);
  });

  it("throws ArtifactUploadError with path+status on a 413 PUT and sends NO commit", async () => {
    const fake = new FakeFetch((url) => (url.endsWith("increment.prover") ? 413 : 200));

    await expect(
      uploadArtifacts(
        { fetch: fake.fetch },
        {
          projectId: PROJECT_ID,
          sourceHash: SOURCE_HASH,
          compilerVersion: "0.31.1",
          files: sampleFiles(),
          circuits: CIRCUITS,
        },
      ),
    ).rejects.toMatchObject({
      name: "ArtifactUploadError",
      path: "keys/increment.prover",
      status: 413,
    });

    // The first PUT went out, the failing PUT threw, and the commit never fired.
    expect(fake.calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("throws ArtifactUploadError naming the manifest when the commit POST fails", async () => {
    const fake = new FakeFetch((url) => (url.endsWith("/commit") ? 500 : 200));

    const error = await uploadArtifacts(
      { fetch: fake.fetch },
      {
        projectId: PROJECT_ID,
        sourceHash: SOURCE_HASH,
        compilerVersion: "0.31.1",
        files: sampleFiles(),
        circuits: CIRCUITS,
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ArtifactUploadError);
    expect((error as ArtifactUploadError).path).toBe("manifest.json");
    expect((error as ArtifactUploadError).status).toBe(500);
  });

  it("honours an injected baseUrl for cross-origin upload targets", async () => {
    const fake = new FakeFetch();
    await uploadArtifacts(
      { fetch: fake.fetch, baseUrl: "https://api.example.test" },
      {
        projectId: PROJECT_ID,
        sourceHash: SOURCE_HASH,
        compilerVersion: "0.31.1",
        files: [{ path: "a.txt", bytes: new Uint8Array([1]), contentType: "text/plain" }],
        circuits: [],
      },
    );

    expect(fake.calls[0]?.url).toBe(
      `https://api.example.test/projects/${PROJECT_ID}/artifacts/${SOURCE_HASH}/files/a.txt`,
    );
  });
});
