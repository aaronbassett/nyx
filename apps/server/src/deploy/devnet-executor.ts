/**
 * The REAL devnet deploy executor (P4 Task 2) — the orchestration that fills the pipeline's narrow
 * {@link DeployExecutor} seam (`prove` → `signAndSubmit` → `awaitFinality`, see `pipeline.ts`) with
 * a working, devnet-targeted implementation, replacing the owner-gated stub (`executor.ts`).
 *
 * ⚠️ CONSTITUTION I — THIS FILE CONTAINS ZERO `@midnight-ntwrk/*` IMPORTS. Every SDK shape lives
 * behind the injectable {@link DeploySdk} seam whose ONLY production implementation is
 * `sdk-adapter.ts` (the single SDK-touching module, built from the verified `sdk-recipe.md`). This
 * module is pure orchestration + classification: it loads the compiled artifacts from the P2
 * {@link ArtifactStore}, routes proving through the D37 {@link ProverClient} same-origin proxy,
 * classifies node rejections (EC-38), and polls finality under an injected clock. That keeps the
 * whole state machine deterministically testable with a FAKE `DeploySdk` — no chain, no prover, no
 * key — and keeps the SDK boundary in exactly one owner-gated place.
 *
 * ⚠️ CONSTITUTION III / SC-031 — the deploy signing key (`signingKey`, from `config.secrets`,
 * D50) flows into the SDK seam calls (`buildDeploy`/`submit`) and NOWHERE else: it is never logged,
 * never returned on any {@link ProveOutcome}/{@link SubmitOutcome}/{@link DeployFinality}, and never
 * folded into a `reason` string (all reasons are FIXED, key-free classifications; a raw SDK error
 * message — which could echo an input — is NEVER interpolated into an outcome). The deterministic
 * suite proves this with a canary key.
 *
 * FAILURE IS DATA (the pipeline depends on it): every method RESOLVES with an outcome and never
 * throws — a malformed prefix, a missing artifact, an unreachable prover, and a node rejection all
 * become the seam's designed failure arms. The pipeline has a never-reject backstop, but this
 * executor honours the seam contract directly so a fault is classified precisely, not swallowed.
 *
 * SUBMISSION SERIALIZATION (SPIKE-2 risk 7): the pipeline's one-in-flight invariant is PER PROJECT,
 * but concurrent projects share the ONE deploy wallet, and per-wallet concurrent submissions race
 * UTXO state. So {@link DeployExecutor.signAndSubmit} is serialized process-wide through a simple
 * promise-chain mutex held in the executor closure (one executor per deploy wallet in production —
 * see `index.ts`). P3 shipped a WEB-side `serializeSubmissions`; this is the server's own guard.
 */
import type { ArtifactManifest } from "../compile/schemas.js";
import type { NetworkProfile } from "../config/index.js";
import { ProverUnavailableError } from "../prover/index.js";
import type { ProverClient } from "../prover/index.js";
import type { ArtifactStore, StoredArtifactFile } from "../artifacts/store.js";
import type {
  DeployArtifacts,
  DeployExecutor,
  DeployFinality,
  FinalityRequest,
  ProveOutcome,
  SubmitOutcome,
} from "./pipeline.js";

// --- Constants --------------------------------------------------------------

/** The proof-server subpath the deploy proving payload is relayed to (recipe element 2). */
const PROVE_SUBPATH = "prove";

/**
 * The content-type the proof server expects for the octet-stream proving request (recipe element
 * 2 — `application/octet-stream`). A MIME constant, not an SDK shape; the payload bytes themselves
 * are produced opaquely by {@link DeploySdk.buildDeploy}.
 */
const PROVER_REQUEST_CONTENT_TYPE = "application/octet-stream";

/** Default interval between finality polls (ms) when none is injected. */
export const DEFAULT_FINALITY_POLL_INTERVAL_MS = 2_000;

// --- The SDK seam (the ONLY boundary sdk-adapter.ts implements) --------------

