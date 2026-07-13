import { createServer } from "node:net";

/** Occupancy status of a single TCP port after a bind probe. */
export interface PortStatus {
  readonly port: number;
  readonly inUse: boolean;
}

/**
 * Thrown by {@link assertPortsFree} when one or more required ports are already
 * bound. The message names every occupied port so an operator can identify and
 * stop the conflicting process. Nyx never attaches to a devnet it did not start,
 * so this is a hard, fail-fast abort rather than a fallback-to-reuse.
 */
export class PortsInUseError extends Error {
  /** The occupied ports, in the order they were requested. */
  readonly ports: readonly number[];

  constructor(ports: readonly number[]) {
    super(
      `ports already in use: ${ports.join(", ")} — Nyx will not reuse a devnet it did not start; stop the other process and retry.`,
    );
    this.name = "PortsInUseError";
    this.ports = ports;
    // Keep `instanceof` reliable if this is ever emitted through a transpile
    // target that breaks the native Error subclassing prototype chain.
    Object.setPrototypeOf(this, PortsInUseError.prototype);
  }
}

/**
 * Bind failures that mean the port is unavailable to us: already bound
 * (`EADDRINUSE`) or bind refused by the OS, e.g. a privileged port held by
 * another user (`EACCES`). Both count as "in use" for the fail-fast contract.
 */
const IN_USE_CODES: ReadonlySet<string> = new Set(["EADDRINUSE", "EACCES"]);

function bindErrorCode(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "code" in value) {
    const { code } = value;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

/**
 * Probe a single port by attempting to BIND a fresh server (never a client
 * connection). A successful bind means the port is free — the server is closed
 * again immediately. `EADDRINUSE`/`EACCES` mean it is in use. Any other error is
 * surfaced so genuine faults are not silently reported as "free".
 */
function probePort(port: number, host: string | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();

    const onError = (err: unknown): void => {
      server.removeListener("listening", onListening);
      const code = bindErrorCode(err);
      if (code !== undefined && IN_USE_CODES.has(code)) {
        resolve(true);
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onListening = (): void => {
      server.removeListener("error", onError);
      // We only opened it to prove it was bindable — release it before reporting.
      server.close(() => {
        resolve(false);
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);

    if (host === undefined) {
      server.listen(port);
    } else {
      server.listen(port, host);
    }
  });
}

/**
 * Probe each port by attempting to bind it, in input order. Returns one
 * {@link PortStatus} per requested port. Never opens a client connection to any
 * port, so it cannot accidentally interact with a foreign service.
 */
export async function checkPortsFree(
  ports: readonly number[],
  host?: string,
): Promise<PortStatus[]> {
  const statuses: PortStatus[] = [];
  for (const port of ports) {
    const inUse = await probePort(port, host);
    statuses.push({ port, inUse });
  }
  return statuses;
}

/**
 * Assert that every port is free. Resolves when all are bindable; otherwise
 * throws a single {@link PortsInUseError} listing every occupied port.
 */
export async function assertPortsFree(ports: readonly number[], host?: string): Promise<void> {
  const statuses = await checkPortsFree(ports, host);
  const occupied = statuses.filter((status) => status.inUse).map((status) => status.port);
  if (occupied.length > 0) {
    throw new PortsInUseError(occupied);
  }
}
