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
 *  3. SOURCE AUDIT — a grep-style scan of `apps/server/src/deploy/*.ts` **and the executor
 *     construction site `apps/server/src/index.ts`** + the `publicConfig` constructor: the deploy
 *     modules never reference `deployKey`/`DEPLOY_KEY`, and no emitted-frame line
 *     (`ctx.send`/`emit`/`emitContractDeployed`/`reply.send`) nor log line (`console`/
 *     `process.std*.write`) nor the `publicConfig` body names key material.
 *  4. CONSTRUCTION SITE — in `index.ts` the deploy key (`config.secrets.deployKey`) flows ONLY into
 *     the `createOwnerGatedDeployExecutor({ signingKey: ... })` dependency and NOWHERE else — not an
 *     emit sink, a log, or a `publicConfig` projection.
 *
 * WHY `signingKey` IS LOAD-BEARING HERE. `signingKey` is the deploy executor's key-FIELD name
 * (`OwnerGatedDeployExecutorDeps.signingKey` in `deploy/executor.ts`); the value it holds is
 * `config.secrets.deployKey`, wired in exactly once by `index.ts`. The line that actually MOVES the
 * key is the executor construction in `index.ts` — which the original audit never scanned — and the
 * highest-risk future regression is a real Midnight-SDK adapter in `deploy/executor.ts` that does
 * `console.log(deps.signingKey)` or folds it into a proof/error/`deploy:status.detail`. Neither
 * would have named `deployKey`/`DEPLOY_KEY`, so both would have SAILED THROUGH the old gate at the
 * exact spot constitution III cares about most. So `signingKey` is now a forbidden token on any
 * emitted-frame / log / `publicConfig` line — while the executor's LEGITIMATE `signingKey` field
 * TYPE declaration and its private dependency read stay server-side and MUST keep passing.
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

/** A line that writes to a log / diagnostic sink (where `console.log(deps.signingKey)` would live). */
const LOG_SURFACE_LINE =
  /console\s*\.\s*\w+\s*\(|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(/;

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
    MCP_TOOLCHAIN_URL: "http://nyx-toolchain.flycast:8080/mcp",
    MCP_TOME_URL: "https://tome.example/mcp",
    MCP_MNM_URL: "https://mnm.example/mcp",
    PROVER_URL: "https://prover.example",
    COMPILE_SERVICE_URL: "https://compile.internal/v1",
    DEPLOY_KEY: "deploy-secret-value",
    COMPILE_SERVICE_TOKEN: "compile-service-secret-token",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
    R2_ACCOUNT_ID: "r2-account-id",
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
    // Scoped to deploy/*.ts ONLY — `index.ts` legitimately names `config.secrets.deployKey` at the
    // sanctioned construction site (covered by the dedicated construction-site audit below).
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

describe("SC-031: in index.ts the deploy key flows ONLY into the executor construction", () => {
  it("names the deploy key exactly once — as the executor's signingKey dependency", () => {
    const { source } = readServerIndex();
    // The key value (`config.secrets.deployKey`) and the bare `signingKey` identifier each appear
    // EXACTLY once, together, as the executor's `signingKey:` dependency — nothing else in the
    // entry point may name either.
    expect(source.match(/config\s*\.\s*secrets\s*\.\s*deployKey/g) ?? []).toHaveLength(1);
    expect(source.match(/\bsigningKey\b/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/signingKey\s*:\s*config\s*\.\s*secrets\s*\.\s*deployKey/);
  });

  it("holds the key inside createOwnerGatedDeployExecutor(...) and NOWHERE else (no emit/log/publicConfig)", () => {
    const { source } = readServerIndex();
    // The sanctioned server-side sink: the executor factory argument.
    const construction =
      /createOwnerGatedDeployExecutor\s*\(\s*\{[\s\S]*?\}\s*\)/.exec(source)?.[0] ?? "";
    expect(construction).not.toBe("");
    expect(construction).toMatch(/signingKey\s*:\s*config\s*\.\s*secrets\s*\.\s*deployKey/);
    // Excise the construction site; the key value AND its field name vanish entirely from the rest
    // of index.ts — so no `ctx.send`/`emit`/`reply.send`, log, or `publicConfig` line can name them.
    const rest = source.replace(construction, "");
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
