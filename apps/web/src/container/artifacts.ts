/**
 * `artifacts:ready` re-pointer for the Nyx WebContainer preview host (US3, T087).
 *
 * When the server announces freshly-compiled ZK artifacts (`artifacts:ready`,
 * FR-014, D35), the generated app must read its ZK config from the NEW R2 prefix.
 * The app's `FetchZkConfigProvider` resolves its base URL from an env var at
 * startup, so re-pointing == rewriting that key in the container's `.env.local`
 * (the D10 config chokepoint) then asking the coordinator to re-point/reload.
 *
 * This handler is intentionally thin and side-effect-narrow:
 *  - it does NOT touch `.env.local` directly — it writes through the SHARED
 *    {@link ContainerEnv} instance (co-owned with the `contract:deployed`
 *    handler), so neither writer clobbers the other's key;
 *  - it does NOT perform the reload/restart itself — that mechanic belongs to the
 *    caller, reached through the injected {@link ArtifactsRepointerDeps.onRepointed}
 *    callback;
 *  - it remembers the last APPLIED `urlPrefix` so a repeat announcement of the
 *    same prefix (D35 allows re-fires across turns) is a no-op: no redundant file
 *    write, no redundant re-point. A DIFFERENT prefix re-points.
 */
import type { ContainerEnv } from "./env-file";
import type { ArtifactsReadyPayload } from "@nyx/protocol";

/**
 * The env var the generated app reads at startup to locate its ZK config base
 * URL (consumed by `FetchZkConfigProvider`). Vite only exposes `VITE_`-prefixed
 * vars to client code, hence the prefix.
 */
export const ZK_CONFIG_BASE_ENV_KEY = "VITE_ZK_CONFIG_BASE_URL";

/** Injectable collaborators for {@link createArtifactsRepointer}. */
export interface ArtifactsRepointerDeps {
  /** The shared, merge-not-clobber writer over the container's `.env.local`. */
  readonly env: ContainerEnv;
  /**
   * Invoked AFTER the env var is (re)written, with the newly-applied prefix, so
   * the coordinator can trigger the actual re-point/reload. Optional and awaited
   * (may be sync or async). Not called on an idempotent repeat.
   */
  readonly onRepointed?: (urlPrefix: string) => void | Promise<void>;
}

/** Handles `artifacts:ready`, holding the last-applied prefix for idempotency. */
export interface ArtifactsRepointer {
  /**
   * Apply an `artifacts:ready` announcement: on a NEW `urlPrefix`, write the
   * ZK-config base env var then fire the re-point callback; on a repeat of the
   * last-applied prefix, return without side effects.
   */
  handleArtifactsReady(payload: ArtifactsReadyPayload): Promise<void>;
}

/**
 * Create an {@link ArtifactsRepointer}. The returned handler closes over the
 * last-applied `urlPrefix` (`undefined` until the first announcement) — that
 * single piece of state is what makes a repeat announcement a no-op.
 */
export function createArtifactsRepointer(deps: ArtifactsRepointerDeps): ArtifactsRepointer {
  let appliedUrlPrefix: string | undefined;

  return {
    async handleArtifactsReady(payload: ArtifactsReadyPayload): Promise<void> {
      const { urlPrefix } = payload;

      // Idempotency (D35): the same prefix arriving again is a no-op.
      if (urlPrefix === appliedUrlPrefix) return;

      // Re-point only after the write settles, so a failed write leaves the
      // last-applied state untouched and a retry re-applies.
      await deps.env.set(ZK_CONFIG_BASE_ENV_KEY, urlPrefix);
      appliedUrlPrefix = urlPrefix;

      await deps.onRepointed?.(urlPrefix);
    },
  };
}
