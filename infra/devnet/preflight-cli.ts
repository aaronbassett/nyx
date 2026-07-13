import { assertPortsFree, PortsInUseError } from "./preflight.js";

/**
 * Ports the local devnet MUST occupy: node (9944), proof server (6300), and the
 * indexer (8088) — all pinned by Lace's "Undeployed" network and its connector's
 * ServiceUriConfig. If any is already bound we fail fast and NEVER attach to a
 * devnet we did not start (which could risk deploying to a foreign chain).
 */
const REQUIRED_PORTS: readonly number[] = [9944, 6300, 8088];

/**
 * Probe the loopback interface. A specific-address bind conflicts with either a
 * loopback-bound or a wildcard-bound (`0.0.0.0` / `::`) listener on the same
 * port — e.g. Docker's default published ports — so occupancy is detected
 * regardless of how the conflicting process bound.
 */
const DEVNET_HOST = "127.0.0.1";

async function main(): Promise<void> {
  try {
    await assertPortsFree(REQUIRED_PORTS, DEVNET_HOST);
    console.log(`devnet preflight ok — ports free: ${REQUIRED_PORTS.join(", ")}`);
  } catch (err) {
    if (err instanceof PortsInUseError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    // Unexpected fault (not a plain occupancy conflict): let it surface as a
    // non-zero exit with a stack trace rather than masquerade as "all clear".
    throw err;
  }
}

await main();