/** The compiled-artifact input to a deploy build: the integrity manifest + every file's bytes. */
export interface DeployFileSet {
  /** The R2 integrity manifest (`§5` shape) for the `(projectId, sourceHash)` prefix. */
  readonly manifest: ArtifactManifest;
  /** Every artifact file keyed by its manifest path (`contract/index.js`, `keys/…`, `zkir/…`). */
  readonly files: ReadonlyMap<string, StoredArtifactFile>;
}

/**
 * The finality verdict {@link DeploySdk.queryFinality} returns for ONE poll of the indexer (recipe
 * element 4). `pending` means the tx is not yet visible via the indexer (keep polling within the
 * bounded wait); `finalized` carries the on-chain contract address; `failed` carries the
 * (key-free, SDK-produced) reason (`FailEntirely`/`FailFallible`); `reorged` is dead-defensive —
 * the indexer never serves a block that later reorgs, so it can only arise from the optional
 * node-side cross-check disagreeing (recipe element 4). NEVER invent a reorg signal.
 */
export type FinalityQueryResult =
  | { readonly status: "finalized"; readonly address: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "reorged" }
  | { readonly status: "pending" };

/**
 * The narrow SDK boundary — the ONE seam `sdk-adapter.ts` implements against the installed
 * `@midnight-ntwrk/*` (constitution I). Split into build / submit / finality so the orchestrator
 * can route proving through the D37 proxy between build and submit, serialize submission, and poll
 * finality under an injected clock. The `signingKey` (D50) is passed IN for signing/building and is
 * the ONLY place it flows; the adapter must never echo it into a result or an error.
 */
export interface DeploySdk {
  /**
   * Build the UNPROVEN deploy tx bytes from the compiled artifacts (recipe element 1). The returned
   * `unprovenDeploy` bytes are the octet-stream proving payload the orchestrator relays to the
   * prover; `signingKey` binds the deploy to the deploy wallet's coin public key.
   */
  buildDeploy(input: {
    readonly files: DeployFileSet;
    readonly signingKey: string;
    readonly network: NetworkProfile;
  }): Promise<{ readonly unprovenDeploy: Uint8Array }>;

  /**
   * Sign the PROVEN deploy (BIP-340, recipe element 3) with `signingKey` and submit it to the
   * node's WS transport (`network.nodeUrl`). Resolves the node's tx reference. REJECTS on a
   * fee-wallet shortfall (EC-38, classified by {@link isInsufficientTdust}) or any other node-side
   * rejection — the orchestrator maps both to {@link SubmitOutcome}. Serialized by the caller.
   */
  submit(input: {
    readonly provenDeploy: Uint8Array;
    readonly signingKey: string;
    readonly network: NetworkProfile;
  }): Promise<{ readonly txRef: string }>;

  /**
   * Poll the indexer ONCE for the submitted tx's finality (recipe element 4) against
   * `network.indexerUrl`. Resolving is the finality signal; the orchestrator drives the bounded
   * poll loop (EC-39). Returns the on-chain address on `finalized`.
   */
  queryFinality(input: {
    readonly txRef: string;
    readonly network: NetworkProfile;
  }): Promise<FinalityQueryResult>;
}

// --- Executor deps ----------------------------------------------------------

/**
 * Dependencies for {@link createDevnetDeployExecutor}. `signingKey` is the server-side deploy
 * signing credential (D50/constitution III — never client-routed, never logged); `network` is the
 * resolved profile submitted to + awaited against; `proverClient` is the D37 same-origin prover the
 * proving payload is relayed through; `artifacts` is the P2 store the compiled contract is read
 * from (a pure READER — only `getManifest` + `getFile`). `sdk` defaults to the real `sdk-adapter.ts`
 * (loaded lazily so this module — and its tests — pull in NO `@midnight-ntwrk/*` unless a real
 * deploy actually runs). `now`/`delay`/`finalityPollIntervalMs` drive the bounded finality poll
 * deterministically (mirrors `pipeline.ts`'s injected `now`/`delay` defaulting).
 */
