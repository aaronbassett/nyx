/**
 * Handoff secrets scanner (US13: FR-077/SC-044) — a curated-regex, zero-dependency check
 * over project file contents that backs the "no secrets in handoff artifacts" rule.
 *
 * By design (D10, PRD §16) a secret NEVER reaches a project file: the contract-address
 * chokepoint keeps `VITE_CONTRACT_ADDRESS` in `.env.local` (never bundled), the deploy key
 * lives only in the orchestrator, and R2 write creds never cross the server boundary. So
 * this scan is BELT-AND-SUSPENDERS: on the expected clean tree it MUST return `[]`, and a
 * false positive would wrongly block a legitimate handoff. The detectors are therefore
 * tuned for precision — strong prefix anchors (PEM markers, `sk-`, `AKIA…`) plus a
 * Shannon-entropy + mixed-alphabet gate that distinguishes a random credential from the
 * hex addresses, git SHAs, and identifiers that ordinary source is full of.
 *
 * RECALL vs PRECISION are BOTH load-bearing. Recall: the platform's own secret shapes are
 * single-case HEX (`DEPLOY_KEY`, `R2_ACCESS_KEY_ID` [32-hex], `R2_SECRET_ACCESS_KEY` [64-hex])
 * or bearer tokens (`COMPILE_SERVICE_TOKEN`, `sk-…` provider keys) — the mixed-alphabet gate
 * never fires on hex, so a hex value in a SECRET-NAMED assignment/env line is treated as a
 * finding regardless of case. Precision: a bare long-hex run OUTSIDE such an assignment (a git
 * SHA, a content hash) is NOT flagged, subresource-integrity hashes (`sha512-…`), `data:` URIs,
 * and known lockfiles are excluded — else the FIRST archive of a typical project (which commits
 * a lockfile) would 500 and the user could never download their own code (D17/FR-074).
 *
 * A finding NEVER carries the full secret — only its `kind`, location, and a REDACTED
 * snippet (a short non-secret prefix plus a length marker). {@link assertNoSecrets} is the
 * enforcement gate the archive/git routes call before serving: it throws a named
 * {@link SecretsFoundError} (whose message is likewise redacted) when any finding fires.
 */

/** The category of a detected secret — each maps to one curated detector. */
export type SecretKind =
  | "pem-private-key"
  | "openai-api-key"
  | "aws-access-key-id"
  | "assignment-secret"
  | "high-entropy-token";

/** One file to scan: its stored path plus its verbatim content. */
export interface ScanInput {
  readonly path: string;
  readonly content: string;
}

/** A single detection. `snippet` is REDACTED and never contains the full secret (SC-044). */
export interface SecretFinding {
  /** The file the secret was found in. */
  readonly path: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** Which detector fired. */
  readonly kind: SecretKind;
  /** A redacted, length-bounded hint — safe to log/serve; never the raw secret. */
  readonly snippet: string;
}

/** Raised by {@link assertNoSecrets} when a handoff tree contains one or more secrets. */
export class SecretsFoundError extends Error {
  constructor(readonly findings: readonly SecretFinding[]) {
    super(
      `refusing handoff: ${String(findings.length)} potential secret(s) found: ` +
        findings.map((f) => `${f.path}:${String(f.line)} [${f.kind}] ${f.snippet}`).join("; "),
    );
    this.name = "SecretsFoundError";
  }
}

// --- Tuning constants -------------------------------------------------------

