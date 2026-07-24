/**
 * SC-031 deploy-key ZERO-exposure audit (T160, US8, constitution III / D52).
 *
 * THE SC-031 CI GATE. A STATIC, deterministic assertion suite — the CI hook proving the deploy key
 * can NEVER reach a client-bound surface (an emitted WS frame, a REST reply, a `publicConfig`
 * projection) or a log/diagnostic. It attacks the exposure surface from four angles:
 *
 *  1. CONFIG PROJECTION — `publicConfig` (the only sanctioned server→boundary projection) drops
 *     `secrets` entirely, so the type has no `secrets`/`deployKey` key AND a real projected
 *     config carries neither at runtime (while the private `Config.secrets.deployKey` still
 *     holds it server-side).
 *  2. WIRE PAYLOADS — the deploy protocol payloads a client can receive (`DeployStatusPayload`,
 *     `ContractDeployedPayload`, `DeployRegistryRow`) have EXACTLY their known safe keys — none
 *     of which could carry key material — asserted against each schema's own shape.
 *  3. SOURCE AUDIT — a grep-style scan of `apps/server/src/deploy/*.ts` (which now includes the real
 *     `devnet-executor.ts`, `sdk-adapter.ts`, `balance.ts`, and `balance-sdk-adapter.ts` — all read
 *     verbatim by `readdirSync`) **and the construction site `apps/server/src/index.ts`** + the
 *     `publicConfig` constructor: the deploy modules never reference `deployKey`/`DEPLOY_KEY`, and no
 *     emitted-frame line (`ctx.send`/`emit`/`emitContractDeployed`/`reply.send`) nor log line
 *     (`console`/`process.std*.write`) nor the `publicConfig` body names key material.
 *  4. CONSTRUCTION SITE — in `index.ts` the deploy key (`config.secrets.deployKey`) flows ONLY into
 *     the two sanctioned deploy dependencies — `createDevnetDeployExecutor({ signingKey: ... })` and
 *     `createDevnetBalanceQuery({ signingKey: ... })` — and NOWHERE else: not an emit sink, a log,
 *     the deposit-indexer/vault-reader wiring, or a `publicConfig` projection.
 *
 * WHY `signingKey` IS LOAD-BEARING HERE. `signingKey` is the deploy seams' key-FIELD name
 * (`DevnetDeployExecutorDeps.signingKey` in `deploy/devnet-executor.ts`, `DevnetBalanceQueryDeps.
 * signingKey` in `deploy/balance.ts`); the value it holds is `config.secrets.deployKey`, wired in by
 * `index.ts` at exactly those two construction sites. The lines that actually MOVE the key are those
 * constructions — and the highest-risk future regression is a real Midnight-SDK adapter
 * (`deploy/sdk-adapter.ts` / `deploy/balance-sdk-adapter.ts`) that does `console.log(deps.signingKey)`
 * or folds it into a proof/error/`deploy:status.detail`. Neither would have named
 * `deployKey`/`DEPLOY_KEY`, so both would have SAILED THROUGH the old gate at the exact spot
 * constitution III cares about most. So `signingKey` is now a forbidden token on any emitted-frame /
 * log / `publicConfig` line — while the seams' LEGITIMATE `signingKey` field TYPE declarations and
 * their private dependency reads stay server-side and MUST keep passing.
 *
 * This is the SC-031 CI audit hook: a regression that routed the deploy key toward a client
 * surface (a leaked payload field, a `ctx.send`/log of a secret, a `signingKey` on an outbound
 * frame, a `publicConfig` that kept `secrets`) fails this suite LOUDLY, never silently.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ContractDeployedPayloadSchema,
  DeployRegistryRowSchema,
  DeployStatusPayloadSchema,
} from "@nyx/protocol";
import { loadConfig, publicConfig } from "../../src/config/index.js";
import type { PublicConfig } from "../../src/config/index.js";

// --- Shared audit vocabulary (the exact regexes the gate greps with; reused by the self-check
//     below so the teeth-proving fixtures exercise the SAME patterns the audit runs). ------------

/**
 * Key-material identifiers that must NEVER appear on a client-bound frame or a log line.
 * `signingKey` is the deploy executor's key-FIELD name (`deploy/executor.ts`); the value it holds is
 * `config.secrets.deployKey` (`index.ts`). Declaring it as a field TYPE or holding it as a private
 * dependency is fine (server-side); NAMING it on an emitted frame, a REST reply, or a log is the
 * regression this token set catches. `/secret/i` also flags the `secrets` bag and any `*Secret*`.
 */
