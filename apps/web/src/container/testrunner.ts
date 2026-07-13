/**
 * Behavioural verify test-runner for the WebContainer preview host (US4).
 *
 * Runs ONE behavioural verify cycle in-container and emits the turn's
 * `test:results` verdict over the {@link PreviewBridge} (FR-028, FR-020). The
 * single runner is `npx vitest run --reporter=json` — the OZ Compact simulator
 * runs UNDER Vitest, so there is no separate simulator CLI. The module is pure
 * orchestration over the {@link WebContainerHandle} and {@link PreviewBridge}
 * seams — no DOM, no socket, no `@webcontainer/api` import — so it unit-tests
 * against in-memory fakes with no browser and no real timers.
 *
 * The process output stream is read EXACTLY ONCE, by {@link streamProcessConsole},
 * which relays every chunk as `console:log`/`console:error`. Runtime feedback
 * therefore travels ONLY via the process streams (FR-020, R6) — never a socket
 * from inside the container. The STRUCTURED verdict is read from the JSON report
 * FILE (`resultsPath`), not scraped from stdout.
 *
 * Three invariants shape the control flow:
 *  - The 120s budget (D42, FR-030) is enforced by racing `proc.exit` against an
 *    injected timer. On timeout the process is killed and a FAILING verdict with
 *    a timeout diagnostic is emitted. The run is NEVER retried. The post-exit
 *    (and post-kill) console drain is itself bounded by a short grace (see
 *    {@link drainWithGrace}), so a wedged `output` stream that resolves `exit`
 *    but never CLOSES cannot strand the verdict past the budget + grace.
 *  - Every turn gets a verdict. A spawn failure, an unreadable report, or an
 *    invalid-JSON report all yield a FAILING `runner-error` verdict rather than a
 *    throw — `runTestCycle` never rejects, never hangs, and never strands a turn.
 *  - Every nondeterministic input (`now`, the timer) is injectable, so `ts`,
 *    `elapsedMs`, and the emitted payload are fully deterministic under test
 *    (SC-014). `parseVitestJson` is a PURE, exported function.
 */
import { streamProcessConsole } from "./streams";
import type { ConsoleClassification } from "./streams";
import type { PreviewBridge, WebContainerHandle, WebContainerProcessHandle } from "./types";
import type { TestFailure, TestResultsPayload, TurnId } from "@nyx/protocol";

/** In-container path Vitest writes its JSON report to (excluded from VFS sync). */
const DEFAULT_RESULTS_PATH = "/.nyx/test-results.json";
/** The command that runs the in-container verify cycle. */
const DEFAULT_COMMAND = "npx";
/** The behavioural verify budget in ms (D42, FR-030). */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Grace budget in ms bounding the post-exit / post-kill console drain. A healthy
 * `output` stream closes within milliseconds, so a few seconds is ample headroom;
 * the bound exists ONLY so a wedged stream that resolves `exit` but never closes
 * cannot strand the verdict forever (see {@link drainWithGrace}).
 */
const DEFAULT_DRAIN_GRACE_MS = 5_000;

/** `name` of the synthetic failure emitted when the budget is exceeded. */
const TIMEOUT_FAILURE_NAME = "verify:timeout";
/** `name` of the synthetic failure emitted when the runner itself fails. */
const RUNNER_ERROR_FAILURE_NAME = "verify:runner-error";

/** Sentinel exit code for a `proc.exit` that rejected (the seam contracts resolve-only). */
const EXIT_REJECTED = -1;

/** Cancels a pending timer; returned by {@link TestCycleOptions.setTimer}. */
type CancelTimer = () => void;

/** How the `exit`-vs-timeout race resolved. */
type RaceOutcome = { readonly kind: "exit"; readonly code: number } | { readonly kind: "timeout" };

/** The default `vitest run` args for a given results path. */
function defaultVitestArgs(resultsPath: string): readonly string[] {
  return ["vitest", "run", "--reporter=json", `--outputFile=${resultsPath}`];
}

/** Wraps `setTimeout`/`clearTimeout` as the injectable timer seam's default. */
function defaultSetTimer(fn: () => void, ms: number): CancelTimer {
  const id = setTimeout(fn, ms);
  return () => {
    clearTimeout(id);
  };
}

/** How a verify cycle concluded, for the caller's telemetry and branching. */
export type TestCycleOutcome = "passed" | "failed" | "timed-out" | "runner-error";

/** The structured result parsed from a Vitest JSON report. */
export interface ParsedTestResults {
  /** `true` iff the report declares success. */
  readonly pass: boolean;
  /** Every failed assertion, in encounter order. */
  readonly failures: TestFailure[];
}

