/**
 * Deletion-cascade tests (T054) — the immediate ephemeral teardown on soft-delete.
 *
 * For US7 every side effect is a STUBBED seam (no-op by default). These tests prove
 * the cascade fires all three seams, in order, with the project id — the contract the
 * later stories fill in (contract teardown S8, R2 prefix cleanup, session termination).
 */
import { describe, expect, it } from "vitest";
import { createDeletionCascade } from "../../src/projects/index.js";

describe("createDeletionCascade (D49)", () => {
  it("runs with default no-op seams (US7: durable soft-delete is the only effect)", async () => {
    const cascade = createDeletionCascade();
    await expect(cascade.run("proj-1")).resolves.toBeUndefined();
  });

  it("fires every seam exactly once, in order, with the project id", async () => {
    const calls: string[] = [];
    const cascade = createDeletionCascade({
      teardownContracts: (id) => {
        calls.push(`contracts:${id}`);
        return Promise.resolve();
      },
      cleanupR2Prefix: (id) => {
        calls.push(`r2:${id}`);
        return Promise.resolve();
      },
      terminateSessions: (id) => {
        calls.push(`sessions:${id}`);
        return Promise.resolve();
      },
    });

    await cascade.run("proj-42");
    expect(calls).toEqual(["contracts:proj-42", "r2:proj-42", "sessions:proj-42"]);
  });
});
