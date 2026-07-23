/**
 * P2 — the web-side `compile:run` handler (Task 4).
 *
 * The server delegates each turn's compile to the CLIENT'S wasm toolchain (design
 * §4: the user's code builds on the user's machine). It sends `compile:run
 * { turnId, kind }`; this handler runs the compile on the injected {@link
 * CompileWorkerClient}, uploads artifacts on a green `full`, and replies with a
 * single `compile:results` verdict. It mirrors the `verify:run` → `test:results`
 * shape wired in `container/` (a server-driven run, a client-owned reply).
 *
 * The load-bearing invariant: EVERY `compile:run` yields exactly one terminal
 * `compile:results`. A compile failure is DATA (`ok:false` + diagnostics); an
 * upload failure or a worker/`getSources` throw becomes a synthesized-diagnostic
 * `ok:false` verdict — never a silent drop, which would strand the server on its
 * per-turn compile timeout. A failed upload never advertises a `sourceHash` (that
 * would signal a complete artifact set to the server).
 *
 * Every collaborator is INJECTABLE (bridge, worker, `getSources`, `upload`,
 * `now`), so the whole handler unit-tests against fakes — no socket, no worker,
 * no server upload.
 */
import { uploadArtifacts } from "@/compile/upload";
import type { CompileWorkerClient } from "@/compile/client";
import type { CheckOutput, FullOutput } from "@/compile/messages";
import type { PreviewBridge, Unsubscribe } from "@/container/types";
import type { WasmSourceFile } from "@nyx/compact-wasm";
import type { CompileDiagnostic, CompileKind, CompileResultsPayload, TurnId } from "@nyx/protocol";

/** Compiler version stamped on a synthesized-error verdict (no worker result to read). */
const UNKNOWN_COMPILER_VERSION = "unknown";

/** Injectable collaborators for {@link registerCompileHandlers}. */
export interface RegisterCompileHandlersDeps {
  /** WS seam the `compile:run` frames arrive on and `compile:results` go out on. */
  readonly bridge: PreviewBridge;
  /** In-browser compile toolchain (Task 3). */
  readonly worker: CompileWorkerClient;
  /** Project the compile (and any artifact upload) is scoped to. */
  readonly projectId: string;
  /** Resolve the current Compact sources to compile. */
  readonly getSources: () => Promise<WasmSourceFile[]>;
  /** Artifact publisher; defaults to {@link uploadArtifacts}. Tests inject a mock. */
  readonly upload?: typeof uploadArtifacts;
  /** Clock for emitted event timestamps + synthesized-error durations. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Extract a human-readable message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Synthesize a single `error` diagnostic for an infra fault (upload/worker/sources). */
function infraDiagnostic(message: string): CompileDiagnostic {
  return { severity: "error", source: "compactc", message };
}

/**
 * Subscribe to `compile:run` and reply with `compile:results`. On `check` the
 * worker's verdict is echoed verbatim; on a green `full` the artifacts are
 * uploaded (manifest-last) before a verdict carrying `sourceHash`+`circuits` is
 * sent; a non-green `full`, an upload failure, or any throw yields a terminal
 * `ok:false` verdict. Returns the {@link Unsubscribe} that detaches the listener.
 */
export function registerCompileHandlers(deps: RegisterCompileHandlersDeps): Unsubscribe {
  const now = deps.now ?? Date.now;
  const upload = deps.upload ?? uploadArtifacts;

  /** Emit exactly one terminal verdict up the bridge. */
  const reply = (payload: CompileResultsPayload): void => {
    deps.bridge.send({ type: "compile:results", payload, ts: now() });
  };

  /** Run a `check`: echo the worker verdict as-is (a compile failure is DATA). */
  const runCheck = async (turnId: TurnId, sources: WasmSourceFile[]): Promise<void> => {
    const result: CheckOutput = await deps.worker.check(sources);
    reply({
      turnId,
      kind: "check",
      ok: result.ok,
      diagnostics: result.diagnostics,
      compilerVersion: result.compilerVersion,
      durationMs: result.durationMs,
    });
  };

  /**
   * Run a `full`: on a green compile upload the artifacts LAST-committed, then
   * reply with `sourceHash`+`circuits`; a non-green compile replies `ok:false`
   * with its diagnostics; an upload failure replies `ok:false` with a synthesized
   * diagnostic and NO `sourceHash`.
   */
  const runFull = async (turnId: TurnId, sources: WasmSourceFile[]): Promise<void> => {
    const result: FullOutput = await deps.worker.compileFull(sources);

    // A non-green compile (or a green one that produced no artifacts) is reported
    // as data; nothing to upload, no sourceHash to advertise.
    if (!result.ok || result.sourceHash === undefined || result.files === undefined) {
      reply({
        turnId,
        kind: "full",
        ok: false,
        diagnostics: result.diagnostics,
        compilerVersion: result.compilerVersion,
        durationMs: result.durationMs,
      });
      return;
    }

    const circuits = result.circuits ?? [];
    try {
      await upload(
        {},
        {
          projectId: deps.projectId,
          sourceHash: result.sourceHash,
          compilerVersion: result.compilerVersion,
          files: result.files,
          circuits,
        },
      );
    } catch (error) {
      // Upload failed after a green compile: reply with a verdict either way (a
      // missing reply burns the server timeout), but WITHOUT a sourceHash.
      reply({
        turnId,
        kind: "full",
        ok: false,
        diagnostics: [infraDiagnostic(`artifact upload failed: ${messageOf(error)}`)],
        compilerVersion: result.compilerVersion,
        durationMs: result.durationMs,
      });
      return;
    }

    reply({
      turnId,
      kind: "full",
      ok: true,
      diagnostics: result.diagnostics,
      compilerVersion: result.compilerVersion,
      durationMs: result.durationMs,
      sourceHash: result.sourceHash,
      circuits,
    });
  };

  /** Drive one `compile:run`; never rejects — any fault becomes an `ok:false` verdict. */
  const handleRun = async (turnId: TurnId, kind: CompileKind): Promise<void> => {
    const startedAt = now();
    try {
      const sources = await deps.getSources();
      if (kind === "check") {
        await runCheck(turnId, sources);
      } else {
        await runFull(turnId, sources);
      }
    } catch (error) {
      // getSources or the worker itself faulted (an infra error, not a compile
      // diagnostic): still send a terminal verdict so the turn is never stranded.
      reply({
        turnId,
        kind,
        ok: false,
        diagnostics: [infraDiagnostic(`compile could not run: ${messageOf(error)}`)],
        compilerVersion: UNKNOWN_COMPILER_VERSION,
        durationMs: Math.max(0, now() - startedAt),
      });
    }
  };

  return deps.bridge.on("compile:run", (event) => {
    void handleRun(event.payload.turnId, event.payload.kind);
  });
}
