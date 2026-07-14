/**
 * Connect-time project-ownership authorizer unit tests (T-hijack, Defense 1).
 *
 * The authorizer is the WS `ProjectAuthorizer` seam: it may only OPEN a connection for a
 * project the session's account OWNS (D43). These pin the four outcomes in isolation with
 * a one-method fake `getProject` — no DB, no socket (constitution IV):
 *  - an owned project authorizes;
 *  - a project owned by someone else denies (never leaking that it exists);
 *  - a missing project (`getProject` → null) denies;
 *  - a `getProject` REJECTION denies (fail closed — a store outage never widens access).
 */
import { describe, expect, it } from "vitest";
import { ProjectSchema, type Project } from "@nyx/protocol";
import { createProjectAuthorizer } from "../../src/projects/authorize.js";
import type { Session } from "../../src/protocol/index.js";
import type { ProjectStore } from "../../src/projects/store.js";

const OWNER = "addr-owner-1";
const OTHER = "addr-attacker-2";
const PROJECT_ID = "proj-1";

/** A session for `address` — the connection's authenticated account. */
function session(address: string): Session {
  return { accountAddress: address };
}

/** A live {@link Project} owned by `ownerAddress`. */
function project(ownerAddress: string): Project {
  return ProjectSchema.parse({
    id: PROJECT_ID,
    ownerAddress,
    name: "counter",
    createdAt: 1_700_000_000_000,
  });
}

/** A one-method `getProject` fake standing in for the {@link ProjectStore}. */
function store(getProject: () => Promise<Project | null>): Pick<ProjectStore, "getProject"> {
  return { getProject };
}

describe("createProjectAuthorizer", () => {
  it("authorizes a session for a project it owns", async () => {
    const authorize = createProjectAuthorizer(store(() => Promise.resolve(project(OWNER))));
    await expect(authorize(session(OWNER), PROJECT_ID)).resolves.toBe(true);
  });

  it("denies a session for a project owned by another account (no existence leak)", async () => {
    const authorize = createProjectAuthorizer(store(() => Promise.resolve(project(OWNER))));
    await expect(authorize(session(OTHER), PROJECT_ID)).resolves.toBe(false);
  });

  it("denies when the project does not exist (getProject → null)", async () => {
    const authorize = createProjectAuthorizer(store(() => Promise.resolve(null)));
    await expect(authorize(session(OWNER), PROJECT_ID)).resolves.toBe(false);
  });

  it("fails closed: denies when getProject rejects", async () => {
    const authorize = createProjectAuthorizer(
      store(() => Promise.reject(new Error("store transport down"))),
    );
    await expect(authorize(session(OWNER), PROJECT_ID)).resolves.toBe(false);
  });
});
