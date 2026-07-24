/**
 * Dev wallet connector (Task 3) — the demo's ONE wallet concession, wired.
 *
 * Wraps the Task-2 {@link createDevSigner} core in a connector-v4-shaped entry and
 * installs it under `window.midnight.nyxDev`, so the EXISTING detection / connect /
 * SIWE stack runs UNCHANGED: `detect.ts` duck-types it to generation `v4`,
 * `connect.ts` probes `getConnectionStatus()` + `getUnshieldedAddress()`, and
 * `auth.ts` drives `signData({ encoding: "text", keyType: "unshielded" })`. No
 * detection/classifier logic changes — the shape alone satisfies the contract.
 *
 * The seed never leaves this module: it is captured in the connected-api closure
 * (via the {@link DevSigner}) and is not re-exposed. Everything else the connector
 * type demands but Nyx does not use is an HONEST rejection, never a fake success.
 *
 * Constitution I — the connector shape below was read from the installed
 * `@midnight-ntwrk/dapp-connector-api@4.0.1` `.d.ts`
 * (`node_modules/@midnight-ntwrk/dapp-connector-api/dist/api.d.ts`), never memory.
 * The members Nyx actually uses:
 *   type InitialAPI = { rdns; name; icon; apiVersion; connect(networkId): Promise<ConnectedAPI> }
 *   type ConnectedAPI = WalletConnectedAPI & HintUsage   // 17 members total
 *   WalletConnectedAPI.getConnectionStatus(): Promise<ConnectionStatus>
 *     ConnectionStatus = { status: "connected"; networkId } | { status: "disconnected" }
 *   WalletConnectedAPI.getUnshieldedAddress(): Promise<{ unshieldedAddress: string }>
 *   WalletConnectedAPI.signData(data, SignDataOptions): Promise<Signature>
 *     SignDataOptions = { encoding: "hex"|"base64"|"text"; keyType: "unshielded" }
 *     Signature = { data: string; signature: string; verifyingKey: string }
 * Every other WalletConnectedAPI/HintUsage member (getShieldedBalances,
 * getUnshieldedBalances, getDustBalance, getShieldedAddresses, getDustAddress,
 * getTxHistory, balanceUnsealedTransaction, balanceSealedTransaction, makeTransfer,
 * makeIntent, submitTransaction, getProvingProvider, getConfiguration, hintUsage)
 * rejects — the dev wallet only implements what Nyx's auth path exercises.
 */
import type {
  ConnectedAPI,
  InitialAPI,
  Signature,
  SignDataOptions,
} from "@midnight-ntwrk/dapp-connector-api";

import { EXPECTED_NETWORK_ID } from "./config";
import { createDevSigner, DEV_WALLET_ADDRESS_NETWORK, type DevSigner } from "./dev-signer";

/** The `window.midnight` key the dev wallet installs under. */
export const DEV_WALLET_KEY = "nyxDev";

/** Human-readable wallet name (rendered as text by the picker — untrusted-safe). */
export const DEV_WALLET_NAME = "Nyx Dev Wallet";

/** Reverse-DNS identifier for the dev wallet entry. */
export const DEV_WALLET_RDNS = "network.nyx.devwallet";

/** Connector API version this entry advertises (v4 = exposes `connect`). */
const DEV_WALLET_API_VERSION = "4";

/** Error thrown by every connector method the dev wallet deliberately omits. */
const NOT_IMPLEMENTED_MESSAGE = "dev wallet: not implemented";

/** Honest rejection for any connector member outside Nyx's auth path. */
function notImplemented(): Promise<never> {
  return Promise.reject(new Error(NOT_IMPLEMENTED_MESSAGE));
}

/**
 * Build the connector-v4 `ConnectedAPI` backed by `signer`, reporting `networkId`.
 * The signer (and thus the seed) lives only in this closure. Only the four members
 * Nyx's connect + SIWE flow uses are real; the rest reject honestly.
 */
