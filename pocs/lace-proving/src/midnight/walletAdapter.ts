// Adapts the DApp Connector v4 `WalletConnectedAPI` into the midnight-js
// `WalletProvider` + `MidnightProvider` interfaces that deployContract/callTx
// consume. There is deliberately no official helper for this direction
// (window.midnight -> WalletProvider); DApp authors implement it themselves.
//
// Balancing / submission flow (connector v4):
//   - balanceTx(unboundTx): serialize -> wallet.balanceUnsealedTransaction(hex)
//                           -> deserialize the returned balanced+bound tx.
//   - submitTx(finalizedTx): serialize -> wallet.submitTransaction(hex).
//
// NOTE: proving does NOT happen here — it happens earlier inside the
// ProofProvider (that is the discovery-Q2 step). This adapter only balances and
// submits, so a proof is already present on the transactions it handles.

import type { WalletConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import type { MidnightProvider, WalletProvider } from "@midnight-ntwrk/midnight-js-types";
import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js-types";
import {
  type Binding,
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
  type Proof,
  type SignatureEnabled,
  Transaction,
} from "@midnight-ntwrk/ledger-v8";
import {
  type Bech32mCodec,
  MidnightBech32m,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnight-ntwrk/wallet-sdk-address-format";
import { log, traced } from "@/lib/logger";
import { fromHex, toHex } from "@/lib/hex";

const SCOPE = "wallet-adapter";

export type ConnectorWalletMidnightProvider = WalletProvider & MidnightProvider;

/** Best-effort conversion of a Bech32m shielded key to the hex form ledger uses. */
function bech32mToHex<T extends { toHexString(): string }>(
  bech: string,
  codec: Bech32mCodec<T>,
  networkId: string,
  label: string,
): string {
  try {
    const parsed = MidnightBech32m.parse(bech);
    const decoded = codec.decode(networkId, parsed);
    const hex = decoded.toHexString();
    log.debug(SCOPE, `${label}: bech32m -> hex`, { bech, hex });
    return hex;
  } catch (err) {
    log.warn(SCOPE, `${label}: could not decode bech32m to hex; passing raw bech32m through`, err);
    return bech;
  }
}

/**
 * Build the wallet+midnight provider from a connected wallet API. Pre-fetches
 * the shielded keys because WalletProvider exposes them synchronously.
 */
export async function makeConnectorWalletProvider(
  api: WalletConnectedAPI,
  networkId: string,
): Promise<ConnectorWalletMidnightProvider> {
  const addrs = await traced(SCOPE, "getShieldedAddresses()", () => api.getShieldedAddresses(), {
    onResult: (a) => ({
      shieldedAddress: a.shieldedAddress,
      shieldedCoinPublicKey: a.shieldedCoinPublicKey,
      shieldedEncryptionPublicKey: a.shieldedEncryptionPublicKey,
    }),
  });

  const coinPublicKey = bech32mToHex(
    addrs.shieldedCoinPublicKey,
    ShieldedCoinPublicKey.codec,
    networkId,
    "coinPublicKey",
  ) as CoinPublicKey;
  const encryptionPublicKey = bech32mToHex(
    addrs.shieldedEncryptionPublicKey,
    ShieldedEncryptionPublicKey.codec,
    networkId,
    "encryptionPublicKey",
  ) as EncPublicKey;

  return {
    getCoinPublicKey(): CoinPublicKey {
      return coinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return encryptionPublicKey;
    },

    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
      return traced(
        SCOPE,
        "balanceTx -> wallet.balanceUnsealedTransaction()",
        async () => {
          const serialized = toHex(tx.serialize());
          log.debug(SCOPE, `serialized unbound tx (${serialized.length / 2} bytes)`, { ttl: ttl?.toISOString() });
          const { tx: balancedHex } = await api.balanceUnsealedTransaction(serialized, { payFees: true });
          log.debug(SCOPE, `wallet returned balanced tx (${balancedHex.length / 2} bytes)`);
          return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
            "signature",
            "proof",
            "binding",
            fromHex(balancedHex),
          );
        },
      );
    },

    async submitTx(tx: FinalizedTransaction): Promise<string> {
      return traced(
        SCOPE,
        "submitTx -> wallet.submitTransaction()",
        async () => {
          const serialized = toHex(tx.serialize());
          await api.submitTransaction(serialized);
          const id = tx.identifiers()[0] ?? tx.transactionHash();
          log.info(SCOPE, `submitted; watch identifier = ${id}`);
          return id;
        },
      );
    },
  };
}
