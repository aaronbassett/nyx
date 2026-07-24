/**
 * Deterministic tests for {@link createDevnetDeployExecutor} — the REAL devnet deploy executor
 * (P4 Task 2) that fills the pipeline's owner-gated {@link DeployExecutor} seam.
 *
 * These tests exercise ONLY the orchestration + classification logic in `devnet-executor.ts`
 * against a FAKE {@link DeploySdk} + an in-memory {@link ArtifactStore} — no chain, no prover, no
 * key, no `@midnight-ntwrk/*`. They pin: (a) `prove` loads the manifest + every artifact file for
 * the `urlPrefix`, hands them to `sdk.buildDeploy`, relays the proving payload through
 * `proverClient.relay({ subpath:"prove", ... })`, and maps the prover result to a `ProveOutcome`
 * (2xx→proved, non-2xx→failed-with-status, `ProverUnavailableError`→failed-as-data, missing
 * manifest→failed "artifacts missing"); (b) `signAndSubmit` maps `sdk.submit` to a `SubmitOutcome`
 * (ok→submitted, EC-38 tagged error→insufficient-tdust, any other throw→rejected); (c)
 * `awaitFinality` polls `sdk.queryFinality` under injected `delay`/`now` until finalized/failed/
 * reorged, and STOPS at `timeoutMs` (EC-39, no poll past the deadline); (d) the signing key NEVER
 * appears in any outcome/reason (SC-031 canary); (e) `parseArtifactUrlPrefix` round-trips the P2
 * prefix + rejects malformed prefixes; and (f) `signAndSubmit` is serialized process-wide (SPIKE-2
 * risk 7 — two concurrent deploys' submits observed strictly sequentially).
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactManifest } from "../../src/compile/schemas.js";
import type { NetworkProfile } from "../../src/config/index.js";
import {
  createDevnetDeployExecutor,
  MalformedArtifactUrlPrefixError,
  parseArtifactUrlPrefix,
} from "../../src/deploy/devnet-executor.js";
import type {
  DeployFileSet,
  DeploySdk,
  FinalityQueryResult,
} from "../../src/deploy/devnet-executor.js";
import { createInMemoryArtifactStore } from "../../src/artifacts/store.js";
import type { ArtifactStore } from "../../src/artifacts/store.js";
import { ProverUnavailableError } from "../../src/prover/index.js";
import type { ProverClient, ProxyRequest, ProxyResult } from "../../src/prover/index.js";

// --- Fixtures ---------------------------------------------------------------

const NETWORK: NetworkProfile = {
  id: "local-devnet",
  networkId: "Undeployed",
  nodeUrl: "http://localhost:9944",
  indexerUrl: "http://localhost:8088",
  proofServerUrl: "http://localhost:6300",
};

const PROJECT_ID = "proj-abc123";
const SOURCE_HASH = "a".repeat(64);
const URL_PREFIX = `https://nyx.test/artifacts/${PROJECT_ID}/${SOURCE_HASH}`;
const CANARY_KEY = "CANARY-SIGNING-KEY-must-never-leak-9f2b";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Seed an in-memory store with a two-file committed prefix and return it + the manifest. */
async function seedStore(): Promise<{ store: ArtifactStore; manifest: ArtifactManifest }> {
  const store = createInMemoryArtifactStore();
  const contractBytes = new TextEncoder().encode("export const Contract = {};\n");
  const proverBytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
  await store.putFile(
    PROJECT_ID,
    SOURCE_HASH,
    "contract/index.js",
    contractBytes,
    "text/javascript",
  );
  await store.putFile(
    PROJECT_ID,
    SOURCE_HASH,
    "keys/mint.prover",
    proverBytes,
    "application/octet-stream",
  );
  const manifest: ArtifactManifest = {
    sourceHash: SOURCE_HASH,
    compilerVersion: "0.31.1",
    circuits: [{ name: "mint", proof: true }],
    files: [
      {
        path: "contract/index.js",
        sha256: sha256Hex(contractBytes),
        bytes: contractBytes.length,
        contentType: "text/javascript",
      },
      {
        path: "keys/mint.prover",
        sha256: sha256Hex(proverBytes),
        bytes: proverBytes.length,
        contentType: "application/octet-stream",
      },
    ],
  };
  await store.commit(PROJECT_ID, SOURCE_HASH, manifest);
  return { store, manifest };
}