/** Tunables for {@link runTestCycle}; every nondeterministic input is injectable. */
export interface TestCycleOptions {
  /** Turn this verify cycle belongs to; stamped onto the emitted `test:results`. */
  readonly turnId: TurnId;
  /** In-container path Vitest writes its JSON report to. Defaults to `/.nyx/test-results.json`. */
  readonly resultsPath?: string;
  /** Command to spawn. Defaults to `"npx"`. */
  readonly command?: string;
  /**
   * Args to spawn with. Defaults to the JSON reporter targeting `resultsPath`;
   * a caller that overrides this owns the `--outputFile` wiring.
   */
  readonly args?: readonly string[];
  /** Budget in ms before the run is killed (D42, FR-030). Defaults to `120_000`. */
  readonly timeoutMs?: number;
  /**
   * Grace budget in ms bounding the post-exit (and post-kill) console drain. The
   * verdict must never hang on a wedged `output` stream that resolves `exit` but
   * never closes, so the drain is capped here and then proceeds best-effort. A
   * healthy stream closes in ms. Driven by the {@link TestCycleOptions.setTimer}
   * seam, so tests advance it with no real timer. Defaults to `5_000`.
   */
  readonly drainGraceMs?: number;
  /** Clock for `ts`/`elapsedMs`. Defaults to {@link Date.now}. */
  readonly now?: () => number;
  /** Timer seam for the timeout race; returns a canceller. Defaults to `setTimeout`. */
  readonly setTimer?: (fn: () => void, ms: number) => CancelTimer;
  /** Console classifier forwarded to {@link streamProcessConsole}. Defaults to log-only. */
  readonly classify?: (chunk: string) => ConsoleClassification;
}

/** The outcome of a verify cycle, with the emitted payload and round-trip timing. */
export interface TestCycleResult {
  /** Discriminant describing how the cycle ended. */
  readonly outcome: TestCycleOutcome;
  /** The `test:results` payload emitted up the bridge. */
  readonly results: TestResultsPayload;
  /** Wall-clock ms from spawn to emit, from the injected clock (SC-013). */
  readonly elapsedMs: number;
}

/** The synthetic failure carrying timeout diagnostics (D42, FR-030). */
function timeoutFailure(timeoutMs: number): TestFailure {
  return {
    name: TIMEOUT_FAILURE_NAME,
    message: `Test run exceeded ${String(timeoutMs)}ms and was killed (D42)`,
  };
}

/** The synthetic failure carrying runner-error diagnostics (missing/invalid report, spawn failure). */
function runnerErrorFailure(detail: string): TestFailure {
  return { name: RUNNER_ERROR_FAILURE_NAME, message: detail };
}

/** Extracts a human-readable message from an unknown thrown value (mirrors boot.ts). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Awaits the console drain, but NO longer than `graceMs`, via the injected
 * `setTimer` seam (so tests advance it with no real clock). A healthy `output`
 * stream closes in ms; a wedged stream that resolves `exit` but never CLOSES
 * would otherwise strand the verdict forever, so once the grace elapses this
 * resolves best-effort and the caller proceeds to emit its verdict. NEVER
 * rejects (`drained` already swallows its own errors) and NEVER hangs. Used on
 * BOTH terminal paths so buffered console flushes first and `test:results` stays
 * the last event a cycle sends.
 */
async function drainWithGrace(
  drained: Promise<void>,
  setTimer: (fn: () => void, ms: number) => CancelTimer,
  graceMs: number,
): Promise<void> {
  let cancelGrace: CancelTimer | undefined;
  const grace = new Promise<void>((resolve) => {
    cancelGrace = setTimer(() => {
      resolve();
    }, graceMs);
  });
  await Promise.race([drained, grace]);
  cancelGrace?.();
}

/**
 * Runs ONE behavioural verify cycle: spawn `vitest run --reporter=json`, relay
 * its console output over `bridge`, enforce the 120s budget, then emit a
 * `test:results` verdict read from the JSON report file. Resolves with the
 * verdict, the outcome discriminant, and the spawn→emit `elapsedMs`. NEVER
 * rejects — a spawn/report failure becomes a `runner-error` verdict, and a
 * timeout becomes a `timed-out` verdict, so a turn always gets a verdict.
 */