export interface DevnetDeployExecutorDeps {
  /** Server-side deploy signing credential (D50/constitution III). */
  readonly signingKey: string;
  /** Resolved network endpoints — `nodeUrl` (submit) + `indexerUrl` (finality). */
  readonly network: NetworkProfile;
  /** The D37 same-origin prover client the proving payload is relayed through. */
  readonly proverClient: ProverClient;
  /** The P2 artifact store — read-only source of the compiled contract + ZK artifacts. */
  readonly artifacts: ArtifactStore;
  /** The SDK seam; defaults to the lazily-loaded real `sdk-adapter.ts`. Tests inject a fake. */
  readonly sdk?: DeploySdk;
  /** Clock for the bounded finality wait; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Delay between finality polls; defaults to an UNREF'd `setTimeout` so a wait never pins the process. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Interval between finality polls (ms); defaults to {@link DEFAULT_FINALITY_POLL_INTERVAL_MS}. */
  readonly finalityPollIntervalMs?: number;
  /**
   * Structured error sink for otherwise-swallowed deploy faults (I2). A build/submit/finality
   * fault used to vanish (no server log) — an unwired adapter or a real SDK bug presented to ops
   * as nothing. This logs them LOUDLY. ⚠️ SC-031: it is only ever called with `error.name` (never
   * `.message`/`.stack` — a real SDK error can echo inputs incl. the signing key) plus key-free
   * context (projectId/txRef/phase). Defaults to a structured `process.stderr` line (mirrors the
   * pipeline/handler seam); tests inject a spy to assert the loud log fired and stays key-free.
   */
  readonly logError?: (message: string, detail: Record<string, unknown>) => void;
}

// --- Artifact-URL parsing ---------------------------------------------------

/** Thrown when a green build's `urlPrefix` is not the P2 `…/artifacts/<projectId>/<sourceHash>` shape. */
export class MalformedArtifactUrlPrefixError extends Error {
  constructor(urlPrefix: string) {
    super(
      `malformed artifact urlPrefix (expected …/artifacts/<projectId>/<sourceHash>): ${urlPrefix}`,
    );
    this.name = "MalformedArtifactUrlPrefixError";
  }
}

/**
 * Parse the P2 green-build `urlPrefix` into its `(projectId, sourceHash)`. The recorded prefix is
 * the ABSOLUTE URL `${publicOrigin}/artifacts/<projectId>/<sourceHash>` with NO trailing slash
 * (built at `compile/browser-client.ts`), so we parse the URL PATH — the last two segments after an
 * `artifacts` segment — rather than string-splitting a bare prefix. A trailing slash is tolerated.
 * Anything else (not a URL, wrong path shape, empty segment) throws
 * {@link MalformedArtifactUrlPrefixError}.
 */
export function parseArtifactUrlPrefix(urlPrefix: string): {
  readonly projectId: string;
  readonly sourceHash: string;
} {
  let url: URL;
  try {
    url = new URL(urlPrefix);
  } catch {
    throw new MalformedArtifactUrlPrefixError(urlPrefix);
  }
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  // Expect exactly: ["artifacts", <projectId>, <sourceHash>].
  if (segments.length !== 3 || segments[0] !== "artifacts") {
    throw new MalformedArtifactUrlPrefixError(urlPrefix);
  }
  const projectId = segments[1];
  const sourceHash = segments[2];
  if (
    projectId === undefined ||
    sourceHash === undefined ||
    projectId === "" ||
    sourceHash === ""
  ) {
    throw new MalformedArtifactUrlPrefixError(urlPrefix);
  }
  return { projectId, sourceHash };
}

// --- EC-38 discriminator (recipe "EC-38 discriminator") ---------------------

/**
 * EC-38 — "deploy wallet out of tDUST". The failure is CLIENT-SIDE, thrown by the wallet's
 * balancing before submission (recipe EC-38, four probes 2026-07-24): every probe threw an Effect
 * `FiberFailure` whose `name` embeds the tagged wallet error `Wallet.InsufficientFunds` (stable
 * across the no-NIGHT and the dust-less/unregistered cases; the two message variants differ, so we
 * match the tagged NAME, not the message). Any other submit-path throw is a plain `rejected`.
 *
 * This pure, SDK-free discriminator lives in the ORCHESTRATOR (not `sdk-adapter.ts`) because the
 * classification runs here — the deterministic suite drives it by having a FAKE `DeploySdk` throw
 * the recipe-recorded shape (which would be impossible if the classifier could only run behind the
 * real SDK import). The recipe's probed evidence is the source of truth for the matched token.
 */