const FORBIDDEN_KEY_TOKENS = /deployKey|DEPLOY_KEY|secret|\bsigningKey\b/i;

/**
 * A line that ships a frame to a connected client: the deploy pipeline's emit sinks
 * (`ctx.send`/`emit`/`emitContractDeployed`) plus a Fastify REST reply (`reply.send`).
 */
const EMITTED_FRAME_LINE =
  /ctx\s*\.\s*send\s*\(|(?<![A-Za-z])emit\s*\(|emitContractDeployed\s*\(|reply\s*\.\s*send\s*\(/;

/**
 * A line that writes to a log / diagnostic sink (where `console.log(deps.signingKey)` would live).
 * Includes `logError(` — the deploy modules' structured error seam (I1/I2 added loud fault logs to
 * the executor/handler); a regression that logged `{ signingKey: deps.signingKey }` through it must
 * fail this gate exactly like a raw `console.log` would. The scan is per-line, so the seam's rule
 * is "name no key material on the `logError(` line" (the executor/handler pass `error.name` ONLY).
 */
const LOG_SURFACE_LINE =
  /console\s*\.\s*\w+\s*\(|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(|logError\s*\(/;

/**
 * The FULL argument span of a `logError(...)` CALL, across newlines, up to its terminating `);`.
 * The per-line {@link LOG_SURFACE_LINE} scan sees a multi-line call's `logError(` OPENER line only —
 * so a `signingKey` on a CONTINUATION line (the detail object below the opener, as in the executor's
 * money-critical address-unavailable log) would slip past it. This span match captures every line of
 * the call so a key on ANY of them is caught. The `logError` token is lowercase-anchored, matching
 * the seams' guarded `logError(...)` call sites but NOT the `defaultLogError`/`rawLogError`
 * definitions (capital L → no lowercase `logError(` substring), so only real calls are scanned.
 * The terminator is an END-OF-LINE `);` (the `m` flag anchors `$` per line) — NOT merely the first
 * `);`. That matters: the executor's address-unavailable message literally contains "double-deploy);
 * ops reconcile", whose mid-line `);` would otherwise truncate the span BEFORE the detail object —
 * the exact blind spot L-1 closes. A real call's closing `);` sits alone at the end of its line, so
 * anchoring to end-of-line captures the WHOLE call (message + detail). Built fresh per use (`gm`) to
 * avoid shared `lastIndex` state.
 */
const LOG_ERROR_CALL_SPAN_SOURCE = String.raw`logError\s*\(([\s\S]*?)\);\s*$`;
/** Flags for {@link LOG_ERROR_CALL_SPAN_SOURCE}: `g` to scan all calls, `m` to anchor `$` per line. */
const LOG_ERROR_CALL_SPAN_FLAGS = "gm";

// --- A complete, valid env (mirrors config.test.ts) so `loadConfig` yields a real Config. ---

function routingJson(): string {
  return JSON.stringify({
    supervisor: { provider: "anthropic", model: "model-supervisor" },
    scaffolding: { provider: "openai", model: "model-scaffolding" },
    planning: { provider: "gemini", model: "model-planning" },
    implementation: { provider: "openrouter", model: "vendor/model-impl" },
    review: {
      provider: "openai-compatible",
      model: "local-review",
      baseUrl: "https://infer.internal/v1",
    },
  });
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/nyx",
    MCP_TOME_URL: "https://tome.example/mcp",
    MCP_MNM_URL: "https://mnm.example/mcp",
    PROVER_URL: "https://prover.example",
    DEPLOY_KEY: "deploy-secret-value",
    MODEL_ROUTING: routingJson(),
  };
}

// --- 1. Config projection ---------------------------------------------------

describe("SC-031: publicConfig never carries the deploy key", () => {
  it("PublicConfig type omits `secrets` (compile-time)", () => {
    // `Extract<keyof PublicConfig, "secrets">` is `never` iff PublicConfig has no `secrets` key
    // (and `deployKey` lives only under `secrets`, so this covers it). Compiles ONLY when true.
    const noSecretsKey: [Extract<keyof PublicConfig, "secrets">] extends [never] ? true : false =
      true;
    expect(noSecretsKey).toBe(true);
  });

  it("a projected config drops secrets/deployKey while the private config still holds the key", () => {
    const config = loadConfig(validEnv());
    // Sanity: the private, server-side config DOES hold the key (it must, to sign deploys).
    expect(config.secrets.deployKey).toBe("deploy-secret-value");

    const projected = publicConfig(config);
    // The client-bound projection has NO secrets bag and no top-level deployKey.
    expect("secrets" in projected).toBe(false);
    expect("deployKey" in (projected as Record<string, unknown>)).toBe(false);
    // Belt-and-braces: the key value does not appear anywhere in the serialized projection
    // (bigint-safe stringify, mirroring the WS `serializeEvent` encoder).
    const serialized = JSON.stringify(projected, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("deploy-secret-value");
  });
});

// --- 2. Wire payload shapes -------------------------------------------------

describe("SC-031: deploy protocol payloads carry only key-safe fields", () => {
  it("DeployStatusPayload exposes only requestId/phase/detail", () => {
    expect(Object.keys(DeployStatusPayloadSchema.shape).sort()).toEqual([
      "detail",
      "phase",
      "requestId",
    ]);
  });

  it("ContractDeployedPayload exposes only the contract address", () => {
    expect(Object.keys(ContractDeployedPayloadSchema.shape)).toEqual(["address"]);
  });

  it("DeployRegistryRow exposes only project/address/version/status/deployedAt/txRef", () => {
    expect(Object.keys(DeployRegistryRowSchema.shape).sort()).toEqual(
      ["address", "deployedAt", "projectId", "status", "txRef", "version"].sort(),
    );
  });
});

// --- 3. Source audit (grep-style) ------------------------------------------

/** Read every `.ts` file in `apps/server/src/deploy/` (resolved relative to this test). */
function readDeploySources(): { file: string; source: string }[] {
  const deployDir = fileURLToPath(new URL("../../src/deploy/", import.meta.url));
  return readdirSync(deployDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: name,
      source: readFileSync(new URL(name, new URL("../../src/deploy/", import.meta.url)), "utf8"),
    }));
}

/** Read `apps/server/src/index.ts` — the executor construction site where the key is wired in. */
function readServerIndex(): { file: string; source: string } {
  return {
    file: "index.ts",
    source: readFileSync(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), "utf8"),
  };
}

/** deploy/*.ts + the construction site: the union scanned for outbound-frame / log leaks. */
function readOutboundSurfaceSources(): { file: string; source: string }[] {
  return [...readDeploySources(), readServerIndex()];
}

describe("SC-031: the deploy key never flows into an outbound frame (source audit)", () => {
  it("no deploy module references deployKey / DEPLOY_KEY / secrets.deployKey", () => {
    // Scoped to deploy/*.ts ONLY (incl. the real devnet-executor/sdk-adapter/balance/balance-sdk-
    // adapter modules) — `index.ts` legitimately names `config.secrets.deployKey` at the two
    // sanctioned construction sites (covered by the dedicated construction-site audit below).
    const forbidden = [/\bdeployKey\b/, /\bDEPLOY_KEY\b/, /secrets\s*\.\s*deployKey/];
    for (const { file, source } of readDeploySources()) {
      for (const pattern of forbidden) {
        expect(source, `${file} must not reference deploy-key material`).not.toMatch(pattern);
      }
    }
  });

  it("no emitted-frame line (ctx.send / emit / emitContractDeployed / reply.send) carries key material", () => {
    for (const { file, source } of readOutboundSurfaceSources()) {
      for (const line of source.split("\n")) {
        if (EMITTED_FRAME_LINE.test(line)) {
          expect(
            line,
            `${file}: an emitted frame must not reference a key/secret (incl. signingKey)`,
          ).not.toMatch(FORBIDDEN_KEY_TOKENS);
        }
      }
    }
  });

  it("no log line (console / process.std*.write) carries key material", () => {
    // Closes the highest-risk regression: a real deploy adapter in executor.ts doing
    // `console.log(deps.signingKey)` (or logging it from index.ts) would name `signingKey` here.
    for (const { file, source } of readOutboundSurfaceSources()) {
      for (const line of source.split("\n")) {
        if (LOG_SURFACE_LINE.test(line)) {
          expect(
            line,
            `${file}: a log line must not reference a key/secret (incl. signingKey)`,
          ).not.toMatch(FORBIDDEN_KEY_TOKENS);
        }
      }
    }
  });

  it("no logError(...) call span carries key material — even on a continuation line (L-1)", () => {
    // The per-line scan above cannot see a `signingKey` on a logError CONTINUATION line (a multi-line
    // call whose detail object sits below the `logError(` opener — e.g. the executor's money-critical
    // address-unavailable log). Scan each call's FULL argument span so a key on ANY of its lines is
    // caught. The seams pass `errorName`/`txRef`/key-free context only, so this must PASS today.
    for (const { file, source } of readOutboundSurfaceSources()) {
      for (const [span] of source.matchAll(
        new RegExp(LOG_ERROR_CALL_SPAN_SOURCE, LOG_ERROR_CALL_SPAN_FLAGS),
      )) {
        expect(
          span,
          `${file}: a logError(...) call must not reference a key/secret (incl. signingKey) on ANY of its lines`,
        ).not.toMatch(FORBIDDEN_KEY_TOKENS);
      }
    }
  });

  it("the span scan captures the executor's address-unavailable call WHOLE (message + detail, no truncation)", () => {
    // Positive coverage / regression guard: the executor's money-critical address-unavailable log
    // has a message that literally contains "double-deploy);" — a mid-line `);`. The span terminator
    // must NOT stop there (that would drop the detail object below it from the scan), so at least one
    // captured span must contain BOTH the "UNAVAILABLE" message marker AND its `errorName` detail key.
    const executor = readDeploySources().find((entry) => entry.file === "devnet-executor.ts");
    expect(executor).toBeDefined();
    const spans = [
      ...(executor?.source ?? "").matchAll(
        new RegExp(LOG_ERROR_CALL_SPAN_SOURCE, LOG_ERROR_CALL_SPAN_FLAGS),
      ),
    ].map(([span]) => span);
    const addressUnavailableSpan = spans.find((span) => span.includes("UNAVAILABLE"));
    expect(
      addressUnavailableSpan,
      "the address-unavailable logError call must be captured",
    ).toBeDefined();
    // Whole-call capture: the detail's `errorName` (which sits BELOW the mid-line `);`) is in the span.
    expect(addressUnavailableSpan).toContain("errorName");
    expect(addressUnavailableSpan).toContain("txRef");
  });

  it("the publicConfig constructor references no secret/deployKey", () => {
    const configIndex = readFileSync(
      fileURLToPath(new URL("../../src/config/index.ts", import.meta.url)),
      "utf8",
    );
    // Isolate the `publicConfig` function body (up to its first closing brace at column 0).
    const body = /export function publicConfig[\s\S]*?\n}/.exec(configIndex)?.[0] ?? "";
    expect(body).not.toBe("");
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/deployKey/);
  });
});

// --- 4. Construction-site audit (index.ts) ---------------------------------

describe("SC-031: in index.ts the deploy key flows ONLY into the deploy-seam constructions", () => {
  it("names the deploy key exactly twice — each as a `signingKey:` dependency", () => {
    const { source } = readServerIndex();
    // The key value (`config.secrets.deployKey`) and the bare `signingKey` identifier each appear
    // EXACTLY twice — once for the executor construction, once for the balance-query construction —
    // and EVERY occurrence is a `signingKey: config.secrets.deployKey` dependency. Nothing else in
    // the entry point may name either. (The vault-state-reader/deposit-indexer wiring takes NO key.)
    expect(source.match(/config\s*\.\s*secrets\s*\.\s*deployKey/g) ?? []).toHaveLength(2);
    expect(source.match(/\bsigningKey\b/g) ?? []).toHaveLength(2);
    expect(
      source.match(/signingKey\s*:\s*config\s*\.\s*secrets\s*\.\s*deployKey/g) ?? [],
    ).toHaveLength(2);
  });

  it("holds the key inside the two deploy-seam constructions and NOWHERE else (no emit/log/publicConfig)", () => {
    const { source } = readServerIndex();
    // The sanctioned server-side sinks: the executor + balance-query factory arguments.
    const executorConstruction =
      /createDevnetDeployExecutor\s*\(\s*\{[\s\S]*?\}\s*\)/.exec(source)?.[0] ?? "";
    const balanceConstruction =
      /createDevnetBalanceQuery\s*\(\s*\{[\s\S]*?\}\s*\)/.exec(source)?.[0] ?? "";
    expect(executorConstruction).not.toBe("");
    expect(balanceConstruction).not.toBe("");
    expect(executorConstruction).toMatch(/signingKey\s*:\s*config\s*\.\s*secrets\s*\.\s*deployKey/);
    expect(balanceConstruction).toMatch(/signingKey\s*:\s*config\s*\.\s*secrets\s*\.\s*deployKey/);
    // Excise BOTH construction sites; the key value AND its field name vanish entirely from the rest
    // of index.ts — so no `ctx.send`/`emit`/`reply.send`, log, or `publicConfig` line can name them.
    const rest = source.replace(executorConstruction, "").replace(balanceConstruction, "");
    expect(rest).not.toMatch(/config\s*\.\s*secrets\s*\.\s*deployKey/);
    expect(rest).not.toMatch(/\bsigningKey\b/);
  });

  it("no emit/log/publicConfig line in index.ts names key material (defense in depth)", () => {
    const { source } = readServerIndex();
    const clientOrLogSurface = new RegExp(
      [EMITTED_FRAME_LINE.source, LOG_SURFACE_LINE.source, /publicConfig\s*\(/.source].join("|"),
    );
    for (const line of source.split("\n")) {
      if (clientOrLogSurface.test(line)) {
        expect(
          line,
          "index.ts: an emitted frame / log / publicConfig line must not name key material",
        ).not.toMatch(FORBIDDEN_KEY_TOKENS);
      }
    }
  });
});

// --- 5. Self-check: the gate has teeth (and stays correctly scoped) ---------

describe("SC-031: the audit catches a real leak (regex self-check)", () => {
  it("flags an emitted frame that carries the executor's signingKey field", () => {
    const violation = "      ctx.send({ requestId, phase, detail, signingKey: deps.signingKey });";
    expect(EMITTED_FRAME_LINE.test(violation)).toBe(true);
    expect(violation).toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("flags a deploy:status.detail that interpolates the deploy key", () => {
    const violation = '        deps.emit({ requestId, phase: "failed", detail: signingKey });';
    expect(EMITTED_FRAME_LINE.test(violation)).toBe(true);
    expect(violation).toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("flags a REST reply that leaks the raw deploy key", () => {
    const violation = "    reply.send({ error: config.secrets.deployKey });";
    expect(EMITTED_FRAME_LINE.test(violation)).toBe(true);
    expect(violation).toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("flags a console.log of the executor's signingKey dependency", () => {
    const violation = "  console.log(deps.signingKey);";
    expect(LOG_SURFACE_LINE.test(violation)).toBe(true);
    expect(violation).toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("flags a logError call that names the executor's signingKey dependency (I1/I2 loud logs)", () => {
    // The exact regression the loud deploy-fault logs (I1/I2) could introduce: passing the raw key
    // (or a key-bearing field) through the structured error seam instead of `error.name` only.
    const violation = '    logError("deploy submit failed", { signingKey: deps.signingKey });';
    expect(LOG_SURFACE_LINE.test(violation)).toBe(true);
    expect(violation).toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("does NOT flag the loud logs' legitimate name-only detail (errorName)", () => {
    // The sanctioned shape the executor/handler actually use: the error NAME only, never the key.
    const safe = '    logError("deploy build failed", { phase: "proving", errorName: name });';
    expect(safe).not.toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("the span scan catches a MULTI-LINE logError with signingKey on a continuation line (L-1)", () => {
    // The exact blind spot L-1 closes: a multi-line call whose OPENER line is clean but whose detail
    // object (a continuation line) carries the key — the shape of the executor's money-critical
    // address-unavailable log.
    const violation = [
      "          logError(",
      '            "deploy FINALIZED on-chain but the contract address was UNAVAILABLE",',
      "            { txRef: request.txRef, signingKey: deps.signingKey },",
      "          );",
    ].join("\n");
    const openerLine = violation.split("\n")[0] ?? "";
    // The per-line scan sees the opener (a log surface) but the opener alone is CLEAN — so the old
    // per-line check would MISS the key sitting on the continuation line below it.
    expect(openerLine).toMatch(LOG_SURFACE_LINE);
    expect(openerLine).not.toMatch(FORBIDDEN_KEY_TOKENS);
    // The full-span scan captures every line of the call and DOES catch the leaked signingKey.
    const [span] =
      [
        ...violation.matchAll(new RegExp(LOG_ERROR_CALL_SPAN_SOURCE, LOG_ERROR_CALL_SPAN_FLAGS)),
      ][0] ?? [];
    expect(span).toBeDefined();
    expect(span).toMatch(FORBIDDEN_KEY_TOKENS);
  });

  it("does NOT flag the executor's legitimate signingKey field type declaration or private read", () => {
    // executor.ts DECLARES `signingKey` as a field type and holds it as a private dependency — that
    // is the key staying SERVER-SIDE, not an exposure. The gate is scoped to emit/log surface lines,
    // so a bare declaration or a private destructuring read is NOT a violation. (If these WERE
    // flagged, the honest owner-gated stub would fail — proving the check would be too broad.)
    const fieldDeclaration = "  readonly signingKey: string;";
    expect(EMITTED_FRAME_LINE.test(fieldDeclaration)).toBe(false);
    expect(LOG_SURFACE_LINE.test(fieldDeclaration)).toBe(false);

    const wiringDep = "    signingKey: config.secrets.deployKey,";
    expect(EMITTED_FRAME_LINE.test(wiringDep)).toBe(false);
    expect(LOG_SURFACE_LINE.test(wiringDep)).toBe(false);
  });
});
