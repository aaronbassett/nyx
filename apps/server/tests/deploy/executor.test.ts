/**
 * Owner-gated deploy executor stub tests (T157/US8, constitution I).
 *
 * The real Midnight-SDK deploy adapter is OWNER-GATED (it needs the local devnet + a funded signing
 * credential + mnm/MNE-verified `@midnight-ntwrk/*` shapes). Until wired, the stub can NEVER be
 * mistaken for a working deploy: EVERY {@link DeployExecutor} method throws
 * {@link DeployExecutorNotWiredError}. These tests pin exactly that — a call to any method is a
 * loud, unmistakable failure — and that the stub matches the pipeline's `DeployExecutor` seam
 * (so it wires straight into `createDeployPipeline`). Deterministic: no chain, no prover, no key.
 */
import { describe, expect, it } from "vitest";
import type { NetworkProfile } from "../../src/config/index.js";
import {
  createOwnerGatedDeployExecutor,
  DeployExecutorNotWiredError,
} from "../../src/deploy/executor.js";
import type {
  DeployExecutor,
  DeployArtifacts,
  DeployProof,
  FinalityRequest,
} from "../../src/deploy/pipeline.js";
import type { ProverClient } from "../../src/prover/index.js";

// --- Fixtures (all inert — the stub never touches them) ----------------------

const NETWORK: NetworkProfile = {
  id: "local-devnet",
  networkId: "Undeployed",
  nodeUrl: "http://localhost:9944",
  indexerUrl: "http://localhost:8088",
  proofServerUrl: "http://localhost:6300",
};

/** An inert prover client — never invoked by the stub. */
const PROVER: ProverClient = {
  prove: () => Promise.reject(new Error("prover must not be reached by the stub")),
};

const ARTIFACTS: DeployArtifacts = {
  urlPrefix: "https://r2.nyx.test/p/hash",
  compilerVersion: "0.24.0",
};
const PROOF: DeployProof = { bytes: new Uint8Array([1, 2, 3]) };
const FINALITY: FinalityRequest = { txRef: "tx-abc", timeoutMs: 1_000 };

/** Build the stub with the future real-adapter dependency shape. */
function makeExecutor(): DeployExecutor {
  return createOwnerGatedDeployExecutor({
    signingKey: "unused-by-the-stub",
    network: NETWORK,
    proverClient: PROVER,
  });
}

/** Run `fn` and return whatever it threw (the stub methods throw SYNCHRONOUSLY, never a promise). */
function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// --- Tests ------------------------------------------------------------------

describe("createOwnerGatedDeployExecutor (owner-gated stub)", () => {
  it("throws DeployExecutorNotWiredError from prove — never proves", () => {
    expect(() => makeExecutor().prove(ARTIFACTS)).toThrow(DeployExecutorNotWiredError);
  });

  it("throws DeployExecutorNotWiredError from signAndSubmit — never signs or submits", () => {
    expect(() => makeExecutor().signAndSubmit(PROOF)).toThrow(DeployExecutorNotWiredError);
  });

  it("throws DeployExecutorNotWiredError from awaitFinality — never awaits finality", () => {
    expect(() => makeExecutor().awaitFinality(FINALITY)).toThrow(DeployExecutorNotWiredError);
  });

  it("carries an unmistakable, network-tagged message so a stub can never read as a success", () => {
    const caught = caughtFrom(() => makeExecutor().prove(ARTIFACTS));
    expect(caught).toBeInstanceOf(DeployExecutorNotWiredError);
    const error = caught as DeployExecutorNotWiredError;
    expect(error.message).toContain("owner-gated");
    expect(error.message).toContain("mnm-verified");
    // The (public, non-secret) configured network id is surfaced for ops context.
    expect(error.configuredNetwork).toBe("local-devnet");
    expect(error.message).toContain("local-devnet");
  });
});
