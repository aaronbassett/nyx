/**
 * Ceremony proving seam (P3 Task 4).
 *
 * Turns an unproven Midnight transaction into a proven one via the SUPPORTED SDK seam
 * `Transaction.prove(provingProvider, CostModel.initialCostModel())` (ledger-v8) — the
 * exact injection point SPIKE-2 executed (§C proof-server, §D in-browser wasm). Both
 * routes share the SAME client-supplied key material (`{proverKey, verifierKey, ir}` per
 * circuit, fetched same-origin from `/vault-artifacts/*`; SRS via `/srs/*`), so switching
 * between them is a one-line `proofProvider` swap (SPIKE-2 fallback decision).
 *
 * This module produces the `{check, prove}` {@link ProvingProviderLike} that
 * `Transaction.prove` accepts. Two factories:
 *
 *  - {@link createWasmCeremonyProver} — PRIMARY (in-browser wasm): wraps the published
 *    `@midnight-ntwrk/zkir-v2@2.1.0` `provingProvider(keyMaterialProvider)`. The real
 *    prove is ~23-26 s at k=13 and MUST run in a Web Worker so it never blocks the UI —
 *    modelled here as an injectable {@link WasmCeremonyProverDeps.runInWorker} seam.
 *  - {@link createProxyCeremonyProver} — FALLBACK (proof server): builds the proof-server
 *    payload with the real ledger-v8 codecs and relays it to the same-origin, session-gated
 *    `/prover/check` + `/prover/prove` proxy (SPIKE-2 §C — the modern protocol POSTs each
 *    circuit's serialized preimage + client key material to `/check` and `/prove`).
 *
 * CONSTITUTION I — every `@midnight-ntwrk/*` shape here is typed from the installed `.d.ts`:
 * `ProvingProviderLike` mirrors ledger-v8's `ProvingProvider` and zkir-v2's `ProvingProvider`
 * (byte-identical shapes); `CircuitKeySource`/`CircuitKeyMaterial` mirror zkir-v2's
 * `KeyMaterialProvider`/`ProvingKeyMaterial`; the payload codecs are ledger-v8 exports
 * (`createCheckPayload`/`createProvingPayload`/`parseCheckResult`) — NO wire shape is
 * hand-written. Every real engine/transport is injectable so unit tests fake them; the
 * live wasm prove is owner/`DEVNET_URL`-gated (Task 5).
 */
import {
  createCheckPayload as ledgerCreateCheckPayload,
  createProvingPayload as ledgerCreateProvingPayload,
  parseCheckResult as ledgerParseCheckResult,
} from "@midnight-ntwrk/ledger-v8";

/**
 * The `{check, prove}` pair `Transaction.prove(provider, costModel)` accepts. Structurally
 * identical to ledger-v8's `ProvingProvider` and zkir-v2's `ProvingProvider` (verified from
 * both installed `.d.ts`) — kept local so this seam owns no `@midnight-ntwrk` value imports
 * beyond the codecs.
 */
export interface ProvingProviderLike {
  check(serializedPreimage: Uint8Array, keyLocation: string): Promise<(bigint | undefined)[]>;
  prove(
    serializedPreimage: Uint8Array,
    keyLocation: string,
    overwriteBindingInput?: bigint,
  ): Promise<Uint8Array>;
}

/**
 * Per-circuit key material — mirrors zkir-v2's `ProvingKeyMaterial` and ledger-v8's
 * `ProvingKeyMaterial` (`createProvingPayload`'s optional argument).
 */
export interface CircuitKeyMaterial {
  readonly proverKey: Uint8Array;
  readonly verifierKey: Uint8Array;
  readonly ir: Uint8Array;
}

/**
 * Resolves `{proverKey, verifierKey, ir}` + SRS params by circuit id — structurally the
 * zkir-v2 `KeyMaterialProvider`, so it can be handed straight to `zkir.provingProvider(...)`.
 * The production impl fetches over `/vault-artifacts/*` (keys/IR) + `/srs/*` (params);
 * `lookupKey` returns `undefined` for an unknown circuit (fail-closed at the payload codec).
 */
