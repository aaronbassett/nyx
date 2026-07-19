/**
 * The "take your project home" handoff panel (US13, FR-074/FR-075/D49/D58/D59).
 *
 * A small, self-contained panel over the two read-only export mechanisms a
 * developer needs to leave the platform with their work:
 *
 *  1. ARCHIVE — a button that triggers `GET /projects/:id/archive` (a source-only
 *     zip). Handled through an injectable {@link DownloadTrigger} seam so tests
 *     assert the URL without a real browser navigation.
 *  2. CLONE URL — mint / regenerate / revoke a read-only git clone token
 *     (`POST`/`DELETE /projects/:id/clone-token`). The displayed URL is derived
 *     purely from the token and the injected `gitBaseUrl`
 *     (`<gitBaseUrl>/git/<token>/`). Copy is an injectable {@link ClipboardWriter}
 *     seam. Revoking removes the URL and shows a "revoked" note.
 *  3. SOFT-DELETED (D49/FR-077) — when the injected project carries a
 *     `deletedAt`, the panel renders a disabled explanation and NEVER touches the
 *     client (handoff pauses with the project until it is restored).
 *
 * {@link handoffReducer} is a PURE fold over the clone-token lifecycle;
 * {@link useHandoff} wires it to the injected {@link HandoffClient} and the two
 * side-effecting seams, guarding every action behind the soft-deleted flag and a
 * single-in-flight latch. Every client call is user-initiated — the panel does
 * NOTHING on mount, so an untouched (or deleted) project never hits the network.
 *
 * It is deliberately NOT wired into the app Shell (the Shell mount point is an
 * owner-gated placeholder); the real app injects `createHttpHandoffClient()`, the
 * configured `gitBaseUrl`, and the default seams, and mounts this.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  Check,
  Copy,
  Download,
  GitBranch,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { HandoffFetchError } from "./handoff-client";
import type { HandoffClient } from "./handoff-client";

/** How long the "copied" confirmation stays visible after a successful copy (ms). */
export const DEFAULT_COPY_RESET_MS = 2000;

/** The minimal project view the panel needs (from the project fetch / list). */
export interface HandoffProject {
  /** The project id used in every handoff path. */
  readonly id: string;
  /** Display name (surfaced in copy). */
  readonly name: string;
  /** Soft-delete marker (D49/FR-077) — epoch-ms, matching the wire `Project.deletedAt`;
   *  present only when the project is soft-deleted, which pauses handoff. */
  readonly deletedAt?: number;
}

/** Injectable archive-download seam. The default triggers a browser download. */
export type DownloadTrigger = (url: string) => void;

/** Injectable clipboard seam. The default writes via the async Clipboard API. */
export type ClipboardWriter = (text: string) => Promise<void>;

/** Whether the clone-token lifecycle is idle, mid-request, or in error. */
export type HandoffStatus = "idle" | "working" | "error";

/** The derived clone-token UI state — folded purely by {@link handoffReducer}. */
export interface HandoffState {
  /** The current clone token, or `null` when none is minted. */
  readonly token: string | null;
  /** Request lifecycle status. */
  readonly status: HandoffStatus;
  /** User-facing error copy for the last failed request, else `null`. */
  readonly error: string | null;
  /** Whether a revoke just happened (drives the "revoked" note). */
  readonly justRevoked: boolean;
  /** Whether the clone URL was just copied (drives the confirmation). */
  readonly copied: boolean;
}

/** One transition in the clone-token lifecycle. */
export type HandoffAction =
  | { readonly kind: "working" }
  | { readonly kind: "minted"; readonly token: string }
  | { readonly kind: "revoked" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "copied" }
  | { readonly kind: "copy-reset" };

/** Build the initial state, optionally seeded with an already-minted token. */
export function createInitialHandoffState(initialToken?: string): HandoffState {
  return {
    token: initialToken ?? null,
    status: "idle",
    error: null,
    justRevoked: false,
    copied: false,
  };
}