/** Leading chars of a secret kept in a redacted snippet (a prefix hint, never enough to use). */
const REDACT_HEAD = 4;
/** Longest snippet we emit; a redacted hint is short by construction. */
const MAX_SNIPPET = 80;
/** Min length of a value assigned to a secret-named variable before it can be a finding. */
const MIN_ASSIGN_VALUE_LEN = 12;
/** Min Shannon entropy (bits/char) of such a value — filters english-ish placeholders. */
const MIN_ASSIGN_VALUE_ENTROPY = 3.5;
/** Min length of a bare high-entropy token run. */
const MIN_TOKEN_LEN = 32;
/** Min Shannon entropy of a bare token. NOTE: 4.0 is the theoretical MAX for hex (log2 16) so a
 *  4.0 floor is unreachable — we deliberately keep this at the mixed-alphabet band (random base64
 *  is ~5.5–6, camelCase identifiers far lower). Hex credentials are caught in the assignment path
 *  (see {@link detectAssignment}), not here, so the mixed-alphabet gate keeps this precise. */
const MIN_TOKEN_ENTROPY = 3.5;
/** Min Shannon entropy of an `sk-` key suffix (a secondary guard behind the prefix anchor). */
const MIN_OPENAI_SUFFIX_ENTROPY = 3.0;

// --- Entropy + alphabet helpers ---------------------------------------------

/** Shannon entropy in bits/char (0 for the empty string). */
function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;

/** A mixed alphabet (lower + upper + digit) marks a random credential and, crucially,
 *  EXCLUDES the lowercase-hex addresses/SHAs and UPPER_SNAKE constants ordinary code uses. */
function isMixedAlphabet(value: string): boolean {
  return HAS_LOWER.test(value) && HAS_UPPER.test(value) && HAS_DIGIT.test(value);
}

/** Redact a secret to a short prefix hint plus its length — NEVER the full value (SC-044). */
function redact(value: string): string {
  return `${value.slice(0, REDACT_HEAD)}…[redacted ${String(value.length)} chars]`;
}

// --- Detectors --------------------------------------------------------------

/** A single located candidate within one line (span is [start, end) in that line). */
interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly kind: SecretKind;
  readonly snippet: string;
}

/** A detector scans one line and returns any candidates it finds (already redacted). */
type Detector = (line: string) => Candidate[];

/** Run a global regex over a line, yielding each match's text and start offset. */
function* matches(re: RegExp, line: string): Generator<{ text: string; index: number }> {
  // `re` is expected to carry the global flag; reset lastIndex so detectors are reusable.
  re.lastIndex = 0;
  let match = re.exec(line);
  while (match !== null) {
    yield { text: match[0], index: match.index };
    // Guard against a zero-width match wedging the loop (none of ours are, but be safe).
    if (match.index === re.lastIndex) {
      re.lastIndex += 1;
    }
    match = re.exec(line);
  }
}

const PEM_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g;

/** PEM private-key marker. The marker itself is public boilerplate (no key bytes), so it is
 *  reported verbatim; its presence is the signal. */
const detectPem: Detector = (line) => {
  const out: Candidate[] = [];
  for (const { text, index } of matches(PEM_RE, line)) {
    out.push({ start: index, end: index + text.length, kind: "pem-private-key", snippet: text });
  }
  return out;
};

const AWS_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

/** AWS access-key id: the `AKIA`/`ASIA` prefix + 16 upper-alnum is a near-zero-FP signal. */
const detectAws: Detector = (line) => {
  const out: Candidate[] = [];
  for (const { text, index } of matches(AWS_RE, line)) {
    out.push({
      start: index,
      end: index + text.length,
      kind: "aws-access-key-id",
      snippet: redact(text),
    });
  }
  return out;
};

const OPENAI_RE = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g;

/** OpenAI-style `sk-`/`sk-proj-` key. The prefix anchors it; an entropy + digit-or-mixed-case
 *  guard rejects long lowercase-hyphen slugs that share the `sk-` shape. */
const detectOpenai: Detector = (line) => {
  const out: Candidate[] = [];
  for (const { text, index } of matches(OPENAI_RE, line)) {
    const suffix = text.replace(/^sk-(?:proj-)?/, "");
    const randomish = HAS_DIGIT.test(suffix) || (HAS_LOWER.test(suffix) && HAS_UPPER.test(suffix));
    if (!randomish || shannonEntropy(suffix) < MIN_OPENAI_SUFFIX_ENTROPY) {
      continue;
    }
    out.push({
      start: index,
      end: index + text.length,
      kind: "openai-api-key",
      snippet: redact(text),
    });
  }
  return out;
};

