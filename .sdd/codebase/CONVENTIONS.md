# Coding Conventions

> **Purpose**: Document code style, naming conventions, error handling, and common patterns.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5: External-service client convention, submit→poll job model, exactOptionalPropertyTypes)

## Code Style & Formatting

### Formatting Tools

| Tool | Configuration | Command |
|------|---------------|---------|
| Prettier | `.prettierrc.json` | `pnpm format` / `pnpm format:check` |
| ESLint | `eslint.config.mjs` | `pnpm lint` |
| TypeScript | `tsconfig.base.json` (+ per-package overrides) | `pnpm typecheck` |

### Style Rules

| Rule | Convention | Example |
|------|------------|---------|
| Indentation | 2 spaces (Prettier default) | |
| Quotes | Double quotes | `"string"` |
| Import quotes | Double quotes with `.js` extensions (ESM + NodeNext) | `import { x } from "./utils.js"` |
| Semicolons | Always required | `const x = 1;` |
| Line length | 100 characters max | See `printWidth` in `.prettierrc.json` |
| Trailing commas | Automatic (Prettier) | Multi-line constructs get commas |

### TypeScript Strict Mode

All projects use **strict TypeScript** via `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

**Key constraints:**
- No implicit `any` types
- No non-null assertions (`!`)
- Indexed access on objects requires explicit checks
- Optional properties must use `?`, not `| undefined`
- Override methods must declare `override` keyword

## Naming Conventions

### Files & Directories

| Type | Convention | Example |
|------|------------|---------|
| Source files | camelCase or kebab-case | `loadConfig.ts`, `mcp-clients.ts` |
| Component files (React) | PascalCase | `UserProfile.tsx` |
| Test files | Same as source + `.test.ts` suffix | `loadConfig.test.ts` |
| Config files | camelCase or dot-notation | `eslint.config.mjs`, `.prettierrc.json` |
| Directories | kebab-case | `src/config`, `src/mcp`, `src/db` |

### Code Elements

| Type | Convention | Example |
|------|------------|---------|
| Variables | camelCase | `sessionId`, `accountAddress` |
| Constants | camelCase or SCREAMING_SNAKE_CASE | `PORT`, `MAX_RETRIES` or `defaultTimeout` |
| Functions | camelCase, verb prefix | `loadConfig`, `createMcpClients`, `parseEvent` |
| Classes | PascalCase | `McpClient`, `ConfigValidationError` |
| Interfaces | PascalCase, no `I` prefix | `McpClients`, `ServerDeps` |
| Types | PascalCase | `Config`, `McpSession`, `QueryResult` |
| Enums | PascalCase | `Status` (use const enum when possible) |
| Type brands | PascalCase | `TimestampMs`, `ProjectId` (defined via `z.ZodBrand`) |

## JSDoc Headers

Every source file must have a JSDoc header documenting its purpose with task/decision references:

```typescript
/**
 * Boot-config loader for the Nyx orchestrator (T015, DS-003).
 *
 * `loadConfig(env)` validates the environment and returns a typed, deeply-frozen
 * `Config`, THROWING `ConfigValidationError` (listing every offender) on invalid
 * input.
 */
```

**Format:**
- First line: brief description + task/decision references in parentheses (e.g., `(T015, DS-003)`)
- Subsequent lines: more detail, contract for public exports, key invariants
- Reference format: `T###` for tasks, `DS-###` for design decisions, `D##` for milestone decisions

## Import Organization

Standard import order:

1. External packages (`zod`, `fastify`, `@fastify/websocket`)
2. Type imports from external packages (`import type { ... } from "package"`)
3. Internal absolute imports (`import { ... } from "@/..."`)
4. Relative imports with `.js` extension (`import { ... } from "./utils.js"`)
5. Type imports from relatives (`import type { ... } from "./types.js"`)

```typescript
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { loadConfig } from "../config/index.js";
import type { Config } from "../config/index.js";
```

**Note**: NodeNext resolution requires `.js` extensions on all relative imports.

### DTOs from `@nyx/protocol`

