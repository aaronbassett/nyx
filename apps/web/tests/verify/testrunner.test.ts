/**
 * US4 — behavioural verify test-runner tests (WebContainer preview host).
 *
 * `runTestCycle` runs ONE behavioural verify cycle in-container (a single
 * `npx vitest run --reporter=json` invocation — the OZ Compact simulator runs
 * UNDER Vitest, so this one command is the runner) and emits the turn's
 * `test:results` verdict up the {@link PreviewBridge} (FR-028, FR-020). Console
 * feedback travels ONLY via the process output stream (FR-020, R6); the
 * STRUCTURED verdict is read from the JSON report FILE, never parsed from stdout.
 *
 * These tests drive the runner against an in-memory FAKE `WebContainerHandle`
 * (`spawn` returns a seeded process; `fs.readFile` returns a seeded JSON report
 * or rejects) and a recording `PreviewBridge` — no real `@webcontainer/api`, no
 * cross-origin-isolated browser, no real timers. Every nondeterministic input
 * (`now`, the timeout timer) is injected, so `ts`/`elapsedMs` are stable and the
 * 120s budget (D42, FR-030) is exercised without waiting.
 *
 * Coverage: green run, red run (failure order preserved), the 120s timeout
 * (kill + failing verdict, NO retry), runner-error (non-zero exit + missing or
 * invalid JSON), console relay ordering, `elapsedMs` measurement, the pure
 * `parseVitestJson` over the exact Vitest 4.1.10 reporter shape, and a
 * determinism harness (SC-014) over 100 consecutive runs.
 */
import { describe, expect, it, vi } from "vitest";

import { parseVitestJson, runTestCycle } from "@/container/testrunner";
import type {
  PreviewBridge,
  Unsubscribe,
  WebContainerFsHandle,
  WebContainerHandle,
  WebContainerProcessHandle,
} from "@/container/types";
import type { ClientToServerEvent, TestResultsPayload } from "@nyx/protocol";
import { TurnIdSchema } from "@nyx/protocol";

const TURN = TurnIdSchema.parse("turn-verify-1");

// ---------------------------------------------------------------------------
// Vitest 4.1.10 JSON reporter fixtures (the exact ground-truth shape).
// ---------------------------------------------------------------------------

const GREEN_REPORT = JSON.stringify({
  success: true,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  startTime: 0,
  testResults: [
    {
      name: "/project/tests/counter.test.ts",
      status: "passed",
      startTime: 0,
      endTime: 5,
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["counter"],
          fullName: "counter increments",
          title: "increments",
          status: "passed",
          duration: 1,
          failureMessages: [],
          meta: {},
        },
        {
          ancestorTitles: ["counter"],
          fullName: "counter resets",
          title: "resets",
          status: "passed",
          duration: 1,
          failureMessages: [],
          meta: {},
        },
      ],
    },
  ],
});

const RED_REPORT = JSON.stringify({
  success: false,
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 2,
  numPendingTests: 0,
  numTodoTests: 0,
  startTime: 0,
  testResults: [
    {
      name: "/project/tests/a.test.ts",
      status: "failed",
      startTime: 0,
      endTime: 9,
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["suite"],
          fullName: "suite first fails",
          title: "first fails",
          status: "failed",
          duration: 2,
          failureMessages: ["expected 1 to be 2", "AssertionError: at line 3"],
          meta: {},
        },
        {
          ancestorTitles: ["suite"],
          fullName: "suite passes",
          title: "passes",
          status: "passed",
          duration: 1,
          failureMessages: [],
          meta: {},
        },
      ],
    },
    {
      name: "/project/tests/b.test.ts",
      status: "failed",
      startTime: 0,
      endTime: 4,
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["other"],
          fullName: "other second fails",
          title: "second fails",
          status: "failed",
          duration: 1,
          failureMessages: [],
          meta: {},
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// In-memory fakes.
// ---------------------------------------------------------------------------

/** A `ReadableStream<string>` that emits the given chunks then closes. */
function streamFromChunks(chunks: readonly string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * A `ReadableStream<string>` that delivers each chunk one MACROTASK apart, then
 * closes — modelling process output that lands asynchronously (as the real
 * `@webcontainer/api` stream does), so a chunk can still be in flight when the
 * run is killed. Macrotask delivery is deterministic in ORDER: every chunk lands
 * strictly AFTER all pending microtasks, so a fire-and-forget drain provably has
 * not relayed yet when the synchronous timeout branch reaches its verdict.
 */
function macrotaskStreamFromChunks(chunks: readonly string[]): ReadableStream<string> {
  let index = 0;
  return new ReadableStream<string>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const chunk = chunks[index];
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(chunk);
            index += 1;
          }
          resolve();
        }, 0);
      });
    },
  });
}

