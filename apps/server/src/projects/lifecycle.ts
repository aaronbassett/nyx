/**
 * Ephemeral deletion cascade for a soft-deleted project (T054, D49).
 *
 * Deletion is SOFT with a 30-day recovery window (the row keeps `deleted_at`, the
 * store owns the flip), but the ephemeral cascade runs IMMEDIATELY: the durable
 * Postgres rows stay recoverable while every ephemeral side effect is torn down at
 * once. Each side effect is a clearly-marked SEAM that no-ops for US7 — the real
 * implementations land with their owning stories. The cascade is invoked
 * synchronously from the DELETE route right after the soft-delete commits.
 *
 * Retention (`purgeDeletedProjects`, `pruneFileVersions`) is NOT here — those are
 * DB routines on the store, invoked by an operator/scheduler (D48/D49).
 */

/** The immediate ephemeral teardown fired on soft-delete (D49). */
export interface DeletionCascade {
  run(projectId: string): Promise<void>;
}

/**
 * The three ephemeral side effects, each injectable so a test can assert the
 * cascade fires them (and so later stories can wire the real teardown without
 * touching this module). Every seam defaults to a no-op for US7.
 */
export interface CascadeSeams {
  /** Tear down active deploys through the deploy registry (S8). */
  readonly teardownContracts?: (projectId: string) => Promise<void>;
  /** Delete the project's compiled-artifact prefix in R2 (D7). */
  readonly cleanupR2Prefix?: (projectId: string) => Promise<void>;
  /** Terminate the live session with notice (D40). */
  readonly terminateSessions?: (projectId: string) => Promise<void>;
}

const noop = (): Promise<void> => Promise.resolve();

/**
 * Build the deletion cascade. With no seams supplied every side effect is a no-op —
 * the durable soft-delete is the only observable effect in US7.
 */
export function createDeletionCascade(seams: CascadeSeams = {}): DeletionCascade {
  const teardownContracts = seams.teardownContracts ?? noop;
  const cleanupR2Prefix = seams.cleanupR2Prefix ?? noop;
  const terminateSessions = seams.terminateSessions ?? noop;

  return {
    async run(projectId: string): Promise<void> {
      // TODO(T158): contract teardown handoff — drive S8 registry teardown for active deploys.
      await teardownContracts(projectId);
      // TODO(R2): prefix cleanup — delete the project's compiled-artifact prefix (D7/D26).
      await cleanupR2Prefix(projectId);
      // TODO(WS): open-session termination — evict the single live session with notice (D40).
      await terminateSessions(projectId);
    },
  };
}