`@nyx/protocol` is the shared source of truth for all wire protocol types (Zod schemas for WS events and REST DTOs):

- **Server imports**: Import both types and values (the Zod schema instances for runtime validation)
  ```typescript
  import { ProjectCreateRequestSchema, type ProjectCreateRequest } from "@nyx/protocol";
  ```

- **Web client imports**: Import **type-only** to avoid bundling Zod runtime into the client
  ```typescript
  // ✅ Correct: type-only import
  import type { ProjectCreateRequest } from "@nyx/protocol";
  
  // ❌ Avoid: would bundle Zod into browser
  import { ProjectCreateRequestSchema } from "@nyx/protocol";
  ```

This pattern ensures the web bundle stays lean (no Zod in browser) while server retains full validation capability.

## Error Handling

### Error Patterns

| Scenario | Pattern | Example |
|----------|---------|---------|
| Config validation | Custom error class with structured issues | `ConfigValidationError` in `src/config/errors.ts` |
| Network/MCP errors | Named error types (timeout, connection, call) | `McpTimeoutError`, `McpConnectionError`, `McpCallError` |
| Type validation | Zod `.safeParse()` with error collection | `EnvSchema.safeParse()` returns `{ success, error }` |
| Store errors | Named custom errors (not-found, quota, size cap) | `ProjectNotFoundError`, `ProjectQuotaExceededError`, `FileTooLargeError` (see below) |
| External service errors | Named error types (unavailable, protocol, response) | `CompileServiceError`, `CompileServiceUnavailableError`, `CompileServiceProtocolError` |
| Assertions | Custom validation with thrown errors | Never silent failures; throw with context |

### Named Store Errors & Async Rejection Channel

**Store error classes** (e.g., `ProjectNotFoundError`, `ProjectQuotaExceededError`, `FileTooLargeError`) are the single source of truth for persistence failures. These errors:

1. **Always reject asynchronously** — Store methods are `async`, validation failures surface as `Promise.reject()`, never synchronous throws
2. **Enable uniform error handling** — Route error-handlers map known error types to HTTP status/body; unknown errors rethrow (→ 500)
3. **Carry context** — Each error includes the offending value and limit (e.g., `FileTooLargeError` carries path, size, limit)

**Pattern:**

```typescript
// In src/projects/store.ts or src/projects/errors.ts
export class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(`file exceeds size cap: ${path} is ${String(size)} bytes (limit ${String(limit)})`);
    this.name = "FileTooLargeError";
  }
}

// In store methods (both Pg* and in-memory):
async commit(projectId: string, request: CommitRequest): Promise<CommitResult> {
  // Validation failures are caught and rejected, not thrown synchronously.
  for (const file of request.files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > this.maxFileBytes) {
      return Promise.reject(new FileTooLargeError(file.path, bytes, this.maxFileBytes));
      // ← Or throw within try/catch that converts sync throws to rejections
    }
  }
  // ...
}

// In route error-handlers:
try {
  await store.commit(projectId, request);
} catch (error) {
  if (error instanceof FileTooLargeError) {
    reply.code(413).send({ error: "file too large", path: error.path, limit: error.limit });
    return;
  }
  throw error; // Unknown → 500
}
```

### External-Service Client Convention

**File**: `src/compile/client.ts`, mirroring the web auth client at `apps/web/src/wallet/auth.ts` (T066, D52).

An HTTP client for an external, owner-built service (Compile Service) uses **injectable transport** and **failure-is-data** semantics:

**Injectable pattern:**
```typescript
export interface CompileServiceClientDeps {
  /** The server-only bearer token sent as Authorization: Bearer. */
  readonly token: string;
  /** fetch implementation; defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Base URL prefixed to the relative /v1/* paths; defaults to "". */
  readonly baseUrl?: string;
}

export class HttpCompileClient implements CompileClient {
  constructor(deps: CompileServiceClientDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.baseUrl = deps.baseUrl ?? "";
    this.token = deps.token;
  }

  private async send(path: string, method: "GET" | "POST", body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CompileServiceUnavailableError(path, error); // Network fault
    }
  }
}
```

