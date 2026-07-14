/**
 * Owner-gated real deploy executor (T157/US8, constitution I / III / D37 / D50).
 *
 * {@link createOwnerGatedDeployExecutor} is the PRODUCTION adapter behind the pipeline's narrow
 * {@link DeployExecutor} seam (`prove` → `signAndSubmit` → `awaitFinality`, see `pipeline.ts`).
 * The real adapter drives a Midnight-SDK contract deploy end to end — but every `@midnight-ntwrk/*`
 * shape it touches (the deploy builder, the proving payload, the finality query) MUST be
 * mnm/MNE-verified against the INSTALLED SDK on a live local devnet before use, and it needs a
 * FUNDED signing credential to submit. Until that owner-gated wiring is done, this is a STUB whose
 * every method THROWS {@link DeployExecutorNotWiredError} — it can NEVER be mistaken for a working
 * deploy (it deploys nothing, records nothing, announces nothing; a caller sees a loud, retriable
 * failure). This mirrors the top-up ceremony's owner-gated stub: the SEAM + its dependency shape
 * are wired today, so swapping in the verified adapter is a body-only change.
 *
 * REAL-WIRING STEPS (owner-gated — do NOT implement from memory; verify EACH SDK shape via
 * mnm/MNE against the installed `@midnight-ntwrk/*` + a running devnet, constitution I):
 *  1. Build the contract deploy from the green artifacts at `artifacts.urlPrefix` — the compiled
 *     contract module + ZK params read from R2 — using the Midnight SDK deploy builder.
 *  2. `prove(artifacts)`: prove the deploy SERVER-SIDE through `proverClient` (the D37 same-origin
 *     prover proxy at `config.prover.url`), NEVER a client-side prover; wrap the proving bytes in
 *     the opaque {@link DeployProof}.
 *  3. `signAndSubmit(proof)`: sign the proven deploy transaction with the server-side signing
 *     credential (`signingKey`, held server-side only — D50/constitution III, never on any
 *     client-bound surface) and submit it to `network.nodeUrl`; classify a fee-wallet shortfall as
 *     `insufficient-tdust` (EC-38) and any other node rejection as `rejected`.
 *  4. `awaitFinality(request)`: await finality for the submitted tx against `network.indexerUrl`,
 *     bounded by `request.timeoutMs` (EC-39 — never unbounded); map settled→`finalized{address}`,
 *     rolled-back→`failed`, a re-org→`reorged`, and no-settle-in-time→`timeout`.
 *
 * CONSTITUTION III — the signing credential flows into THIS adapter and nowhere else. The stub
 * holds it in its dependency shape but never logs it, never returns it, and never puts it on a
 * frame; it is deliberately kept out of every diagnostic string here (the SC-031 audit forbids the
 * key identifier appearing anywhere under `src/deploy/`).
 */
import type { NetworkProfile } from "../config/index.js";
import type { ProverClient } from "../prover/index.js";
import type { DeployExecutor } from "./pipeline.js";

/**
 * Thrown by every method of the owner-gated deploy executor stub until the real Midnight-SDK
 * adapter is wired + verified. Its message is deliberately unmistakable so a stubbed deploy can
 * never be read as a success. Carries the (non-secret) configured network id for ops context.
 */
export class DeployExecutorNotWiredError extends Error {
  /** The configured network the (unwired) deploy targeted — a public profile id, never a secret. */
  readonly configuredNetwork: string | undefined;

  constructor(configuredNetwork?: string) {
    const suffix =
      configuredNetwork === undefined ? "" : ` (configured network: ${configuredNetwork})`;
    super(
      "owner-gated: real Midnight SDK deploy needs the local devnet + funded deploy key + " +
        `mnm-verified SDK shapes${suffix}`,
    );
    this.name = "DeployExecutorNotWiredError";
    this.configuredNetwork = configuredNetwork;
  }
}

/**
 * Dependencies for the real deploy executor (owner-gated). The shape is the FUTURE adapter's shape,
 * so the stub is a drop-in: `signingKey` is the server-side deploy signing credential (D50 — wired
 * from `config.secrets` by `index.ts`, never client-routed); `network` is the resolved
 * {@link NetworkProfile} the adapter submits to + awaits finality against; `proverClient` is the
 * D37 same-origin prover the adapter proves through. The stub reads only `network` (to tag its
 * error); `signingKey` + `proverClient` are held for the real impl and never touched here.
 */
export interface OwnerGatedDeployExecutorDeps {
  /** Server-side deploy signing credential (D50/constitution III). Held for the real adapter only. */
  readonly signingKey: string;
  /** Resolved network endpoints — `nodeUrl` (submit) + `indexerUrl` (finality) + the profile id. */
  readonly network: NetworkProfile;
  /** The D37 same-origin prover client the real adapter proves the deploy through (server-side). */
  readonly proverClient: ProverClient;
}

/**
 * Construct the owner-gated deploy executor. Side-effect-free at construction (it opens no chain,
 * prover, or key connection). Every method THROWS {@link DeployExecutorNotWiredError} — the adapter
 * performs NO deploy until the real, mnm/MNE-verified Midnight-SDK wiring replaces these bodies
 * (see the module JSDoc). The typed dependencies are accepted now so that swap is body-only.
 */
export function createOwnerGatedDeployExecutor(deps: OwnerGatedDeployExecutorDeps): DeployExecutor {
  // The stub tags its failure with the (public) configured network id for ops context. The
  // signing credential + prover client are retained on `deps` for the real adapter and are
  // deliberately NOT read here — the stub deploys nothing.
  const { network } = deps;
  const notWired = (): never => {
    throw new DeployExecutorNotWiredError(network.id);
  };

  return {
    prove: () => notWired(),
    signAndSubmit: () => notWired(),
    awaitFinality: () => notWired(),
  };
}