// The secret-word matches ANYWHERE in the variable/env key (surrounded by `[A-Za-z0-9_]*`, not
// just as a suffix), so `DEPLOY_KEY`, `R2_SECRET_ACCESS_KEY`, `R2_ACCESS_KEY_ID`,
// `COMPILE_SERVICE_TOKEN`, and `signingKey` all match — the platform's real env/field shapes
// (config/schema.ts). `signing[_-]?key`/`deploy[_-]?key`/`access[_-]?key` are the specific
// `*key` forms; a BARE `key`/`token` is only matched inside one of these compounds, never
// standalone, so an ordinary `const key = "name"` does not trip it.
const ASSIGN_RE =
  /\b([A-Za-z0-9_]*(?:secret|api[_-]?key|apikey|passwd|password|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|signing[_-]?key|deploy[_-]?key|access[_-]?key|token)[A-Za-z0-9_]*)\s*[:=]\s*(["']?)([^\s"']{8,})\2/gi;

/** A credential-shaped hex run (32+ nibbles) — the platform's own key shape (DEPLOY_KEY,
 *  R2_ACCESS_KEY_ID [32], R2_SECRET_ACCESS_KEY [64]). Single-case, so the mixed-alphabet gate
 *  never catches it; recognised HERE only inside a secret-named assignment (precision). */
const HEX_SECRET_VALUE = /^[0-9a-fA-F]{32,}$/;

/** A code reference (member access / call / template) rather than a literal secret value. */
const CODE_REFERENCE = /[.$(){}]/;
/** Common placeholder values (`your-key-here`, `changeme`, …) that are not real secrets. */
const PLACEHOLDER =
  /^(?:your|xxx|changeme|placeholder|example|redacted|todo|dummy|sample|replace|insert|none|null|undefined)/i;

/** A credential-shaped value assigned to a secret-named variable (`apiKey = "…"`,
 *  `DEPLOY_KEY=…`). The KEY name is the signal; the value qualifies when it is EITHER a 32+
 *  hex run (the platform's own key shape, any case) OR a high-entropy literal — the latter
 *  gated on length + entropy and screened against code references / placeholders so
 *  `apiKey = config.apiKey` and `secret = "your-secret"` still pass clean. */
const detectAssignment: Detector = (line) => {
  const out: Candidate[] = [];
  ASSIGN_RE.lastIndex = 0;
  let match = ASSIGN_RE.exec(line);
  while (match !== null) {
    const key = match[1];
    const value = match[3];
    if (key !== undefined && value !== undefined) {
      const isHexSecret = HEX_SECRET_VALUE.test(value);
      const isHighEntropy =
        value.length >= MIN_ASSIGN_VALUE_LEN &&
        !CODE_REFERENCE.test(value) &&
        !PLACEHOLDER.test(value) &&
        shannonEntropy(value) >= MIN_ASSIGN_VALUE_ENTROPY;
      if (isHexSecret || isHighEntropy) {
        out.push({
          start: match.index,
          end: match.index + match[0].length,
          kind: "assignment-secret",
          snippet: `${key} = ${redact(value)}`,
        });
      }
    }
    if (match.index === ASSIGN_RE.lastIndex) {
      ASSIGN_RE.lastIndex += 1;
    }
    match = ASSIGN_RE.exec(line);
  }
  return out;
};

const TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

/** A subresource-integrity hash prefix (`sha256-`/`sha384-`/`sha512-`) — the base64 that follows
 *  is a benign integrity digest (lockfiles, `<script integrity>`), not a credential. */
const SRI_PREFIX = /^sha(?:256|384|512)-/;

/** A `data:` URI's base64 marker immediately preceding a token — the payload is embedded asset
 *  bytes (e.g. an inlined PNG), not a secret. Matched against the line text BEFORE the token. */
const DATA_URI_BASE64_PREFIX = /data:[^"'\s]*base64,$/i;

/** A bare high-entropy base64/base62 blob. The mixed-alphabet gate excludes lowercase-hex
 *  addresses, git SHAs, and UPPER_SNAKE constants; the entropy gate excludes long
 *  camelCase identifiers; SRI hashes and `data:` URI payloads are excluded as benign-by-nature
 *  (precision — D17/FR-074). Anything left is a random-looking credential. */
const detectToken: Detector = (line) => {
  const out: Candidate[] = [];
  for (const { text, index } of matches(TOKEN_RE, line)) {
    if (
      text.length < MIN_TOKEN_LEN ||
      !isMixedAlphabet(text) ||
      shannonEntropy(text) < MIN_TOKEN_ENTROPY
    ) {
      continue;
    }
    // Precision: never flag an integrity hash or a data-URI's embedded base64 payload — both are
    // high-entropy by nature and appear in ordinary, exportable source.
    if (SRI_PREFIX.test(text) || DATA_URI_BASE64_PREFIX.test(line.slice(0, index))) {
      continue;
    }
    out.push({
      start: index,
      end: index + text.length,
      kind: "high-entropy-token",
      snippet: redact(text),
    });
  }
  return out;
};

/**
 * Detectors in PRIORITY order. When two detectors match the same span on a line (e.g. an
 * `sk-` value would also match the bare-token detector), the earlier one wins and the later
 * overlapping candidate is dropped — one secret yields one finding.
 */
const DETECTORS: readonly Detector[] = [
  detectPem,
  detectAws,
  detectOpenai,
  detectAssignment,
  detectToken,
];

/** Do two half-open spans overlap? */
function overlaps(a: Candidate, b: Candidate): boolean {
  return a.start < b.end && b.start < a.end;
}

// --- Public API -------------------------------------------------------------

/** Lockfiles are content-addressed integrity manifests (`sha512-…` hashes, base64 blobs) that
 *  are benign by nature — scanning them would false-positive and block the FIRST archive of any
 *  ordinary project (which commits a lockfile), so they are allowlisted whole (D17/FR-074). */
const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
]);

/** A benign-by-nature file that must not be scanned (currently: known lockfiles). */
function isAllowlistedPath(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  return LOCKFILE_BASENAMES.has(basename);
}

/**
 * Scan file contents for secrets. Deterministic: findings are ordered by input file, then
 * by line, then by column. Returns `[]` for a clean tree (the expected state). Allowlisted
 * files (lockfiles) are skipped whole.
 */
export function scanForSecrets(files: readonly ScanInput[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    if (isAllowlistedPath(file.path)) {
      continue;
    }
    const lines = file.content.split(/\r\n|\r|\n/);
    lines.forEach((line, lineIndex) => {
      const taken: Candidate[] = [];
      for (const detector of DETECTORS) {
        for (const candidate of detector(line)) {
          if (taken.some((accepted) => overlaps(accepted, candidate))) {
            continue;
          }
          taken.push(candidate);
        }
      }
      taken
        .sort((a, b) => a.start - b.start)
        .forEach((candidate) => {
          findings.push({
            path: file.path,
            line: lineIndex + 1,
            kind: candidate.kind,
            snippet: candidate.snippet.slice(0, MAX_SNIPPET),
          });
        });
    });
  }
  return findings;
}

/**
 * The enforcement gate: throw {@link SecretsFoundError} (with redacted findings) if the tree
 * contains any secret. A no-op on a clean tree. Callers (archive/git routes) invoke this
 * before serving so a secret can never leave the platform.
 */
export function assertNoSecrets(files: readonly ScanInput[]): void {
  const findings = scanForSecrets(files);
  if (findings.length > 0) {
    throw new SecretsFoundError(findings);
  }
}
