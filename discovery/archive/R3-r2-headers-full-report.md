# R3 — Full report: Cloudflare R2 + COEP for Nyx zk artifacts

*Research subagent report, 2026-07-10. Summary entry: R3 in RESEARCH.md. Every claim carries its source URL.*

## 1. R2 CORS: configuration, emitted headers, limitations

Source: https://developers.cloudflare.com/r2/buckets/cors/

- CORS is a **bucket-level policy** — dashboard (bucket → Settings → CORS Policy → JSON) or `npx wrangler r2 bucket cors set <BUCKET> --file cors.json` (verify with `... cors list`).
- Policy fields map to response headers: `AllowedOrigins` → `Access-Control-Allow-Origin`, `AllowedMethods` → `Access-Control-Allow-Methods`, `AllowedHeaders` → `Access-Control-Allow-Headers`, `ExposeHeaders` → `Access-Control-Expose-Headers`, `MaxAgeSeconds` → preflight cache time (browsers may clamp to ≤2h).
- Custom domains connected to a bucket with a CORS policy automatically return CORS headers for cross-origin requests.
- Limitations: CORS headers returned **only** when the request's `Origin` exactly matches an `AllowedOrigins` entry (curl without Origin shows nothing); origins are `scheme://host[:port]`, no paths; rule propagation up to 30s; non-safelisted headers JS-readable only via `ExposeHeaders`.
- Cache interplay: changing the CORS policy does not refresh already-cached responses — purge required (https://developers.cloudflare.com/cache/cache-security/cors/).

## 2. r2.dev vs custom domains

Sources: https://developers.cloudflare.com/r2/platform/limits/#rate-limiting-on-managed-public-buckets-through-r2dev · https://developers.cloudflare.com/r2/buckets/public-buckets/

- `r2.dev` is explicitly **not intended for production**: variable rate limit (~hundreds of req/s → 429s), possible bandwidth throttling, and **no** Cloudflare cache, WAF, Transform Rules, or Bot Management (it's Cloudflare's zone, not ours).
- Custom domains get the full stack (Cache, Cache Rules, Transform Rules, Workers, analytics); the domain must be a zone in the same Cloudflare account; connect via dashboard or `wrangler r2 bucket domain add`.
- Verdict: r2.dev for throwaway dev only; production artifacts require a custom domain.

## 3. Attaching Cache-Control and Cross-Origin-Resource-Policy

**Cache-Control — native, per-object, no Worker:**
- R2 replays object HTTP metadata on GET. Set at upload: wrangler `--cache-control`/`--content-type` flags; S3 `PutObjectCommand` `CacheControl`; Workers `put(key, body, { httpMetadata: { cacheControl, contentType } })`.
  (https://developers.cloudflare.com/r2/reference/wrangler-commands/ · https://developers.cloudflare.com/r2/objects/upload-objects/ · https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- Cloudflare's edge honors origin cache headers: caches on `Cache-Control: public` with `max-age > 0` (https://developers.cloudflare.com/cache/concepts/default-cache-behavior/). Object-level Cache-Control drives **both** browser and edge TTLs.

**CORP — not natively settable on R2:**
- No R2 mechanism emits arbitrary response headers (custom metadata comes back as `x-amz-meta-*`).
- Supported path: **Response Header Transform Rule** on the custom domain's zone (https://developers.cloudflare.com/rules/transform/response-header-modification/ · https://developers.cloudflare.com/cache/cache-security/cors/#add-or-change-cors-headers-on-cloudflare · example https://developers.cloudflare.com/rules/transform/examples/add-cors-header/). Simplest option; no Worker cost.
- Caveat: `Cache-Control` set via Transform Rule changes only what the browser sees, not how Cloudflare caches ("caching behavior is evaluated before response header modifications") — another reason to set Cache-Control on the object.

## 4. Custom domain via Cloudflare CDN, content-hashed immutable URLs

Sources: https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/ · https://developers.cloudflare.com/cache/concepts/default-cache-behavior/ · https://developers.cloudflare.com/cache/cache-security/cors/

Helps: Smart Tiered Cache (recommended); request collapsing (thundering-herd protection when new artifacts go live); origin-aware cache key (Host + **Origin** + path + query — no cross-origin CORS poisoning); ranged 206 responses from cache when Content-Length present (useful for multi-MB prover keys).

Bites:
- **Extension-based default caching**: Cloudflare only default-caches known file extensions; `.prover`, `.verifier`, `.bzkir` are NOT on the list and JSON is never default-cached → **without an explicit Cache Rule, nothing is edge-cached at all.**
- Cacheable file size limit: 512 MB (Free/Pro/Business); larger artifacts serve from R2 every time.
- CORS-policy changes don't propagate into cached responses — purge after changing.
- Default Edge TTL is only 120 min when no Cache-Control present.

## 5. COEP interaction (the crux)

Sources: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy · https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Resource-Policy · https://developer.mozilla.org/en-US/docs/Web/API/Request/mode

- COEP `require-corp` governs **`no-cors`-mode** loads. MDN: requests made in `cors` mode "won't be blocked by COEP or trigger COEP violations, but must still be permitted by CORS."
- `fetch(url)` defaults to `cors` mode; `no-cors` is the default only for markup-initiated loads (plain `<img>`, `<script>` without `crossorigin`).
- **SDK verification** (midnightntwrk/midnight-js, `packages/fetch-zk-config-provider/src/fetch-zk-config-provider.ts`, main): calls `fetchFunc(fullUrl, { method: 'GET' })` — cors-mode, credentialless simple GET, no preflight → wildcard `Access-Control-Allow-Origin: *` is fully compatible. Artifact URL shape: `${baseURL}/keys/<circuit>.prover|.verifier`, `${baseURL}/zkir/<circuit>.bzkir`, plus an integrity-manifest JSON. The provider **rejects any `text/html` response** (SPA-fallback detection) — correct `Content-Type` metadata is mandatory.

## Recommendation for Nyx

Architecture: **R2 bucket → custom domain (`zk.<nyx-domain>`) in the same Cloudflare account → bucket CORS policy + one Transform Rule + one Cache Rule. No Worker.** r2.dev for throwaway dev only.

1. **Bucket CORS policy** (artifacts are public + immutable; SDK fetch is credentialless, so wildcard works):
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "MaxAgeSeconds": 86400
  }
]
```
No `AllowedHeaders` needed (SDK sends none); no `ExposeHeaders` needed (SDK reads body + safelisted Content-Type only). Pin explicit origins instead of `*` if preferred (exact-match `scheme://host[:port]`).