/** A prover client whose relay is a spy returning a canned `ProxyResult` (or throwing). */
function fakeProverClient(
  handler: (request: ProxyRequest) => Promise<ProxyResult>,
): ProverClient & { readonly calls: ProxyRequest[] } {
  const calls: ProxyRequest[] = [];
  return {
    calls,
    relay(request: ProxyRequest): Promise<ProxyResult> {
      calls.push(request);
      return handler(request);
    },
  };
}

function okProxyResult(body: Uint8Array): ProxyResult {
  return { status: 200, body: Buffer.from(body), contentType: "application/octet-stream" };
}

/** A minimal fake `DeploySdk`; each member is overridable and records its inputs. */
interface FakeSdkOverrides {
  buildDeploy?: DeploySdk["buildDeploy"];
  submit?: DeploySdk["submit"];
  queryFinality?: DeploySdk["queryFinality"];
}

function fakeSdk(overrides: FakeSdkOverrides = {}): DeploySdk {
  return {
    buildDeploy:
      overrides.buildDeploy ??
      (() => Promise.resolve({ unprovenDeploy: new Uint8Array([9, 9, 9]) })),
    submit: overrides.submit ?? (() => Promise.resolve({ txRef: "tx-default" })),
    queryFinality:
      overrides.queryFinality ??
      (() =>
        Promise.resolve<FinalityQueryResult>({ status: "finalized", address: "addr-default" })),
  };
}

// --- parseArtifactUrlPrefix -------------------------------------------------

