/**
 * Project route tests (T052/T054/T055) — driven through `app.inject()` against the
 * real `buildServer` wiring with injected in-memory auth + project stores, so they
 * are fully deterministic with NO external Postgres and NO wallet.
 *
 * Coverage:
 *  - SC-027 ownership matrix: owner 200 / other-account 404 (existence never leaks) /
 *    unauthenticated 401, across read + lifecycle routes;
 *  - lifecycle: create (+ count quota 409), rename, soft-delete (+ immediate cascade),
 *    restore — the D49 round-trip end to end;
 *  - reads: manifest (D38), file content, and chat rehydration (D23) — populated via the
 *    internal store write path (there is no file/chat WRITE REST endpoint in US7);
 *  - a missing file read fails loudly naming the project + path (EC-34).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@nyx/protocol";
import { bootProjects } from "./helpers.js";
import type { ProjectHarness } from "./helpers.js";

const OWNER = "owner-address";
const OTHER = "other-address";

let h: ProjectHarness;
let ownerCookie: string;
let otherCookie: string;

beforeEach(async () => {
  h = await bootProjects();
  ownerCookie = await h.seedSession(OWNER);
  otherCookie = await h.seedSession(OTHER);
});

afterEach(async () => {
  await h.app.close();
});

/** Create a project as the owner via HTTP and return its DTO. */
async function createOwned(name = "demo"): Promise<Project> {
  const response = await h.app.inject({
    method: "POST",
    url: "/projects",
    headers: { cookie: ownerCookie },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<Project>();
}

describe("POST /projects — create (T054)", () => {
  it("creates a project owned by the session address and lists it", async () => {
    const project = await createOwned("first");
    expect(project.ownerAddress).toBe(OWNER);
    expect(project.name).toBe("first");
    expect(project.deletedAt).toBeUndefined();

    const list = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: { cookie: ownerCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<Project[]>().map((p) => p.id)).toEqual([project.id]);
  });

  it("rejects an unauthenticated create with 401", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects creating past the per-account quota with 409", async () => {
    const capped = await bootProjects({ projectQuotaPerAccount: 1 });
    const cookie = await capped.seedSession(OWNER);
    const first = await capped.app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { name: "one" },
    });
    expect(first.statusCode).toBe(201);
    const second = await capped.app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { name: "two" },
    });
    expect(second.statusCode).toBe(409);
    await capped.app.close();
  });
});

describe("PATCH /projects/:id — rename (T054)", () => {
  it("renames a project the caller owns", async () => {
    const project = await createOwned("before");
    const response = await h.app.inject({
      method: "PATCH",
      url: `/projects/${project.id}`,
      headers: { cookie: ownerCookie },
      payload: { name: "after" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Project>().name).toBe("after");
  });
});

describe("DELETE + restore — soft-delete round-trip (T054, D49)", () => {
  it("soft-deletes with the ephemeral cascade, then restores", async () => {
    const project = await createOwned();

    const deleted = await h.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<Project>().deletedAt).toBeGreaterThan(0);
    // The immediate ephemeral cascade fired synchronously for this project (D49).
    expect(h.cascade.fired).toEqual([project.id]);

    // Soft-deleted projects drop out of the list.
    const afterDelete = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: { cookie: ownerCookie },
    });
    expect(afterDelete.json<Project[]>()).toEqual([]);

    const restored = await h.app.inject({
      method: "POST",
      url: `/projects/${project.id}/restore`,
      headers: { cookie: ownerCookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<Project>().deletedAt).toBeUndefined();

    const afterRestore = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: { cookie: ownerCookie },
    });
    expect(afterRestore.json<Project[]>().map((p) => p.id)).toEqual([project.id]);
  });
});

describe("ownership gating — SC-027 (owner OK / other 404 / anon 401)", () => {
  it("serves the manifest to the owner but 404s a different account and 401s anon", async () => {
    const project = await createOwned();
    await h.store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/index.ts", content: "export const x = 1;" }],
    });

    const owner = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/manifest`,
      headers: { cookie: ownerCookie },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json<{ path: string }[]>().map((e) => e.path)).toEqual(["src/index.ts"]);

    // A different account must not even learn the project exists — 404, not 403.
    const other = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/manifest`,
      headers: { cookie: otherCookie },
    });
    expect(other.statusCode).toBe(404);

    const anon = await h.app.inject({ method: "GET", url: `/projects/${project.id}/manifest` });
    expect(anon.statusCode).toBe(401);
  });

  it("denies cross-account rename and delete with 404", async () => {
    const project = await createOwned();
    const rename = await h.app.inject({
      method: "PATCH",
      url: `/projects/${project.id}`,
      headers: { cookie: otherCookie },
      payload: { name: "hijack" },
    });
    expect(rename.statusCode).toBe(404);

    const remove = await h.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
      headers: { cookie: otherCookie },
    });
    expect(remove.statusCode).toBe(404);
    // No cascade for a denied delete.
    expect(h.cascade.fired).toEqual([]);
  });
});

describe("reads — manifest / file / chat rehydration (T052/T055)", () => {
  it("reopens a project: manifest → file content → chat history", async () => {
    const project = await createOwned();
    await h.store.commit(project.id, {
      author: "agent",
      files: [
        { path: "a.ts", content: "alpha" },
        { path: "b.ts", content: "beta" },
      ],
    });
    await h.store.appendChat(project.id, { role: "user", content: "hi" });
    await h.store.appendChat(project.id, { role: "assistant", content: "hello" });

    const manifest = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/manifest`,
      headers: { cookie: ownerCookie },
    });
    expect(manifest.json<{ path: string }[]>().map((e) => e.path)).toEqual(["a.ts", "b.ts"]);

    const file = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/a.ts`,
      headers: { cookie: ownerCookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.json<{ content: string }>().content).toBe("alpha");

    const chat = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/chat`,
      headers: { cookie: ownerCookie },
    });
    expect(chat.json<{ content: string; seq: number }[]>()).toEqual([
      expect.objectContaining({ seq: 1, content: "hi" }),
      expect.objectContaining({ seq: 2, content: "hello" }),
    ]);
  });

  it("fails loudly naming the project + path for a missing file (EC-34)", async () => {
    const project = await createOwned();
    const response = await h.app.inject({
      method: "GET",
      url: `/projects/${project.id}/files/does/not/exist.ts`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: string; projectId: string; path: string }>();
    expect(body.projectId).toBe(project.id);
    expect(body.path).toBe("does/not/exist.ts");
  });
});
