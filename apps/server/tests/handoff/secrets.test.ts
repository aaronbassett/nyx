/**
 * Handoff secrets-scanner contract tests (US13, FR-077/SC-044) — deterministic, pure,
 * no I/O.
 *
 * The scanner is a BELT-AND-SUSPENDERS check: by design (D10, PRD §16) no secret ever
 * reaches a project file, so over the expected clean tree it MUST return `[]` — a false
 * positive would block every legitimate handoff. These tests pin SC-044 in BOTH
 * directions:
 *  - ADVERSARIAL: a PEM private-key block, an OpenAI `sk-` key, an AWS `AKIA…` access
 *    key, a high-entropy `apiKey = "…"` assignment, and a bare high-entropy base64 token
 *    are each caught, tagged with the right `kind`, and REDACTED (no finding ever carries
 *    the full secret);
 *  - CLEAN: an ordinary DApp source set — a lowercase-hex contract address, a git SHA, a
 *    normal import, a `package.json`, a `.compact` contract — yields ZERO findings (no
 *    false positives on hex/SHA/identifiers that merely look secret-shaped).
 *
 * `assertNoSecrets` is the enforcement gate the archive/git routes call before serving:
 * it throws a named {@link SecretsFoundError} listing the REDACTED findings when any fire,
 * and is a no-op on a clean tree.
 */
import { describe, expect, it } from "vitest";
import { assertNoSecrets, scanForSecrets, SecretsFoundError } from "../../src/projects/secrets.js";
import type { ScanInput, SecretFinding, SecretKind } from "../../src/projects/secrets.js";

// --- Fixtures ---------------------------------------------------------------

/** A fake RSA private key: real BEGIN marker, deliberately LOW-entropy body (repeated
 *  `fake`) so only the marker fires — the body must not also trip the entropy detector. */
const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEpAIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake",
  "fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

/** OpenAI-style project key: `sk-proj-` + a random-looking mixed-case suffix. */
const FAKE_OPENAI_KEY = "sk-proj-Ab3Xk9Zq7Lm2Np5Rs8Tv1Wy4Bd6Fg0Hj3Kl5";

/** The canonical AWS docs example access-key id (safe to hard-code). */
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/** A 40-nibble hex value assigned to an api-key-named variable. */
const FAKE_HEX_SECRET = "8f3a9c2e7b1d4f6a0c5e8b2d9f1a4c7e0b3d6f9a";

/** A 40-char mixed-alphabet base62 blob assigned to an INNOCENTLY-named variable, so
 *  only the standalone high-entropy-token detector (not the assignment one) fires. */
const FAKE_BASE62_TOKEN = "Ab3Xk9ZqLm2Np5Rs8Tv1Wy4Bd6Fg0Hj3Kl7Qw9Er";

const ADVERSARIAL: ScanInput[] = [
  { path: "secrets/id_rsa", content: FAKE_PEM },
  { path: "src/openai.ts", content: `const client = "${FAKE_OPENAI_KEY}";\n` },
  { path: "infra/aws.txt", content: `aws_access_key_id = ${FAKE_AWS_KEY}\n` },
  { path: "src/config-bad.ts", content: `const apiKey = "${FAKE_HEX_SECRET}";\n` },
  { path: "src/blob.ts", content: `const payload = ["${FAKE_BASE62_TOKEN}"];\n` },
];