/** A fake spawned process with seeded output, a chosen `exit`, and a `kill` spy. */
function makeProcess(opts: {
  readonly chunks?: readonly string[];
  readonly exit: Promise<number>;
  readonly kill?: () => void;
}): WebContainerProcessHandle {
  return {
    output: streamFromChunks(opts.chunks ?? []),
    exit: opts.exit,
    kill: opts.kill ?? ((): void => undefined),
  };
}

interface HandleHarness {
  readonly handle: WebContainerHandle;
  /** Every `spawn` call, in order. */
  readonly spawnCalls: { command: string; args: readonly string[] }[];
  /** Every path passed to `fs.readFile`, in order. */
  readonly readFileCalls: string[];
}

/**
 * Builds a fake {@link WebContainerHandle}: `spawn` always returns `opts.process`
 * and records the call; `fs.readFile` records the path and defers to
 * `opts.readFile` (which may reject or return garbage to exercise the
 * runner-error path). The `on*` listeners are inert — the runner never wires them.
 */
function makeHandle(opts: {
  readonly process: WebContainerProcessHandle;
  readonly readFile: (path: string) => Promise<string>;
}): HandleHarness {
  const spawnCalls: { command: string; args: readonly string[] }[] = [];
  const readFileCalls: string[] = [];

  const readFile = (path: string): Promise<string> => {
    readFileCalls.push(path);
    return opts.readFile(path);
  };

  const fs: WebContainerFsHandle = {
    writeFile: vi.fn((): Promise<void> => Promise.resolve()),
    rm: vi.fn((): Promise<void> => Promise.resolve()),
    readFile,
    mkdir: vi.fn((): Promise<string> => Promise.resolve("")),
  };

  const handle: WebContainerHandle = {
    mount: vi.fn((): Promise<void> => Promise.resolve()),
    spawn: vi.fn((command: string, args: readonly string[]): Promise<WebContainerProcessHandle> => {
      spawnCalls.push({ command, args });
      return Promise.resolve(opts.process);
    }),
    fs,
    onServerReady: vi.fn((): Unsubscribe => vi.fn()),
    onError: vi.fn((): Unsubscribe => vi.fn()),
    teardown: vi.fn(),
  };

  return { handle, spawnCalls, readFileCalls };
}

/** A recording {@link PreviewBridge}. */
function makeBridge(): { bridge: PreviewBridge; sent: ClientToServerEvent[] } {
  const sent: ClientToServerEvent[] = [];
  const bridge: PreviewBridge = {
    send: (event) => {
      sent.push(event);
    },
    on: vi.fn(() => vi.fn()),
  };
  return { bridge, sent };
}

type TestResultsEvent = Extract<ClientToServerEvent, { type: "test:results" }>;
type ConsoleLogEvent = Extract<ClientToServerEvent, { type: "console:log" }>;

/** Pulls the ordered `test:results` events out of what the bridge recorded. */
function testResultsEvents(sent: readonly ClientToServerEvent[]): TestResultsEvent[] {
  return sent.filter((e): e is TestResultsEvent => e.type === "test:results");
}

/** A clock whose FIRST reading is `first` and every later reading is `rest`. */
function twoPhaseClock(first: number, rest: number): () => number {
  let firstRead = true;
  return () => {
    if (firstRead) {
      firstRead = false;
      return first;
    }
    return rest;
  };
}

/** A timer seam that NEVER fires — the process `exit` always wins the race. */
const neverFires = (): Unsubscribe => (): void => undefined;

/**
 * A timer seam that fires ONLY timers scheduled for exactly `target` ms
 * (synchronously, at registration) and leaves every other timer pending. The
 * 120s budget and the short drain grace share the one injected `setTimer`, so a
 * test uses this to trip one without tripping the other.
 */
function fireTimersOfDuration(target: number): (fn: () => void, ms: number) => Unsubscribe {
  return (fn, ms) => {
    if (ms === target) fn();
    return (): void => undefined;
  };
}