/** Pure reducer: fold one clone-token event onto the derived UI state. */
export function handoffReducer(state: HandoffState, action: HandoffAction): HandoffState {
  switch (action.kind) {
    case "working":
      // A fresh request clears any stale error / revoked note / copy confirmation.
      return { ...state, status: "working", error: null, justRevoked: false, copied: false };

    case "minted":
      return { ...state, token: action.token, status: "idle", error: null, justRevoked: false };

    case "revoked":
      // Drop the token and latch the "revoked" note; the URL disappears.
      return {
        ...state,
        token: null,
        status: "idle",
        error: null,
        justRevoked: true,
        copied: false,
      };

    case "failed":
      // Keep the existing token — a failed regenerate/revoke must not lose it.
      return { ...state, status: "error", error: action.message };

    case "copied":
      return { ...state, copied: true };

    case "copy-reset":
      return state.copied ? { ...state, copied: false } : state;
  }
}

/**
 * Map a handoff request failure to user-facing copy. A 401/403 on this
 * cookie-authed endpoint means the session lapsed (prompt re-auth) rather than
 * the misleading "check your connection".
 */
export function handoffErrorMessage(error: unknown): string {
  if (error instanceof HandoffFetchError) {
    if (error.reason === "http" && (error.status === 401 || error.status === 403)) {
      return "Your session has expired. Please sign in again to manage handoff.";
    }
    if (error.reason === "http" || error.reason === "malformed") {
      return "Something went wrong managing your clone URL. Please try again.";
    }
  }
  return "We couldn't reach the server. Check your connection and try again.";
}

/** A project is soft-deleted when it carries a `deletedAt` timestamp (D49). */
function isDeleted(project: HandoffProject): boolean {
  return project.deletedAt !== undefined;
}

/** Derive the read-only git clone URL from the base and token: `<base>/git/<token>/`. */
export function buildCloneUrl(gitBaseUrl: string, token: string): string {
  const base = gitBaseUrl.replace(/\/+$/, "");
  return `${base}/git/${token}/`;
}

