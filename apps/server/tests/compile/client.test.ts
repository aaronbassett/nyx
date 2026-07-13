/**
 * Compile Service client contract tests (T066) — deterministic, mocked `fetch`,
 * NO real service.
 *
 * These pin the Nyx-side view of the Compile Service HTTP contract
 * (`infra/compile-service/API.md`):
 *  - the Bearer token + relative `/v1/*` paths + request bodies go out correctly;
 *  - a compile FAILURE is DATA (`check` `ok:false`, job `status:"failed"`), never a
 *    throw — only 4xx/5xx envelopes, network faults, and malformed bodies throw a
 *    named {@link CompileServiceError};
 *  - {@link runCompileJob} surfaces queued→running progress and returns `succeeded`,
 *    and a hung job raises {@link CompileJobTimeoutError} — bounded, never infinite
 *    (FR-016).
 */
import { describe, expect, it } from "vitest";
import type { Mock } from "vitest";
import {
  CompileJobTimeoutError,
  CompileServiceProtocolError,
  CompileServiceResponseError,
  CompileServiceUnavailableError,
  HttpCompileClient,
  runCompileJob,
} from "../../src/compile/index.js";
import type { CompileProgressUpdate } from "../../src/compile/index.js";
import {
  advancingDelay,
  callUrl,
  CHECK_FAILED,
  CHECK_OK,
  COMPILER_VERSION,
  emptyResponse,
  FakeCompileClient,
  JOB_ID,
  jsonResponse,
  mockFetch,
  PROJECT_ID,
  runningPoll,
  SOURCE_FILES,
  SUBMIT_QUEUED,
  succeededJob,
  URL_PREFIX,
} from "./helpers.js";
import type { Clock } from "./helpers.js";

const TOKEN = "test-compile-token";

/** Extract the Nth recorded fetch call as `{ url, init }`, or throw. */
function requireCall(
  fetchMock: Mock<typeof fetch>,
  index: number,
): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`expected a fetch call at index ${String(index)}`);
  }
  const [input, init] = call;
  return { url: callUrl(input), init: init ?? {} };
}

/** Read a header off a recorded `RequestInit` regardless of the header shape. */
function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (headers === undefined) {
    return undefined;
  }
  const record = headers as Record<string, string>;
  return record[name];
}

describe("HttpCompileClient.check — POST /v1/check", () => {
  it("sends the Bearer token, JSON body, and relative path, returning the parsed response", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(CHECK_OK));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const result = await client.check({ files: [...SOURCE_FILES] });

    expect(result).toEqual(CHECK_OK);
    const { url, init } = requireCall(fetchMock, 0);
    expect(url).toBe("/v1/check");
    expect(init.method).toBe("POST");
    expect(header(init, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(init, "content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ files: SOURCE_FILES });
  });

  it("treats a failed compile as DATA (ok:false + diagnostics), not a throw", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(CHECK_FAILED));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const result = await client.check({ files: [...SOURCE_FILES] });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("parse error");
    expect(result.compilerVersion).toBe(COMPILER_VERSION);
  });

  it("prefixes an absolute baseUrl onto the path", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(CHECK_OK));

    const client = new HttpCompileClient({
      token: TOKEN,
      fetch: fetchMock,
      baseUrl: "https://compile.flycast",
    });
    await client.check({ files: [...SOURCE_FILES] });

    expect(requireCall(fetchMock, 0).url).toBe("https://compile.flycast/v1/check");
  });

  it("throws CompileServiceResponseError carrying status + code on a 400 envelope", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "empty_files", message: "files must be non-empty" } }, 400),
    );

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const error = await client.check({ files: [...SOURCE_FILES] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompileServiceResponseError);
    const responseError = error as CompileServiceResponseError;
    expect(responseError.status).toBe(400);
    expect(responseError.code).toBe("empty_files");
  });

  it("throws CompileServiceUnavailableError when fetch rejects (network fault)", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    await expect(client.check({ files: [...SOURCE_FILES] })).rejects.toBeInstanceOf(
      CompileServiceUnavailableError,
    );
  });

  it("throws CompileServiceProtocolError when a 2xx body does not match the contract", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: "yes" }));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    await expect(client.check({ files: [...SOURCE_FILES] })).rejects.toBeInstanceOf(
      CompileServiceProtocolError,
    );
  });
});

describe("HttpCompileClient.compile — POST /v1/compile", () => {
  it("posts projectId + files and returns the job handle (202 work-started)", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(SUBMIT_QUEUED, 202));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const result = await client.compile({ projectId: PROJECT_ID, files: [...SOURCE_FILES] });

    expect(result).toEqual(SUBMIT_QUEUED);
    const { url, init } = requireCall(fetchMock, 0);
    expect(url).toBe("/v1/compile");
    expect(JSON.parse(init.body as string)).toEqual({ projectId: PROJECT_ID, files: SOURCE_FILES });
  });
});

describe("HttpCompileClient.pollCompile — GET /v1/compile/{jobId}", () => {
  it("returns a succeeded job (result is data)", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(succeededJob()));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const job = await client.pollCompile(JOB_ID);

    expect(job.status).toBe("succeeded");
    expect(job.result?.urlPrefix).toBe(URL_PREFIX);
    expect(requireCall(fetchMock, 0).url).toBe(`/v1/compile/${JOB_ID}`);
    expect(requireCall(fetchMock, 0).init.method).toBe("GET");
  });

  it("throws CompileServiceResponseError with status 404 for an unknown job", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(emptyResponse(404));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const error = await client.pollCompile("job_missing").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompileServiceResponseError);
    expect((error as CompileServiceResponseError).status).toBe(404);
  });
});

describe("runCompileJob — submit → poll to terminal (FR-016)", () => {
  it("surfaces queued/running progress and returns the succeeded job", async () => {
    const client = new FakeCompileClient({
      submit: SUBMIT_QUEUED,
      polls: [runningPoll(1), runningPoll(2), succeededJob()],
    });
    const clock: Clock = { now: 0 };
    const progress: CompileProgressUpdate[] = [];

    const job = await runCompileJob(
      client,
      { projectId: PROJECT_ID, files: [...SOURCE_FILES] },
      {
        now: () => clock.now,
        delay: advancingDelay(clock),
        pollIntervalMs: 1_000,
        maxWaitMs: 60_000,
        onProgress: (update) => progress.push(update),
      },
    );

    expect(job.status).toBe("succeeded");
    expect(progress.map((p) => p.status)).toEqual(["running", "running"]);
    expect(progress[0]?.progress?.message).toContain("compiling");
    expect(client.compileCalls).toHaveLength(1);
  });

  it("raises CompileJobTimeoutError for a hung job — bounded, never infinite", async () => {
    const client = new FakeCompileClient({
      submit: SUBMIT_QUEUED,
      polls: [],
      pollDefault: runningPoll(99), // always running — the job never settles
    });
    const clock: Clock = { now: 0 };

    const error = await runCompileJob(
      client,
      { projectId: PROJECT_ID, files: [...SOURCE_FILES] },
      {
        now: () => clock.now,
        delay: advancingDelay(clock),
        pollIntervalMs: 1_000,
        maxWaitMs: 5_000,
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompileJobTimeoutError);
    const timeout = error as CompileJobTimeoutError;
    expect(timeout.maxWaitMs).toBe(5_000);
    expect(timeout.lastStatus).toBe("running");
    // The bounded wait terminated the loop rather than polling forever.
    expect(client.pollCalls.length).toBeGreaterThan(0);
    expect(client.pollCalls.length).toBeLessThan(1_000);
  });
});