**Failure-is-data contract:**
- A compile failure (`ok:false` / job `status:"failed"`) is DATA, returned cleanly with diagnostics
- Only transport faults (network, fetch throws), service 4xx/5xx envelopes, and malformed response bodies throw named errors (`CompileServiceUnavailableError`, `CompileServiceResponseError`, `CompileServiceProtocolError`)
- Example: `check` returns `{ ok: false, diagnostics: [...] }` rather than throwing on failed compilation

**Submit→Poll Job Model:**

The `runCompileJob(client, request, options)` function implements a bounded poll loop (§4.2→§4.3, FR-016):

```typescript
export async function runCompileJob(
  client: Pick<CompileClient, "compile" | "pollCompile">,
  req: CompileRequest,
  options: RunCompileJobOptions = {},
): Promise<CompileJob> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? realDelay;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = now();

  const submit = await client.compile(req);
  const jobId = submit.jobId;

  for (;;) {
    const job = await client.pollCompile(jobId);
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    options.onProgress?.({ status: job.status, progress: job.progress });
    if (now() - startedAt >= maxWaitMs) {
      throw new CompileJobTimeoutError(jobId, maxWaitMs, job.status);
    }
    await delay(pollIntervalMs);
  }
}

export interface RunCompileJobOptions {
  readonly now?: () => number;           // Monotonic clock (injectable for tests)
  readonly delay?: (ms: number) => Promise<void>; // Sleep impl (injectable)
  readonly pollIntervalMs?: number;      // Poll cadence
  readonly maxWaitMs?: number;           // Bounded max wait (FR-016, never infinite)
  readonly onProgress?: (update: CompileProgressUpdate) => void; // Progress callback
}
```

**Key invariants:**
- Always polls at least once (even on terminal submit)
- Bounded max wait with injected clock prevents infinite loops; a hung job raises `CompileJobTimeoutError`
- `onProgress` fires on every queued/running poll so callers surface progress
- All parameters (delay, clock, max wait) are injectable for deterministic testing

### Error Response Format

```typescript
// Standard error response structure
{
  error: {
    code: 'ERROR_CODE',
    message: 'Human readable message',
    details?: object
  }
}
```

### Logging

Use Fastify's built-in logger (`logger: true` on `Fastify()` instance):

```typescript
const app = Fastify({ logger: true });
// Logs via pino; structured JSON in production, pretty in development
```

Do not use `console.log` in server code; defer to the Fastify logger.

## Common Patterns

### Dependency Injection

All major components accept injected dependencies for testability:

```typescript
interface ServerDeps {
  readonly config: Config;
  readonly db: Queryable;
  readonly mcp: McpClients;
  readonly wsHandler?: WsConnectionHandler;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // ...
}
```

**Key principle**: No side effects in the build function; bootstrap owns config loading and `listen`.

### Store Pattern (T050/T051/T054)

**Overview**: Stores separate the interface from Postgres-backed and test-double implementations.

**Three tiers:**

1. **Interface** (e.g., `ProjectStore`, `SessionAuthStore` in `src/projects/store.ts`, `src/auth/store.ts`)
   - Defines the contract: async methods that return Promises
   - Validation errors surface as `Promise.reject()`, never synchronous throws
   - All expiry/quota decisions use an abstracted clock (the DB clock in Postgres, injected in tests)

2. **Pg* Implementation** (e.g., `PgProjectStore`, `PgSessionAuthStore`)
   - Reads/writes via parameterized SQL against a pooled DB
   - Transactions via `db.transaction(fn)` for atomic batches (commits, version allocation, restore)
   - Errors are caught and mapped to named custom errors (e.g., Postgres 22P02 → treated as not-found)
   - All time decisions delegate to the DB clock (`now()` in SQL)