describe("parseArtifactUrlPrefix", () => {
  it("round-trips the P2 absolute prefix shape (no trailing slash)", () => {
    expect(parseArtifactUrlPrefix(URL_PREFIX)).toEqual({
      projectId: PROJECT_ID,
      sourceHash: SOURCE_HASH,
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseArtifactUrlPrefix(`${URL_PREFIX}/`)).toEqual({
      projectId: PROJECT_ID,
      sourceHash: SOURCE_HASH,
    });
  });

  it.each([
    "not a url",
    "https://nyx.test/artifacts/only-one-segment",
    "https://nyx.test/artifacts/proj/hash/extra",
    "https://nyx.test/other/proj/hash",
    "https://nyx.test/artifacts//hash",
    "",
  ])("rejects a malformed prefix: %s", (bad) => {
    expect(() => parseArtifactUrlPrefix(bad)).toThrow(MalformedArtifactUrlPrefixError);
  });
});

// --- prove ------------------------------------------------------------------

describe("createDevnetDeployExecutor.prove", () => {
  it("loads the manifest + every file, builds a deploy, relays the payload, and resolves proved", async () => {
    const { store } = await seedStore();
    let builtWith: DeployFileSet | undefined;
    const provenBytes = new Uint8Array([7, 7, 7, 7]);
    const prover = fakeProverClient(() => Promise.resolve(okProxyResult(provenBytes)));
    const sdk = fakeSdk({
      buildDeploy: (input) => {
        builtWith = input.files;
        return Promise.resolve({ unprovenDeploy: new Uint8Array([1, 2, 3, 4, 5]) });
      },
    });
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: prover,
      artifacts: store,
      sdk,
    });

    const outcome = await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" });

    expect(outcome.outcome).toBe("proved");
    if (outcome.outcome !== "proved") throw new Error("unreachable");
    expect(Array.from(outcome.proof.bytes)).toEqual(Array.from(provenBytes));
    // The full file set (both manifest files) was handed to buildDeploy.
    expect(builtWith).toBeDefined();
    expect(builtWith?.files.size).toBe(2);
    expect(builtWith?.files.has("contract/index.js")).toBe(true);
    expect(builtWith?.files.has("keys/mint.prover")).toBe(true);
    // Relayed exactly once, to the `prove` subpath, with the unproven-deploy bytes.
    expect(prover.calls).toHaveLength(1);
    expect(prover.calls[0]?.subpath).toBe("prove");
    expect(Array.from(prover.calls[0]?.body ?? Buffer.alloc(0))).toEqual([1, 2, 3, 4, 5]);
  });

  it("maps a non-2xx prover ProxyResult to failed, naming the status but never the body", async () => {
    const { store } = await seedStore();
    const secretBody = new TextEncoder().encode("PROVER-INTERNAL-STACK-TRACE-SECRET");
    const prover = fakeProverClient(() =>
      Promise.resolve({ status: 503, body: Buffer.from(secretBody), contentType: "text/plain" }),
    );
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: prover,
      artifacts: store,
      sdk: fakeSdk(),
    });

    const outcome = await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" });

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("503");
    expect(outcome.reason).not.toContain("PROVER-INTERNAL-STACK-TRACE-SECRET");
  });

  it("maps a ProverUnavailableError rejection to failed (data, not a throw)", async () => {
    const { store } = await seedStore();
    const prover = fakeProverClient(() =>
      Promise.reject(new ProverUnavailableError("http://localhost:6300/prove")),
    );
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: prover,
      artifacts: store,
      sdk: fakeSdk(),
    });

    const outcome = await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" });
    expect(outcome.outcome).toBe("failed");
  });

  it("maps a missing manifest to failed 'artifacts missing' — no build, no relay", async () => {
    const store = createInMemoryArtifactStore(); // empty — no commit for this prefix
    const prover = fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array())));
    const buildSpy = vi.fn(() => Promise.resolve({ unprovenDeploy: new Uint8Array() }));
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: prover,
      artifacts: store,
      sdk: fakeSdk({ buildDeploy: buildSpy }),
    });

    const outcome = await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" });

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("artifacts missing");
    expect(buildSpy).not.toHaveBeenCalled();
    expect(prover.calls).toHaveLength(0);
  });

  it("maps a missing file (incomplete prefix) to failed — never relays a half build", async () => {
    // Commit a manifest that references a file the store never received.
    const store = createInMemoryArtifactStore();
    const present = new Uint8Array([1, 2, 3]);
    await store.putFile(PROJECT_ID, SOURCE_HASH, "contract/index.js", present, "text/javascript");
    const manifest: ArtifactManifest = {
      sourceHash: SOURCE_HASH,
      compilerVersion: "0.31.1",
      circuits: [],
      files: [
        {
          path: "contract/index.js",
          sha256: sha256Hex(present),
          bytes: present.length,
          contentType: "text/javascript",
        },
      ],
    };
    await store.commit(PROJECT_ID, SOURCE_HASH, manifest);
    // Now the executor asks for a file NOT in the committed manifest by using a manifest that lists
    // one more — simulate by deleting via a store wrapper that hides a file.
    const wrapped: ArtifactStore = {
      ...store,
      getManifest: () =>
        Promise.resolve({
          ...manifest,
          files: [
            ...manifest.files,
            { path: "keys/ghost.prover", sha256: "0".repeat(64), bytes: 1, contentType: "x" },
          ],
        }),
    };
    const prover = fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array())));
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: prover,
      artifacts: wrapped,
      sdk: fakeSdk(),
    });

    const outcome = await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" });
    expect(outcome.outcome).toBe("failed");
    expect(prover.calls).toHaveLength(0);
  });

  it("maps a malformed urlPrefix to failed (data, not a throw)", async () => {
    const { store } = await seedStore();
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk(),
    });
    const outcome = await executor.prove({ urlPrefix: "not-a-valid-prefix", compilerVersion: "x" });
    expect(outcome.outcome).toBe("failed");
  });
});

// --- signAndSubmit ----------------------------------------------------------

