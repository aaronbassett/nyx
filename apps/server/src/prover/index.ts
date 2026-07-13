/**
 * Public surface of the interim prover proxy (US6, D37/D62).
 *
 * A session-authenticated, same-origin proxy that relays opaque proof requests
 * from Nyx-app flows (deposits, deploys) to the interim hosted prover. Cookie
 * auth, no proving tokens (tokens gate only the S9 public escape-hatch exposure).
 * The real prover endpoint is injected config and owner-gated.
 */
export * from "./proxy.js";
