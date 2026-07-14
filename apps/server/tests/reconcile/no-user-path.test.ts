/**
 * SC-039 static dependency audit (T177, US10) — reconcile adds ZERO latency to user paths:
 * "no user-facing endpoint invokes any reconcile code path" (FR-066 / D13). This is the
 * "static dependency check" SC-039 names, mechanised: statically scan every production source
 * file under `apps/server/src` for an IMPORT of a reconcile module (`reconcile.js` /
 * `reconcile-scheduler.js`) and assert the ONLY importers are the composition root (`index.ts`,
 * which arms the background scheduler at boot) and the scheduler itself (which imports the job
 * types). Any request-path module — a route, WS handler, the turn coordinator — importing
 * reconcile would fail this test.
 *
 * The reconcile modules are also deliberately kept OFF the `ledger/index.ts` barrel, so a route
 * importing `../ledger/index.js` never transitively pulls reconcile into a request path.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/**
 * Matches any reference to a reconcile module specifier (`.../reconcile[-scheduler].js`):
 *  - a static `import … from "…/reconcile.js"` / `export … from …`;
 *  - a dynamic `import("…/reconcile.js")` (a lazy pull inside a handler would evade a
 *    from-only regex — a real bypass of the zero-user-path guarantee, so it is caught too);
 *  - a bare side-effect `import "…/reconcile.js"`.
 */
const RECONCILE_IMPORT = /(?:from|import)\s*\(?\s*["'][^"']*[./]reconcile(?:-scheduler)?\.js["']/;

/** The ONLY files allowed to import a reconcile module (POSIX-relative to `apps/server/src`). */
const ALLOWED_IMPORTERS = ["index.ts", "ledger/reconcile-scheduler.ts"];

/** Recursively collect production `.ts` files (excluding tests) under `dir`. */
function collectSources(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectSources(full, base));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

describe("SC-039 — reconcile is off every user-facing path", () => {
  const sources = collectSources(SRC_DIR);

  it("finds the production source tree (sanity)", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources).toContain("index.ts");
    expect(sources).toContain("ledger/reconcile.ts");
  });

  it("is imported ONLY by the composition root and the scheduler", () => {
    const importers = sources.filter((rel) =>
      RECONCILE_IMPORT.test(readFileSync(`${SRC_DIR}/${rel}`, "utf8")),
    );
    expect(importers.sort()).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it("is never imported by a request-path module (routes, handlers, coordinator, router)", () => {
    const requestPath = sources.filter(
      (rel) =>
        rel.endsWith("routes.ts") ||
        rel.endsWith("handler.ts") ||
        rel.endsWith("coordinator.ts") ||
        rel.endsWith("router.ts") ||
        rel.endsWith("events.ts") ||
        rel.endsWith("app.ts"),
    );
    // Guard the guard: the request-path set must actually cover the known entrypoints.
    expect(requestPath).toContain("app.ts");
    expect(requestPath).toContain("turn/coordinator.ts");
    for (const rel of requestPath) {
      const source = readFileSync(`${SRC_DIR}/${rel}`, "utf8");
      expect(RECONCILE_IMPORT.test(source), `${rel} must not import a reconcile module`).toBe(
        false,
      );
    }
  });

  it("keeps reconcile off the ledger barrel (no transitive pull into request paths)", () => {
    const barrel = readFileSync(`${SRC_DIR}/ledger/index.ts`, "utf8");
    expect(RECONCILE_IMPORT.test(barrel)).toBe(false);
  });
});
