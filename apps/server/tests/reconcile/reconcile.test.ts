/**
 * Deterministic reconcile-job tests (T174, US10) — the three-source compare + drift alarm +
 * watermark-idempotent batched burn, over injected seams and the in-memory store double.
 *
 * Covers SC-037 (zero double-burn under crash-replay), SC-038 (drift detected + alarmed,
 * never auto-corrected), EC-48 (indexer unavailable → skip + reschedule + alert after N),
 * EC-49 (burn fails → error report, watermark unmoved, retry next run), FR-069 (persisted
 * queryable report). The live-SQL counterpart (numeric widths + 23505 backstop) is in
 * pg-reconcile.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createReconcileJob,
  InMemoryReconcileStore,
  type BurnExecutor,
  type LedgerTotals,
  type ReconcileAlarm,
  type ReconcileJob,
  type ReconcileJobDeps,
  type ReconcileStore,
} from "../../src/ledger/reconcile.js";

/** A mutable set of source values a test can hand to the seams. */
interface Sources {
  credits: bigint;
  settlements: bigint;
  onchainDepositTotal: bigint;
  vaultBalance: bigint;
}

interface Harness {
  readonly job: ReconcileJob;
  readonly store: InMemoryReconcileStore;
  readonly burnSpy: ReturnType<typeof vi.fn>;
  readonly alerts: ReconcileAlarm[];
  readonly sources: Sources;
}

/**
 * Build a job whose seams read a mutable {@link Sources} object, with a spy-able burn (default
 * resolving) and a captured alarm log. Tests mutate `sources` between runs to model consumption
 * and burns landing on-chain.
 */
function harness(init: Partial<Sources> = {}, deps: Partial<ReconcileJobDeps> = {}): Harness {
  const sources: Sources = {
    credits: 1_000n,
    settlements: 300n,
    onchainDepositTotal: 1_000n,
    vaultBalance: 1_000n,
    ...init,
  };
  const store = new InMemoryReconcileStore();
  const alerts: ReconcileAlarm[] = [];
  const burnSpy = vi.fn<BurnExecutor>(({ watermark }) =>
    Promise.resolve({ txRef: `tx-${watermark}` }),
  );
  const ledgerTotals = (): Promise<LedgerTotals> =>
    Promise.resolve({ credits: sources.credits, settlements: sources.settlements });
  const job = createReconcileJob({
    ledgerTotals,
    onchainDepositTotal: () => Promise.resolve(sources.onchainDepositTotal),
    vaultBalance: () => Promise.resolve(sources.vaultBalance),
    executeBurn: burnSpy,
    store,
    alert: (a) => alerts.push(a),
    ...deps,
  });
  return { job, store, burnSpy, alerts, sources };
}

describe("createReconcileJob — clean equality + batched burn (D55)", () => {
  it("burns consumed credit since the last watermark, exactly once, and persists the report", async () => {
    const h = harness();
    const result = await h.job.runReconcile("wm-1");

    expect(result.kind).toBe("reconciled");
    if (result.kind !== "reconciled") throw new Error("expected reconciled");
    expect(result.burnAmount).toBe(300n); // settlements 300 − burned high-water 0
    expect(result.burnTx).toBe("tx-wm-1");
    expect(h.burnSpy).toHaveBeenCalledTimes(1);
    expect(h.burnSpy).toHaveBeenCalledWith({ amount: 300n, watermark: "wm-1" });

    // FR-069: the report is persisted + queryable, carrying the three-source snapshot.
    const row = await h.store.getRun("wm-1");
    expect(row?.outcome).toBe("reconciled");
    expect(row?.burnAmount).toBe(300n);
    expect(row?.burnTx).toBe("tx-wm-1");
    expect(row?.snapshot).toEqual({
      ledgerCredits: 1_000n,
      ledgerSettlements: 300n,
      onchainDepositTotal: 1_000n,
      vaultBalance: 1_000n,
    });
    expect(h.alerts).toHaveLength(0);
  });

  it("only burns the DELTA of consumed credit across successive watermarks", async () => {
    const h = harness();
    await h.job.runReconcile("wm-1"); // burns 300
    // 200 more consumed; the earlier burn of 300 landed on-chain (vault 1000 → 700).
    h.sources.settlements = 500n;
    h.sources.vaultBalance = 700n;
    const second = await h.job.runReconcile("wm-2");

    expect(second.kind).toBe("reconciled");
    if (second.kind !== "reconciled") throw new Error("expected reconciled");
    expect(second.burnAmount).toBe(200n); // 500 − 300 high-water
    expect(h.burnSpy).toHaveBeenNthCalledWith(2, { amount: 200n, watermark: "wm-2" });
  });

  it("records equality with no on-chain burn when nothing was consumed since the last watermark", async () => {
    const h = harness();
    await h.job.runReconcile("wm-1"); // burns 300
    h.sources.vaultBalance = 700n; // the burn landed; no new consumption
    const second = await h.job.runReconcile("wm-2");

    expect(second.kind).toBe("reconciled");
    if (second.kind !== "reconciled") throw new Error("expected reconciled");
    expect(second.burnAmount).toBe(0n);
    expect(second.burnTx).toBeNull();
    expect(h.burnSpy).toHaveBeenCalledTimes(1); // no second on-chain burn
    expect((await h.store.getRun("wm-2"))?.outcome).toBe("reconciled");
  });

  it("treats a positive chain-leads-credits gap within the lag tolerance as clean", async () => {
    // A finalized deposit observed on-chain but not yet credited off-chain (deposit lag).
    const h = harness({ onchainDepositTotal: 1_010n, vaultBalance: 1_010n }, { lagTolerance: 50n });
    const result = await h.job.runReconcile("wm-1");
    expect(result.kind).toBe("reconciled");
    expect(h.alerts).toHaveLength(0);
  });
});

