/**
 * Handoff path-safety guard (US13 security fix — zip-slip / git-tree traversal).
 *
 * Stored project paths are UNTRUSTED: they originate from agent turns and user edits, and the
 * store persists exactly the paths it is handed (no validation). Both the archive zip
 * (`archive.ts`) and the synthesized git tree (`git.ts`) must therefore reject an unsafe path
 * BEFORE emitting a single byte, or a malicious stored path could escape the extraction
 * directory (a classic zip-slip) or plant a `.git/` payload a clone would honour.
 *
 * A path is UNSAFE when it is:
 *  - absolute (a leading `/`, or a Windows drive/UNC form);
 *  - a traversal — it contains a `..` SEGMENT (segment-wise, so `a..b.ts` is fine, only a whole
 *    `..` component is a traversal), or a backslash (a Windows separator / `..\` vector); or
 *  - rooted at `.git` (a `.git` FIRST segment), which a real `git clone` would materialize into
 *    the repo's own control directory.
 *
 * The check is deliberately conservative and segment-based so ordinary nested source paths
 * (`client/src/lib/config.ts`) always pass while every escape shape is refused, LOUDLY, via a
 * named {@link UnsafePathError} the archive/clone routes map to a non-leaking 5xx.
 */

/** A stored path that could escape the artifact boundary (zip-slip / git-tree traversal). */
export class UnsafePathError extends Error {
  constructor(readonly path: string) {
    super(`refusing handoff: unsafe stored path: ${path}`);
    this.name = "UnsafePathError";
  }
}

/** Windows drive-absolute (`C:\`, `C:/`) or UNC (`\\host`) — never a legit project-relative path. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** True when `path` is safe to materialize into an archive zip or a git tree. */
export function isSafePath(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  if (path.startsWith("/") || WINDOWS_ABSOLUTE.test(path) || path.startsWith("\\")) {
    return false; // absolute / drive / UNC
  }
  if (path.includes("\\")) {
    return false; // a backslash is a Windows separator and a `..\` traversal vector
  }
  const segments = path.split("/");
  if (segments[0] === ".git") {
    return false; // rooted at the git control directory
  }
  for (const segment of segments) {
    if (segment === "..") {
      return false; // a whole `..` component is a traversal
    }
  }
  return true;
}

/**
 * Throw {@link UnsafePathError} for the FIRST unsafe path, else a no-op. Callers pass every
 * path they are about to emit (archive members, git-tree blob paths) so a single bad path
 * refuses the whole artifact rather than being served.
 */
export function assertSafePaths(paths: Iterable<string>): void {
  for (const path of paths) {
    if (!isSafePath(path)) {
      throw new UnsafePathError(path);
    }
  }
}
