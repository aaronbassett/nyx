/**
 * Compile Service wire schemas (US2 — compile pipeline, T066).
 *
 * The single zod source of truth for the Nyx-side view of the Compile Service
 * HTTP contract (`infra/compile-service/API.md`). Nyx does NOT compile or write
 * R2 — it consumes this owner-built glue API — so these schemas mirror the
 * contract's §3 shared types (`Diagnostic`, `CompilerVersions`, `SourceFile`),
 * §4 endpoint request/response bodies (check / compile submit / job poll /
 * version), and the §5 R2 integrity `manifest.json` that verify-before-announce
 * reads.
 *
 * A compile FAILURE is DATA here, never a schema/transport error: `check`
 * returns `{ ok:false, diagnostics }` and a job returns `status:"failed"` with a
 * `Diagnostic[]` — both parse cleanly. Only a malformed body (a response that
 * does not match these schemas) is a protocol breach the client raises. Every
 * result carries `compilerVersion` (D6/FR-012) so the agent always has it in
 * context.
 */
import { z } from "zod";

// ── §3.1 Diagnostic (passed through verbatim from compact-mcp) ────────────────

/** Diagnostic severity — errors feed the verify loop, never surface as done work. */
export const DiagnosticSeveritySchema = z.enum(["error", "warning", "note"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

/** Which tool spoke; the streams are never merged (`compactp` parser vs `compactc`). */
export const DiagnosticSourceSchema = z.enum(["compactp", "compactc"]);
export type DiagnosticSource = z.infer<typeof DiagnosticSourceSchema>;

/** A 1-based line/column position; `offset` is optional per the contract. */
export const DiagnosticPositionSchema = z.object({
  line: z.number(),
  column: z.number(),
  offset: z.number().optional(),
});
export type DiagnosticPosition = z.infer<typeof DiagnosticPositionSchema>;

/** A source span; `end` is optional (a point diagnostic carries only `start`). */
export const DiagnosticSpanSchema = z.object({
  start: DiagnosticPositionSchema,
  end: DiagnosticPositionSchema.optional(),
});
export type DiagnosticSpan = z.infer<typeof DiagnosticSpanSchema>;

/** One structured diagnostic (§3.1). `raw:true` is an un-parsed passthrough. */
export const DiagnosticSchema = z.object({
  severity: DiagnosticSeveritySchema,
  source: DiagnosticSourceSchema,
  message: z.string(),
  file: z.string().optional(),
  span: DiagnosticSpanSchema.optional(),
  code: z.string().optional(),
  raw: z.boolean().default(false),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

// ── §3.2 CompilerVersions (D6) ────────────────────────────────────────────────

/** Parser-vs-compiler skew verdict carried on the pinned-versions payload. */
export const CompilerSkewSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type CompilerSkew = z.infer<typeof CompilerSkewSchema>;

/**
 * The pinned toolchain versions (§3.2). `compilerVersion` (compactc) is the
 * load-bearing pin folded into every artifact prefix; the rest are context.
 */
export const CompilerVersionsSchema = z.object({
  compilerVersion: z.string(),
  languageVersion: z.string(),
  ledger: z.string(),
  runtime: z.string(),
  cli: z.string(),
  compactp: z.string(),
  skew: CompilerSkewSchema,
});
export type CompilerVersions = z.infer<typeof CompilerVersionsSchema>;

// ── §3.3 SourceFile ───────────────────────────────────────────────────────────

/** One request source file — Compact contracts import sibling modules, so a SET. */
export const SourceFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type SourceFile = z.infer<typeof SourceFileSchema>;

// ── §4.1 POST /v1/check ───────────────────────────────────────────────────────

/** Check request: the source set, plus an optional `entry` file to compile. */
export const CheckRequestSchema = z.object({
  files: z.array(SourceFileSchema).min(1),
  entry: z.string().optional(),
});
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

/**
 * Check response (§4.1). A failed compile is `ok:false` DATA — never an HTTP
 * error. `durationMs` is the service-measured check latency (an SC-008 input).
 */
export const CheckResponseSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(DiagnosticSchema),
  compilerVersion: z.string(),
  durationMs: z.number(),
});
export type CheckResponse = z.infer<typeof CheckResponseSchema>;

// ── §4.2/4.3 job model (compile + publish) ────────────────────────────────────

/** Compile job status; `succeeded`/`failed` are terminal (D31 job model). */
export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Compile request (§4.2): project id + source set + optional entry. */
export const CompileRequestSchema = z.object({
  projectId: z.string().min(1),
  files: z.array(SourceFileSchema).min(1),
  entry: z.string().optional(),
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

/**
 * The immediate `POST /v1/compile` response (§4.2): a job handle. Even a terminal
 * status (reuse / fast failure) carries no result body here — the outcome is read
 * from the job poll (§4.3), so the client always polls at least once.
 */
export const CompileSubmitResponseSchema = z.object({
  jobId: z.string().min(1),
  status: JobStatusSchema,
  sourceHash: z.string().min(1),
});
export type CompileSubmitResponse = z.infer<typeof CompileSubmitResponseSchema>;

/** One compiled circuit named in a result/manifest. */
export const CompileCircuitSchema = z.object({
  name: z.string(),
  proof: z.boolean(),
});
export type CompileCircuit = z.infer<typeof CompileCircuitSchema>;

/**
 * Honest heartbeat while queued/running (§4.3, D31): a message and elapsed
 * seconds — NEVER a fabricated percentage (compactc reports no stages).
 */
export const CompileProgressSchema = z.object({
  message: z.string(),
  elapsedSeconds: z.number(),
});
export type CompileProgress = z.infer<typeof CompileProgressSchema>;

/**
 * The result on a `succeeded` job (§4.3). `urlPrefix` points at a complete,
 * verified R2 prefix (the service reaches `succeeded` only after upload +
 * re-fetch). `reused:true` means a content-hash match served existing artifacts
 * with NO keygen (SC-006).
 */
export const CompileResultSchema = z.object({
  urlPrefix: z.string().url(),
  sourceHash: z.string(),
  compilerVersion: z.string(),
  reused: z.boolean(),
  circuits: z.array(CompileCircuitSchema),
});
export type CompileResult = z.infer<typeof CompileResultSchema>;

/**
 * The error on a `failed` job (§4.3). `kind:"compile"` carries diagnostics (a
 * data failure that feeds the verify loop); `kind:"service"` carries a message
 * (an infra fault).
 */
export const CompileJobErrorSchema = z.object({
  kind: z.enum(["compile", "service"]),
  diagnostics: z.array(DiagnosticSchema).optional(),
  compilerVersion: z.string().optional(),
  message: z.string().optional(),
});
export type CompileJobError = z.infer<typeof CompileJobErrorSchema>;

/**
 * A polled compile job (§4.3). `progress` is present while queued/running;
 * `result` iff succeeded; `error` iff failed.
 */
export const CompileJobSchema = z.object({
  jobId: z.string().min(1),
  status: JobStatusSchema,
  sourceHash: z.string(),
  progress: CompileProgressSchema.optional(),
  result: CompileResultSchema.optional(),
  error: CompileJobErrorSchema.optional(),
});
export type CompileJob = z.infer<typeof CompileJobSchema>;

// ── Service error envelope (§4.1: 4xx/5xx, distinct from a compile failure) ───

/** The `{ error: { code, message } }` envelope on a 4xx/5xx service fault. */
export const ServiceErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ServiceErrorBody = z.infer<typeof ServiceErrorBodySchema>;

// ── §5 R2 integrity manifest (uploaded LAST = completeness marker) ────────────

/** One artifact listed in the integrity manifest, with its hash + size + type. */
export const ArtifactManifestFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string(),
  bytes: z.number(),
  contentType: z.string(),
});
export type ArtifactManifestFile = z.infer<typeof ArtifactManifestFileSchema>;

/**
 * The `<urlPrefix>/manifest.json` integrity manifest (§5). Verify-before-announce
 * reads this and confirms every listed file is fetchable before Nyx emits
 * `artifacts:ready` (FR-014).
 */
export const ArtifactManifestSchema = z.object({
  sourceHash: z.string(),
  compilerVersion: z.string(),
  circuits: z.array(CompileCircuitSchema),
  files: z.array(ArtifactManifestFileSchema),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
