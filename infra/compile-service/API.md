> **SUPERSEDED (2026-07-23, owner decision — design: docs/superpowers/specs/2026-07-23-demo-ready-local-mode-design.md §4).**
> The Compile Service is retired. User contracts compile in the user's browser
> (`@nyx/compact-wasm`); artifacts upload to the Nyx server's ArtifactStore.
> This contract is kept for historical reference only. Do not build against it.

# Nyx Compile Service — API contract (v1)

**Status:** draft contract, authored by the Nyx side (US2). The service itself is
built separately against this document. This is the **glue** between Nyx and the
owner's `compact-mcp` toolchain.

## 1. Why this service exists

`compact-mcp` (the owner's Rust/rmcp toolchain MCP) is a **local compile/analyze
toolchain over a workspace directory**. It compiles Compact source to a local
`target_dir` and returns structured diagnostics — but it has **no concept of R2,
uploads, content-hashed prefixes, or a CDN**, and it reads source from a
filesystem workspace rather than an HTTP request.

Nyx needs the missing half: turn a project's source (Postgres rows, US7) into a
**fetchable, content-addressed artifact prefix on R2** that the browser
`FetchZkConfigProvider` can read under the R3 header rules. The Compile Service is
that glue. It:

1. accepts a project's Compact source over an authenticated HTTP call,
2. materialises it into a workspace and drives `compact-mcp` (check / full),
3. on a green **full** build, uploads the artifacts to R2 under a content-hashed
   prefix with the immutable cache headers (R3), and
4. returns structured results (diagnostics, compiler version, `urlPrefix`).

### Trust boundary (constitution III — NON-NEGOTIABLE)

- The Compile Service **holds the only R2 write credentials**. They **never** cross
  to the Nyx orchestrator, the browser, the WebContainer, or any generated file
  (D50/D6). Nyx authenticates to the service with a bearer token
  (`COMPILE_SERVICE_TOKEN`); that token grants compile+publish, not raw R2 access.
- The service is **private-by-construction** (no public IP; same posture as
  `compact-mcp` — Fly 6PN / private mesh). Only the Nyx orchestrator calls it.
- Nyx reads artifacts back from R2 over the **public read** domain (the R3 CORS/CORP/
  Cache config); it only ever _reads_ R2, never writes.

## 2. Transport, versioning, auth

- Base path is version-prefixed: `/v1/...`. Breaking changes bump the prefix.
- JSON over HTTP. `Content-Type: application/json` for request/response bodies.
- **Auth:** every request carries `Authorization: Bearer <COMPILE_SERVICE_TOKEN>`.
  Missing/invalid → `401`.
- The service is stateless w.r.t. workspaces (each build gets a fresh ephemeral
  workspace, torn down after). R2 is the only durable store. Job state (§4) may be
  in-memory or backed by the service's own store — opaque to Nyx.

## 3. Shared types

### 3.1 `Diagnostic` (passed through verbatim from `compact-mcp`)

```jsonc
{
  "severity": "error" | "warning" | "note",
  "source":   "compactp" | "compactc",   // which tool spoke; never merge the streams
  "message":  "string",
  "file":     "src/foo.compact",           // optional, workspace-relative
  "span": {                                 // optional
    "start": { "line": 7, "column": 3, "offset": 142 },  // 1-based line/column; offset optional
    "end":   { "line": 7, "column": 9 }                   // optional
  },
  "code": "string",                         // optional compiler code
  "raw":  false                             // true = unstructured passthrough (never dropped)
}
```

Note: `compactc` reports only the **first** error and stops; the parser
(`compactp`, via the `check` path) reports **every** syntax error at once. Nyx
surfaces diagnostics to the verify loop / agent, not to the end user as done work
(US2 scenario 1).

### 3.2 `CompilerVersions` (D6)

```jsonc
{
  "compilerVersion": "0.31.1", // compactc — the load-bearing pin
  "languageVersion": "0.23",
  "ledger": "…",
  "runtime": "…",
  "cli": "…",
  "compactp": "…",
  "skew": { "ok": true, "detail": "…" }, // parser-vs-compiler skew verdict
}
```

### 3.3 `SourceFile` and the content hash

Request source is a **set of files**, not a single blob (Compact contracts import
sibling modules):

```jsonc
{ "path": "src/counter.compact", "content": "pragma language_version >= 0.23; …" }
```

The **content hash** that addresses the artifact prefix is deterministic and
computed by the service (and reproducible by Nyx so it can predict reuse):

```
sourceHash = sha256(
  "compact-artifacts/v1\n" ‖
  compilerVersion ‖ "\n" ‖
  flags_canonical ‖ "\n" ‖         // e.g. "no_communications_commitment=false"
  for each file sorted by path:  path ‖ "\0" ‖ sha256(content) ‖ "\n"
)  → lowercase hex
```

`compilerVersion` and compile flags are folded in **on purpose**: a compiler bump
or a flag change must yield a _new_ prefix, so artifact reuse (§4, SC-006) can
never serve keys built by a different compiler.

## 4. Endpoints

### 4.1 `POST /v1/check` — fast static validity (no keygen, no upload)

Runs `compact-mcp compile --skip-zk` (full static/type validity, **no** proving
keys) over the submitted source. This is the per-iteration **check** of D35.
Synchronous; fast (seconds).

**Request**

```jsonc
{
  "files": [{ "path": "src/counter.compact", "content": "…" }],
  "entry": "src/counter.compact", // optional; the file to compile. Defaults by convention.
}
```

**Response `200`** (a _failed compile is not an HTTP error_ — it is `ok:false` data):

```jsonc
{
  "ok": true, // false ⇒ see diagnostics
  "diagnostics": [/* Diagnostic */],
  "compilerVersion": "0.31.1",
  "durationMs": 812.4,
}
```

`400` malformed request (e.g. empty `files`, `entry` not in `files`). `401` auth.
`5xx` service/compact-mcp failure (`compact` not on PATH, workspace error) with
`{ "error": { "code", "message" } }` — distinct from a compile failure.

### 4.2 `POST /v1/compile` — full compile + publish to R2 (async job)

Full build (`compact-mcp compile` **without** `--skip-zk`: PLONK proving keys +
zkIR), then upload to R2 under the content-hashed prefix. Long-running → **job**
model (D31: explicit queued/progress, never a silent timeout).

**Request**

```jsonc
{
  "projectId": "9f…uuid",
  "files": [{ "path": "src/counter.compact", "content": "…" }],
  "entry": "src/counter.compact", // optional
}
```

**Reuse (SC-006):** the service computes `sourceHash`; if a **complete, verified**
prefix already exists at `<projectId>/<sourceHash>/`, it returns a terminal
`succeeded` result immediately with `"reused": true` and **runs no keygen**.

**Response `202`** (work started) or `200` (terminal immediately — reuse or a fast
failure):

```jsonc
{
  "jobId": "job_…",
  "status": "queued" | "running" | "succeeded" | "failed",
  "sourceHash": "e3b0c4…"
}
```

### 4.3 `GET /v1/compile/{jobId}` — poll a compile job

**Response `200`**

```jsonc
{
  "jobId": "job_…",
  "status": "queued" | "running" | "succeeded" | "failed",
  "sourceHash": "e3b0c4…",
  "progress": {                     // present while queued/running (D31 heartbeat)
    "message": "compiling and generating proving keys",
    "elapsedSeconds": 41.2
    // NO fabricated percentage — compactc reports no stages. Honest elapsed only.
  },
  "result": {                       // present iff status = "succeeded"
    "urlPrefix": "https://<r2-public>/9f…uuid/e3b0c4…",
    "sourceHash": "e3b0c4…",
    "compilerVersion": "0.31.1",
    "reused": false,
    "circuits": [ { "name": "increment", "proof": true } ]
  },
  "error": {                        // present iff status = "failed"
    "kind": "compile" | "service",
    "diagnostics": [ /* Diagnostic */ ],   // present when kind = "compile"
    "compilerVersion": "0.31.1",
    "message": "…"                          // present when kind = "service"
  }
}
```

`404` unknown `jobId`. Jobs are retained for a documented minimum (≥ 1h) after
terminal state so Nyx can always read the outcome.

**Verify-before-announce (FR-014):** a job reaches `succeeded` **only after** every
artifact _and_ the `manifest.json` (§5) are uploaded and re-fetched to confirm the
prefix is complete. So `urlPrefix` always points at a complete, fetchable set —
Nyx emits `artifacts:ready { urlPrefix }` at most once per green turn on this basis
(and may additionally HEAD/GET `manifest.json` itself before announcing).

### 4.4 `GET /v1/version` — pinned toolchain versions (D6)

**Response `200`**: a `CompilerVersions` (§3.2). Also embedded in every
check/compile result so the agent always has the compiler version in context
(US2 scenario 6).

## 5. R2 artifact prefix layout (what `urlPrefix` points at)

Under `<projectId>/<sourceHash>/`, in `FetchZkConfigProvider` layout:

```
manifest.json                     # integrity manifest, uploaded LAST = completeness marker
keys/<circuit>.prover
keys/<circuit>.verifier
zkir/<circuit>.bzkir
```

`manifest.json`:

```jsonc
{
  "sourceHash": "e3b0c4…",
  "compilerVersion": "0.31.1",
  "circuits": [{ "name": "increment", "proof": true }],
  "files": [
    {
      "path": "keys/increment.prover",
      "sha256": "…",
      "bytes": 12345,
      "contentType": "application/octet-stream",
    },
    {
      "path": "zkir/increment.bzkir",
      "sha256": "…",
      "bytes": 678,
      "contentType": "application/octet-stream",
    },
  ],
}
```

Every object is uploaded with `Cache-Control: public, max-age=31536000, immutable`
and the correct `Content-Type` as **object metadata** (R3). The artifact read
domain carries the R3 bucket CORS policy, the CORP Transform Rule, and the
mandatory Cache Rule for `.prover`/`.verifier`/`.bzkir` — so a cross-origin-isolated
`FetchZkConfigProvider` fetch succeeds with no silent CORS/CORP failure (SC-005,
SC-007). Prefixes are content-addressed and **immutable**; a new source (or
compiler bump) is a new prefix. R2 lifecycle expires prefixes on the D7 window
(≈ 1 day) — a stale fetch drives reopen→recompile (D36), which produces a fresh
prefix.

## 6. Semantics Nyx relies on (mapped to US2 acceptance criteria)

| #   | Behaviour                                                                                                                                                                                   | Where it lives                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `check` returns structured diagnostics within the turn; failure feeds the verify loop                                                                                                       | §4.1; Nyx never shows a failed check as done work                                              |
| 2   | full compile uploads keys+zkir+manifest to R2 under the content-hashed prefix, immutable + correct Content-Type; `succeeded` (and thus `urlPrefix`) only after the set is complete+verified | §4.2–4.3, §5                                                                                   |
| 3   | fetches under `urlPrefix` succeed from a cross-origin-isolated context (R3)                                                                                                                 | §5 (service uploads correct metadata; read domain carries R3)                                  |
| 4   | content-hash match ⇒ reuse existing artifacts, no re-keygen                                                                                                                                 | §4.2 `reused:true`                                                                             |
| 5   | long keygen ⇒ explicit `queued`/`running` + progress, never a silent timeout                                                                                                                | §4.2–4.3 job model + honest heartbeat                                                          |
| 6   | every result carries the exact compiler version                                                                                                                                             | §3.2, embedded in results; §4.4                                                                |
| 7   | concurrent projects compile safely; artifacts isolated by `projectId` + `sourceHash`                                                                                                        | §5 prefix; the service manages compact-mcp's serializing gate                                  |
| 8   | stale prefix past the lifecycle window → reopen guidance (Nyx-side), reopen recompiles                                                                                                      | §5 lifecycle; Nyx maps a stale-prefix fetch failure to D36 guidance                            |
| 9   | frontend-only turn (no `.compact` change) ⇒ no compile invoked                                                                                                                              | **Nyx-side gate** — the service compiles whatever it is handed; Nyx decides whether to call it |

## 7. What is NOT this service's job (Nyx owns these)

- Deciding **whether** to compile a turn (EC-11 frontend-only skip) — Nyx gates the call.
- Emitting `artifacts:ready { urlPrefix }` over the WS protocol (D12) — Nyx does this
  after a `succeeded` job (at most once per green turn).
- Reopen → recompile orchestration (D36/FR-050) — Nyx re-submits a full compile on
  project open to repopulate a fresh prefix.
- Holding project source of truth — Nyx sends the file set per call (from US7 rows).

## 8. Open questions for the service author

1. **Job store durability:** in-memory is fine for v1 (jobs are short-lived and
   re-submittable), but confirm the ≥1h terminal-retention so Nyx polls never race a
   GC. If the service is multi-replica, jobs need a shared store or sticky routing.
2. **Workspace file limits:** Nyx will cap per-file / per-project bytes (US7); the
   service should still defend its own limits and reject oversized submissions with a
   `service` error rather than OOM.
3. **`entry` convention:** default entry-point resolution when `entry` is omitted
   (single `.compact`? a manifested entry?) — pin it so Nyx and the service agree.
4. **compilerVersion pinning:** the service pins the compactc version (D6); confirm
   how a pin bump is rolled out (it changes every `sourceHash` → full recompile on
   next open for all projects, handled as a normal compile).