2. **CORP strictly not required** (SDK fetches in cors mode) — but add one static Transform Rule anyway on `zk.<nyx-domain>`: set `Cross-Origin-Resource-Policy: cross-origin` (belt-and-braces for any future no-cors context; free). Optionally also set `Access-Control-Allow-Origin: *` in the same rule against cached-response/CORS-policy drift.

3. **Cache-Control at upload, as object metadata** (paths are content-hashed): `Cache-Control: public, max-age=31536000, immutable` + correct `Content-Type` (e.g. `application/octet-stream`) — SDK hard-fails on `text/html`. Integrity manifest (JSON) gets short TTL / `no-cache` unless its path is also content-hashed. Do NOT set Cache-Control via Transform Rule (doesn't affect edge caching).

4. **Cache Rule — mandatory and easy to miss**: `.prover`/`.verifier`/`.bzkir` are not default-cached extensions and JSON never is → add rule: hostname eq `zk.<nyx-domain>` → Cache eligible, Edge TTL "respect origin". Enable **Smart Tiered Cache** on the zone. Without this the "CDN-fast repeat fetches" assumption in the PRD (§9) silently does not happen.

5. **Size check**: prover keys > 512 MB never edge-cache on non-Enterprise plans (still served, straight from R2). Verify largest keys fit.
