/**
 * `CompileResultsInbox` contract tests (P2 — browser-delegating compile, Task 7).
 *
 * The inbox is the server-side rendezvous for the `compile:run` → `compile:results`
 * round-trip: {@link BrowserCompileClient} `register`s a wait per `(turnId, kind)`
 * OWNED by a project, and the WS `compile:results` handler `deliver`s the client's
 * verdict. It mirrors the verify loop's `PendingTestResultsInbox` (`turn/coordinator.ts`):
 *  - a delivery resolves only the matching `(turnId, kind)` wait — a `check` verdict
 *    never resolves a `full` wait (or vice versa);
 *  - a cross-tenant delivery (wrong `deliveringProjectId`) is IGNORED and leaves the
 *    wait pending so the OWNER's later delivery still resolves it (Defense-4 lesson);
 *  - a bounded timeout resolves `null` (never rejects) and frees the wait;
 *  - a late/duplicate/unknown delivery is a silent no-op, never a throw.
 */
import { describe, expect, it } from "vitest";
import type { CompileResultsPayload } from "@nyx/protocol";
import { createCompileResultsInbox } from "../../src/compile/inbox.js";

/** A delay that never resolves — the timeout leg is disabled, so delivery must win. */
const neverDelay = (): Promise<void> =>
  new Promise<void>(() => {
    /* never resolves */
  });

/** A delay that resolves on the next microtask — the timeout leg fires deterministically. */
const immediateDelay = (): Promise<void> => Promise.resolve();

/** Build a schema-shaped `compile:results` payload for one `(turnId, kind)`. */
function resultsPayload(
  turnId: string,
  kind: "check" | "full",
  overrides: Partial<CompileResultsPayload> = {},
): CompileResultsPayload {
  return {
    turnId: turnId as CompileResultsPayload["turnId"],
    kind,
    ok: true,
    diagnostics: [],
    compilerVersion: "0.31.1",
    durationMs: 12,
    ...overrides,
  };
}

const TURN = "turn-1";
const OWNER = "project-owner";
const INTRUDER = "project-intruder";

describe("createCompileResultsInbox", () => {
  it("resolves the matching (turnId, kind) wait when the owner delivers", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const pending = inbox.register(TURN, "check", OWNER, 1_000);
    const payload = resultsPayload(TURN, "check");

    inbox.deliver(payload, OWNER);

    await expect(pending).resolves.toEqual(payload);
  });

  it("does not resolve a full wait with a check delivery (kind is part of the key)", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const fullWait = inbox.register(TURN, "full", OWNER, 1_000);

    // A check verdict for the same turn must NOT settle the full wait.
    inbox.deliver(resultsPayload(TURN, "check"), OWNER);

    let settled = false;
    void fullWait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // The matching full verdict settles it.
    const fullPayload = resultsPayload(TURN, "full", {
      sourceHash: "a".repeat(64),
      circuits: [{ name: "main", proof: true }],
    });
    inbox.deliver(fullPayload, OWNER);
    await expect(fullWait).resolves.toEqual(fullPayload);
  });

  it("independent check and full waits for one turn resolve independently", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const checkWait = inbox.register(TURN, "check", OWNER, 1_000);
    const fullWait = inbox.register(TURN, "full", OWNER, 1_000);

    const checkPayload = resultsPayload(TURN, "check");
    inbox.deliver(checkPayload, OWNER);
    await expect(checkWait).resolves.toEqual(checkPayload);

    const fullPayload = resultsPayload(TURN, "full", { sourceHash: "b".repeat(64) });
    inbox.deliver(fullPayload, OWNER);
    await expect(fullWait).resolves.toEqual(fullPayload);
  });

  it("ignores a cross-tenant delivery and still resolves for the owner (Defense 4)", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const pending = inbox.register(TURN, "check", OWNER, 1_000);

    // A foreign socket cannot force a verdict for a turn it does not own.
    inbox.deliver(resultsPayload(TURN, "check", { ok: false }), INTRUDER);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // The owner's own verdict still resolves the wait.
    const ownerPayload = resultsPayload(TURN, "check");
    inbox.deliver(ownerPayload, OWNER);
    await expect(pending).resolves.toEqual(ownerPayload);
  });

  it("resolves null on timeout and frees the wait", async () => {
    const inbox = createCompileResultsInbox({ delay: immediateDelay });
    const pending = inbox.register(TURN, "check", OWNER, 1_000);

    await expect(pending).resolves.toBeNull();

    // The wait is freed: a post-timeout delivery finds nothing and is dropped (no throw),
    // and a fresh register for the same key works normally.
    expect(() => {
      inbox.deliver(resultsPayload(TURN, "check"), OWNER);
    }).not.toThrow();

    const second = inbox.register(TURN, "check", OWNER, 1_000);
    const secondPayload = resultsPayload(TURN, "check", { durationMs: 99 });
    inbox.deliver(secondPayload, OWNER);
    await expect(second).resolves.toEqual(secondPayload);
  });

  it("drops an unknown delivery (no waiter) without throwing", () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    expect(() => {
      inbox.deliver(resultsPayload("no-such-turn", "check"), OWNER);
    }).not.toThrow();
  });

  it("drops a duplicate delivery after the wait already resolved (no double-resolve, no throw)", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const pending = inbox.register(TURN, "full", OWNER, 1_000);

    const first = resultsPayload(TURN, "full", { sourceHash: "c".repeat(64) });
    inbox.deliver(first, OWNER);
    await expect(pending).resolves.toEqual(first);

    // A duplicate/late delivery for the same key is a silent no-op.
    expect(() => {
      inbox.deliver(resultsPayload(TURN, "full", { sourceHash: "d".repeat(64) }), OWNER);
    }).not.toThrow();
  });

  it("omits the ownership check when no deliveringProjectId is given (trusted in-process caller)", async () => {
    const inbox = createCompileResultsInbox({ delay: neverDelay });
    const pending = inbox.register(TURN, "check", OWNER, 1_000);

    const payload = resultsPayload(TURN, "check");
    inbox.deliver(payload);

    await expect(pending).resolves.toEqual(payload);
  });
});
