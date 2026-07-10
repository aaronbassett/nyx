# R2 setup for zk artifacts (R3 — full cited report: discovery/archive/R3-r2-headers-full-report.md)

Serves prover/verifier keys + zkIR to cross-origin-isolated preview pages
(COEP require-corp). The SDK's FetchZkConfigProvider fetches in cors mode
(verified in midnight-js source), so CORP is strictly optional — but we set it
belt-and-braces. The **Cache Rule is mandatory**: `.prover`/`.verifier`/`.bzkir`
are not default-cached extensions, so without it nothing edge-caches and the
"CDN-fast repeat fetches" assumption silently fails.

## 1. Bucket CORS policy (wildcard is safe — SDK fetch is credentialless)

```json
[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "MaxAgeSeconds": 86400 }]
```

Apply: `wrangler r2 bucket cors set <BUCKET> --file cors.json`

## 2. Custom domain (production — r2.dev is throttled/rule-less, dev only)

Connect `zk.<nyx-domain>` (same Cloudflare account). Enable **Smart Tiered Cache**.

## 3. Transform Rule (response headers) on the zk.<nyx-domain> zone

- `Cross-Origin-Resource-Policy: cross-origin` (belt-and-braces for future no-cors contexts)
- optionally `Access-Control-Allow-Origin: *` (guards against cached-response/CORS drift)
  Do NOT set Cache-Control here — Transform-Rule Cache-Control does not affect edge caching.

## 4. Cache Rule (MANDATORY) on the zone

Match `hostname eq "zk.<nyx-domain>"` → Cache eligible, Edge TTL "respect origin".

## 5. Object metadata at upload (content-hashed paths => immutable)

```
Cache-Control: public, max-age=31536000, immutable
Content-Type:  application/octet-stream   # SDK hard-fails on text/html
```

The integrity-manifest JSON gets a short TTL / no-cache unless its path is also content-hashed.

## 6. Size note

Artifacts > 512 MB never edge-cache on non-Enterprise plans (still served, from R2).

## Write credentials

The toolchain compile MCP holds the ONLY R2 write credentials (D6, constitution III).
Browsers and the orchestrator have read-only access.
