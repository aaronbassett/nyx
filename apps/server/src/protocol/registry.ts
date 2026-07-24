/**
 * Single-live-session registry for last-tab-wins takeover (D40, T022).
 *
 * At most one live WebSocket may exist per (account, project). When a new
 * authenticated connection claims a key that is already held, the prior socket
 * is displaced: the caller notifies it (`session:takeover`) and closes it, then
 * the new socket becomes the live one.
 *
 * Generic over the socket type so the registry logic is unit-testable with
 * plain sentinel objects, with no real WebSocket required.
 */

/**
 * Compose the takeover key from (account, project). Encoded as a JSON tuple so
 * the two fields cannot collide regardless of their contents (a printable,
 * unambiguous separator).
 */
export function sessionKey(accountAddress: string, projectId: string): string {
  return JSON.stringify([accountAddress, projectId]);
}

/**
 * Decode the account address a {@link sessionKey} was composed from — the inverse of the tuple
 * encoding above. Used for account-scoped broadcast (e.g. a finalized-deposit `ledger:update`,
 * which belongs to an ACCOUNT across all its open projects, not to one (account, project) key).
 */
export function accountFromKey(key: string): string {
  return (JSON.parse(key) as [string, string])[0];
}

export interface SessionRegistry<TSocket> {
  /**
   * Register `socket` as the live connection for `key`, returning the socket it
   * displaced (if any). The new socket is live immediately on return; the caller
   * is responsible for notifying + closing the returned prior socket.
   */
  claim(key: string, socket: TSocket): TSocket | undefined;
  /**
   * Remove `socket` from `key` iff it is still the live one. A socket that was
   * already displaced by a newer claim is a no-op here, so a late `close` from a
   * superseded tab never evicts its successor.
   */
  release(key: string, socket: TSocket): void;
  /** The live socket for `key`, if any. */
  get(key: string): TSocket | undefined;
  /**
   * Every live socket whose key belongs to `accountAddress` — an account-scoped broadcast target
   * (a finalized-deposit `ledger:update` is credited to an account, not a single project). At
   * most one socket per (account, project) is live (D40), so this is the account's currently-open
   * projects. Empty when the account has no live connection (a boot-time deposit push is dropped —
   * the client re-reads `GET /ledger` on next connect, so the balance is never lost).
   */
  socketsForAccount(accountAddress: string): TSocket[];
}

/** Create an in-memory {@link SessionRegistry}. */
export function createSessionRegistry<TSocket>(): SessionRegistry<TSocket> {
  const live = new Map<string, TSocket>();
  return {
    claim(key, socket) {
      const prior = live.get(key);
      live.set(key, socket);
      return prior;
    },
    release(key, socket) {
      if (live.get(key) === socket) {
        live.delete(key);
      }
    },
    get(key) {
      return live.get(key);
    },
    socketsForAccount(accountAddress) {
      const sockets: TSocket[] = [];
      for (const [key, socket] of live) {
        if (accountFromKey(key) === accountAddress) {
          sockets.push(socket);
        }
      }
      return sockets;
    },
  };
}