export function isInsufficientTdust(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.includes("Wallet.InsufficientFunds");
}

/**
 * The `.name` of an unknown throw, safe to LOG (SC-031 — a name is a class identifier, never an
 * input echo, unlike `.message`/`.stack`). Falls back to a fixed token for a nameless throw.
 */
export function errorNameOf(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : "UnknownError";
}

/**
 * The adapter's owner-gated "not wired" error class NAME (`sdk-adapter.ts` `DeploySdkNotWiredError`).
 * Matched by NAME (not an `instanceof` import) so this module — and its tests — pull in NO
 * `@midnight-ntwrk/*` (importing the class would load the SDK-touching adapter). Two contexts throw
 * it: `submit` (the sign+submit seam is unwired) and `queryFinality` (the finalized-but-no-address
 * extraction path); the caller interprets it per context (I1/I2).
 */
const DEPLOY_SDK_NOT_WIRED_ERROR_NAME = "DeploySdkNotWiredError";

/** Is `error` the adapter's not-wired signal (matched by name, no SDK import)? */
function isDeploySdkNotWired(error: unknown): boolean {
  return errorNameOf(error) === DEPLOY_SDK_NOT_WIRED_ERROR_NAME;
}

/**
 * The default structured error sink (I2): a single JSON line to `process.stderr` (mirrors the
 * pipeline/handler `defaultLogError`). ⚠️ It renders `detail` values verbatim, so the CALLER must
 * only ever pass key-free values (an `errorName` string, never a raw `Error` whose message/stack
 * could echo the signing key). A stray `bigint` renders to a decimal string so the line can never
 * throw and block the deploy.
 */