// ---------------------------------------------------------------------------
// runTestCycle
// ---------------------------------------------------------------------------

describe("runTestCycle", () => {
  it("spawns the JSON-reporter vitest run with the default results path", async () => {
    const { handle, spawnCalls } = makeHandle({
      process: makeProcess({ exit: Promise.resolve(0) }),
      readFile: () => Promise.resolve(GREEN_REPORT),
    });
    const { bridge } = makeBridge();

    await runTestCycle(handle, bridge, { turnId: TURN, now: () => 1000, setTimer: neverFires });

    expect(spawnCalls).toEqual([
      {
        command: "npx",
        args: ["vitest", "run", "--reporter=json", "--outputFile=/.nyx/test-results.json"],
      },
    ]);
  });

  it("emits a passing test:results for an all-green report", async () => {
    const { handle } = makeHandle({
      process: makeProcess({ exit: Promise.resolve(0) }),
      readFile: () => Promise.resolve(GREEN_REPORT),
    });
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      setTimer: neverFires,
    });

    expect(testResultsEvents(sent)).toEqual([
      { type: "test:results", payload: { turnId: TURN, pass: true, failures: [] }, ts: 1000 },
    ]);
    expect(result.outcome).toBe("passed");
    expect(result.results).toEqual({ turnId: TURN, pass: true, failures: [] });
  });

  it("emits a failing test:results and preserves failure order for a red report", async () => {
    const { handle } = makeHandle({
      process: makeProcess({ exit: Promise.resolve(1) }),
      readFile: () => Promise.resolve(RED_REPORT),
    });
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      setTimer: neverFires,
    });

    const events = testResultsEvents(sent);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      turnId: TURN,
      pass: false,
      failures: [
        { name: "suite first fails", message: "expected 1 to be 2\nAssertionError: at line 3" },
        { name: "other second fails", message: "" },
      ],
    });
    expect(result.outcome).toBe("failed");
  });

  it("kills the run and emits a timeout verdict at the 120s budget, never retrying (D42)", async () => {
    const kill = vi.fn();
    const { handle, spawnCalls, readFileCalls } = makeHandle({
      // exit never resolves — only the injected timer can end the race.
      process: makeProcess({ exit: new Promise<number>(() => undefined), kill }),
      readFile: () => Promise.resolve(GREEN_REPORT),
    });
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      // fire the timeout synchronously so no real timer is needed.
      setTimer: (fn) => {
        fn();
        return (): void => undefined;
      },
    });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("timed-out");
    expect(testResultsEvents(sent)).toEqual([
      {
        type: "test:results",
        payload: {
          turnId: TURN,
          pass: false,
          failures: [
            { name: "verify:timeout", message: "Test run exceeded 120000ms and was killed (D42)" },
          ],
        },
        ts: 1000,
      },
    ]);
    // No results were read, and the run was spawned exactly once (no retry).
    expect(readFileCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });

  it("honours a caller-supplied timeoutMs in the timeout diagnostic", async () => {
    const { handle } = makeHandle({
      process: makeProcess({ exit: new Promise<number>(() => undefined) }),
      readFile: () => Promise.resolve(GREEN_REPORT),
    });
    const { bridge, sent } = makeBridge();

    await runTestCycle(handle, bridge, {
      turnId: TURN,
      timeoutMs: 5000,
      now: () => 1000,
      setTimer: (fn) => {
        fn();
        return (): void => undefined;
      },
    });

    expect(testResultsEvents(sent)[0]?.payload.failures).toEqual([
      { name: "verify:timeout", message: "Test run exceeded 5000ms and was killed (D42)" },
    ]);
  });

  it("emits a runner-error verdict when the results file is unreadable (never throws)", async () => {
    const { handle } = makeHandle({
      process: makeProcess({ exit: Promise.resolve(1) }),
      readFile: () => Promise.reject(new Error("ENOENT: no such file")),
    });
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      setTimer: neverFires,
    });

    expect(result.outcome).toBe("runner-error");
    const payload = testResultsEvents(sent)[0]?.payload;
    expect(payload?.pass).toBe(false);
    expect(payload?.failures).toHaveLength(1);
    expect(payload?.failures[0]?.name).toBe("verify:runner-error");
    expect(payload?.failures[0]?.message).toContain("ENOENT");
  });

  it("emits a runner-error verdict when the results file is not valid JSON", async () => {
    const { handle } = makeHandle({
      process: makeProcess({ exit: Promise.resolve(1) }),
      readFile: () => Promise.resolve("not json {"),
    });
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      setTimer: neverFires,
    });

    expect(result.outcome).toBe("runner-error");
    expect(testResultsEvents(sent)[0]?.payload.failures[0]?.name).toBe("verify:runner-error");
  });

  it("emits a runner-error verdict when the run cannot even be spawned", async () => {
    const spawn = vi.fn((): Promise<WebContainerProcessHandle> =>
      Promise.reject(new Error("spawn EPERM")),
    );
    const fs: WebContainerFsHandle = {
      writeFile: vi.fn((): Promise<void> => Promise.resolve()),
      rm: vi.fn((): Promise<void> => Promise.resolve()),
      readFile: vi.fn((): Promise<string> => Promise.resolve(GREEN_REPORT)),
      mkdir: vi.fn((): Promise<string> => Promise.resolve("")),
    };
    const handle: WebContainerHandle = {
      mount: vi.fn((): Promise<void> => Promise.resolve()),
      spawn,
      fs,
      onServerReady: vi.fn((): Unsubscribe => vi.fn()),
      onError: vi.fn((): Unsubscribe => vi.fn()),
      teardown: vi.fn(),
    };
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      setTimer: neverFires,
    });

    expect(result.outcome).toBe("runner-error");
    expect(testResultsEvents(sent)[0]?.payload.failures[0]?.name).toBe("verify:runner-error");
  });

  it("relays process output as console:log before the test:results verdict", async () => {
    const { handle } = makeHandle({
      process: makeProcess({
        chunks: ["vitest running\n", "2 passed\n"],
        exit: Promise.resolve(0),
      }),
      readFile: () => Promise.resolve(GREEN_REPORT),
    });
    const { bridge, sent } = makeBridge();

    await runTestCycle(handle, bridge, { turnId: TURN, now: () => 1000, setTimer: neverFires });

    const logs = sent.filter((e): e is ConsoleLogEvent => e.type === "console:log");
    expect(logs.map((e) => e.payload.message)).toEqual(["vitest running\n", "2 passed\n"]);
    // The console relay drains fully before the verdict is emitted last.
    expect(sent.at(-1)?.type).toBe("test:results");
  });

  it("measures elapsedMs from spawn to emit off the injected clock", async () => {
    const { handle } = makeHandle({
      process: makeProcess({ chunks: ["a\n"], exit: Promise.resolve(0) }),
      readFile: () => Promise.resolve(GREEN_REPORT),
    });
    const { bridge, sent } = makeBridge();

    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: twoPhaseClock(100, 175),
      setTimer: neverFires,
    });

    expect(result.elapsedMs).toBe(75);
    expect(testResultsEvents(sent)[0]?.ts).toBe(175);
  });

  it("resolves with a verdict when exit wins but the output stream never closes (never hangs, HIGH-1)", async () => {
    // A wedged/zombie stream: `exit` resolves, but `output` NEVER closes, so the
    // post-exit console drain would hang forever without the grace bound.
    const wedgedOutput = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("still streaming\n");
        // Deliberately no controller.close() — models the never-closing stream.
      },
    });
    const process: WebContainerProcessHandle = {
      output: wedgedOutput,
      exit: Promise.resolve(0),
      kill: (): void => undefined,
    };
    const { handle } = makeHandle({ process, readFile: () => Promise.resolve(GREEN_REPORT) });
    const { bridge, sent } = makeBridge();

    // Fire ONLY the short drain grace (3_000), never the 120s budget, so `exit`
    // wins the race (normal path) and then the grace unblocks the wedged drain.
    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      drainGraceMs: 3_000,
      setTimer: fireTimersOfDuration(3_000),
    });

    expect(result.outcome).toBe("passed");
    expect(testResultsEvents(sent)).toEqual([
      { type: "test:results", payload: { turnId: TURN, pass: true, failures: [] }, ts: 1000 },
    ]);
  });

  it("flushes buffered console before the terminal verdict on the timeout path (HIGH-2)", async () => {
    // The run is killed for exceeding the budget while console chunks are still
    // in flight (macrotask delivery); they must relay BEFORE the terminal
    // `test:results`. With the unfixed fire-and-forget drain they land after it.
    const process: WebContainerProcessHandle = {
      output: macrotaskStreamFromChunks(["partial output\n", "more output\n"]),
      // exit never resolves — only the injected budget timer ends the race.
      exit: new Promise<number>(() => undefined),
      kill: (): void => undefined,
    };
    const { handle } = makeHandle({ process, readFile: () => Promise.resolve(GREEN_REPORT) });
    const { bridge, sent } = makeBridge();

    // Fire ONLY the 120s budget, never the drain grace, so the drain flushes fully.
    const result = await runTestCycle(handle, bridge, {
      turnId: TURN,
      now: () => 1000,
      setTimer: fireTimersOfDuration(120_000),
    });

    expect(result.outcome).toBe("timed-out");
    const logs = sent.filter((e): e is ConsoleLogEvent => e.type === "console:log");
    expect(logs.map((e) => e.payload.message)).toEqual(["partial output\n", "more output\n"]);
    // `test:results` is the terminal event — no console:* chunk arrives after it.
    expect(sent.at(-1)?.type).toBe("test:results");
  });
});

