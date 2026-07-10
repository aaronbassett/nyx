/**
 * Vitest global setup (T038) — provide in-memory Web Storage under jsdom.
 *
 * The jsdom environment in this toolchain exposes the `Storage` class but no
 * `localStorage` / `sessionStorage` instance on the window, so the EC-26
 * remembered-wallet code (`src/wallet/remember.ts`) and its tests have no store
 * to write to. Install a spec-faithful in-memory Storage ONLY when the real one
 * is missing, so a future jsdom that ships Web Storage keeps its own. This
 * changes nothing at runtime in a real browser — production keeps its native
 * `localStorage` and the defensive `safeStorage()` guard.
 */

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, value);
    },
  };
  return storage;
}

/** Install `name` on the global (and `window`) only when it is absent. */
function ensureStorage(name: "localStorage" | "sessionStorage"): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[name] !== undefined) {
    return;
  }
  const storage = createMemoryStorage();
  scope[name] = storage;
  const win = scope.window;
  if (win !== undefined && win !== null) {
    const windowScope = win as Record<string, unknown>;
    if (windowScope[name] === undefined) {
      windowScope[name] = storage;
    }
  }
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");

export {};
