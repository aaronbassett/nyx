/**
 * `BrowserCompileClient` contract tests (P2 — browser-delegating compile, Task 7).
 *
 * The browser client implements the EXISTING {@link CompileClient} interface the
 * orchestrator drives unchanged, but instead of calling the retired Compile Service it
 * emits `compile:run` on the project's live connection and awaits the client's
 * `compile:results` through the {@link CompileResultsInbox}. The tests pin:
 *  - a green `check` payload maps to a `CheckResponse` (wire diagnostics gain `raw:false`);
 *  - a `check` timeout maps to a synthesized FAILING check (dead tab, no-hang D42);
 *  - a green `full` payload becomes a stored `succeeded` job whose `urlPrefix` is
 *    `${publicOrigin}/artifacts/${projectId}/${sourceHash}`, readable via `pollCompile`;
 *  - a failed `full` payload becomes a `failed` job with a `kind:"compile"` error;
 *  - a `full` timeout throws {@link CompileJobTimeoutError} (the orchestrator maps it to
 *    the explicit `timeout` outcome);
 *  - an unknown `pollCompile` id throws a 404 {@link CompileServiceResponseError};
 *  - `version()` reports the pinned wasm toolchain;
 *  - END-TO-END: a real {@link ArtifactOrchestrator} + browser client + in-memory
 *    {@link ArtifactStore} + {@link storeFetchAdapter} yields `kind:"ready"` and emits
 *    `artifacts:ready` exactly once.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ArtifactsReadyPayload,
  CompileResultsPayload,
  CompileRunPayload,
} from "@nyx/protocol";
import { COMPACT_WASM_META } from "@nyx/compact-wasm/meta";
import { createBrowserCompileClient } from "../../src/compile/browser-client.js";
import type { BrowserCompileSession } from "../../src/compile/browser-client.js";
import { createCompileResultsInbox } from "../../src/compile/inbox.js";
import type { CompileResultsInbox } from "../../src/compile/inbox.js";
import {
  ArtifactOrchestrator,
  CompileJobTimeoutError,
  CompileServiceResponseError,
} from "../../src/compile/index.js";
import type { CheckRequest, CompileRequest } from "../../src/compile/index.js";
import { createInMemoryArtifactStore, storeFetchAdapter } from "../../src/artifacts/index.js";
import type { ArtifactManifest } from "../../src/compile/index.js";

const PROJECT_ID = "project-a";
const PUBLIC_ORIGIN = "http://localhost:8080";
const TURN = "turn-42";
const SOURCE_HASH = "a".repeat(64);

/** A recording session that captures every `compile:run` and can script a scheduled reply. */
function recordingSession(deps: {
  inbox: CompileResultsInbox;
  reply?: (run: CompileRunPayload) => CompileResultsPayload | null;
}): BrowserCompileSession & { runs: CompileRunPayload[] } {
  const runs: CompileRunPayload[] = [];
  return {
    projectId: PROJECT_ID,
    runs,
    emitCompileRun(payload) {
      runs.push(payload);
      const reply = deps.reply?.(payload);
      if (reply !== null && reply !== undefined) {
        // Deliver on a microtask so the client's `await register(...)` has recorded the
        // wait first (emit precedes register in the client), mirroring the live WS path.
        queueMicrotask(() => {
          deps.inbox.deliver(reply, PROJECT_ID);
        });
      }
    },
  };
}

/** A delay that never resolves — delivery (scripted or via `deliver`) is the only resolver. */
const neverDelay = (): Promise<void> =>
  new Promise<void>(() => {
    /* never resolves */
  });
/** A delay that resolves immediately — the timeout leg fires deterministically. */
const immediateDelay = (): Promise<void> => Promise.resolve();

function greenCheck(turnId = TURN): CompileResultsPayload {
  return {
    turnId: turnId as CompileResultsPayload["turnId"],
    kind: "check",
    ok: true,
    diagnostics: [
      { severity: "warning", source: "compactp", message: "unused import", file: "main.compact" },
    ],
    compilerVersion: "0.31.1",
    durationMs: 21,
  };
}

function greenFull(turnId = TURN): CompileResultsPayload {
  return {
    turnId: turnId as CompileResultsPayload["turnId"],
    kind: "full",
    ok: true,
    diagnostics: [],
    compilerVersion: "0.31.1",
    durationMs: 340,
    sourceHash: SOURCE_HASH,
    circuits: [{ name: "increment", proof: true }],
  };
}

const CHECK_REQ: CheckRequest = { files: [{ path: "main.compact", content: "x" }] };
const COMPILE_REQ: CompileRequest = {
  projectId: PROJECT_ID,
  files: [{ path: "main.compact", content: "x" }],
};