describe("createDevnetDeployExecutor.signAndSubmit", () => {
  it("maps a successful submit to submitted with the txRef", async () => {
    const { store } = await seedStore();
    let submittedProof: Uint8Array | undefined;
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        submit: (input) => {
          submittedProof = input.provenDeploy;
          return Promise.resolve({ txRef: "tx-9f" });
        },
      }),
    });

    const outcome = await executor.signAndSubmit({ bytes: new Uint8Array([4, 2]) });
    expect(outcome).toEqual({ outcome: "submitted", txRef: "tx-9f" });
    expect(Array.from(submittedProof ?? new Uint8Array())).toEqual([4, 2]);
  });

  it("classifies the EC-38 tagged error as insufficient-tdust", async () => {
    const { store } = await seedStore();
    // The recipe-recorded shape: an Effect FiberFailure whose name embeds the tagged wallet error.
    const ec38 = new Error("Insufficient Funds: could not balance dust");
    ec38.name = "(FiberFailure) Wallet.InsufficientFunds";
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ submit: () => Promise.reject(ec38) }),
    });

    const outcome = await executor.signAndSubmit({ bytes: new Uint8Array() });
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome !== "rejected") throw new Error("unreachable");
    expect(outcome.cause).toBe("insufficient-tdust");
  });

  it("classifies any other submit throw as rejected", async () => {
    const { store } = await seedStore();
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ submit: () => Promise.reject(new Error("node said no")) }),
    });

    const outcome = await executor.signAndSubmit({ bytes: new Uint8Array() });
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome !== "rejected") throw new Error("unreachable");
    expect(outcome.cause).toBe("rejected");
  });

  it("serializes concurrent submits process-wide (SPIKE-2 risk 7)", async () => {
    const { store } = await seedStore();
    let inFlight = 0;
    let maxConcurrent = 0;
    const gates: (() => void)[] = [];
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        submit: () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          return new Promise<{ txRef: string }>((resolve) => {
            gates.push(() => {
              inFlight -= 1;
              resolve({ txRef: `tx-${String(gates.length)}` });
            });
          });
        },
      }),
    });

    const first = executor.signAndSubmit({ bytes: new Uint8Array([1]) });
    const second = executor.signAndSubmit({ bytes: new Uint8Array([2]) });
    // Let microtasks settle: only ONE submit may be running.
    await Promise.resolve();
    await Promise.resolve();
    expect(gates).toHaveLength(1); // second is queued behind the mutex, not yet started
    gates[0]?.(); // release the first submit
    await first;
    await Promise.resolve();
    await Promise.resolve();
    expect(gates).toHaveLength(2); // now the second has started
    gates[1]?.();
    await second;
    expect(maxConcurrent).toBe(1);
  });
});

// --- awaitFinality ----------------------------------------------------------