function buildConnectedApi(signer: DevSigner, networkId: string): ConnectedAPI {
  return {
    getConnectionStatus() {
      return Promise.resolve({ status: "connected", networkId });
    },
    getUnshieldedAddress() {
      return Promise.resolve({ unshieldedAddress: signer.address });
    },
    signData(data: string, options: SignDataOptions): Promise<Signature> {
      // Honest: the dev wallet only signs UTF-8 text with the unshielded key —
      // the exact shape `auth.ts` requests. Anything else is unimplemented. The
      // `keyType` is widened to `string` for the guard: the `.d.ts` types it as the
      // sole literal `"unshielded"`, but a JS caller can still pass anything.
      const keyType: string = options.keyType;
      if (options.encoding !== "text" || keyType !== "unshielded") {
        return Promise.reject(
          new Error(
            "dev wallet: signData supports only { encoding: 'text', keyType: 'unshielded' }",
          ),
        );
      }
      return Promise.resolve({
        data,
        signature: signer.sign(data),
        verifyingKey: signer.verifyingKey,
      });
    },
    getShieldedBalances: notImplemented,
    getUnshieldedBalances: notImplemented,
    getDustBalance: notImplemented,
    getShieldedAddresses: notImplemented,
    getDustAddress: notImplemented,
    getTxHistory: notImplemented,
    balanceUnsealedTransaction: notImplemented,
    balanceSealedTransaction: notImplemented,
    makeTransfer: notImplemented,
    makeIntent: notImplemented,
    submitTransaction: notImplemented,
    getProvingProvider: notImplemented,
    getConfiguration: notImplemented,
    hintUsage: notImplemented,
  };
}

/**
 * Install the dev wallet under `window.midnight.nyxDev` unconditionally.
 *
 * `networkId` is the id the connector reports from `getConnectionStatus()` — set it
 * to {@link EXPECTED_NETWORK_ID} so the FR-037 wrong-network gate passes. The
 * connect hint from the caller is ignored (a dev wallet is pinned to one network).
 */
export function installDevWallet(options: {
  readonly seed: string;
  readonly networkId: string;
}): void {
  const signer = createDevSigner(options.seed, DEV_WALLET_ADDRESS_NETWORK);
  const connectedApi = buildConnectedApi(signer, options.networkId);
  const entry: InitialAPI = {
    name: DEV_WALLET_NAME,
    rdns: DEV_WALLET_RDNS,
    icon: "",
    apiVersion: DEV_WALLET_API_VERSION,
    connect: () => Promise.resolve(connectedApi),
  };
  const globals = globalThis as { midnight?: Record<string, unknown> };
  globals.midnight ??= {};
  globals.midnight[DEV_WALLET_KEY] = entry;
}

/** Read `import.meta.env` defensively (mirrors `auth.ts` / `config.ts`). */
function readEnv(): Record<string, string | undefined> {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return meta.env ?? {};
}

/**
 * Whether this is a PRODUCTION build (`import.meta.env.PROD`). Belt-and-braces (Fable-M3): even
 * if the demo flags leak into a prod build, {@link maybeInstallDevWallet} must never install a
 * key-holding wallet. `PROD` is a Vite boolean; a stubbed string form is tolerated defensively.
 */
function isProductionBuild(): boolean {
  const meta = import.meta as unknown as { env?: { PROD?: unknown } };
  const prod = meta.env?.PROD;
  return prod === true || prod === "true" || prod === "1";
}

/**
 * Install the dev wallet iff the demo env vars opt in: `VITE_DEV_WALLET === "1"`
 * and a non-empty `VITE_DEV_WALLET_SEED`. Returns whether it installed. The
 * reported network is pinned to {@link EXPECTED_NETWORK_ID} (the config chokepoint),
 * so a dev-wallet session passes the wrong-network gate. A no-op in any build that
 * does not set the flags — production never ships a phantom wallet.
 */
export function maybeInstallDevWallet(): boolean {
  // Fable-M3 — never install a key-holding wallet in a production build, even if the demo
  // flags somehow leak in. This is defence in depth behind main.tsx's dynamic-import gate.
  if (isProductionBuild()) {
    return false;
  }
  const env = readEnv();
  const enabled = env.VITE_DEV_WALLET === "1";
  const seed = env.VITE_DEV_WALLET_SEED;
  if (!enabled || typeof seed !== "string" || seed.length === 0) {
    return false;
  }
  installDevWallet({ seed, networkId: EXPECTED_NETWORK_ID });
  return true;
}