function defaultLogError(message: string, detail: Record<string, unknown>): void {
  const rendered: Record<string, unknown> = { level: "error", source: "deploy-executor", message };
  for (const [key, value] of Object.entries(detail)) {
    rendered[key] = value;
  }
  const line = JSON.stringify(rendered, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  process.stderr.write(`${line}\n`);
}

// --- Fixed, key-free outcome reasons (SC-031) -------------------------------

/**
 * Server-side `reason` strings carried on the seam's failure arms. All are FIXED classifications —
 * a raw SDK error message (which could echo an input, incl. the signing key) is NEVER interpolated
 * into an outcome (constitution III / SC-031). The prover-status reason names only the numeric HTTP
 * status, never the response body (which could carry prover internals).
 */
const REASON = {
  artifactsMissing: "artifacts missing",
  malformedPrefix: "malformed artifact urlPrefix",
  proverUnavailable: "prover unavailable",
  buildFailed: "failed to build the deploy transaction",
  insufficientTdust: "deploy wallet has insufficient tDUST (EC-38)",
  nodeRejected: "node rejected the deploy submission",
  /**
   * I2 — a submit-PATH fault (the SDK adapter is not wired) — DISTINCT from a real node rejection
   * so it never impersonates "node rejected the deploy submission" (no node was contacted).
   */
  submitUnavailable: "deploy submission path unavailable (SDK adapter not wired)",
} as const;

// --- Executor ---------------------------------------------------------------

/** The default inter-poll delay — an UNREF'd timer so a live finality wait never pins the process. */
function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * A lazily-loaded real {@link DeploySdk} backed by `sdk-adapter.ts`. The dynamic `import()` keeps
 * `@midnight-ntwrk/*` OUT of this module's static graph — so a deterministic test that injects a
 * fake `sdk` never loads the SDK — while a real deploy transparently pulls it in on first use.
 */
function createLazyRealSdk(): DeploySdk {
  let loaded: Promise<DeploySdk> | undefined;
  const load = (): Promise<DeploySdk> => {
    loaded ??= import("./sdk-adapter.js").then((module) => module.createDeploySdkAdapter());
    return loaded;
  };
  return {
    buildDeploy: async (input) => (await load()).buildDeploy(input),
    submit: async (input) => (await load()).submit(input),
    queryFinality: async (input) => (await load()).queryFinality(input),
  };
}

/**
 * Build the real devnet {@link DeployExecutor} over its injected seams. Side-effect-free at
 * construction (opens no chain/prover/key). The returned executor honours the seam's "failure is
 * DATA" contract on every method, serializes `signAndSubmit` process-wide (SPIKE-2 risk 7), and
 * bounds `awaitFinality` (EC-39).
 */
export function createDevnetDeployExecutor(deps: DevnetDeployExecutorDeps): DeployExecutor {
  const { signingKey, network, proverClient, artifacts } = deps;
  const sdk = deps.sdk ?? createLazyRealSdk();
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? defaultDelay;
  const pollIntervalMs = deps.finalityPollIntervalMs ?? DEFAULT_FINALITY_POLL_INTERVAL_MS;
  const logError = deps.logError ?? defaultLogError;

  // Per-wallet submission mutex (SPIKE-2 risk 7): a simple promise chain so every `signAndSubmit`
  // awaits the prior one — concurrent projects' deploys share the one deploy wallet, and their
  // submissions must never race UTXO state. One executor per deploy wallet, so a closure chain IS
  // the process-wide guard. Failures don't break the chain (the tail swallows).
  let submitChain: Promise<unknown> = Promise.resolve();
  function serializeSubmit<T>(task: () => Promise<T>): Promise<T> {
    const run = submitChain.then(task, task);
    submitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Load the compiled artifacts for the prefix into a {@link DeployFileSet}: the committed manifest
   * (null before commit — an incomplete/absent prefix) plus every file it lists. A file listed in
   * the manifest but absent from the store is a half-uploaded prefix — surfaced as `null` so the
   * caller fails BEFORE building/relaying anything.
   */
  async function loadFileSet(projectId: string, sourceHash: string): Promise<DeployFileSet | null> {
    const manifest = await artifacts.getManifest(projectId, sourceHash);
    if (manifest === null) {
      return null;
    }
    const files = new Map<string, StoredArtifactFile>();
    for (const entry of manifest.files) {
      const file = await artifacts.getFile(projectId, sourceHash, entry.path);
      if (file === null) {
        return null; // incomplete prefix — never build a partial deploy
      }
      files.set(entry.path, file);
    }
    return { manifest, files };
  }

  async function prove(deployArtifacts: DeployArtifacts): Promise<ProveOutcome> {
    // Parse the prefix (data failure, never a throw — the pipeline relies on it).
    let projectId: string;
    let sourceHash: string;
    try {
      ({ projectId, sourceHash } = parseArtifactUrlPrefix(deployArtifacts.urlPrefix));
    } catch {
      return { outcome: "failed", reason: REASON.malformedPrefix };
    }

    const fileSet = await loadFileSet(projectId, sourceHash);
    if (fileSet === null) {
      return { outcome: "failed", reason: REASON.artifactsMissing };
    }

    // Build the unproven deploy from the artifacts (recipe element 1). A build fault is DATA.
    let unprovenDeploy: Uint8Array;
    try {
      ({ unprovenDeploy } = await sdk.buildDeploy({ files: fileSet, signingKey, network }));
    } catch (error) {
      // I2: log the fault LOUDLY (an unwired adapter / real SDK bug used to vanish) — name ONLY
      // (SC-031: never `.message`/`.stack`, which could echo the signing key).
      logError("deploy build failed", {
        projectId,
        sourceHash,
        phase: "proving",
        errorName: errorNameOf(error),
      });
      return { outcome: "failed", reason: REASON.buildFailed };
    }

    // Relay the proving payload through the D37 same-origin prover (recipe element 2). A transport
    // fault (ProverUnavailableError) and any prover non-2xx are BOTH failures-as-data; only a 2xx
    // yields the opaque proof bytes.
    try {
      const result = await proverClient.relay({
        subpath: PROVE_SUBPATH,
        body: Buffer.from(unprovenDeploy),
        contentType: PROVER_REQUEST_CONTENT_TYPE,
      });
      if (result.status < 200 || result.status >= 300) {
        // Name the STATUS only — never the response body (which could carry prover internals).
        return { outcome: "failed", reason: `prover returned status ${String(result.status)}` };
      }
      return { outcome: "proved", proof: { bytes: new Uint8Array(result.body) } };
    } catch (error) {
      if (error instanceof ProverUnavailableError) {
        return { outcome: "failed", reason: REASON.proverUnavailable };
      }
      // Any other unexpected relay throw is still surfaced as DATA (the seam never throws).
      return { outcome: "failed", reason: REASON.proverUnavailable };
    }
  }

  async function signAndSubmit(proof: { readonly bytes: Uint8Array }): Promise<SubmitOutcome> {
    // Serialized process-wide over the one deploy wallet (SPIKE-2 risk 7).
    return serializeSubmit(async () => {
      try {
        const { txRef } = await sdk.submit({ provenDeploy: proof.bytes, signingKey, network });
        return { outcome: "submitted", txRef } as const;
      } catch (error) {
        // I2: log the fault LOUDLY (name ONLY — SC-031: never `.message`/`.stack`).
        logError("deploy submit failed", { phase: "submitting", errorName: errorNameOf(error) });
        // Classify WITHOUT ever interpolating the raw error (it could echo the signing key) — a
        // FIXED, key-free reason per cause (SC-031).
        if (isInsufficientTdust(error)) {
          return {
            outcome: "rejected",
            cause: "insufficient-tdust",
            reason: REASON.insufficientTdust,
          } as const;
        }
        if (isDeploySdkNotWired(error)) {
          // I2: the submit PATH is unwired — NOT a node rejection (no node was contacted). A
          // distinct cause + reason so it never impersonates "node rejected the deploy submission".
          return {
            outcome: "rejected",
            cause: "unavailable",
            reason: REASON.submitUnavailable,
          } as const;
        }
        return { outcome: "rejected", cause: "rejected", reason: REASON.nodeRejected } as const;
      }
    });
  }

  async function awaitFinality(request: FinalityRequest): Promise<DeployFinality> {
    const startedAt = now();
    // Bounded poll loop (EC-39): poll at least once, then stop the instant the deadline is reached —
    // never a poll at or beyond `timeoutMs`, never an unbounded wait.
    for (;;) {
      let result: FinalityQueryResult;
      try {
        result = await sdk.queryFinality({ txRef: request.txRef, network });
      } catch (error) {
        // I1 (money-critical): `queryFinality` is DOCUMENTED to resolve, but the real adapter
        // THROWS on two paths. Handle both HERE so a throw never escapes into the pipeline's
        // generic retriable backstop → a retry that re-drives prove→submit → a SECOND on-chain
        // deploy (real tDUST double-spend).
        if (isDeploySdkNotWired(error)) {
          // Finalized-but-no-address: the tx is KNOWN-finalized, only the address extraction failed.
          // A retry double-deploys for CERTAIN, so return a distinct NON-retriable terminal (the
          // pipeline maps it accordingly) + a LOUD, key-free log carrying the txRef for ops.
          logError(
            "deploy FINALIZED on-chain but the contract address was UNAVAILABLE — do NOT retry (a retry would double-deploy); ops reconcile from the txRef",
            { txRef: request.txRef, phase: "awaiting_finality", errorName: errorNameOf(error) },
          );
          return { outcome: "address-unavailable" };
        }
        // A transient indexer/transport fault (e.g. DeployIndexerUnavailableError) — or any other
        // unexpected throw — is treated as PENDING: keep polling within the bounded wait, so a
        // one-off blip does not abort an otherwise-finalizing deploy. A persistent outage then
        // degrades to the honest `timeout` (never a reject that re-drives submit).
        result = { status: "pending" };
      }
      switch (result.status) {
        case "finalized":
          return { outcome: "finalized", address: result.address };
        case "failed":
          return { outcome: "failed", reason: result.reason };
        case "reorged":
          return { outcome: "reorged" };
        case "pending":
          // Fall through to the deadline check + delay.
          break;
      }
      if (now() - startedAt >= request.timeoutMs) {
        return { outcome: "timeout" };
      }
      await delay(pollIntervalMs);
      // Re-check after the delay so a poll never fires at/after the deadline (EC-39).
      if (now() - startedAt >= request.timeoutMs) {
        return { outcome: "timeout" };
      }
    }
  }

  return { prove, signAndSubmit, awaitFinality };
}
