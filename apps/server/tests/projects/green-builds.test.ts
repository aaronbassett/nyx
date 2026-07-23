/**
 * Green-build persistence tests (Task 5 — closes the "getLatestGreenBuild is a stub
 * returning null" gap so a deploy's FR-054 greenness gate can actually pass).
 *
 * A `ready` CompileOutcome is the ONLY green build; the store keeps exactly the LATEST
 * one per project (upsert, latest wins) and the deploy handler reads it AT DEPLOY TIME
 * (the US8 stale-build lesson). These deterministic scenarios run against the in-memory
 * double; `pg-store.test.ts` proves the same SQL against a live Postgres (DATABASE_URL).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeInMemoryStore } from "./helpers.js";
import type { Clock, InMemoryProjectStore } from "./helpers.js";

const ADDRESS = "addr-owner-green";

describe("ProjectStore green-build persistence (FR-054)", () => {
  let clock: Clock;
  let store: InMemoryProjectStore;
  let projectId: string;

  beforeEach(async () => {
    clock = { now: 1_000_000 };
    store = makeInMemoryStore(clock);
    const project = await store.createProject(ADDRESS, "counter");
    projectId = project.id;
  });

  it("records and returns the latest green build per project", async () => {
    await store.recordGreenBuild(projectId, { urlPrefix: "p1/hashA/", compilerVersion: "0.31.1" });
    await store.recordGreenBuild(projectId, { urlPrefix: "p1/hashB/", compilerVersion: "0.31.1" });
    await expect(store.getLatestGreenBuild(projectId)).resolves.toEqual({
      urlPrefix: "p1/hashB/",
      compilerVersion: "0.31.1",
    });
  });

  it("returns null when no green build exists", async () => {
    await expect(store.getLatestGreenBuild(projectId)).resolves.toBeNull();
  });

  it("keeps green builds isolated per project", async () => {
    const other = await store.createProject(ADDRESS, "other");
    await store.recordGreenBuild(projectId, { urlPrefix: "p1/hashA/", compilerVersion: "0.31.1" });
    await store.recordGreenBuild(other.id, { urlPrefix: "p2/hashZ/", compilerVersion: "0.30.0" });
    await expect(store.getLatestGreenBuild(projectId)).resolves.toEqual({
      urlPrefix: "p1/hashA/",
      compilerVersion: "0.31.1",
    });
    await expect(store.getLatestGreenBuild(other.id)).resolves.toEqual({
      urlPrefix: "p2/hashZ/",
      compilerVersion: "0.30.0",
    });
  });
});