describe("createDevnetDeployExecutor.awaitFinality", () => {
  /** A monotone injected clock that `delay` advances — deterministic, no real timers. */
  function injectedClock(): { now: () => number; delay: (ms: number) => Promise<void> } {
    let t = 0;
    return {
      now: () => t,
      delay: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it("polls until finalized and returns the address", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    const results: FinalityQueryResult[] = [
      { status: "pending" },
      { status: "pending" },
      { status: "finalized", address: "deadbeef-addr" },
    ];
    let call = 0;
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        queryFinality: () => {
          const r = results[call] ?? { status: "pending" };
          call += 1;
          return Promise.resolve(r);
        },
      }),
      now: clock.now,
      delay: clock.delay,
      finalityPollIntervalMs: 100,
    });

    const finality = await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 60_000 });
    expect(finality).toEqual({ outcome: "finalized", address: "deadbeef-addr" });
    expect(call).toBe(3);
  });

  it("maps a failed finality to failed", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        queryFinality: () =>
          Promise.resolve<FinalityQueryResult>({ status: "failed", reason: "FailEntirely" }),
      }),
      now: clock.now,
      delay: clock.delay,
    });
    const finality = await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 60_000 });
    expect(finality.outcome).toBe("failed");
  });

  it("maps a reorged signal to reorged (dead-defensive node cross-check)", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        queryFinality: () => Promise.resolve<FinalityQueryResult>({ status: "reorged" }),
      }),
      now: clock.now,
      delay: clock.delay,
    });
    const finality = await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 60_000 });
    expect(finality.outcome).toBe("reorged");
  });

  it("STOPS at timeoutMs and never polls past the deadline (EC-39)", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    const polledAt: number[] = [];
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        queryFinality: () => {
          polledAt.push(clock.now());
          return Promise.resolve<FinalityQueryResult>({ status: "pending" });
        },
      }),
      now: clock.now,
      delay: clock.delay,
      finalityPollIntervalMs: 100,
    });

    const finality = await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 1_000 });
    expect(finality).toEqual({ outcome: "timeout" });
    // No poll may have happened at or beyond the deadline.
    expect(polledAt.length).toBeGreaterThan(0);
    for (const at of polledAt) {
      expect(at).toBeLessThan(1_000);
    }
  });

  // --- I1: queryFinality throws are handled IN the executor (no reject → no double-deploy) ------

  it("I1: tolerates a one-off transient queryFinality throw and still reaches finalized (no reject)", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    // A transient indexer/transport fault (matched by name, like the real DeployIndexerUnavailableError).
    const transient = new Error("indexer unreachable: http://localhost:8088");
    transient.name = "DeployIndexerUnavailableError";
    let call = 0;
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({
        queryFinality: () => {
          call += 1;
          if (call === 1) {
            return Promise.reject(transient);
          }
          return Promise.resolve<FinalityQueryResult>({ status: "finalized", address: "addr-ok" });
        },
      }),
      now: clock.now,
      delay: clock.delay,
      finalityPollIntervalMs: 100,
    });

    // The one-off throw is treated as pending (keep polling); the deploy still finalizes — a blip
    // never aborts an otherwise-finalizing deploy, and awaitFinality NEVER rejects.
    const finality = await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 60_000 });
    expect(finality).toEqual({ outcome: "finalized", address: "addr-ok" });
    expect(call).toBe(2);
  });

  it("I1: a PERSISTENTLY-throwing queryFinality degrades to the honest timeout — never rejects, never a retriable re-drive", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    const outage = new Error("indexer down");
    outage.name = "DeployIndexerUnavailableError";
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ queryFinality: () => Promise.reject(outage) }),
      now: clock.now,
      delay: clock.delay,
      finalityPollIntervalMs: 100,
    });

    // A persistent outage bounds out to `timeout` (never a reject that the pipeline backstop would
    // mark retriable → a re-drive → a SECOND on-chain deploy).
    const finality = await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 1_000 });
    expect(finality).toEqual({ outcome: "timeout" });
  });

  it("I1: a finalized-but-no-address throw maps to a NON-retriable address-unavailable + a loud key-free log (txRef only)", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    // The sdk-adapter's finalized-but-no-address signal (matched by name, no SDK import).
    const notWired = new Error("finalized-deploy address extraction (confirm the subfield ...)");
    notWired.name = "DeploySdkNotWiredError";
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ queryFinality: () => Promise.reject(notWired) }),
      now: clock.now,
      delay: clock.delay,
      logError: (message, detail) => {
        logs.push({ message, detail });
      },
    });

    const finality = await executor.awaitFinality({ txRef: "tx-deadbeef", timeoutMs: 60_000 });
    // A distinct NON-retriable terminal (the pipeline maps it so a retry can never double-deploy).
    expect(finality).toEqual({ outcome: "address-unavailable" });
    // A loud log carrying the txRef (ops reconcile) + the error NAME only — never the message.
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail.txRef).toBe("tx-deadbeef");
    expect(logs[0]?.detail.errorName).toBe("DeploySdkNotWiredError");
  });
});

// --- I2: deploy faults are logged loudly (name-only, SC-031-safe) -----------