// ---------------------------------------------------------------------------
// parseVitestJson (pure)
// ---------------------------------------------------------------------------

describe("parseVitestJson", () => {
  it("maps an all-green report to pass:true with no failures", () => {
    expect(parseVitestJson(GREEN_REPORT)).toEqual({ pass: true, failures: [] });
  });

  it("flattens failed assertions in encounter order, joining failureMessages", () => {
    expect(parseVitestJson(RED_REPORT)).toEqual({
      pass: false,
      failures: [
        { name: "suite first fails", message: "expected 1 to be 2\nAssertionError: at line 3" },
        { name: "other second fails", message: "" },
      ],
    });
  });

  it("ignores passed/skipped/todo assertions in a mixed report", () => {
    const mixed = JSON.stringify({
      success: false,
      testResults: [
        {
          assertionResults: [
            { fullName: "a skipped", status: "skipped", failureMessages: [] },
            { fullName: "b todo", status: "todo", failureMessages: [] },
            { fullName: "c fails", status: "failed", failureMessages: ["boom"] },
            { fullName: "d passes", status: "passed", failureMessages: [] },
          ],
        },
      ],
    });
    expect(parseVitestJson(mixed)).toEqual({
      pass: false,
      failures: [{ name: "c fails", message: "boom" }],
    });
  });

  it("defensively coerces a structurally malformed (but valid JSON) report", () => {
    expect(parseVitestJson("{}")).toEqual({ pass: false, failures: [] });
    expect(parseVitestJson('{"success":true}')).toEqual({ pass: true, failures: [] });
    expect(parseVitestJson('{"success":true,"testResults":"nope"}')).toEqual({
      pass: true,
      failures: [],
    });
    // A failed assertion missing fullName / failureMessages → empty strings.
    expect(
      parseVitestJson(
        '{"success":false,"testResults":[{"assertionResults":[{"status":"failed"}]}]}',
      ),
    ).toEqual({ pass: false, failures: [{ name: "", message: "" }] });
  });

  it("throws only on truly unparseable input", () => {
    expect(() => parseVitestJson("not json {")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism (SC-014)
// ---------------------------------------------------------------------------

describe("determinism (SC-014)", () => {
  it("parseVitestJson is deeply equal across 100 consecutive runs", () => {
    const runs = Array.from({ length: 100 }, () => parseVitestJson(RED_REPORT));
    const first = runs[0];
    for (const run of runs) expect(run).toEqual(first);
  });

  it("runTestCycle emits an identical payload across 100 runs under a fixed clock", async () => {
    const payloads: TestResultsPayload[] = [];
    for (let i = 0; i < 100; i += 1) {
      const { handle } = makeHandle({
        process: makeProcess({ chunks: ["x\n"], exit: Promise.resolve(1) }),
        readFile: () => Promise.resolve(RED_REPORT),
      });
      const { bridge } = makeBridge();
      const result = await runTestCycle(handle, bridge, {
        turnId: TURN,
        now: () => 1000,
        setTimer: neverFires,
      });
      expect(result.elapsedMs).toBe(0);
      payloads.push(result.results);
    }
    const first = payloads[0];
    for (const payload of payloads) expect(payload).toEqual(first);
  });
});