export async function runTestCycle(
  handle: WebContainerHandle,
  bridge: PreviewBridge,
  opts: TestCycleOptions,
): Promise<TestCycleResult> {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const drainGraceMs = opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
  const resultsPath = opts.resultsPath ?? DEFAULT_RESULTS_PATH;
  const command = opts.command ?? DEFAULT_COMMAND;
  const args = opts.args ?? defaultVitestArgs(resultsPath);

  const startedAt = now();

  // Builds the payload, emits `test:results`, and captures the round-trip time.
  const finish = (
    outcome: TestCycleOutcome,
    pass: boolean,
    failures: TestFailure[],
  ): TestCycleResult => {
    const emittedAt = now();
    const results: TestResultsPayload = { turnId: opts.turnId, pass, failures };
    bridge.send({ type: "test:results", payload: results, ts: emittedAt });
    return { outcome, results, elapsedMs: emittedAt - startedAt };
  };

  // 1. Spawn the verify run. A spawn failure is a runner error, never a throw.
  let proc: WebContainerProcessHandle;
  try {
    proc = await handle.spawn(command, args);
  } catch (error) {
    return finish("runner-error", false, [
      runnerErrorFailure(`could not spawn ${command}: ${messageOf(error)}`),
    ]);
  }

  // 2. Relay console output for the whole run — the SINGLE read of the stream.
  //    Fire-and-forget so the timeout path is never blocked on the drain; a
  //    drain error is swallowed (console relay must not fail the verdict).
  const drained = streamProcessConsole(proc, bridge, {
    now,
    ...(opts.classify ? { classify: opts.classify } : {}),
  }).catch(() => undefined);

  // 3. Race the process exit against the 120s budget (D42, FR-030).
  let cancelTimer: CancelTimer | undefined;
  const timeoutPromise = new Promise<RaceOutcome>((resolve) => {
    cancelTimer = setTimer(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const exitPromise = proc.exit.then(
    (code): RaceOutcome => ({ kind: "exit", code }),
    (): RaceOutcome => ({ kind: "exit", code: EXIT_REJECTED }),
  );
  const raced = await Promise.race([exitPromise, timeoutPromise]);
  cancelTimer?.();

  // 4. Timeout: kill the run, then flush any buffered console within the drain
  //    grace so `test:results` stays the terminal event even when the killed
  //    process' stream lags. Emit a failing verdict and NEVER retry (FR-030).
  if (raced.kind === "timeout") {
    proc.kill();
    await drainWithGrace(drained, setTimer, drainGraceMs);
    return finish("timed-out", false, [timeoutFailure(timeoutMs)]);
  }

  // 5. Normal exit: flush the console relay — bounded by the drain grace so a
  //    wedged stream that never closes can't strand the verdict — then read the
  //    report.
  await drainWithGrace(drained, setTimer, drainGraceMs);

  let raw: string;
  try {
    raw = await handle.fs.readFile(resultsPath, "utf-8");
  } catch (error) {
    return finish("runner-error", false, [
      runnerErrorFailure(`could not read results at ${resultsPath}: ${messageOf(error)}`),
    ]);
  }

  let parsed: ParsedTestResults;
  try {
    parsed = parseVitestJson(raw);
  } catch (error) {
    return finish("runner-error", false, [
      runnerErrorFailure(`could not parse results at ${resultsPath}: ${messageOf(error)}`),
    ]);
  }

  return finish(parsed.pass ? "passed" : "failed", parsed.pass, parsed.failures);
}

/**
 * PURE. Maps a raw Vitest 4.1.10 JSON report to `{ pass, failures }`.
 *
 * `pass = report.success === true`. `failures` flattens every `assertionResults`
 * entry whose `status === "failed"` into `{ name: fullName, message:
 * failureMessages.join("\n") }`, in encounter order. Defensive throughout:
 * missing arrays coerce to `[]`, missing strings to `""` — a structurally
 * malformed (but valid-JSON) report yields a verdict rather than throwing. Only
 * truly unparseable input throws (via `JSON.parse`), which the caller treats as
 * a runner error.
 */
export function parseVitestJson(raw: string): ParsedTestResults {
  const parsed: unknown = JSON.parse(raw);
  const report = asRecord(parsed);
  return {
    pass: report?.success === true,
    failures: collectFailures(report?.testResults),
  };
}

/** Flattens the failed assertions across every file result, in encounter order. */
function collectFailures(testResults: unknown): TestFailure[] {
  const failures: TestFailure[] = [];
  const files = Array.isArray(testResults) ? testResults : [];
  for (const file of files) {
    const fileRecord = asRecord(file);
    if (fileRecord === undefined) continue;
    const rawAssertions = fileRecord.assertionResults;
    const assertions = Array.isArray(rawAssertions) ? rawAssertions : [];
    for (const assertion of assertions) {
      const record = asRecord(assertion);
      if (record?.status !== "failed") continue;
      failures.push({ name: fullNameOf(record), message: messagesOf(record) });
    }
  }
  return failures;
}

/** The assertion's `fullName` if present, else `""`. */
function fullNameOf(assertion: Record<string, unknown>): string {
  const value = assertion.fullName;
  return typeof value === "string" ? value : "";
}

/** The assertion's `failureMessages` joined with newlines, else `""`. */
function messagesOf(assertion: Record<string, unknown>): string {
  const value = assertion.failureMessages;
  if (!Array.isArray(value)) return "";
  return value.filter((message): message is string => typeof message === "string").join("\n");
}

/** Narrows an unknown value to a plain record, or `undefined` if it is not object-like. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