describe("createReconcileJob — drift (SC-038, never auto-corrected)", () => {
  it("alarms loudly and does NOT burn when the ledger out-credits the chain", async () => {
    const h = harness({ credits: 1_200n, onchainDepositTotal: 1_000n });
    const result = await h.job.runReconcile("wm-1");

    expect(result.kind).toBe("drift");
    if (result.kind !== "drift") throw new Error("expected drift");
    expect(result.creditsVsChainDrift).toBe(-200n); // onchain 1000 − credits 1200
    expect(h.burnSpy).not.toHaveBeenCalled(); // never auto-corrected

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.reason).toBe("drift");
    expect(h.alerts[0]?.message).toMatch(/DRIFT/);
    const row = await h.store.getRun("wm-1");
    expect(row?.outcome).toBe("drift");
    expect(row?.drift).toBe(-200n);
    expect(row?.burnAmount).toBeNull();
  });

  it("alarms when the vault balance disagrees with mints minus burns", async () => {
    const h = harness({ vaultBalance: 900n }); // expected 1000 (no burns yet)
    const result = await h.job.runReconcile("wm-1");

    expect(result.kind).toBe("drift");
    if (result.kind !== "drift") throw new Error("expected drift");
    expect(result.vaultVsExpectedDrift).toBe(-100n);
    expect(h.burnSpy).not.toHaveBeenCalled();
    expect(h.alerts[0]?.reason).toBe("drift");
  });

  it("detects drift beyond the configured lag tolerance", async () => {
    const h = harness(
      { onchainDepositTotal: 1_200n, vaultBalance: 1_200n },
      { lagTolerance: 50n }, // +200 gap exceeds 50
    );
    const result = await h.job.runReconcile("wm-1");
    expect(result.kind).toBe("drift");
    expect(h.burnSpy).not.toHaveBeenCalled();
  });

  it("does not advance the burned high-water on a drift run (next clean run burns the full delta)", async () => {
    const h = harness({ vaultBalance: 900n }); // drift on wm-1, settlements 300
    await h.job.runReconcile("wm-1");
    expect(h.burnSpy).not.toHaveBeenCalled();

    // The operator fixes the vault; wm-2 is clean. The 300 consumed during the drift period
    // must still be burned (the drift row did not advance the high-water).
    h.sources.vaultBalance = 1_000n;
    const second = await h.job.runReconcile("wm-2");
    expect(second.kind).toBe("reconciled");
    if (second.kind !== "reconciled") throw new Error("expected reconciled");
    expect(second.burnAmount).toBe(300n);
  });
});