describe("createBrowserCompileClient", () => {
  it("emits compile:run { kind: check } and maps a green payload to a CheckResponse", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const session = recordingSession({ inbox, reply: () => greenCheck() });
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    const response = await client.check(CHECK_REQ);

    expect(session.runs).toEqual([{ turnId: TURN, kind: "check" }]);
    expect(response.ok).toBe(true);
    expect(response.compilerVersion).toBe("0.31.1");
    expect(response.durationMs).toBe(21);
    // Wire → server Diagnostic: `raw:false` is added.
    expect(response.diagnostics).toEqual([
      {
        severity: "warning",
        source: "compactp",
        message: "unused import",
        file: "main.compact",
        raw: false,
      },
    ]);
  });

  it("maps a check timeout to a synthesized failing check (no-hang D42)", async () => {
    const inbox = createCompileResultsInbox({ delay: immediateDelay });
    const session = recordingSession({ inbox }); // no scripted reply → the timeout leg fires
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    const response = await client.check(CHECK_REQ);

    expect(response.ok).toBe(false);
    expect(response.compilerVersion).toBe("unknown");
    expect(response.diagnostics).toHaveLength(1);
    const [diagnostic] = response.diagnostics;
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.source).toBe("compactc");
    expect(diagnostic?.message).toContain("5000");
    expect(diagnostic?.raw).toBe(false);
  });

  it("stores a succeeded full job with the exact artifact urlPrefix, read via pollCompile", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const session = recordingSession({ inbox, reply: () => greenFull() });
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    const submit = await client.compile(COMPILE_REQ);
    expect(session.runs).toEqual([{ turnId: TURN, kind: "full" }]);
    expect(submit).toEqual({ jobId: `${TURN}:full`, status: "succeeded", sourceHash: SOURCE_HASH });

    const job = await client.pollCompile(submit.jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result).toEqual({
      urlPrefix: `${PUBLIC_ORIGIN}/artifacts/${PROJECT_ID}/${SOURCE_HASH}`,
      sourceHash: SOURCE_HASH,
      compilerVersion: "0.31.1",
      reused: false,
      circuits: [{ name: "increment", proof: true }],
    });
  });

  it("stores a failed full job with a kind:compile error carrying diagnostics", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const failed: CompileResultsPayload = {
      turnId: TURN as CompileResultsPayload["turnId"],
      kind: "full",
      ok: false,
      diagnostics: [{ severity: "error", source: "compactc", message: "type error" }],
      compilerVersion: "0.31.1",
      durationMs: 88,
    };
    const session = recordingSession({ inbox, reply: () => failed });
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    const submit = await client.compile(COMPILE_REQ);
    expect(submit.status).toBe("failed");

    const job = await client.pollCompile(submit.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toEqual({
      kind: "compile",
      compilerVersion: "0.31.1",
      diagnostics: [{ severity: "error", source: "compactc", message: "type error", raw: false }],
    });
  });

  it("throws CompileJobTimeoutError when a full compile times out", async () => {
    const inbox = createCompileResultsInbox({ delay: immediateDelay });
    const session = recordingSession({ inbox }); // no reply → timeout
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    await expect(client.compile(COMPILE_REQ)).rejects.toBeInstanceOf(CompileJobTimeoutError);
  });

  it("throws a 404 CompileServiceResponseError for an unknown pollCompile id", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const session = recordingSession({ inbox });
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    await expect(client.pollCompile("nope:full")).rejects.toMatchObject({
      name: "CompileServiceResponseError",
      status: 404,
    });
    await expect(client.pollCompile("nope:full")).rejects.toBeInstanceOf(
      CompileServiceResponseError,
    );
  });

  it("reports the pinned wasm toolchain from version()", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const session = recordingSession({ inbox });
    const client = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    }).forTurn(TURN);

    const versions = await client.version();
    expect(versions.compilerVersion).toBe(COMPACT_WASM_META.compilerVersion);
    expect(versions.languageVersion).toBe(COMPACT_WASM_META.languageVersion);
    expect(versions.runtime).toBe(COMPACT_WASM_META.runtimeVersion);
    expect(versions.skew).toEqual({
      ok: true,
      detail: "browser wasm toolchain (single pinned bundle)",
    });
  });

  it("end-to-end: orchestrator + browser client + store yields ready and announces once", async () => {
    // Stage + commit the artifacts under (projectId, sourceHash) so verify-before-announce
    // (the orchestrator, reading through storeFetchAdapter) sees a complete prefix.
    const store = createInMemoryArtifactStore();
    const zkeyBytes = new TextEncoder().encode("proving-key-bytes");
    await store.putFile(
      PROJECT_ID,
      SOURCE_HASH,
      "increment.zkey",
      zkeyBytes,
      "application/octet-stream",
    );
    const manifest: ArtifactManifest = {
      sourceHash: SOURCE_HASH,
      compilerVersion: "0.31.1",
      circuits: [{ name: "increment", proof: true }],
      files: [
        {
          path: "increment.zkey",
          sha256: sha256Hex(zkeyBytes),
          bytes: zkeyBytes.length,
          contentType: "application/octet-stream",
        },
      ],
    };
    await store.commit(PROJECT_ID, SOURCE_HASH, manifest);

    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const session = recordingSession({
      inbox,
      reply: (run) => (run.kind === "check" ? greenCheck() : greenFull()),
    });
    const browser = createBrowserCompileClient({
      inbox,
      session,
      publicOrigin: PUBLIC_ORIGIN,
      checkTimeoutMs: 5_000,
      fullTimeoutMs: 60_000,
    });

    const announced: ArtifactsReadyPayload[] = [];
    const orchestrator = new ArtifactOrchestrator({
      client: browser.forTurn(TURN),
      emitArtifactsReady: (payload) => {
        announced.push(payload);
      },
      fetchArtifact: storeFetchAdapter(store),
    });

    const outcome = await orchestrator.runTurn({
      turnId: "turn-1",
      projectId: PROJECT_ID,
      files: [{ path: "main.compact", content: "x" }],
      changedPaths: ["main.compact"],
    });

    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.urlPrefix).toBe(`${PUBLIC_ORIGIN}/artifacts/${PROJECT_ID}/${SOURCE_HASH}`);
      expect(outcome.announced).toBe(true);
    }
    expect(announced).toEqual([
      { urlPrefix: `${PUBLIC_ORIGIN}/artifacts/${PROJECT_ID}/${SOURCE_HASH}` },
    ]);
  });
});

/** Local sha256-hex for the E2E manifest (matches the store's content addressing). */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