/** Default download seam: click a transient anchor, else navigate the location. */
function defaultTriggerDownload(url: string): void {
  if (typeof document !== "undefined") {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  if (typeof location !== "undefined") {
    location.href = url;
  }
}

/** Default clipboard seam: the async Clipboard API, if the environment has one. */
async function defaultCopyToClipboard(text: string): Promise<void> {
  // DOM types declare `navigator.clipboard` non-optional, but it is genuinely
  // absent in insecure contexts / non-browser envs — widen so the guard is real.
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const clipboard = nav?.clipboard;
  if (clipboard !== undefined) {
    await clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard API is not available in this environment.");
}

/** Options for {@link useHandoff}. */
export interface UseHandoffOptions {
  /** The handoff REST seam. */
  readonly client: HandoffClient;
  /** The injected project (id + name + optional `deletedAt`). */
  readonly project: HandoffProject;
  /** Base URL the clone path is built under (`<gitBaseUrl>/git/<token>/`). */
  readonly gitBaseUrl: string;
  /** An already-minted token to display on mount (from the project fetch). */
  readonly initialCloneToken?: string;
  /** Archive-download seam; defaults to {@link defaultTriggerDownload}. */
  readonly triggerDownload?: DownloadTrigger;
  /** Clipboard seam; defaults to {@link defaultCopyToClipboard}. */
  readonly copyToClipboard?: ClipboardWriter;
  /** How long the copy confirmation shows; defaults to {@link DEFAULT_COPY_RESET_MS}. */
  readonly copyResetMs?: number;
}

/** The handoff surface exposed to the presentational panel. */
export interface UseHandoff {
  /** The project is soft-deleted — every action is a guarded no-op (D49). */
  readonly disabled: boolean;
  /** Request lifecycle status. */
  readonly status: HandoffStatus;
  /** The derived clone URL, or `null` when no token is minted. */
  readonly cloneUrl: string | null;
  /** Whether a token is currently minted. */
  readonly hasToken: boolean;
  /** Whether a revoke just happened (drives the note). */
  readonly justRevoked: boolean;
  /** Whether the clone URL was just copied (drives the confirmation). */
  readonly copied: boolean;
  /** User-facing error copy for the last failed request, else `null`. */
  readonly error: string | null;
  /** Mint (or replace) the clone token. Same action for Generate + Regenerate. */
  readonly generate: () => void;
  /** Revoke the clone token. */
  readonly revoke: () => void;
  /** Copy the clone URL via the clipboard seam. */
  readonly copy: () => void;
  /** Trigger the archive download via the download seam. */
  readonly downloadArchive: () => void;
}

/**
 * Wire {@link handoffReducer} to the injected client + seams. Every action is
 * guarded by the soft-deleted flag and a single-in-flight latch, and reads its
 * dependencies through refs so the callbacks stay stable across renders and
 * never fire a client call for an untouched (or deleted) project.
 */
export function useHandoff(options: UseHandoffOptions): UseHandoff {
  const [state, dispatch] = useReducer(handoffReducer, undefined, () =>
    createInitialHandoffState(options.initialCloneToken),
  );

  const depsRef = useRef(options);
  depsRef.current = options;

  const disabled = isDeleted(options.project);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const tokenRef = useRef(state.token);
  tokenRef.current = state.token;

  // Single-in-flight latch so a double-click can't fire two mint/revoke calls.
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const generate = useCallback(() => {
    if (disabledRef.current || pendingRef.current) {
      return;
    }
    const { client, project } = depsRef.current;
    pendingRef.current = true;
    dispatch({ kind: "working" });
    void client
      .mintCloneToken(project.id)
      .then((result) => {
        pendingRef.current = false;
        if (mountedRef.current) {
          dispatch({ kind: "minted", token: result.cloneToken });
        }
      })
      .catch((error: unknown) => {
        pendingRef.current = false;
        if (mountedRef.current) {
          dispatch({ kind: "failed", message: handoffErrorMessage(error) });
        }
      });
  }, []);

  const revoke = useCallback(() => {
    if (disabledRef.current || pendingRef.current) {
      return;
    }
    const { client, project } = depsRef.current;
    pendingRef.current = true;
    dispatch({ kind: "working" });
    void client
      .revokeCloneToken(project.id)
      .then(() => {
        pendingRef.current = false;
        if (mountedRef.current) {
          dispatch({ kind: "revoked" });
        }
      })
      .catch((error: unknown) => {
        pendingRef.current = false;
        if (mountedRef.current) {
          dispatch({ kind: "failed", message: handoffErrorMessage(error) });
        }
      });
  }, []);

  const copy = useCallback(() => {
    if (disabledRef.current) {
      return;
    }
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    const { gitBaseUrl, copyToClipboard } = depsRef.current;
    const url = buildCloneUrl(gitBaseUrl, token);
    const write = copyToClipboard ?? defaultCopyToClipboard;
    void write(url)
      .then(() => {
        if (!mountedRef.current) {
          return;
        }
        dispatch({ kind: "copied" });
        if (resetTimerRef.current !== null) {
          clearTimeout(resetTimerRef.current);
        }
        const resetMs = depsRef.current.copyResetMs ?? DEFAULT_COPY_RESET_MS;
        resetTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            dispatch({ kind: "copy-reset" });
          }
        }, resetMs);
      })
      .catch(() => {
        // Best-effort: a clipboard rejection leaves the URL on screen to copy manually.
      });
  }, []);

  const downloadArchive = useCallback(() => {
    if (disabledRef.current) {
      return;
    }
    const { client, project, triggerDownload } = depsRef.current;
    const url = client.archiveUrl(project.id);
    (triggerDownload ?? defaultTriggerDownload)(url);
  }, []);

  const cloneUrl = state.token !== null ? buildCloneUrl(options.gitBaseUrl, state.token) : null;

  return {
    disabled,
    status: state.status,
    cloneUrl,
    hasToken: state.token !== null,
    justRevoked: state.justRevoked,
    copied: state.copied,
    error: state.error,
    generate,
    revoke,
    copy,
    downloadArchive,
  };
}

/** Props for {@link HandoffPanel} — the injected seams plus display config. */
export interface HandoffPanelProps {
  /** The handoff REST seam. */
  readonly client: HandoffClient;
  /** The injected project (id + name + optional `deletedAt`). */
  readonly project: HandoffProject;
  /** Base URL the clone path is built under. */
  readonly gitBaseUrl: string;
  /** An already-minted token to display on mount. */
  readonly initialCloneToken?: string;
  /** Archive-download seam (injected for tests). */
  readonly triggerDownload?: DownloadTrigger;
  /** Clipboard seam (injected for tests). */
  readonly copyToClipboard?: ClipboardWriter;
  /** Copy-confirmation duration (ms). */
  readonly copyResetMs?: number;
}

