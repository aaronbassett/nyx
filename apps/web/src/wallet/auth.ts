/**
 * US5 SIWE sign-in flow (T039) — the client half of authentication.
 *
 * Drives the server auth layer (nonce → verify → session cookie → logout) from
 * the browser. Consumes the T038 seam: a live `ConnectedAPI` (from `connect.ts`)
 * and the unshielded Bech32m address (`observation.unshieldedAddress`, D43). This
 * module never re-implements connect/detect — it takes the handle and address as
 * given and runs the SIWE-for-Midnight handshake:
 *
 *   requestNonce → buildSiweMessage → api.signData → POST /auth/verify → (cookie)
 *
 * Every request is session-cookie based, so each fetch sends `credentials:
 * "include"`: that is how the HttpOnly session cookie is set on verify and
 * returned on the resume/logout paths. URLs are relative by default; the `fetch`
 * and base URL are INJECTABLE so unit tests drive the whole flow with a mock and
 * no live backend (mirroring the deterministic-deps pattern in `connect.ts`).
 *
 * The DTOs come from `@nyx/protocol` — the shared source of truth — as TYPE-ONLY
 * imports, so no runtime zod is pulled into the web bundle. Response shapes are
 * trusted per the server contract; the wire types keep the request bodies honest.
 */
import type { ConnectedAPI, Signature } from "@midnight-ntwrk/dapp-connector-api";
import type {
  AuthNonceResponse,
  AuthSessionResponse,
  AuthVerifyRequest,
  AuthVerifyResponse,
  MidnightAddress,
} from "@nyx/protocol";

/**
 * Injectable transport. Defaults to the global `fetch` and relative URLs; tests
 * pass a mock `fetch` (and never touch a real backend), and a deployment can
 * point at a cross-origin API via `baseUrl` / `VITE_API_BASE_URL`.
 */
export interface AuthClientDeps {
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Base URL prefixed to the relative `/auth/*` paths; defaults to `""`. */
  readonly baseUrl?: string;
}

/** The subset of the connected wallet handle sign-in needs — just `signData`. */
export type WalletSigner = Pick<ConnectedAPI, "signData">;

/** An authenticated account, keyed by its unshielded address (D43). */
export interface Account {
  readonly address: MidnightAddress;
}

/** Why a sign-in attempt did not authenticate the session. */
export type SignInFailureReason =
  /** The user declined the wallet signature prompt (EC-24). */
  | "rejected"
  /** The server refused the signature/nonce binding (verify 401) or rejected the body (400). */
  | "unauthenticated"
  /** A request never reached a verdict — fetch threw, or an unexpected status. */
  | "network";

/** The discriminated outcome of {@link signIn}. */
export type SignInResult =
  | { readonly ok: true; readonly address: MidnightAddress }
  | { readonly ok: false; readonly reason: SignInFailureReason };

/** Parameters for the pure {@link buildSiweMessage} — no ambient time or DOM. */
export interface SiweMessageParams {
  /** The domain the sign-in is bound to (e.g. `nyx.example`). */
  readonly domain: string;
  /** The server-issued single-use nonce, carried verbatim on its own line. */
  readonly nonce: string;
  /** Human-readable intent line shown to the user in the wallet. */
  readonly statement: string;
  /** ISO-8601 issuance timestamp — a parameter so callers stay deterministic. */
  readonly issuedAt: string;
}

/** Options for {@link signIn}: the wallet handle, its address, and message overrides. */
export interface SignInOptions extends AuthClientDeps {
  /** The live wallet handle (the T038 seam); only `signData` is used. */
  readonly api: WalletSigner;
  /** The wallet's unshielded address (`observation.unshieldedAddress`, D43). */
  readonly address: string;
  /** Domain to bind the message to; defaults to the current page host. */
  readonly domain?: string;
  /** Statement line; defaults to {@link DEFAULT_STATEMENT}. */
  readonly statement?: string;
  /** Issuance timestamp (ISO); defaults to `new Date().toISOString()`. */
  readonly issuedAt?: string;
}

/** Default statement line — mirrors the shape the server's own tests sign. */
const DEFAULT_STATEMENT = "Sign in to Nyx.";

/** Fallback domain when no page host is available (non-browser test envs). */
const DEFAULT_DOMAIN = "nyx";

/** Read `import.meta.env.VITE_API_BASE_URL` defensively (mirrors `config.ts`). */
function readConfiguredBaseUrl(): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const value = meta.env?.VITE_API_BASE_URL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve the `fetch` to use — the injected one, else the global. */
function resolveFetch(deps: AuthClientDeps | undefined): typeof fetch {
  return deps?.fetch ?? globalThis.fetch;
}