describe("createReconcileJob — exactly-once under replay (SC-037)", () => {
  it("re-burns nothing and re-records nothing on a replayed watermark", async () => {
    const h = harness();
    const first = await h.job.runReconcile("wm-1");
    expect(first.kind).toBe("reconciled");

    const replay = await h.job.runReconcile("wm-1");
    expect(replay.kind).toBe("already-done");
    if (replay.kind !== "already-done") throw new Error("expected already-done");
    expect(replay.outcome).toBe("reconciled");
    expect(h.burnSpy).toHaveBeenCalledTimes(1); // NO second burn
    expect(h.store.all()).toHaveLength(1); // NO second row
  });

  it("keeps the burned high-water advancing exactly once per burned batch across replays", async () => {
    const h = harness();
    await h.job.runReconcile("wm-1"); // burn 300
    await h.job.runReconcile("wm-1"); // replay — no-op
    h.sources.settlements = 500n;
    h.sources.vaultBalance = 700n;
    await h.job.runReconcile("wm-2"); // burn 200
    await h.job.runReconcile("wm-2"); // replay — no-op

    expect(h.burnSpy).toHaveBeenCalledTimes(2);
    expect(await h.store.totalBurned()).toBe(500n); // 300 + 200, counted once each
  });
});

describe("createReconcileJob — indexer unavailable (EC-48)", () => {
  it("skips without advancing the watermark and never compares partially", async () => {
    const h = harness({}, { onchainDepositTotal: () => Promise.reject(new Error("indexer down")) });
    const result = await h.job.runReconcile("wm-1");

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toMatch(/indexer down/);
    expect(h.burnSpy).not.toHaveBeenCalled();
    expect(await h.store.getRun("wm-1")).toBeNull(); // nothing recorded
  });

  it("alerts only after N consecutive skips, and resets the streak on a full snapshot", async () => {
    let up = false;
    const h = harness(
      { vaultBalance: 1_000n },
      {
        maxConsecutiveSkips: 3,
        onchainDepositTotal: () =>
          up ? Promise.resolve(1_000n) : Promise.reject(new Error("indexer down")),
      },
    );

    await h.job.runReconcile("wm-1");
    await h.job.runReconcile("wm-2");
    expect(h.alerts).toHaveLength(0); // 2 skips, below threshold
    await h.job.runReconcile("wm-3");
    expect(h.alerts).toHaveLength(1); // 3rd consecutive skip → alarm
    expect(h.alerts[0]?.reason).toBe("consecutive-skips");
    expect(h.alerts[0]?.consecutiveSkips).toBe(3);

    // The indexer recovers; a full snapshot resets the streak.
    up = true;
    await h.job.runReconcile("wm-4");
    up = false;
    await h.job.runReconcile("wm-5"); // 1st skip of a NEW streak — no new alarm
    expect(h.alerts).toHaveLength(1);
  });
});