3. **In-Memory Test Double** (e.g., `InMemoryProjectStore`, `InMemoryAuthStore` in `tests/*/helpers.ts`)
   - Faithfully models the interface semantics with an **injected clock** for determinism
   - Uses `structuredClone` snapshot-and-restore for transaction rollback (SC-026)
   - Includes one-shot fault hooks (e.g., `failNextCommitAfter`) to inject mid-batch crashes deterministically
   - Validation failures explicitly return `Promise.reject()` to match the Pg* async channel
   - Content hashes use the **real** `computeContentHash` so manifests are byte-comparable (SC-025)

**Example Usage in Tests:**

```typescript
// Test setup: inject in-memory store with a controllable clock
const clock = { now: 1_000_000 };
const store = makeInMemoryStore(clock); // Returns InMemoryProjectStore

// Deterministic contract tests run with the in-memory store (no DB, no network)
const project = await store.createProject("owner", "demo");
expect(project.createdAt).toBe(clock.now);

// SC-026: crash mid-batch is deterministic
store.failNextCommitAfter(1); // Fault after 1 file write
await expect(store.commit(projectId, { author: "agent", files: [...] }))
  .rejects.toThrow("injected mid-commit fault");

// The previous version is intact (rollback worked)
const manifest = await store.getManifest(projectId);
expect(manifest).toEqual(priorManifest);
```

### Pure Decision Functions

Separate pure logic (decisions) from impure I/O to maximize testability:

```typescript
// ✅ Pure: decision function, no side effects
export function classifyConnectState(
  isAuthenticated: boolean,
  hasSession: boolean,
): "idle" | "authenticated" | "reconnecting" {
  if (isAuthenticated && hasSession) return "authenticated";
  if (isAuthenticated) return "reconnecting";
  return "idle";
}

// ✅ Pure: builds a message, doesn't send it
export function buildSiweMessage(
  address: string,
  nonce: string,
  chainId: number,
): string {
  return `nyx.localhost wants you to sign in...\n\nAddress: ${address}\nChain ID: ${chainId}\nNonce: ${nonce}`;
}

// ❌ Impure: I/O and side effects
export async function authenticateUser(
  userId: string,
): Promise<void> {
  const user = await db.getUser(userId);  // ← I/O
  emit("userAuthenticated", user);        // ← Side effect
}
```

**Best practice**: Extract pure logic into separate functions; inject impure dependencies (DB, API clients) into handlers that call the pure functions. This enables testing decision logic with no mocking.

### Test Data Builders

Create reusable test data factories:

```typescript
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/nyx",
    // ... required vars
    ...overrides,
  };
}

function baseRouting(): TestRouting {
  return {
    supervisor: { provider: "anthropic", model: "model-supervisor" },
    // ...
  };
}
```

### Readonly Properties

Use `readonly` on interface/class properties to prevent accidental mutation:

```typescript
interface McpClients {
  readonly toolchain: McpClient;
  readonly tome: McpClient;
  readonly mnm: McpClient;
}
```

### Deep Freezing Config

Config objects are deep-frozen after assembly to prevent runtime mutation:

```typescript
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
```

### Conditional Spread with exactOptionalPropertyTypes

When constructing request bodies with optional fields, use conditional spread to avoid including `undefined`:

```typescript
// ✅ Correct: conditional spread excludes undefined
const checkReq: CheckRequest = {
  files: [...input.files],
  ...(input.entry === undefined ? {} : { entry: input.entry }),
};

// ❌ Avoid: would include entry:undefined, violating exactOptionalPropertyTypes
const checkReq: CheckRequest = {
  files: [...input.files],
  entry: input.entry,
};
```

This pattern ensures TypeScript's `exactOptionalPropertyTypes` constraint is satisfied: optional fields are truly absent from the object, not present with `undefined` value. It's used consistently in the compile pipeline (`src/compile/orchestrator.ts`) when building `CheckRequest` and `CompileRequest` bodies.

## Git Conventions

### Commit Messages

Format: `type(scope): description`

