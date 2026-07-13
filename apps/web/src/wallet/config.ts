/**
 * US5 wallet-connect layer — expected network id (FR-037 wrong-network gate).
 *
 * The expected Midnight network id now comes from the constitution-VII network
 * chokepoint (`../config`): whichever profile `VITE_NYX_NETWORK` selects supplies
 * its `networkId`, so the wrong-network comparison and the node/indexer/proof
 * endpoints stay in lockstep from a single source of truth. The wrong-network
 * LOGIC (compare connected vs expected) is correct regardless of the literal.
 *
 * TODO(verify T273): the default `local-devnet` profile pins `networkId` to
 * "undeployed"; confirm the exact string Lace reports for the local devnet
 * against `@midnight-ntwrk/midnight-js-network-id` at wiring, and set
 * `VITE_NYX_NETWORK` (plus the profile's `networkId`) accordingly.
 */
import { NETWORK } from "../config";

/** The network id the wallet is expected to be connected to. */
export const EXPECTED_NETWORK_ID: string = NETWORK.networkId;
