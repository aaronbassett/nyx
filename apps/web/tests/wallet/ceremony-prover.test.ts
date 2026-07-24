/**
 * Ceremony proving seam tests (P3 Task 4).
 *
 * The seam turns an unproven Midnight tx into a proven one via the SUPPORTED
 * `Transaction.prove(provingProvider, CostModel.initialCostModel())` injection point
 * (SPIKE-2 §D). Two adapters produce the `{check, prove}` `ProvingProviderLike` that
 * `Transaction.prove` accepts:
 *
 *  - PROXY (proof-server fallback): builds the proof-server payload with the real
 *    ledger-v8 codecs (injected as fakes here) and relays it to the same-origin
 *    `/prover/check` + `/prover/prove` routes with `credentials: "include"`; a non-2xx
 *    or fetch throw becomes a {@link CeremonyProvingError} that never leaks the body.
 *  - WASM (in-browser primary): wraps a zkir module's `provingProvider(keySource)` and
 *    routes check/prove through an injectable worker seam, surfacing failures as
 *    {@link CeremonyProvingError}.
 *
 * The real wasm prove (~23-26 s, k=13, browser/owner-gated) is covered by the
 * `DEVNET_URL`-gated ceremony integration test in Task 5; here every dep is faked.
 */
import type { ProvingProvider as LedgerProvingProvider } from "@midnight-ntwrk/ledger-v8";
import { describe, expect, it, vi } from "vitest";
import {
  CeremonyProvingError,
  createProxyCeremonyProver,
  createWasmCeremonyProver,
} from "@/wallet/ceremony-prover";
import type {
  CircuitKeyMaterial,
  CircuitKeySource,
  ProofServerCodecs,
  ProvingProviderLike,
  ZkirModuleLike,
} from "@/wallet/ceremony-prover";

// ── compile-time: our ProvingProviderLike is what Transaction.prove accepts ──
// (assignable TO ledger-v8's ProvingProvider — the seam produces a genuine provider).
const _providerIsLedgerShaped: (p: ProvingProviderLike) => LedgerProvingProvider = (p) => p;
void _providerIsLedgerShaped;

const KEY_MATERIAL: CircuitKeyMaterial = {
  proverKey: new Uint8Array([1, 2, 3]),
  verifierKey: new Uint8Array([4, 5]),
  ir: new Uint8Array([6, 7, 8, 9]),
};

/** A spyable `lookupKey` mock resolving the one circuit's material. */
function fakeLookupKey(): ReturnType<typeof vi.fn<CircuitKeySource["lookupKey"]>> {
  return vi.fn<CircuitKeySource["lookupKey"]>(() =>
    Promise.resolve<CircuitKeyMaterial | undefined>(KEY_MATERIAL),
  );
}

/** A fake key source resolving one circuit's material + SRS params. */
function fakeKeySource(
  lookupKey: CircuitKeySource["lookupKey"] = fakeLookupKey(),
): CircuitKeySource {
  return {
    lookupKey,
    getParams: vi.fn(() => Promise.resolve(new Uint8Array([0xff]))),
  };
}

/** Fake proof-server codecs — deterministic markers, so no real preimage is needed. */
function fakeCodecs(): ProofServerCodecs & {
  createCheckPayload: ReturnType<typeof vi.fn>;
  createProvingPayload: ReturnType<typeof vi.fn>;
  parseCheckResult: ReturnType<typeof vi.fn>;
} {
  return {
    createCheckPayload: vi.fn(() => new Uint8Array([0xc0])),
    createProvingPayload: vi.fn(() => new Uint8Array([0xba])),
    parseCheckResult: vi.fn(() => [1n, undefined, 3n]),
  };
}

function okResponse(bytes: Uint8Array): Response {
  return new Response(bytes as BodyInit, { status: 200 });
}