/** An ordinary generated-DApp tree — the expected state; MUST produce zero findings. */
const CLEAN: ScanInput[] = [
  {
    path: "client/src/lib/config.ts",
    content: [
      "// Contract-address chokepoint (D10, FR-081).",
      "function readContractAddress(): string | undefined {",
      "  const value = import.meta.env.VITE_CONTRACT_ADDRESS;",
      '  return typeof value === "string" && value.length > 0 ? value : undefined;',
      "}",
      "",
      "// Last-known-good deployed address (public on-chain data, lowercase hex).",
      "export const LAST_ADDRESS_HEX =",
      '  "0200a1f39b7c4e2d8a6f0b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a3b4c6d8e";',
    ].join("\n"),
  },
  {
    path: "client/src/version.ts",
    content: [
      "// Build provenance — a plain git SHA and a semver tag, both public.",
      'export const GIT_SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";',
      'export const BUILD_TAG = "v1.4.2";',
    ].join("\n"),
  },
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "my-dapp",
        version: "1.0.0",
        type: "module",
        dependencies: { "@midnight-ntwrk/wallet-sdk": "1.2.3" },
      },
      null,
      2,
    ),
  },
  {
    path: "contracts/counter.compact",
    content: [
      "pragma language_version >= 0.16;",
      "import CompactStandardLibrary;",
      "export ledger count: Counter;",
      "export circuit increment(): [] { count.increment(1); }",
    ].join("\n"),
  },
  {
    path: "client/src/App.tsx",
    content: [
      'import { useState } from "react";',
      "export function App(): string {",
      "  const [connected, setConnected] = useState(false);",
      "  setConnected(true);",
      '  return connected ? "ready" : "connect your wallet";',
      "}",
    ].join("\n"),
  },
];

/** Every raw secret string, for the "no finding leaks the full secret" invariant. */
const RAW_SECRETS = [FAKE_OPENAI_KEY, FAKE_AWS_KEY, FAKE_HEX_SECRET, FAKE_BASE62_TOKEN];

function kindsOf(findings: readonly SecretFinding[]): SecretKind[] {
  return findings.map((f) => f.kind).sort((a, b) => a.localeCompare(b));
}

// --- Adversarial direction: real secrets are caught -------------------------