/** Build an absolute-or-relative URL for `path` under the configured base. */
function resolveUrl(deps: AuthClientDeps | undefined, path: string): string {
  const baseUrl = deps?.baseUrl ?? readConfiguredBaseUrl() ?? "";
  return `${baseUrl}${path}`;
}

/** Parse a JSON response body under a trusted server-contract type. */
async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The current page host, or {@link DEFAULT_DOMAIN} outside a browser. */
function currentDomain(): string {
  const location = (globalThis as { location?: { host?: string } }).location;
  const host = location?.host;
  return host !== undefined && host.length > 0 ? host : DEFAULT_DOMAIN;
}

/**
 * Render the domain-bound SIWE message. PURE: identical inputs always yield the
 * identical string, and it never reads the clock — pass `issuedAt` explicitly.
 *
 * The shape mirrors the server's own test helper so the server's nonce parser
 * (`/(?:^|\n)Nonce:[ \t]*(\S+)/`) matches the `Nonce: <nonce>` line. The domain
 * line is included even though the server does not yet enforce it, so a future
 * server-side domain check finds the binding already present.
 */
export function buildSiweMessage(params: SiweMessageParams): string {
  return [
    `${params.domain} wants you to sign in with your Midnight account.`,
    "",
    params.statement,
    "",
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

/**
 * Request a fresh single-use nonce (`POST /auth/nonce`, no auth). Throws on a
 * non-2xx response; {@link signIn} maps that to a `network` outcome.
 */
export async function requestNonce(deps?: AuthClientDeps): Promise<AuthNonceResponse> {
  const response = await resolveFetch(deps)(resolveUrl(deps, "/auth/nonce"), {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`nonce request failed (${String(response.status)})`);
  }
  return readJson<AuthNonceResponse>(response);
}

/**
 * Run the full SIWE handshake and, on success, leave the browser holding the
 * HttpOnly session cookie the server set on `POST /auth/verify`.
 *
 * Failure mapping: a declined wallet prompt (EC-24) → `rejected`; verify 401
 * (nonce/signature/binding) or 400 (malformed body — a client bug) →
 * `unauthenticated`; a thrown fetch or unexpected status → `network`.
 */
export async function signIn(options: SignInOptions): Promise<SignInResult> {
  const { api, address } = options;

  let nonceResponse: AuthNonceResponse;
  try {
    nonceResponse = await requestNonce(options);
  } catch {
    return { ok: false, reason: "network" };
  }

  const message = buildSiweMessage({
    domain: options.domain ?? currentDomain(),
    nonce: nonceResponse.nonce,
    statement: options.statement ?? DEFAULT_STATEMENT,
    issuedAt: options.issuedAt ?? new Date().toISOString(),
  });

  let signed: Signature;
  try {
    signed = await api.signData(message, { encoding: "text", keyType: "unshielded" });
  } catch {
    // The wallet rejected the prompt (user declined) or errored while signing (EC-24).
    return { ok: false, reason: "rejected" };
  }

  // `signed.data` is the exact text the wallet signed and `signed.verifyingKey`
  // is the BIP-340 key the server needs to check both the signature and the
  // key↔address binding (constitution III). Send all four fields.
  const verifyBody: AuthVerifyRequest = {
    address: address as MidnightAddress,
    message: signed.data,
    signature: signed.signature,
    verifyingKey: signed.verifyingKey,
  };

  let response: Response;
  try {
    response = await resolveFetch(options)(resolveUrl(options, "/auth/verify"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(verifyBody),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (response.ok) {
    const body = await readJson<AuthVerifyResponse>(response);
    return { ok: true, address: body.address };
  }
  if (response.status === 401 || response.status === 400) {
    return { ok: false, reason: "unauthenticated" };
  }
  return { ok: false, reason: "network" };
}

/**
 * Resume an existing session on reload (`GET /auth/session`, SC-019). Returns the
 * account on 200 (the server slides the 7-day expiry, D44) or `null` on any
 * non-2xx (401 = no live session). Cookie-only — never touches the wallet.
 */
export async function resumeSession(deps?: AuthClientDeps): Promise<Account | null> {
  const response = await resolveFetch(deps)(resolveUrl(deps, "/auth/session"), {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    return null;
  }
  const body = await readJson<AuthSessionResponse>(response);
  return { address: body.address };
}

/**
 * End the current session (`POST /auth/logout`). Invalidation is immediate and
 * server-side; the response clears the cookie. Best-effort — a missing session
 * simply 401s, which is already the logged-out state.
 */
export async function logout(deps?: AuthClientDeps): Promise<void> {
  await resolveFetch(deps)(resolveUrl(deps, "/auth/logout"), {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json" },
  });
}