export interface CircuitKeySource {
  lookupKey(keyLocation: string): Promise<CircuitKeyMaterial | undefined>;
  getParams(k: number): Promise<Uint8Array>;
}

/** A factory that builds a {@link ProvingProviderLike} bound to one circuit key source. */
export interface CeremonyProverFactory {
  makeProvingProvider(keySource: CircuitKeySource): ProvingProviderLike;
}

/** Which ceremony leg produced a failure (for diagnostics + fallback decisions). */
export type CeremonyRoute = "wasm" | "proxy";
/** Which proving step failed. */
export type CeremonyStage = "check" | "prove";

/**
 * A ceremony proving failure. Deliberately opaque about upstream internals — the message
 * NEVER carries the proof-server response body (constitution III: no internal leak); the
 * `cause` retains the underlying error for logs only.
 */
export class CeremonyProvingError extends Error {
  readonly route: CeremonyRoute;
  readonly stage: CeremonyStage;
  /** The upstream HTTP status, when the failure was a non-2xx proof-server response. */
  readonly status: number | undefined;

  constructor(stage: CeremonyStage, route: CeremonyRoute, cause?: unknown, status?: number) {
    const suffix = status === undefined ? "" : ` (status ${status.toString()})`;
    super(
      `ceremony ${route} ${stage} failed${suffix}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "CeremonyProvingError";
    this.route = route;
    this.stage = stage;
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WASM adapter (primary — in-browser zkir)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal zkir surface this adapter consumes — the published
 * `@midnight-ntwrk/zkir-v2@2.1.0` `provingProvider(keyMaterialProvider)` export (verified
 * from the installed `.d.ts`). Injected so unit tests fake it and the ~23-26 s wasm prove
 * stays owner/`DEVNET_URL`-gated (Task 5).
 */
export interface ZkirModuleLike {
  provingProvider(keyMaterialProvider: CircuitKeySource): ProvingProviderLike;
}

/**
 * Runs a proving task, in production hosting it in a Web Worker so the ~23-26 s k=13 prove
 * never blocks the UI thread. The default is in-process (`(task) => task()`), used by tests
 * and any non-isolated context; the real worker bridge (postMessage round-trip with the key
 * material + SRS transferred worker-side) is owner-gated (Task 5).
 */
export type CeremonyWorkerRunner = <T>(task: () => Promise<T>) => Promise<T>;

/** Dependencies for {@link createWasmCeremonyProver}. */
export interface WasmCeremonyProverDeps {
  /** The zkir engine (real `@midnight-ntwrk/zkir-v2` in prod; a fake in tests). */
  readonly zkir: ZkirModuleLike;
  /** Worker-hosting seam; defaults to in-process (see {@link CeremonyWorkerRunner}). */
  readonly runInWorker?: CeremonyWorkerRunner;
}

const runInProcess: CeremonyWorkerRunner = (task) => task();

/**
 * Build the PRIMARY (in-browser wasm) ceremony prover. `makeProvingProvider(keySource)`
 * hands the key source straight to `zkir.provingProvider(...)` (structurally a zkir
 * `KeyMaterialProvider`), then routes each `check`/`prove` through the worker seam and maps
 * any failure to a {@link CeremonyProvingError} tagged `route: "wasm"`.
 */
export function createWasmCeremonyProver(deps: WasmCeremonyProverDeps): CeremonyProverFactory {
  const runInWorker = deps.runInWorker ?? runInProcess;

  return {
    makeProvingProvider(keySource: CircuitKeySource): ProvingProviderLike {
      // Key-material resolution is wired via the key source (a zkir KeyMaterialProvider);
      // the engine calls its lookupKey/getParams as it proves.
      const engine = deps.zkir.provingProvider(keySource);

      return {
        async check(serializedPreimage, keyLocation) {
          try {
            return await runInWorker(() => engine.check(serializedPreimage, keyLocation));
          } catch (cause) {
            throw new CeremonyProvingError("check", "wasm", cause);
          }
        },
        async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
          try {
            return await runInWorker(() =>
              engine.prove(serializedPreimage, keyLocation, overwriteBindingInput),
            );
          } catch (cause) {
            throw new CeremonyProvingError("prove", "wasm", cause);
          }
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy adapter (fallback — same-origin proof-server relay)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The proof-server payload codecs — ledger-v8 exports (`createCheckPayload`,
 * `createProvingPayload`, `parseCheckResult`; verified from the installed `.d.ts`).
 * Injectable so unit tests fake them (no valid preimage needed); the default is the real
 * ledger-v8 implementation.
 */
export interface ProofServerCodecs {
  createCheckPayload(serializedPreimage: Uint8Array, ir?: Uint8Array): Uint8Array;
  createProvingPayload(
    serializedPreimage: Uint8Array,
    overwriteBindingInput: bigint | undefined,
    keyMaterial?: CircuitKeyMaterial,
  ): Uint8Array;
  parseCheckResult(result: Uint8Array): (bigint | undefined)[];
}

/** The real ledger-v8 proof-server codecs (constitution I — SDK exports, not hand-written). */
const LEDGER_CODECS: ProofServerCodecs = {
  createCheckPayload: ledgerCreateCheckPayload,
  createProvingPayload: ledgerCreateProvingPayload,
  parseCheckResult: ledgerParseCheckResult,
};

/** Dependencies for {@link createProxyCeremonyProver}. */
export interface ProxyCeremonyProverDeps {
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Origin prefix for the `/prover/*` routes; defaults to `""` (same-origin relative).
   * A trailing slash is normalized away.
   */
  readonly baseUrl?: string;
  /** Proof-server payload codecs; defaults to the real ledger-v8 exports. */
  readonly codecs?: ProofServerCodecs;
}

const OCTET_STREAM = "application/octet-stream";

/**
 * Build the FALLBACK (proof-server) ceremony prover. `makeProvingProvider(keySource)`
 * resolves the circuit key material, builds the proof-server payload with the codecs, and
 * relays it to the same-origin session-gated `/prover/check` / `/prover/prove` proxy with
 * `credentials: "include"`. A non-2xx response or a fetch throw becomes a
 * {@link CeremonyProvingError} (`route: "proxy"`) that never echoes the upstream body.
 */
export function createProxyCeremonyProver(
  deps: ProxyCeremonyProverDeps = {},
): CeremonyProverFactory {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = (deps.baseUrl ?? "").replace(/\/+$/, "");
  const codecs = deps.codecs ?? LEDGER_CODECS;

  const relay = async (
    subpath: "check" | "prove",
    payload: Uint8Array,
    stage: CeremonyStage,
  ): Promise<Uint8Array> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/prover/${subpath}`, {
        method: "POST",
        // Same-origin session cookie gates the proxy (constitution III); never a token here.
        credentials: "include",
        headers: { "content-type": OCTET_STREAM },
        // A `Uint8Array` is a valid `BodyInit` (BufferSource); the assertion only bridges
        // the TS 5.7 `Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>` split.
        body: payload as BodyInit,
      });
    } catch (cause) {
      // A transport fault — never carries an upstream body.
      throw new CeremonyProvingError(stage, "proxy", cause);
    }
    if (!response.ok) {
      // Status only — the response body is deliberately not read into the error.
      throw new CeremonyProvingError(stage, "proxy", undefined, response.status);
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  return {
    makeProvingProvider(keySource: CircuitKeySource): ProvingProviderLike {
      return {
        async check(serializedPreimage, keyLocation) {
          const keyMaterial = await keySource.lookupKey(keyLocation);
          const payload = codecs.createCheckPayload(serializedPreimage, keyMaterial?.ir);
          const bytes = await relay("check", payload, "check");
          return codecs.parseCheckResult(bytes);
        },
        async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
          const keyMaterial = await keySource.lookupKey(keyLocation);
          const payload = codecs.createProvingPayload(
            serializedPreimage,
            overwriteBindingInput,
            keyMaterial,
          );
          return relay("prove", payload, "prove");
        },
      };
    },
  };
}