/** The panel header (shared by the active and disabled states). */
function HandoffHeader() {
  return (
    <CardHeader>
      <div className="flex items-center gap-3">
        <PackageOpen className="text-primary size-6 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <CardTitle>Take your project home</CardTitle>
          <CardDescription>
            Export your project as a source archive, or clone it over git.
          </CardDescription>
        </div>
      </div>
    </CardHeader>
  );
}

export function HandoffPanel({
  client,
  project,
  gitBaseUrl,
  initialCloneToken,
  triggerDownload,
  copyToClipboard,
  copyResetMs,
}: HandoffPanelProps) {
  const handoff = useHandoff({
    client,
    project,
    gitBaseUrl,
    ...(initialCloneToken !== undefined ? { initialCloneToken } : {}),
    ...(triggerDownload !== undefined ? { triggerDownload } : {}),
    ...(copyToClipboard !== undefined ? { copyToClipboard } : {}),
    ...(copyResetMs !== undefined ? { copyResetMs } : {}),
  });

  // Soft-deleted (D49/FR-077): handoff pauses with the project — no affordances,
  // no client calls, just an honest explanation of why and how to resume.
  if (handoff.disabled) {
    return (
      <Card data-testid="handoff-disabled" className="max-w-md">
        <HandoffHeader />
        <CardContent>
          <p role="status" className="text-muted-foreground text-sm">
            Handoff is paused for deleted projects — restore it first.
          </p>
        </CardContent>
      </Card>
    );
  }

  const busy = handoff.status === "working";

  return (
    <Card data-testid="handoff-panel" className="max-w-md">
      <HandoffHeader />
      <CardContent className="space-y-6">
        {/* Archive download (FR-074). */}
        <section aria-labelledby="handoff-archive-heading" className="space-y-2">
          <h3 id="handoff-archive-heading" className="text-sm font-medium">
            Download archive
          </h3>
          <p className="text-muted-foreground text-sm">
            A zip of your latest source, with a README on what to supply to run it locally.
          </p>
          <Button
            data-testid="handoff-archive-download"
            variant="outline"
            onClick={handoff.downloadArchive}
          >
            <Download className="size-4" aria-hidden="true" />
            Download project archive
          </Button>
        </section>

        {/* Clone URL management (FR-075). */}
        <section aria-labelledby="handoff-clone-heading" className="space-y-2">
          <h3 id="handoff-clone-heading" className="text-sm font-medium">
            Git clone URL
          </h3>

          {handoff.cloneUrl !== null ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code
                  data-testid="handoff-clone-url"
                  className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1 font-mono text-xs"
                >
                  {handoff.cloneUrl}
                </code>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Copy clone URL"
                  data-testid="handoff-clone-copy"
                  disabled={busy}
                  onClick={handoff.copy}
                >
                  {handoff.copied ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              {handoff.copied ? (
                <span
                  role="status"
                  data-testid="handoff-copied"
                  className="text-muted-foreground text-xs"
                >
                  Copied to clipboard
                </span>
              ) : null}
              <p className="text-muted-foreground text-xs">
                Read-only. Anyone with this URL can clone your project's source.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="handoff-clone-regenerate"
                  disabled={busy}
                  onClick={handoff.generate}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Regenerate
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="handoff-clone-revoke"
                  disabled={busy}
                  onClick={handoff.revoke}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Revoke
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {handoff.justRevoked ? (
                <p
                  role="status"
                  data-testid="handoff-revoked-note"
                  className="text-muted-foreground text-sm"
                >
                  The clone URL has been revoked and no longer works. Generate a new one to share
                  access again.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Generate a read-only URL to clone your project over git.
                </p>
              )}
              <Button
                data-testid="handoff-clone-generate"
                disabled={busy}
                onClick={handoff.generate}
              >
                <GitBranch className="size-4" aria-hidden="true" />
                Generate clone URL
              </Button>
            </div>
          )}

          {busy ? (
            <span
              data-testid="handoff-working"
              className="text-muted-foreground flex items-center gap-2 text-xs"
            >
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Working…
            </span>
          ) : null}

          {handoff.status === "error" && handoff.error !== null ? (
            <p
              role="alert"
              data-testid="handoff-error"
              className="text-destructive flex items-center gap-2 text-sm"
            >
              <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
              {handoff.error}
            </p>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