describe("createDevnetDeployExecutor (I2 fault observability)", () => {
  it("logs a buildDeploy fault loudly with the error NAME only — never the key or message", async () => {
    const { store } = await seedStore();
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    // The build error's MESSAGE maliciously echoes the signing key (a real SDK error could).
    const boom = new Error(`build blew up key=${CANARY_KEY}`);
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ buildDeploy: () => Promise.reject(boom) }),
      logError: (message, detail) => {
        logs.push({ message, detail });
      },
    });

    const outcome = await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" });

    expect(outcome.outcome).toBe("failed");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail.errorName).toBe("Error");
    // Canary: nothing the sink received echoes the key (name-only, never message/stack).
    expect(JSON.stringify(logs)).not.toContain(CANARY_KEY);
  });

  it("logs a submit fault loudly, and classifies a not-wired submit as `unavailable` with a DISTINCT reason (never 'node rejected')", async () => {
    const { store } = await seedStore();
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    const notWired = new Error("owner-gated: real Midnight-SDK proven-deploy sign+submit ...");
    notWired.name = "DeploySdkNotWiredError";
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ submit: () => Promise.reject(notWired) }),
      logError: (message, detail) => {
        logs.push({ message, detail });
      },
    });

    const outcome = await executor.signAndSubmit({ bytes: new Uint8Array() });

    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome !== "rejected") throw new Error("unreachable");
    // A not-wired submit is its OWN cause + reason — it no longer impersonates a node rejection.
    expect(outcome.cause).toBe("unavailable");
    expect(outcome.reason).not.toBe("node rejected the deploy submission");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail.errorName).toBe("DeploySdkNotWiredError");
  });

  it("SC-031 canary: a submit error whose MESSAGE echoes the signing key reaches the log sink NAME-only — the key never leaks", async () => {
    const { store } = await seedStore();
    const logs: { message: string; detail: Record<string, unknown> }[] = [];
    // A maliciously key-echoing node error (message embeds the key).
    const leaky = new Error(`node rejected: ${CANARY_KEY}`);
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      proverClient: fakeProverClient(() => Promise.resolve(okProxyResult(new Uint8Array()))),
      artifacts: store,
      sdk: fakeSdk({ submit: () => Promise.reject(leaky) }),
      logError: (message, detail) => {
        logs.push({ message, detail });
      },
    });

    await executor.signAndSubmit({ bytes: new Uint8Array() });

    expect(logs).toHaveLength(1);
    // The sink received the error NAME only ("Error") — the key-bearing message never reached it.
    expect(logs[0]?.detail.errorName).toBe("Error");
    expect(JSON.stringify(logs)).not.toContain(CANARY_KEY);
  });
});

// --- SC-031: the signing key never leaks -----------------------------------

describe("createDevnetDeployExecutor (SC-031 canary)", () => {
  it("the signing key never appears in any outcome or reason across all paths", async () => {
    const { store } = await seedStore();
    const clock = injectedClock();
    // Fakes that ECHO their received signingKey into their own errors/results — proving the
    // orchestrator, not the SDK, is what keeps the key out of the outcomes it returns.
    const executor = createDevnetDeployExecutor({
      signingKey: CANARY_KEY,
      network: NETWORK,
      // A non-2xx prover so `prove` builds a failure reason from the response.
      proverClient: fakeProverClient(() =>
        Promise.resolve({ status: 500, body: Buffer.alloc(0), contentType: undefined }),
      ),
      artifacts: store,
      sdk: fakeSdk({
        submit: (input) => Promise.reject(new Error(`rejected: ${input.signingKey}`)),
        queryFinality: () =>
          Promise.resolve<FinalityQueryResult>({ status: "failed", reason: "FailEntirely" }),
      }),
      now: clock.now,
      delay: clock.delay,
    });

    const outcomes: unknown[] = [];
    outcomes.push(await executor.prove({ urlPrefix: URL_PREFIX, compilerVersion: "0.31.1" }));
    outcomes.push(await executor.signAndSubmit({ bytes: new Uint8Array([1]) }));
    outcomes.push(await executor.awaitFinality({ txRef: "tx-1", timeoutMs: 1_000 }));

    const serialized = JSON.stringify(outcomes, (_key, value: unknown) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    );
    expect(serialized).not.toContain(CANARY_KEY);
  });

  function injectedClock(): { now: () => number; delay: (ms: number) => Promise<void> } {
    let t = 0;
    return { now: () => t, delay: (ms: number) => ((t += ms), Promise.resolve()) };
  }
});
