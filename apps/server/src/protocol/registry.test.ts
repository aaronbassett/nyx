/**
 * Single-live-session takeover registry tests (D40, T022).
 *
 * Deterministic and socket-free: the registry is generic, so plain sentinel
 * objects stand in for sockets. Proves a new claim displaces the prior live
 * socket, that a late release from a displaced socket cannot evict its
 * successor, and that the key is collision-safe.
 */
import { describe, expect, it } from "vitest";
import { createSessionRegistry, sessionKey } from "./registry.js";

/** Distinct sentinel "sockets" — only identity matters to the registry. */
function socket(id: string): { readonly id: string } {
  return { id };
}

describe("createSessionRegistry", () => {
  it("makes the first claim live with no prior socket", () => {
    const registry = createSessionRegistry<{ id: string }>();
    const a = socket("a");
    expect(registry.claim("k", a)).toBeUndefined();
    expect(registry.get("k")).toBe(a);
  });

  it("displaces and returns the prior socket on a new claim (last-tab-wins)", () => {
    const registry = createSessionRegistry<{ id: string }>();
    const a = socket("a");
    const b = socket("b");
    registry.claim("k", a);
    expect(registry.claim("k", b)).toBe(a);
    expect(registry.get("k")).toBe(b);
  });

  it("ignores a late release from a socket that was already displaced", () => {
    const registry = createSessionRegistry<{ id: string }>();
    const a = socket("a");
    const b = socket("b");
    registry.claim("k", a);
    registry.claim("k", b);
    // `a` closes AFTER being superseded: it must not evict `b`.
    registry.release("k", a);
    expect(registry.get("k")).toBe(b);
  });

  it("clears the key when the live socket releases", () => {
    const registry = createSessionRegistry<{ id: string }>();
    const a = socket("a");
    registry.claim("k", a);
    registry.release("k", a);
    expect(registry.get("k")).toBeUndefined();
  });

  it("keeps different (account, project) pairs on independent keys", () => {
    const registry = createSessionRegistry<{ id: string }>();
    const a = socket("a");
    const b = socket("b");
    registry.claim(sessionKey("acc", "p1"), a);
    registry.claim(sessionKey("acc", "p2"), b);
    expect(registry.get(sessionKey("acc", "p1"))).toBe(a);
    expect(registry.get(sessionKey("acc", "p2"))).toBe(b);
  });
});

describe("sessionKey", () => {
  it("is stable for the same (account, project)", () => {
    expect(sessionKey("acc", "proj")).toBe(sessionKey("acc", "proj"));
  });

  it("cannot collide across a shifted field boundary", () => {
    // Without an unambiguous separator, ("a","bc") and ("ab","c") would collide.
    expect(sessionKey("a", "bc")).not.toBe(sessionKey("ab", "c"));
  });
});
