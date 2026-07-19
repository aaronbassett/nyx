/**
 * Handoff archive materialiser (US13: FR-074/SC-042) — turns the authoritative Postgres
 * rows (D26) into a portable, source-only zip on demand, so Nyx never holds a developer's
 * code hostage (D17).
 *
 * The archive is the LATEST committed tree exactly as stored — source only, because the
 * store never persists `node_modules` or build artifacts (D26) — plus one generated
 * handoff README documenting what the developer must supply to run it locally. Two
 * invariants make the download trustworthy:
 *
 *  1. SC-042 — every archived file's content hashes back to the latest manifest EXACTLY.
 *     The bytes come from {@link ProjectStore.getFiles} and the hashes from
 *     {@link ProjectStore.getManifest}; both project the same `project_files` rows through
 *     the same server-side SHA-256 (`computeContentHash`), so a mismatch means the store is
 *     inconsistent and we FAIL LOUDLY ({@link ArchiveManifestMismatchError}, EC-34) rather
 *     than shipping a lie. The generated README is the ONLY archive member absent from the
 *     manifest (it lives at the reserved {@link HANDOFF_README_PATH}).
 *  2. No secrets leave the platform — the whole archive (source + README) is run through
 *     {@link assertNoSecrets} before it is built, so a stray credential rejects the download
 *     (FR-077 scenario 5) even though, by design (D10, PRD §16), none should exist.
 *
 * Output is DETERMINISTIC: files are emitted in stored (path) order with a fixed zip mtime,
 * so re-materialising an unchanged project yields byte-identical output (the D58 per-version
 * watermark cache relies on this). Routes/ownership/soft-delete gating live at the route
 * layer (D43/D49); this module is a pure function of the injected store.
 */
import { strToU8, zipSync } from "fflate";
import type { Zippable } from "fflate";
import { assertSafePaths } from "./paths.js";
import { assertNoSecrets } from "./secrets.js";
import type { HandoffFile, ProjectStore } from "./store.js";

/** The reserved path of the generated handoff README inside the archive — chosen to not
 *  collide with an ordinary DApp source path, and the sole member absent from the manifest. */
export const HANDOFF_README_PATH = "NYX_HANDOFF.md";

/** A fixed, in-range (1980–2099) zip timestamp so repeated archives are byte-stable. fflate
 *  encodes DOS timestamps from local-time getters, so this pins determinism per environment. */
const ARCHIVE_MTIME = new Date(Date.UTC(2024, 0, 1, 0, 0, 0));

/** Caller-supplied metadata folded into the generated README. */
export interface ArchiveMeta {
  /** The project's display name, shown in the README heading. */
  readonly projectName: string;
}

/** The archive plus the exact README text embedded in it (the zip is the deliverable). */
export interface ArchiveResult {
  /** The zip bytes — the download payload. */
  readonly zip: Uint8Array;
  /** The generated handoff README, byte-for-byte identical to the archived copy. */
  readonly readme: string;
}

/** The archived tree diverged from the manifest it should equal — a store inconsistency
 *  (SC-042 would be violated), surfaced loudly instead of served (EC-34). */
export class ArchiveManifestMismatchError extends Error {
  constructor(readonly path: string) {
    super(`archive tree diverges from manifest at: ${path}`);
    this.name = "ArchiveManifestMismatchError";
  }
}

/** A committed source file occupies the reserved README path — generating the README would
 *  silently overwrite it, corrupting the archive; refuse instead. */
export class ArchiveReservedPathError extends Error {
  constructor(readonly path: string) {
    super(`project file collides with the reserved handoff README path: ${path}`);
    this.name = "ArchiveReservedPathError";
  }
}

/** A manifest entry as this module consumes it — the store's `ManifestEntry` (whose
 *  branded `contentHash` is a `string`) satisfies this structurally. */
interface ManifestRow {
  readonly path: string;
  readonly contentHash: string;
}

/**
 * Assert the archived files are exactly the manifest — same paths, same hashes. Both come
 * from the same `project_files` projection, so any divergence is a store bug, not user
 * input; SC-042 depends on this holding before we emit a single byte.
 */
function assertManifestMatch(
  files: readonly HandoffFile[],
  manifest: readonly ManifestRow[],
): void {
  const hashByPath = new Map<string, string>();
  for (const file of files) {
    if (hashByPath.has(file.path)) {
      // Duplicate paths would make the archive ambiguous — the store must not produce them.
      throw new ArchiveManifestMismatchError(file.path);
    }
    hashByPath.set(file.path, file.contentHash);
  }
  if (files.length !== manifest.length) {
    const extra = files.find((file) => !manifest.some((entry) => entry.path === file.path));
    const missing = manifest.find((entry) => !hashByPath.has(entry.path));
    throw new ArchiveManifestMismatchError(extra?.path ?? missing?.path ?? "");
  }
  for (const entry of manifest) {
    const hash = hashByPath.get(entry.path);
    if (hash === undefined || hash !== entry.contentHash) {
      throw new ArchiveManifestMismatchError(entry.path);
    }
  }
}

