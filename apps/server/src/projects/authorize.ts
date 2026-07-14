/**
 * Connect-time project-ownership authorization (T-hijack, Defense 1).
 *
 * The WS connection handler exposes a {@link ProjectAuthorizer} seam that decides whether
 * an already-authenticated session may OPEN a connection for a given `projectId`. Left at
 * its allow-all default, ANY authenticated account could connect for — and then submit
 * prompts against — ANOTHER account's project, receiving that project's in-flight source
 * frames (`file:write`/`turn:message`) and settling turns against the VICTIM's ledger
 * account. This module wires the real check: a session may connect for a project ONLY when
 * its account OWNS that project.
 *
 * Ownership is on the unshielded address (D43), mirroring the HTTP project routes'
 * `project?.ownerAddress === auth.address` rule (`projects/routes.ts`): a missing OR
 * not-owned project denies, so existence is never leaked (the WS handler answers a uniform
 * `4403 FORBIDDEN`). A `getProject` REJECTION fails CLOSED (deny) — the store is the sole
 * source of truth for ownership, so an unavailable store must never widen access.
 */
import type { ProjectAuthorizer, Session } from "../protocol/index.js";
import type { ProjectStore } from "./store.js";

/**
 * Build the connect-time {@link ProjectAuthorizer}: allow iff the session's account owns
 * `projectId`. Takes only the `getProject` slice of the {@link ProjectStore} it needs, so
 * tests can inject a one-method fake.
 *
 * A missing or not-owned project resolves `false`; a `getProject` rejection also resolves
 * `false` (fail closed). The seam never throws — the handler awaits a boolean either way —
 * so a store fault degrades to a denied connection, never an unhandled rejection.
 */
export function createProjectAuthorizer(
  store: Pick<ProjectStore, "getProject">,
): ProjectAuthorizer {
  return async (session: Session, projectId: string): Promise<boolean> => {
    try {
      const project = await store.getProject(projectId);
      // A `null` (missing) project narrows `project?.ownerAddress` to `undefined`, which
      // can never equal the address — so missing and not-owned both deny (SC-027).
      return project?.ownerAddress === session.accountAddress;
    } catch {
      // Fail closed: an unavailable store denies the connection rather than granting it.
      return false;
    }
  };
}