describe("createProxyCeremonyProver — proof-server fallback relay", () => {
  it("prove relays the built payload to /prover/prove with session credentials", async () => {
    const proofBytes = new Uint8Array([0xde, 0xad]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse(proofBytes));
    const codecs = fakeCodecs();
    const lookupKey = fakeLookupKey();
    const keySource = fakeKeySource(lookupKey);

    const provider = createProxyCeremonyProver({
      fetch: fetchMock,
      baseUrl: "https://nyx.test",
      codecs,
    }).makeProvingProvider(keySource);

    const preimage = new Uint8Array([0x11, 0x22]);
    const result = await provider.prove(preimage, "deposit", 42n);

    // Returned the raw proof-server response bytes.
    expect([...result]).toEqual([0xde, 0xad]);
    // Key material was resolved for the circuit and folded into the proving payload.
    expect(lookupKey).toHaveBeenCalledWith("deposit");
    expect(codecs.createProvingPayload).toHaveBeenCalledWith(preimage, 42n, KEY_MATERIAL);

    // POSTed the built payload to the same-origin /prover/prove with credentials + octet-stream.
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://nyx.test/prover/prove");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/octet-stream",
    );
    expect([...(init?.body as Uint8Array)]).toEqual([0xba]);
  });

  it("check relays to /prover/check and decodes via parseCheckResult", async () => {
    const checkBytes = new Uint8Array([0x2a]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse(checkBytes));
    const codecs = fakeCodecs();
    const keySource = fakeKeySource();

    const provider = createProxyCeremonyProver({
      fetch: fetchMock,
      baseUrl: "https://nyx.test",
      codecs,
    }).makeProvingProvider(keySource);

    const preimage = new Uint8Array([0x01]);
    const inputs = await provider.check(preimage, "deposit");

    expect(inputs).toEqual([1n, undefined, 3n]);
    expect(codecs.createCheckPayload).toHaveBeenCalledWith(preimage, KEY_MATERIAL.ir);
    expect(codecs.parseCheckResult).toHaveBeenCalledWith(checkBytes);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://nyx.test/prover/check");
  });

  it("defaults to a same-origin (relative) base when none is given", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse(new Uint8Array([0])));
    const provider = createProxyCeremonyProver({
      fetch: fetchMock,
      codecs: fakeCodecs(),
    }).makeProvingProvider(fakeKeySource());

    await provider.prove(new Uint8Array([1]), "deposit");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/prover/prove");
  });

  it("throws CeremonyProvingError on a non-2xx WITHOUT leaking the response body", async () => {
    const secret = "SECRET-PROVER-INTERNALS";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(secret, { status: 500 }));

    const provider = createProxyCeremonyProver({
      fetch: fetchMock,
      codecs: fakeCodecs(),
    }).makeProvingProvider(fakeKeySource());

    const error = await provider.prove(new Uint8Array([1]), "deposit").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyProvingError);
    const ceremonyError = error as CeremonyProvingError;
    expect(ceremonyError.name).toBe("CeremonyProvingError");
    expect(ceremonyError.route).toBe("proxy");
    expect(ceremonyError.stage).toBe("prove");
    expect(ceremonyError.status).toBe(500);
    // The upstream response body is NEVER echoed into the error message.
    expect(ceremonyError.message).not.toContain(secret);
  });

  it("throws CeremonyProvingError when fetch itself throws", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = createProxyCeremonyProver({
      fetch: fetchMock,
      codecs: fakeCodecs(),
    }).makeProvingProvider(fakeKeySource());

    await expect(provider.check(new Uint8Array([1]), "deposit")).rejects.toBeInstanceOf(
      CeremonyProvingError,
    );
  });
});

/** A fake zkir module whose provingProvider resolves key material through the km (round-trip). */
function fakeZkir(behavior?: {
  proveResult?: Uint8Array;
  proveReject?: Error;
  checkResult?: (bigint | undefined)[];
}): ZkirModuleLike & { seenKeySource: CircuitKeySource[] } {
  const seenKeySource: CircuitKeySource[] = [];
  return {
    seenKeySource,
    provingProvider(km: CircuitKeySource): ProvingProviderLike {
      seenKeySource.push(km);
      return {
        async check(_preimage, keyLocation) {
          // Model the wasm engine resolving key material from the km.
          await km.lookupKey(keyLocation);
          if (behavior?.checkResult !== undefined) {
            return behavior.checkResult;
          }
          return [7n];
        },
        async prove(_preimage, keyLocation) {
          await km.lookupKey(keyLocation);
          if (behavior?.proveReject !== undefined) {
            throw behavior.proveReject;
          }
          return behavior?.proveResult ?? new Uint8Array([0x99]);
        },
      };
    },
  };
}

describe("createWasmCeremonyProver — in-browser zkir adapter", () => {
  it("builds the provider from the injected zkir module over the key source", async () => {
    const zkir = fakeZkir({ proveResult: new Uint8Array([0xab]) });
    const lookupKey = fakeLookupKey();
    const keySource = fakeKeySource(lookupKey);
    const provider = createWasmCeremonyProver({ zkir }).makeProvingProvider(keySource);

    const proof = await provider.prove(new Uint8Array([1]), "deposit");

    // The key source was handed to zkir.provingProvider (key-material resolution wiring)…
    expect(zkir.seenKeySource[0]).toBe(keySource);
    // …and the engine resolved material through it during proving.
    expect(lookupKey).toHaveBeenCalledWith("deposit");
    expect([...proof]).toEqual([0xab]);
  });

  it("routes check/prove through the injectable worker seam (worker round-trip)", async () => {
    const zkir = fakeZkir();
    let workerCalls = 0;
    const runInWorker = <T>(task: () => Promise<T>): Promise<T> => {
      workerCalls += 1;
      return task();
    };
    const provider = createWasmCeremonyProver({ zkir, runInWorker }).makeProvingProvider(
      fakeKeySource(),
    );

    await provider.check(new Uint8Array([1]), "deposit");
    await provider.prove(new Uint8Array([2]), "deposit");

    expect(workerCalls).toBe(2);
  });

  it("surfaces an engine failure as a CeremonyProvingError (route wasm)", async () => {
    const zkir = fakeZkir({ proveReject: new Error("proof machinery blew up") });
    const provider = createWasmCeremonyProver({ zkir }).makeProvingProvider(fakeKeySource());

    const error = await provider.prove(new Uint8Array([1]), "deposit").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CeremonyProvingError);
    const ceremonyError = error as CeremonyProvingError;
    expect(ceremonyError.name).toBe("CeremonyProvingError");
    expect(ceremonyError.route).toBe("wasm");
    expect(ceremonyError.stage).toBe("prove");
  });
});