/**
 * Render the generated handoff README (FR-074). GENERATED content — there is no template
 * asset (D3/FR-003). Purely a function of `projectName`, so the archive stays deterministic
 * (no timestamps, no randomness).
 */
function renderHandoffReadme(projectName: string): string {
  return `# ${projectName} — Nyx handoff

This archive is a portable, self-contained copy of your project's **source**, exported
from Nyx. \`node_modules\` and compiled build artifacts are intentionally excluded — you
regenerate them locally (they are never part of the authoritative project state).

## Local-run requirements

Before the app will run against a live contract you must provide two things Nyx keeps out
of your source on purpose:

### 1. \`VITE_CONTRACT_ADDRESS\` (in \`.env.local\`)

The deployed contract address is read through a single chokepoint
(\`client/src/lib/config.ts\`) and is intentionally **not included** in this archive — the
address is environment configuration, not source, and pinning a stale one is worse than
none. After you deploy your own contract, put its address in a \`.env.local\` file at the
project root:

\`\`\`
VITE_CONTRACT_ADDRESS=<your deployed contract address>
\`\`\`

The \`VITE_\` prefix is mandatory — Vite only exposes \`VITE_\`-prefixed variables to client
code. Until this is set the app renders a "deploy your contract" guard rather than
white-screening.

### 2. \`VITE_ZK_CONFIG_BASE_URL\` (zero-knowledge artifacts + prover)

The compiled zero-knowledge artifacts (\`.prover\` / \`.verifier\` / \`.bzkir\`) are served from
a base URL your client fetches at runtime. Point \`VITE_ZK_CONFIG_BASE_URL\` at wherever you
host the artifacts produced by compiling the contract, and configure your proving provider
(a hosted prover or in-wallet proving) to match your target network:

\`\`\`
VITE_ZK_CONFIG_BASE_URL=<base url hosting your compiled zk artifacts>
\`\`\`

## Compile + run locally

1. Install dependencies: \`pnpm install\` (or \`npm install\`).
2. Compile the Compact contract(s) with the Compact toolchain to produce the on-chain
   contract plus its zero-knowledge artifacts.
3. Deploy the contract to your target network, then copy the resulting address into
   \`.env.local\` as \`VITE_CONTRACT_ADDRESS\` (see above).
4. Publish/serve the compiled zk artifacts and set \`VITE_ZK_CONFIG_BASE_URL\` to their base
   URL; make sure your proving provider is reachable.
5. Start the dev server: \`pnpm dev\`.

Your code is yours — nothing here depends on Nyx to keep running.
`;
}

/**
 * Build a source-only handoff archive for a project: the latest committed tree plus a
 * generated README, as a deterministic zip. Rejects (never returns a corrupt archive) if
 * the tree diverges from its manifest (SC-042/EC-34) or contains a secret (FR-077).
 *
 * Only the read surface is needed, so the parameter is a `Pick` — the caller injects the
 * real `ProjectStore` (or a test double). Ownership / soft-delete gating is the route's job.
 */
export async function buildArchive(
  store: Pick<ProjectStore, "getFiles" | "getManifest">,
  projectId: string,
  meta: ArchiveMeta,
): Promise<ArchiveResult> {
  const files = await store.getFiles(projectId);
  const manifest = await store.getManifest(projectId);

  // SC-042 precondition: the bytes we are about to zip must be exactly the manifest.
  assertManifestMatch(files, manifest);

  // Reject a zip-slip / traversal path (absolute, `..` segment, `.git` root) before emitting.
  assertSafePaths(files.map((file) => file.path));

  if (files.some((file) => file.path === HANDOFF_README_PATH)) {
    throw new ArchiveReservedPathError(HANDOFF_README_PATH);
  }

  const readme = renderHandoffReadme(meta.projectName);

  // Belt-and-suspenders (FR-077): certify the ENTIRE archive — source + README — secret-free
  // before any bytes are produced. By design (D10) this never fires; if it does, refuse.
  assertNoSecrets([...files, { path: HANDOFF_README_PATH, content: readme }]);

  // Emit in stored (path) order + README last, with a fixed mtime, for byte-stable output.
  const zippable: Zippable = {};
  for (const file of files) {
    zippable[file.path] = strToU8(file.content);
  }
  zippable[HANDOFF_README_PATH] = strToU8(readme);

  const zip = zipSync(zippable, { mtime: ARCHIVE_MTIME });
  return { zip, readme };
}
