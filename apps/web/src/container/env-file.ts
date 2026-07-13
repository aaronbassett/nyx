/**
 * The container's `.env.local` (the D10 config chokepoint) modelled as a merged
 * key→value map, so independent writers never clobber each other's keys:
 * `contract:deployed` sets `VITE_CONTRACT_ADDRESS` (env.ts) and `artifacts:ready`
 * sets the ZK-config base URL (artifacts.ts). Each `set` merges then rewrites the
 * whole file via the WebContainer fs (never network — R6).
 *
 * The env-file is owned by these preview handlers; on a fresh boot it starts
 * empty and is (re)written as events arrive. Keys are fixed constants and values
 * are addresses / URLs, so they are written verbatim (no escaping needed).
 */
import type { WebContainerFsHandle } from "./types";

/** Path of the dev-server env file inside the container working directory. */
export const ENV_LOCAL_PATH = ".env.local";

/** A merged, non-clobbering writer over the container's `.env.local`. */
export interface ContainerEnv {
  /** Set (or overwrite) one key and rewrite the merged file. */
  set(key: string, value: string): Promise<void>;
  /** The current key→value view (for tests / diagnostics). */
  snapshot(): Readonly<Record<string, string>>;
}

/** Serialize the map to `KEY=value` lines, insertion-ordered, trailing newline. */
function serialize(vars: ReadonlyMap<string, string>): string {
  return [...vars].map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

/** Create a {@link ContainerEnv} backed by the given WebContainer fs. */
export function createContainerEnv(fs: WebContainerFsHandle): ContainerEnv {
  const vars = new Map<string, string>();
  return {
    async set(key: string, value: string): Promise<void> {
      vars.set(key, value);
      await fs.writeFile(ENV_LOCAL_PATH, serialize(vars));
    },
    snapshot(): Readonly<Record<string, string>> {
      return Object.fromEntries(vars);
    },
  };
}
