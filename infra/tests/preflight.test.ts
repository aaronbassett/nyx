import { createServer, type AddressInfo, type Server } from "node:net";
import { describe, expect, it } from "vitest";

import { assertPortsFree, checkPortsFree, PortsInUseError } from "../devnet/preflight.js";

// Bind everything on the loopback so the probe (same host) is a specific-address
// bind against a specific-address active listener — a guaranteed EADDRINUSE,
// independent of SO_REUSEADDR wildcard quirks. Keeps the suite deterministic.
const HOST = "127.0.0.1";

/** Bind a server to an OS-assigned ephemeral port; resolve with the server + port. */
function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo from listen(0)"));
        return;
      }
      const { port } = address satisfies AddressInfo;
      resolve({ server, port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe("checkPortsFree / assertPortsFree", () => {
  it("reports an occupied port as in use and names it in the thrown error", async () => {
    const { server, port } = await listenEphemeral();
    try {
      const statuses = await checkPortsFree([port], HOST);
      expect(statuses).toEqual([{ port, inUse: true }]);

      const rejection = assertPortsFree([port], HOST);
      await expect(rejection).rejects.toBeInstanceOf(PortsInUseError);
      await expect(assertPortsFree([port], HOST)).rejects.toThrow(String(port));
    } finally {
      await close(server);
    }
  });

  it("reports a definitely-free port as not in use and resolves", async () => {
    // Claim an ephemeral port then release it: a closed listener with no live
    // connections is immediately re-bindable, so the port is now free.
    const { server, port } = await listenEphemeral();
    await close(server);

    const statuses = await checkPortsFree([port], HOST);
    expect(statuses).toEqual([{ port, inUse: false }]);
    await expect(assertPortsFree([port], HOST)).resolves.toBeUndefined();
  });

  it("lists every occupied port when more than one is taken", async () => {
    const first = await listenEphemeral();
    const second = await listenEphemeral();
    try {
      const error: unknown = await assertPortsFree([first.port, second.port], HOST).then(
        () => new Error("expected assertPortsFree to reject"),
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(PortsInUseError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(String(first.port));
      expect(message).toContain(String(second.port));
    } finally {
      await close(first.server);
      await close(second.server);
    }
  });
});