describe("scanForSecrets — adversarial inputs", () => {
  it("catches a PEM private-key marker and tags it, on the right file + line", () => {
    const findings = scanForSecrets([{ path: "secrets/id_rsa", content: FAKE_PEM }]);
    expect(findings).toHaveLength(1);
    const [only] = findings;
    expect(only?.kind).toBe<SecretKind>("pem-private-key");
    expect(only?.path).toBe("secrets/id_rsa");
    expect(only?.line).toBe(1);
  });

  it("catches an OpenAI sk- key", () => {
    const findings = scanForSecrets([{ path: "a.ts", content: `const k = "${FAKE_OPENAI_KEY}";` }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("openai-api-key");
  });

  it("catches an AWS AKIA access-key id", () => {
    const findings = scanForSecrets([{ path: "a.txt", content: `key=${FAKE_AWS_KEY}` }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("aws-access-key-id");
  });

  it("catches a high-entropy value assigned to a secret-named variable", () => {
    const findings = scanForSecrets([
      { path: "a.ts", content: `const apiKey = "${FAKE_HEX_SECRET}";` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
    expect(findings[0]?.line).toBe(1);
  });

  it("catches a bare high-entropy base62 token in a non-secret assignment", () => {
    const findings = scanForSecrets([
      { path: "a.ts", content: `const payload = ["${FAKE_BASE62_TOKEN}"];` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("high-entropy-token");
  });

  it("finds every planted secret across the tree, one finding each", () => {
    const findings = scanForSecrets(ADVERSARIAL);
    expect(findings).toHaveLength(5);
    expect(kindsOf(findings)).toEqual<SecretKind[]>([
      "assignment-secret",
      "aws-access-key-id",
      "high-entropy-token",
      "openai-api-key",
      "pem-private-key",
    ]);
  });

  it("NEVER emits the full secret in any finding snippet (redaction, SC-044)", () => {
    const findings = scanForSecrets(ADVERSARIAL);
    for (const finding of findings) {
      for (const raw of RAW_SECRETS) {
        expect(finding.snippet.includes(raw)).toBe(false);
      }
      // A redacted snippet is short and bounded — never the raw multi-KB key body.
      expect(finding.snippet.length).toBeLessThanOrEqual(80);
    }
  });

  it("orders findings by file, then line ascending (deterministic)", () => {
    const multiline: ScanInput[] = [
      {
        path: "multi.ts",
        content: [
          `const a = "${FAKE_BASE62_TOKEN}";`,
          "const ok = 1;",
          `const apiKey = "${FAKE_HEX_SECRET}";`,
        ].join("\n"),
      },
    ];
    const findings = scanForSecrets(multiline);
    expect(findings.map((f) => f.line)).toEqual([1, 3]);
  });
});

// --- Clean direction: zero false positives ----------------------------------

describe("scanForSecrets — clean generated files", () => {
  it("returns [] for an ordinary DApp source tree (no false positives)", () => {
    expect(scanForSecrets(CLEAN)).toEqual([]);
  });

  it("does not flag a lowercase-hex contract address or a git SHA", () => {
    const findings = scanForSecrets([
      { path: "a.ts", content: 'const addr = "0200a1f39b7c4e2d8a6f0b3c5d7e9f1a2b4c6d8e";' },
      { path: "b.ts", content: 'const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";' },
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag a code-reference value assigned to a secret-named variable", () => {
    // A member-access RHS is code, not a literal secret.
    const findings = scanForSecrets([
      { path: "a.ts", content: "const apiKey = config.apiKey;" },
      { path: "b.ts", content: 'const clientSecret = "your-secret-here";' },
    ]);
    expect(findings).toEqual([]);
  });
});

// --- assertNoSecrets: the enforcement gate ----------------------------------

describe("assertNoSecrets", () => {
  it("throws SecretsFoundError listing REDACTED findings when secrets are present", () => {
    let thrown: unknown;
    try {
      assertNoSecrets(ADVERSARIAL);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SecretsFoundError);
    const err = thrown as SecretsFoundError;
    expect(err.name).toBe("SecretsFoundError");
    expect(err.findings).toHaveLength(5);
    for (const raw of RAW_SECRETS) {
      expect(err.message.includes(raw)).toBe(false);
    }
  });

  it("is a no-op on a clean tree", () => {
    expect(() => {
      assertNoSecrets(CLEAN);
    }).not.toThrow();
  });
});

// --- RECALL: the platform's own hex/token key shapes are caught (FIX 2) ------
//
// The real secret env formats (config/schema.ts) are single-case HEX (DEPLOY_KEY,
// R2_ACCESS_KEY_ID [32], R2_SECRET_ACCESS_KEY [64]) or bearer tokens. The mixed-alphabet gate
// never fires on hex, and the old detector required the secret-word to be a SUFFIX of the var
// name — so all of these previously SLIPPED THROUGH. They must now be caught.

/** A deterministic, well-spread lowercase-hex run of exact `length` (entropy ≈ 4.0). */
function hex(length: number): string {
  const alphabet = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    // `charAt` (never `undefined`, unlike indexing under noUncheckedIndexedAccess); index is
    // always in-range (mod 16 over a 16-char alphabet).
    out += alphabet.charAt((i * 7 + 3) % 16);
  }
  return out;
}

describe("scanForSecrets — recall on the platform's own key shapes (FIX 2)", () => {
  it("catches R2_SECRET_ACCESS_KEY with a 64-lowercase-hex value (env line)", () => {
    const findings = scanForSecrets([
      { path: "infra/.env", content: `R2_SECRET_ACCESS_KEY=${hex(64)}` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
  });

  it("catches DEPLOY_KEY with a hex value (secret-word is not a suffix)", () => {
    const findings = scanForSecrets([
      { path: ".env.production", content: `DEPLOY_KEY=${hex(64)}` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
  });

  it("catches R2_ACCESS_KEY_ID with a 32-hex value (keyword mid-name)", () => {
    const findings = scanForSecrets([
      { path: "infra/.env", content: `R2_ACCESS_KEY_ID=${hex(32)}` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
  });

  it('catches a `signingKey = "<hex>"` code assignment (D19 field name)', () => {
    const findings = scanForSecrets([
      { path: "src/deploy.ts", content: `const signingKey = "${hex(64)}";` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
  });

  it("catches an all-lowercase-hex 64-char value in an .env-style line", () => {
    // Even a low-entropy hex run (repeated nibble) is credential-shaped in a secret-named line:
    // the hex path does NOT gate on entropy (4.0 is unreachable for hex).
    const findings = scanForSecrets([
      { path: "config/.env", content: `COMPILE_SERVICE_TOKEN=${"deadbeef".repeat(8)}` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
    // …and the finding never carries the raw value.
    expect(findings[0]?.snippet.includes("deadbeef".repeat(8))).toBe(false);
  });
});

// --- PRECISION: benign high-entropy content is NOT flagged (FIX 3) -----------
//
// The bare high-entropy detector previously flagged lockfile SRI hashes, `data:` URIs, and any
// long base64 — so the FIRST archive of a typical project (which commits a lockfile) would 500
// and the user could never download their code (D17/FR-074). And the hex recall (FIX 2) must NOT
// re-introduce false positives on git SHAs or content hashes that live OUTSIDE a secret-named
// assignment. Getting BOTH directions right is the point.

describe("scanForSecrets — precision on benign high-entropy content (FIX 3)", () => {
  it("does not flag a pnpm-lock.yaml full of sha512- integrity hashes", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "  /react@19.0.0:",
      "    resolution: {integrity: sha512-Ab3Xk9ZqLm2Np5Rs8Tv1Wy4Bd6Fg0Hj3Kl7Qw9ErAb3Xk9ZqLm2Np5Rs8Tv1Wy4Bd6Fg==}",
      "  /vite@6.0.0:",
      "    resolution: {integrity: sha512-Zq7Lm2Np5Rs8Tv1Wy4Bd6Fg0Hj3Kl5Ab3Xk9ZqLm2Np5Rs8Tv1Wy4Bd6Fg0Hj==}",
    ].join("\n");
    expect(scanForSecrets([{ path: "pnpm-lock.yaml", content: lock }])).toEqual([]);
  });

  it("does not flag a sha512- integrity hash even outside a lockfile", () => {
    const findings = scanForSecrets([
      {
        path: "src/sri.ts",
        content:
          'const integrity = "sha512-Ab3Xk9ZqLm2Np5Rs8Tv1Wy4Bd6Fg0Hj3Kl7Qw9ErAb3Xk9ZqLm2Np5Rs8Tv==";',
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag a base64 data: URI embedded in a .tsx", () => {
    const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    const findings = scanForSecrets([
      { path: "src/Logo.tsx", content: `const logo = "data:image/png;base64,${payload}";` },
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag a bare 40-char git SHA in code", () => {
    const findings = scanForSecrets([
      { path: "src/version.ts", content: `export const commitSha = "${hex(40)}";` },
    ]);
    expect(findings).toEqual([]);
  });

  it("does not flag a bare 64-hex content hash in code (not a secret-named assignment)", () => {
    const findings = scanForSecrets([
      { path: "src/manifest.ts", content: `const digest = "${hex(64)}";` },
    ]);
    expect(findings).toEqual([]);
  });

  it("keeps BOTH directions right: recall + precision in one tree", () => {
    const findings = scanForSecrets([
      { path: ".env", content: `DEPLOY_KEY=${hex(64)}` }, // caught
      { path: "src/version.ts", content: `const sha = "${hex(40)}";` }, // not
      { path: "src/hash.ts", content: `const contentHash = "${hex(64)}";` }, // not
      { path: "pnpm-lock.yaml", content: "integrity: sha512-Ab3Xk9ZqLm2Np5Rs8Tv1Wy4Bd6Fg==" }, // not
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe<SecretKind>("assignment-secret");
    expect(findings[0]?.path).toBe(".env");
  });
});
