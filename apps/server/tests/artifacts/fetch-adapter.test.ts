/**
 * Store-backed fetch adapter tests (P2 — Task 6, Step 3).
 *
 * `storeFetchAdapter` is an in-process `fetch` that answers ONLY what
 * `ArtifactOrchestrator.verifyPrefix` uses: GET `<prefix>/manifest.json` → 200 JSON / 404,
 * and HEAD `<prefix>/<file>` → 200 / 404. The strongest test is the REAL orchestrator: drive
 * `runTurn` with the adapter as its artifact `fetch` and assert it reaches `ready` when the
 * store prefix is committed, and `verification-failed { reason: "manifest-missing" }` when it
 * is not — verify-before-announce (FR-014) folded end-to-end onto the server store.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtifactsReadyPayload } from "@nyx/protocol";
import { ArtifactOrchestrator } from "../../src/compile/index.js";
import type {
  ArtifactManifest,
  CheckResponse,
  CompileClient,
  CompileJob,
  CompileSubmitResponse,
} from "../../src/compile/index.js";
import { createInMemoryArtifactStore, storeFetchAdapter } from "../../src/artifacts/index.js";
import type { ArtifactStore } from "../../src/artifacts/index.js";

const PROJECT_ID = "proj-1";
const SOURCE_HASH = "b".repeat(64);
const ORIGIN = "http://nyx.local";
const URL_PREFIX = `${ORIGIN}/artifacts/${PROJECT_ID}/${SOURCE_HASH}`;
const COMPILER_VERSION = "0.31.1";

const FILE_PATH = "keys/increment.prover";
const FILE_BYTES = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(): ArtifactManifest {
  return {
    sourceHash: SOURCE_HASH,
    compilerVersion: COMPILER_VERSION,
    circuits: [{ name: "increment", proof: true }],
    files: [
      {
        path: FILE_PATH,
        sha256: sha256Hex(FILE_BYTES),
        bytes: FILE_BYTES.byteLength,
        contentType: "application/octet-stream",
      },
    ],
  };
}

/** Seed a committed prefix (files staged + manifest committed) into the store. */
async function seedCommitted(store: ArtifactStore): Promise<void> {
  await store.putFile(PROJECT_ID, SOURCE_HASH, FILE_PATH, FILE_BYTES, "application/octet-stream");
  await store.commit(PROJECT_ID, SOURCE_HASH, manifest());
}

/** A compile client whose full job succeeds pointing at {@link URL_PREFIX}. */
function greenClient(): CompileClient {
  const check: CheckResponse = {
    ok: true,
    diagnostics: [],
    compilerVersion: COMPILER_VERSION,
    durationMs: 10,
  };
  const submit: CompileSubmitResponse = {
    jobId: "job-1",
    status: "queued",
    sourceHash: SOURCE_HASH,
  };
  const succeeded: CompileJob = {
    jobId: "job-1",
    status: "succeeded",
    sourceHash: SOURCE_HASH,
    result: {
      urlPrefix: URL_PREFIX,
      sourceHash: SOURCE_HASH,
      compilerVersion: COMPILER_VERSION,
      reused: false,
      circuits: [{ name: "increment", proof: true }],
    },
  };
  return {
    check: () => Promise.resolve(check),
    compile: () => Promise.resolve(submit),
    pollCompile: () => Promise.resolve(succeeded),
    version: () => Promise.reject(new Error("unused")),
  };
}

function orchestrator(
  store: ArtifactStore,
  emitted: ArtifactsReadyPayload[],
): ArtifactOrchestrator {
  return new ArtifactOrchestrator({
    client: greenClient(),
    emitArtifactsReady: (payload) => {
      emitted.push(payload);
    },
    fetchArtifact: storeFetchAdapter(store),
  });
}

const TURN_INPUT = {
  projectId: PROJECT_ID,
  files: [{ path: "src/counter.compact", content: "pragma language_version >= 0.23;" }],
  changedPaths: ["src/counter.compact"],
};

describe("storeFetchAdapter — real verify-before-announce", () => {
  it("reaches kind:ready when the store prefix is committed", async () => {
    const store = createInMemoryArtifactStore();
    await seedCommitted(store);
    const emitted: ArtifactsReadyPayload[] = [];

    const outcome = await orchestrator(store, emitted).runTurn(TURN_INPUT);

    expect(outcome.kind).toBe("ready");
    expect(emitted).toEqual([{ urlPrefix: URL_PREFIX }]);
  });

  it("reaches verification-failed manifest-missing when the prefix is not committed", async () => {
    const store = createInMemoryArtifactStore();
    // Stage the file but never commit — the manifest completeness marker is absent.
    await store.putFile(PROJECT_ID, SOURCE_HASH, FILE_PATH, FILE_BYTES, "application/octet-stream");
    const emitted: ArtifactsReadyPayload[] = [];

    const outcome = await orchestrator(store, emitted).runTurn(TURN_INPUT);

    expect(outcome.kind).toBe("verification-failed");
    if (outcome.kind === "verification-failed") {
      expect(outcome.reason).toBe("manifest-missing");
    }
    expect(emitted).toEqual([]);
  });
});

describe("storeFetchAdapter — direct probes", () => {
  it("GET manifest.json returns 200 JSON once committed, 404 before", async () => {
    const store = createInMemoryArtifactStore();
    const fetchImpl = storeFetchAdapter(store);

    const before = await fetchImpl(`${URL_PREFIX}/manifest.json`, { method: "GET" });
    expect(before.status).toBe(404);

    await seedCommitted(store);
    const after = await fetchImpl(`${URL_PREFIX}/manifest.json`, { method: "GET" });
    expect(after.status).toBe(200);
    expect(((await after.json()) as ArtifactManifest).sourceHash).toBe(SOURCE_HASH);
  });

  it("HEAD a listed file returns 200 once committed, 404 for an absent file", async () => {
    const store = createInMemoryArtifactStore();
    await seedCommitted(store);
    const fetchImpl = storeFetchAdapter(store);

    const present = await fetchImpl(`${URL_PREFIX}/${FILE_PATH}`, { method: "HEAD" });
    expect(present.status).toBe(200);

    const absent = await fetchImpl(`${URL_PREFIX}/keys/missing.verifier`, { method: "HEAD" });
    expect(absent.status).toBe(404);
  });

  it("returns 404 for a URL that is not an artifact path", async () => {
    const store = createInMemoryArtifactStore();
    const fetchImpl = storeFetchAdapter(store);
    const response = await fetchImpl(`${ORIGIN}/not/artifacts`, { method: "GET" });
    expect(response.status).toBe(404);
  });
});