| Type | Usage | Example |
|------|-------|---------|
| feat | New feature | `feat(ws): add authentication gate` |
| fix | Bug fix | `fix(config): validate model routing schema` |
| docs | Documentation | `docs: update README with setup instructions` |
| style | Formatting/linting | `style: run prettier` |
| refactor | Code restructure (no feature change) | `refactor(mcp): extract client timeout logic` |
| test | Adding/updating tests | `test(config): add edge case for empty env values` |
| chore | Maintenance (deps, CI, tooling) | `chore: upgrade vitest to v3` |

**Rules:**
- Subject must start with **lowercase** (commitlint rejects sentence-case)
- Subject must be **≤72 characters** (conventional commits standard)
- Use imperative mood: "add" not "added" or "adds"
- No period at end of subject
- Detailed body (if needed) separated by blank line

### Commit Hooks

Husky orchestrates pre-commit and commit-msg hooks:

| Hook | Command | Purpose |
|------|---------|---------|
| pre-commit | `pnpm lint-staged` + `pnpm typecheck` | Lint + format + typecheck staged files before commit |
| commit-msg | `pnpm commitlint --edit` | Validate commit message format |

Run `pnpm install` to activate hooks after clone.

### Branch Naming (Recommended)

While not enforced, prefer: `{type}/{ticket}-{description}`

Examples:
- `feat/T067-contract-compilation`
- `fix/DS-031-timeout-handling`
- `docs/update-testing-guide`

## ESLint Configuration

Root config in `eslint.config.mjs` (flat config):

- **Base**: `@eslint/js` recommended rules
- **TypeScript**: `typescript-eslint` strict + stylistic type-checked rules
- **Service**: projectService enabled for type-aware linting (all projects)
- **Prettier**: Integrated via `eslint-config-prettier` (disables conflicting rules)
- **Exclusions**: `dist/`, `node_modules/`, `pocs/`, `.claude/`
- **Special case**: Config files (`*.config.mjs`) use `disableTypeChecked` since they're outside tsconfig

**Running ESLint:**

```bash
pnpm lint              # Check all files
pnpm lint --fix        # Auto-fix issues
pnpm lint src/app.ts   # Check specific file
```

## Comments & Documentation

| Type | When to Use | Format |
|------|-------------|--------|
| File header JSDoc | Always (see JSDoc Headers above) | `/** ... */` with task refs |
| Function/class JSDoc | Public APIs, complex logic | `/** ... */` with `@param`, `@returns` |
| Inline comment | Explain "why", not "what" | `// Explanation of non-obvious logic` |
| TODO | Planned work with context | `// TODO(T###): description` |
| FIXME | Known issues / tech debt | `// FIXME: description` (prefer issues instead) |

Avoid over-commenting; prefer clear names and structure. Comments should explain *why* a decision was made, not *what* the code does.

## Special Considerations

### Secrets & Credentials

**NEVER** commit secrets directly:
- Use `.env.local` (git-ignored) for local development
- Pass secrets via environment variables or the `.secrets` section of config
- Config loading validates secrets are set but never prints them
- `publicConfig()` strips secrets before sending to clients

### Deterministic Testing

All tests are deterministic (no external services required):
- Inject dependencies (`SessionStore`, `McpSessionFactory`, `Queryable`)
- Use test doubles (`okSession`, `stubDb`, `validEnv`)
- No `DATABASE_URL` check in unit tests; live DB checks gated on env var
- All randomness must be seeded or stubbed (`vi.useFakeTimers()`)

### Monorepo Structure

Nyx is a `pnpm` monorepo with workspace packages:
- `apps/server` — Fastify orchestrator + WebSocket handler
- `apps/web` — React frontend + Vite
- `packages/protocol` — Shared wire protocol (Zod schemas)
- `packages/scaffold` — Contract scaffolding service
- `packages/nyxt-vault` — Vault management
- `infra/` — Deployment configs

Each package has its own `package.json` and `tsconfig.json` (extending root `tsconfig.base.json`).

---

## What Does NOT Belong Here

- Test strategies → TESTING.md
- Security practices → SECURITY.md
- Architecture patterns → ARCHITECTURE.md
- Technology choices → STACK.md

---

*This document defines HOW to write code. Update when conventions change.*