describe("createReconcileJob — burn failure blocks, never auto-retries (EC-49, C1 fix)", () => {
  it("records an error report and leaves the burned high-water unmoved", async () => {
    const h = harness();
    h.burnSpy.mockRejectedValueOnce(new Error("prover offline"));
    const first = await h.job.runReconcile("wm-1");

    expect(first.kind).toBe("burn-failed");
    if (first.kind !== "burn-failed") throw new Error("expected burn-failed");
    expect(first.attemptedBurn).toBe(300n);
    expect(first.error).toMatch(/prover offline/);
    const errRow = await h.store.getRun("wm-1");
    expect(errRow?.outcome).toBe("error");
    expect(errRow?.burnAmount).toBe(300n); // the ATTEMPTED amount (for ops resolution)
    expect(await h.store.totalBurned()).toBe(0n); // error rows aren't counted → high-water unmoved
  });

  it("BLOCKS every subsequent run (no burn under a fresh watermark) until ops resolves", async () => {
    const h = harness();
    h.burnSpy.mockRejectedValueOnce(new Error("prover offline"));
    await h.job.runReconcile("wm-1"); // burn-failed → error row

    // The critical anti-double-burn behavior: a NEW watermark does NOT retry the burn.
    const blocked = await h.job.runReconcile("wm-2");
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind !== "blocked") throw new Error("expected blocked");
    expect(blocked.unresolvedWatermark).toBe("wm-1");
    expect(h.burnSpy).toHaveBeenCalledTimes(1); // NO second burn
    expect(await h.store.getRun("wm-2")).toBeNull(); // nothing recorded for the blocked run
    expect(h.alerts.some((a) => a.reason === "burn-unresolved")).toBe(true);
  });

  it("resumes after ops CLEARS the error (burn did not land) — retries the full delta", async () => {
    const h = harness();
    h.burnSpy.mockRejectedValueOnce(new Error("prover offline"));
    await h.job.runReconcile("wm-1"); // burn-failed
    // Ops confirmed the burn did NOT land → clear the error row.
    expect(h.store.resolveError("wm-1", "clear")).toBe(true);

    const resumed = await h.job.runReconcile("wm-2");
    expect(resumed.kind).toBe("reconciled");
    if (resumed.kind !== "reconciled") throw new Error("expected reconciled");
    expect(resumed.burnAmount).toBe(300n); // full un-burned delta, not lost, not doubled
    expect(h.burnSpy).toHaveBeenCalledTimes(2);
  });

  it("resumes after ops marks the error RECONCILED (burn had landed) — high-water advanced", async () => {
    const h = harness();
    h.burnSpy.mockRejectedValueOnce(new Error("ambiguous timeout"));
    await h.job.runReconcile("wm-1"); // burn-failed
    // Ops confirmed the burn DID land → mark the error row reconciled (advances the high-water).
    expect(h.store.resolveError("wm-1", "reconciled")).toBe(true);
    // The vault reflects the burn that landed (1000 → 700); no new consumption.
    h.sources.vaultBalance = 700n;

    const resumed = await h.job.runReconcile("wm-2");
    expect(resumed.kind).toBe("reconciled");
    if (resumed.kind !== "reconciled") throw new Error("expected reconciled");
    expect(resumed.burnAmount).toBe(0n); // the landed burn already covered the delta
    expect(h.burnSpy).toHaveBeenCalledTimes(1); // NOT re-burned
  });
});

describe("createReconcileJob — record failure after a landed burn (H1)", () => {
  it("writes a best-effort error row + returns record-failed, then blocks (never re-burns)", async () => {
    const store = new InMemoryReconcileStore();
    // A store whose RECONCILED inserts always fail (a persistent DB fault, past all retries),
    // but whose ERROR-row fallback + reads still work — forcing the record-failed path.
    const flaky: ReconcileStore = {
      getRun: (w) => store.getRun(w),
      lastReconciled: () => store.lastReconciled(),
      totalBurned: () => store.totalBurned(),
      latestUnresolvedError: () => store.latestUnresolvedError(),
      insertRun: (run) =>
        run.outcome === "reconciled"
          ? Promise.reject(new Error("db connection reset"))
          : store.insertRun(run),
    };
    const burnSpy = vi.fn<BurnExecutor>(({ watermark }) =>
      Promise.resolve({ txRef: `tx-${watermark}` }),
    );
    const job = createReconcileJob({
      ledgerTotals: () => Promise.resolve({ credits: 1_000n, settlements: 300n }),
      onchainDepositTotal: () => Promise.resolve(1_000n),
      vaultBalance: () => Promise.resolve(1_000n),
      executeBurn: burnSpy,
      store: flaky,
      alert: vi.fn(),
    });

    const result = await job.runReconcile("wm-1");
    expect(result.kind).toBe("record-failed");
    if (result.kind !== "record-failed") throw new Error("expected record-failed");
    expect(result.burnTx).toBe("tx-wm-1"); // the burn LANDED
    expect(burnSpy).toHaveBeenCalledTimes(1);
    // A best-effort error row was written so the next run BLOCKS (never re-burns).
    expect((await store.getRun("wm-1"))?.outcome).toBe("error");
    const next = await job.runReconcile("wm-2");
    expect(next.kind).toBe("blocked");
    expect(burnSpy).toHaveBeenCalledTimes(1); // still no second burn
  });
});

describe("createReconcileJob — construction guards", () => {
  it("rejects a negative lagTolerance", () => {
    expect(() => harness({}, { lagTolerance: -1n })).toThrow(/lagTolerance/);
  });
});

describe("createReconcileJob — determinism", () => {
  it("produces identical results across repeated runs with the same injected inputs", async () => {
    const a = harness();
    const b = harness();
    const ra = await a.job.runReconcile("wm-x");
    const rb = await b.job.runReconcile("wm-x");
    expect(ra).toEqual(rb);
  });
});
