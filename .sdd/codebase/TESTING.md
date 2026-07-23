# Testing Strategy

> **Purpose**: Document test frameworks, patterns, organization, and coverage requirements.
> **Generated**: 2026-07-10
> **Last Updated**: 2026-07-13 (Phase 5: External-service client testing, mocked fetch, verify-before-announce pattern, injectable clock/delay)

## Test Framework

| Type | Framework | Version | Configuration |
|------|-----------|---------|---------------|
| Unit | Vitest | v3 (root), v4 (apps/web) | Implicit; extends tsconfig.json |
| Integration | Vitest | v3 (root), v4 (apps/web) | Implicit; extends tsconfig.json |
| E2E | (Not yet in scope) | — | — |

### Framework Details

- **Vitest v3** (root workspaces): `@vitest/ui` optional, runs with TypeScript via tsconfig
- **Vitest v4** in `apps/web`: Pinned to v4 for compatibility with Vite 8 peer dependency
- **No Jest** — Vitest used throughout for fast, ESM-native testing
- **No Playwright/Cypress** — E2E strategy is WebSocket client simulation + real server boot (see foundation.test.ts)

### Running Tests

| Command | Purpose |
|---------|---------|
| `pnpm test` | Run all unit tests in all packages (deterministic only) |
| `pnpm test --watch` | Watch mode for active development |
| `pnpm test --ui` | Open browser UI (if `@vitest/ui` installed) |
| `pnpm test:coverage` | Generate coverage report (not yet standard in this repo) |
| Per-package: `cd apps/server && pnpm test` | Run tests for single package |
| With filter: `pnpm test --grep "loadConfig"` | Run tests matching pattern |

**Empty packages** use a special test command:

```bash
# packages/scaffold/package.json
"test": "vitest run --passWithNoTests"
```

This prevents CI failure when a package has no tests yet.

## Test Organization

### Directory Structure

Tests are organized in two patterns depending on package scope:

**Pattern 1: Co-located tests (most packages)**

```
apps/server/src/
├── config/
│   ├── schema.ts
│   ├── load.ts
│   ├── errors.ts
│   └── config.test.ts           ← Unit test co-located
├── mcp/
│   ├── client.ts
│   ├── clients.ts
│   └── mcp.test.ts              ← Unit test co-located
└── ...

apps/server/tests/
└── foundation.test.ts            ← Integration test (real server boot)
```

**Pattern 2: Separate integration tests**

```
apps/web/
├── src/
│   ├── App.tsx
│   └── ... (components)
└── tests/
    ├── isolation-gate.test.tsx   ← Component tests
    ├── isolation-headers.test.ts ← Runtime tests
    └── setup.ts                  ← Web test setup (Storage polyfill)
```

### Test File Naming

| Test Type | Location | Naming |
|-----------|----------|--------|
| Unit | Co-located in `src/` | `*.test.ts` or `*.test.tsx` |
| Integration | `tests/` directory | `*.test.ts` or `*.test.tsx` |
| Setup/fixtures | `tests/` directory | `setup.ts`, `fixtures/` subfolder, `helpers.ts` |

**Tip**: Unit tests live near their source code; integration tests and E2E simulations live in `tests/`.

## Test Patterns

### Unit Tests

**Structure**: Arrange/Act/Assert with `vitest` primitives

```typescript
import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

describe("loadConfig — valid env", () => {
  it("returns a typed, frozen Config with documented defaults", () => {
    // Arrange
    const env = validEnv();

    // Act
    const config = loadConfig(env);

    // Assert
    expect(config.port).toBe(8080);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("applies env overrides over defaults (numbers, bigints, urls)", () => {
    const config = loadConfig(
      validEnv({
        PORT: "3000",
        FLAT_RESERVE: "250",
      }),
    );
    expect(config.port).toBe(3000);
    expect(config.tunables.flatReserveNyxt).toBe(250n);
  });
});
```

**Key points:**
- `describe()` blocks group related tests
- `it()` (alias for `test()`) defines individual test cases
- Clear test names: "should do X when given Y"
- Arrange/Act/Assert separation
- One logical assertion per test (may use multiple `expect()`)

### Integration Tests (Real Server Boot)

**File**: `apps/server/tests/foundation.test.ts`

**Pattern**: Boot a real server with stubbed external services

```typescript
interface Booted {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly received: string[];
}

describe("Foundation integration test (T024)", () => {
  let booted: Booted;

  beforeEach(async () => {
    // Setup: build server with test doubles
    booted = await bootServer();
  });

  afterEach(async () => {
    // Cleanup: close server, clear connections
    await booted.app.close();
  });

  it("boots the server and authenticates WebSocket connections", async () => {
    // Connect real WebSocket client to ephemeral port
    const ws = new WebSocket(`ws://localhost:${booted.port}/ws`);
    // ...assertions on real protocol exchange...
  });
});
```

**Characteristics:**
- Uses **real Fastify instance** (`buildServer()` with injected deps)
- Uses **real WebSocket client** (`ws` library)
- All external services are **stubbed** (in-memory SessionStore, fake MCP sessions)
- **Fully deterministic**: no external Postgres, network I/O, or async delays
- **Ephemeral port**: each test gets a unique port (OS-assigned)

### External-Service Client Testing (T066, Phase 5)

**File**: `apps/server/tests/compile/client.test.ts`

**Pattern**: Mocked `fetch`, failure-is-data contracts, no real service.

The Compile Service client is tested with a mocked `fetch` to verify:
- Bearer token and relative `/v1/*` paths sent correctly
- Request bodies match the contract (Zod-validated)
- Failure-is-data: compile failures return `ok:false` / `status:"failed"` cleanly (not thrown)
- Named errors thrown only on transport faults and protocol mismatches
- `runCompileJob` poll loop surfaces progress and enforces bounded max wait

**Example: Check Endpoint**

```typescript
/**
 * Compile Service client contract tests (T066) — deterministic, mocked `fetch`,
 * NO real service.
 */
import { describe, expect, it } from "vitest";
import type { Mock } from "vitest";
import {
  CompileServiceProtocolError,
  CompileServiceResponseError,
  CompileServiceUnavailableError,
  HttpCompileClient,
} from "../../src/compile/index.js";
import {
  CHECK_FAILED,
  CHECK_OK,
  mockFetch,
  jsonResponse,
  SOURCE_FILES,
  TOKEN,
} from "./helpers.js";

describe("HttpCompileClient.check — POST /v1/check", () => {
  it("sends the Bearer token, JSON body, and relative path, returning parsed response", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(CHECK_OK));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const result = await client.check({ files: [...SOURCE_FILES] });

    expect(result).toEqual(CHECK_OK);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("/v1/check");
    expect(init.method).toBe("POST");
    expect(init.headers?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ files: SOURCE_FILES });
  });

  it("treats a failed compile as DATA (ok:false + diagnostics), not a throw", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(CHECK_FAILED));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    const result = await client.check({ files: [...SOURCE_FILES] });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("parse error");
  });

  it("throws CompileServiceResponseError on 4xx/5xx service envelope", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "empty_files", message: "files must be non-empty" } }, 400),
    );

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    await expect(client.check({ files: [...SOURCE_FILES] })).rejects.toBeInstanceOf(
      CompileServiceResponseError,
    );
  });

  it("throws CompileServiceUnavailableError when fetch rejects (network fault)", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    await expect(client.check({ files: [...SOURCE_FILES] })).rejects.toBeInstanceOf(
      CompileServiceUnavailableError,
    );
  });

  it("throws CompileServiceProtocolError when a 2xx body violates the contract", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: "yes" })); // Invalid type

    const client = new HttpCompileClient({ token: TOKEN, fetch: fetchMock });
    await expect(client.check({ files: [...SOURCE_FILES] })).rejects.toBeInstanceOf(
      CompileServiceProtocolError,
    );
  });
});
```

**Key characteristics:**
- `mockFetch()` returns a `vi.fn()` that records calls and returns mocked responses
- `jsonResponse()` helper constructs a `Response` with JSON body + optional status
- Compile failures (`ok:false`) are asserted as returned values, not thrown
- Transport/protocol errors are asserted as thrown exceptions
- **No real service, no network**: tests are fast and deterministic

### Artifact Orchestrator Testing (T066, Phase 5)

**File**: `apps/server/tests/compile/orchestrator.test.ts`

**Pattern**: Mocked `CompileClient` + `fetch`, verify-before-announce, no real service or R2.

The orchestrator (which drives the compile pipeline and R2 verification) is tested with:
- Injected `FakeCompileClient` for predictable `check` / `compile` / `pollCompile` responses
- Injected `fetch` for deterministic R2 manifest and artifact verification
- Injected `clock` and `delay` for bounded-wait testing without real sleeps
- `emitArtifactsReady` callback recording to assert `artifacts:ready` emissions

**Example: Verify-Before-Announce Pattern**

```typescript
/**
 * Artifact orchestrator tests (T066) — deterministic, mocked client + R2 fetch, NO
 * real Compile Service and NO real R2.
 */
import { describe, expect, it } from "vitest";
import type { Mock } from "vitest";
import {
  ArtifactOrchestrator,
  hasCompactChange,
  REOPEN_GUIDANCE,
} from "../../src/compile/index.js";
import {
  CHECK_OK,
  CHECK_FAILED,
  FakeCompileClient,
  advancingDelay,
  makeArtifactFetch,
  succeededJob,
  failedJob,
} from "./helpers.js";
import type { Clock, ArtifactFetchConfig } from "./helpers.js";

interface Harness {
  readonly orchestrator: ArtifactOrchestrator;
  readonly client: FakeCompileClient;
  readonly emitted: ArtifactsReadyPayload[];
  readonly artifactFetch: Mock<typeof fetch>;
  readonly clock: Clock;
}

function makeHarness(
  opts: {
    clientConfig?: FakeCompileConfig;
    artifact?: ArtifactFetchConfig;
    maxWaitMs?: number;
  } = {},
): Harness {
  const clock: Clock = { now: 0 };
  const client = new FakeCompileClient(opts.clientConfig ?? {}, clock);
  const emitted: ArtifactsReadyPayload[] = [];
  const artifactFetch = makeArtifactFetch(opts.artifact ?? {});
  const orchestrator = new ArtifactOrchestrator({
    client,
    emitArtifactsReady: (payload) => {
      emitted.push(payload);
    },
    fetchArtifact: artifactFetch,
    now: () => clock.now,
    delay: advancingDelay(clock),
    pollIntervalMs: 1_000,
    maxWaitMs: opts.maxWaitMs ?? 60_000,
  });
  return { orchestrator, client, emitted, artifactFetch, clock };
}

describe("runTurn — EC-11 / scenario 9: frontend-only skip", () => {
  it("does not call the service and does not announce when no .compact changed", async () => {
    const { orchestrator, client, emitted } = makeHarness({ clientConfig: { check: CHECK_OK } });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/App.tsx", content: "..." }],
      changedPaths: ["src/App.tsx"], // No .compact file
    });

    expect(outcome.kind).toBe("skipped");
    expect(client.checkCalls).toHaveLength(0);
    expect(client.compileCalls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — scenario 1: a failed check feeds the verify loop", () => {
  it("returns structured diagnostics, runs no full compile, and never announces", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { check: CHECK_FAILED },
    });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/counter.compact", content: "..." }],
      changedPaths: ["src/counter.compact"],
    });

    if (outcome.kind !== "check-failed") {
      throw new Error(`expected check-failed, got ${outcome.kind}`);
    }
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.severity).toBe("error");
    expect(client.compileCalls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});

describe("runTurn — scenario 2 / FR-014: verify-before-announce on green", () => {
  it("verifies the prefix then emits artifacts:ready exactly once", async () => {
    const { orchestrator, client, emitted, artifactFetch } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
      artifact: { manifest: { present: true, valid: true, complete: true } },
    });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/counter.compact", content: "..." }],
      changedPaths: ["src/counter.compact"],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.announced).toBe(true);
    expect(emitted).toEqual([{ urlPrefix: outcome.urlPrefix }]);

    // Verify called manifest + HEAD for each artifact
    expect(artifactFetch).toHaveBeenCalledWith(
      expect.stringContaining("manifest.json"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("does NOT announce when the manifest is missing (stale prefix)", async () => {
    const { orchestrator, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
      artifact: { manifest: { present: false } }, // ← Manifest not found
    });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/counter.compact", content: "..." }],
      changedPaths: ["src/counter.compact"],
    });

    if (outcome.kind !== "verification-failed") {
      throw new Error(`expected verification-failed, got ${outcome.kind}`);
    }
    expect(outcome.reason).toBe("manifest-missing");
    expect(outcome.guidance).toBe(REOPEN_GUIDANCE);
    expect(emitted).toHaveLength(0); // ← No announcement
  });

  it("does NOT announce when a listed artifact is not fetchable (incomplete upload)", async () => {
    const { orchestrator, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
      artifact: { manifest: { present: true, valid: true, complete: false } }, // ← Missing file
    });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/counter.compact", content: "..." }],
      changedPaths: ["src/counter.compact"],
    });

    if (outcome.kind !== "verification-failed") {
      throw new Error(`expected verification-failed, got ${outcome.kind}`);
    }
    expect(outcome.reason).toBe("incomplete");
    expect(emitted).toHaveLength(0); // ← No announcement
  });
});

describe("runTurn — scenario 4 / SC-006: reuse announces once, no second build", () => {
  it("a reused:true result still announces and triggers no second compile", async () => {
    const { orchestrator, client, emitted } = makeHarness({
      clientConfig: { check: CHECK_OK, polls: [succeededJob({ reused: true })] },
      artifact: { manifest: { present: true, valid: true, complete: true } },
    });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/counter.compact", content: "..." }],
      changedPaths: ["src/counter.compact"],
    });

    if (outcome.kind !== "ready") {
      throw new Error(`expected ready, got ${outcome.kind}`);
    }
    expect(outcome.reused).toBe(true);
    expect(outcome.announced).toBe(true);
    expect(client.compileCalls).toHaveLength(1); // ← One compile, not two
    expect(emitted).toEqual([{ urlPrefix: outcome.urlPrefix }]);
  });
});

describe("runTurn — FR-016: bounded max wait, never infinite", () => {
  it("raises CompileJobTimeoutError when a job never settles within bounded wait", async () => {
    const { orchestrator, client } = makeHarness({
      clientConfig: {
        check: CHECK_OK,
        polls: [queuedPoll(), queuedPoll(), queuedPoll()], // Endless queued state
      },
      maxWaitMs: 5_000, // Short bound
    });

    const outcome = await orchestrator.runTurn({
      projectId: "proj-1",
      files: [{ path: "src/counter.compact", content: "..." }],
      changedPaths: ["src/counter.compact"],
    });

    if (outcome.kind !== "timeout") {
      throw new Error(`expected timeout, got ${outcome.kind}`);
    }
    expect(outcome.waitedMs).toBe(5_000);
    expect(outcome.lastStatus).toBe("queued");
  });
});
```

**Key characteristics:**
- `FakeCompileClient` returns hardcoded responses (check OK/failed, job succeeded/queued/failed)
- `makeArtifactFetch()` returns a `vi.fn()` that simulates R2 (present/absent/incomplete manifest)
- `clock` and `advancingDelay()` advance time deterministically (no real sleeps)
- `emitted` array records every `artifacts:ready` call for assertion
- Verify-before-announce pattern: manifest + HEAD for each artifact, or reopen guidance on gaps
- Bounded max wait: job poll loop enforces `maxWaitMs` and raises `CompileJobTimeoutError` on timeout

### Store Contract Tests (T050/T051/T054)

**Pattern**: Test store interfaces via in-memory doubles with deterministic scenarios

**File**: `apps/server/tests/{auth,projects}/store.test.ts`

The in-memory store (`InMemoryProjectStore`, `InMemoryAuthStore`) is the reference implementation for contract semantics. Tests verify:
- Project-wide monotonic version allocation (scenario 1)
- Manifest reopen stability via content-hash equality (SC-025, D38)
- Crash-atomicity via mid-commit injection (SC-026)
- Named quota/cap rejections (scenario 6)
- Soft-delete/restore round-trips (SC-028)

**Example: Version Allocation & Transaction Rollback**

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { computeContentHash } from "../../src/projects/index.js";
import { makeInMemoryStore } from "./helpers.js";
import type { Clock, InMemoryProjectStore } from "./helpers.js";

let clock: Clock;
let store: InMemoryProjectStore;

beforeEach(() => {
  clock = { now: 1_000_000 };
  store = makeInMemoryStore(clock);
});

describe("commit — project-wide monotonic version (scenario 1)", () => {
  it("stamps each batch with the next version and keeps current state at the latest", async () => {
    const project = await store.createProject("owner", "demo");

    const first = await store.commit(project.id, {
      author: "agent",
      files: [
        { path: "src/a.ts", content: "alpha" },
        { path: "src/b.ts", content: "beta" },
      ],
    });
    expect(first.version).toBe(1);

    const second = await store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/a.ts", content: "alpha-2" }],
    });
    expect(second.version).toBe(2);
  });
});

describe("commit — crash atomicity (SC-026)", () => {
  it("rolls back the entire batch on mid-commit fault, leaving prior version intact", async () => {
    const project = await store.createProject("owner", "demo");

    // First commit: establish baseline
    const baseline = await store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/a.ts", content: "v1" }],
    });
    const baselineManifest = await store.getManifest(project.id);

    // Arm fault hook: crash after 1 file write
    store.failNextCommitAfter(1);

    // Attempt commit with 2 files: will crash mid-batch
    await expect(
      store.commit(project.id, {
        author: "agent",
        files: [
          { path: "src/a.ts", content: "v2" },
          { path: "src/b.ts", content: "new" },
        ],
      }),
    ).rejects.toThrow("injected mid-commit fault");

    // Manifest is unchanged: the version never allocated, the files never committed
    const afterFault = await store.getManifest(project.id);
    expect(afterFault).toEqual(baselineManifest);

    // Verify the version counter was not consumed
    const nextCommit = await store.commit(project.id, {
      author: "agent",
      files: [{ path: "src/c.ts", content: "new" }],
    });
    expect(nextCommit.version).toBe(baseline.version + 1); // 2, not 3
  });
});

describe("manifest — reopen equality (SC-025 / D38)", () => {
  it("serves a deterministic (path, contentHash) set that reproduces the tree on reopen", async () => {
    const project = await store.createProject("owner", "demo");
    const files = [
      { path: "b.ts", content: "second" },
      { path: "a.ts", content: "first" },
    ];
    await store.commit(project.id, { author: "agent", files });

    const manifest = await store.getManifest(project.id);
    // Ordered by path — a stable set to hash-compare on reconnect/reopen.
    expect(manifest.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);

    // Reopen: reading the manifest again yields an identical set (SC-025).
    const reopened = await store.getManifest(project.id);
    expect(reopened).toEqual(manifest);

    // Each hash is the server-side hash of the file content it points at.
    for (const entry of manifest) {
      const file = await store.getFile(project.id, entry.path);
      expect(file).not.toBeNull();
      expect(entry.contentHash).toBe(computeContentHash(file?.content ?? ""));
    }
  });
});
```

**Key characteristics:**
- Uses in-memory store with injected clock for full control
- `failNextCommitAfter(N)` hook injects mid-batch fault deterministically
- Content hashes use REAL `computeContentHash` (byte-for-byte match with Postgres)
- All async methods return `Promise.reject()` for validation failures (uniform rejection channel)
- Transaction rollback via `structuredClone` snapshot-and-restore

### Live Database Tests (Gated on `DATABASE_URL`)

**File**: `apps/server/tests/{auth,projects}/pg-store.test.ts`

When database-specific behavior needs verification (e.g., SQL semantics, real transaction atomicity), gate tests on `DATABASE_URL`:

```typescript
if (process.env.DATABASE_URL) {
  describe("Project store — live database (pg-store)", () => {
    // Only runs if DATABASE_URL is set
    let db: Client;

    beforeAll(async () => {
      db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
    });

    afterAll(async () => {
      await db.end();
    });

    it("persists projects in Postgres and allocates monotonic versions", async () => {
      const store = new PgProjectStore(db, OPTIONS);
      const project = await store.createProject("owner", "test");
      
      const first = await store.commit(project.id, {
        author: "agent",
        files: [{ path: "src/a.ts", content: "alpha" }],
      });
      expect(first.version).toBe(1);

      const second = await store.commit(project.id, {
        author: "agent",
        files: [{ path: "src/b.ts", content: "beta" }],
      });
      expect(second.version).toBe(2);
    });

    it("rolls back on mid-commit fault, proving SQL ROLLBACK works", async () => {
      // Wrap db so the transaction's 2nd version INSERT rejects
      const faulting = faultingDb(db, 2);
      const store = new PgProjectStore(faulting, OPTIONS);
      
      const project = await store.createProject("owner", "test");
      
      // First commit succeeds
      await store.commit(project.id, {
        author: "agent",
        files: [{ path: "src/a.ts", content: "v1" }],
      });
      
      // Second commit fails mid-batch
      await expect(
        store.commit(project.id, {
          author: "agent",
          files: [
            { path: "src/a.ts", content: "v2" },
            { path: "src/b.ts", content: "new" },
          ],
        }),
      ).rejects.toThrow("injected mid-commit fault");

      // Version counter was not consumed; next commit is version 2
      const next = await store.commit(project.id, {
        author: "agent",
        files: [{ path: "src/c.ts", content: "new" }],
      });
      expect(next.version).toBe(2); // Not 3
    });
  });
}
```

**Characteristics:**
- Gate on `process.env.DATABASE_URL` to run only when a test DB is available
- Mirrored test suite to the in-memory store tests (same contract)
- Proves the real SQL behaves correctly (transaction ROLLBACK, version allocation, etc.)
- Gated faulting wrapper simulates mid-commit crashes by rejecting a specific SQL statement

### Server Authentication Testing

Test authentication via `app.inject()` with injected dependencies:

```typescript
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";

describe("Server auth — session resumption (SC-019)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Arrange: build server with stubbed InMemoryAuthStore
    const authStore = new InMemoryAuthStore(testAuthOptions());
    
    app = await buildServer({
      config: testConfig(),
      db: stubDb(),
      mcp: fakeMcpClients(),
      authStore, // ← Injected for determinism
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("resumes an authenticated session with ZERO signature verifications", async () => {
    // Arrange: simulate a prior login
    const sessionId = "session-123";
    const authStore = app.locals.authStore as InMemoryAuthStore;
    await authStore.issue({
      nonce: "nonce-1",
      accountAddress: "account-1",
      verify: () => true,
    });
    
    const verifyCountBefore = authStore.issueCalls;

    // Act: resume the session
    const response = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { cookie: `session_id=${sessionId}` },
    });

    // Assert: auth succeeded, verify was NOT called (signature verification skipped)
    expect(response.statusCode).toBe(200);
    expect(authStore.issueCalls).toBe(verifyCountBefore); // ← Unchanged
  });
});
```

**Key characteristics:**
- **Injected in-memory auth store** for deterministic testing
- Call counters on the store (e.g., `issueCalls`, `slideCalls`) to prove specific paths ran
- **No mocking frameworks** — just dependency injection
- Tests the route auth layer without mocks or complex setup

### Project Route Testing

Test project routes with injected stores and session:

```typescript
describe("Project routes — with injected stores", () => {
  let app: FastifyInstance;
  let projectStore: InMemoryProjectStore;
  let authStore: InMemoryAuthStore;
  const ownerAddress = "owner-123";

  beforeEach(async () => {
    const clock = { now: 1_000_000 };
    projectStore = makeInMemoryStore(clock);
    authStore = makeInMemoryAuthStore(clock);

    // Mint a real session in the in-memory store
    const { ok, sessionId } = await authStore.issue({
      nonce: "nonce-1",
      accountAddress: ownerAddress,
      verify: () => true,
    });
    if (!ok || !sessionId) throw new Error("failed to mint session");

    app = await buildServer({
      config: testConfig(),
      db: stubDb(),
      mcp: fakeMcpClients(),
      projectStore,
      authStore,
    });

    // Stash the session cookie for later requests
    app.locals.sessionId = sessionId;
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the caller's projects only", async () => {
    // Arrange: create two projects
    const p1 = await projectStore.createProject(ownerAddress, "mine");
    const p2 = await projectStore.createProject("other-owner", "theirs");

    // Act: list projects as ownerAddress
    const response = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { cookie: `session_id=${app.locals.sessionId}` },
    });

    // Assert: only p1 is returned
    const body = response.json() as { projects: Project[] };
    expect(body.projects.map((p) => p.id)).toEqual([p1.id]);
  });

  it("returns 404 for projects owned by others (existence never leaks, SC-027)", async () => {
    // Arrange
    const other = await projectStore.createProject("other-owner", "secret");

    // Act: try to access as ownerAddress
    const response = await app.inject({
      method: "GET",
      url: `/projects/${other.id}`,
      headers: { cookie: `session_id=${app.locals.sessionId}` },
    });

    // Assert: 404, not 403 (existence is never leaked)
    expect(response.statusCode).toBe(404);
  });

  it("treats malformed (non-uuid) :id as not-found, not 500", async () => {
    // Act: pass a non-uuid id
    const response = await app.inject({
      method: "GET",
      url: "/projects/not-a-uuid",
      headers: { cookie: `session_id=${app.locals.sessionId}` },
    });

    // Assert: 404 (not 500 from an unhandled exception)
    expect(response.statusCode).toBe(404);
  });
});
```

**Key characteristics:**
- Stores are injected into the app at build time
- Session is minted via the in-memory auth store (`authStore.issue()`)
- Route tests use `app.inject()` to simulate HTTP requests with full auth
- Error scenarios (404, 409 quota, 413 size cap) are tested by mocking store state

### Signature Verification Testing

Test cryptographic signature logic with **synthetic ledger-v8 keypairs** (not mocks):

```typescript
import { describe, expect, it } from "vitest";
import { sampleSigningKey, signatureVerifyingKey, signData } from "@midnight-ntwrk/ledger-v8";
import { verifySignature } from "../../src/crypto/verify.js";

describe("Signature verification — Schnorr (ledger-v8)", () => {
  it("accepts a valid signature from a known keypair", async () => {
    // Arrange: use synthetic keys (execution-verified, not mocked)
    const signingKey = sampleSigningKey(); // ← Real ledger-v8 key
    const message = Buffer.from("nyx.localhost wants you to sign...");
    const signature = signData(message, signingKey); // ← Execution

    // Act: verify the signature
    const isValid = verifySignature(
      message,
      signature,
      signatureVerifyingKey(signingKey), // ← Derive public key
    );

    // Assert
    expect(isValid).toBe(true);
  });

  it("rejects a tampered message", () => {
    // Arrange
    const signingKey = sampleSigningKey();
    const originalMessage = Buffer.from("sign this");
    const signature = signData(originalMessage, signingKey);
    const tamperedMessage = Buffer.from("sign that"); // ← Different message

    // Act
    const isValid = verifySignature(tamperedMessage, signature, signatureVerifyingKey(signingKey));

    // Assert
    expect(isValid).toBe(false);
  });

  it("rejects a signature from a different keypair", () => {
    // Arrange
    const key1 = sampleSigningKey();
    const key2 = sampleSigningKey();
    const message = Buffer.from("sign this");
    const signature = signData(message, key1); // ← Signed with key1

    // Act
    const isValid = verifySignature(
      message,
      signature,
      signatureVerifyingKey(key2), // ← But verified with key2
    );

    // Assert
    expect(isValid).toBe(false);
  });
});
```

**Key characteristics:**
- Uses **real ledger-v8 Schnorr keypairs** (`sampleSigningKey`, `signatureVerifyingKey`)
- **Execution-based testing**: calls `signData()` and `verifySignature()` for real proof
- No mocking of cryptographic primitives
- Deterministic: keys and messages are synthetic, reproducible
- **Owner-gated**: Real Lace `signData()` byte round-trips are unverified (owner responsibility)

### Component Tests (React)

**Framework**: `@testing-library/react` + Vitest

```typescript
import { render, screen } from "@testing-library/react";
import { vi, afterEach, describe, expect, it } from "vitest";
import { App } from "@/App";

describe("App cross-origin isolation gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the shell when crossOriginIsolated is true", () => {
    // Arrange: stub global
    vi.stubGlobal("crossOriginIsolated", true);

    // Act: render component
    render(<App />);

    // Assert: check DOM
    expect(screen.queryByTestId("app-shell")).not.toBeNull();
    expect(screen.queryByTestId("isolation-gate")).toBeNull();
  });
});
```

**Key libraries:**
- `@testing-library/react`: Queries DOM by user-visible labels, not implementation details
- `vi.stubGlobal()`: Mock globals like `crossOriginIsolated`, `fetch`, etc.
- `vi.useFakeTimers()`: For time-dependent logic
- `cleanup()`: Auto-cleanup after each test

### Web Setup: In-Memory Storage Polyfill

**File**: `apps/web/tests/setup.ts`

`jsdom` in Vitest v4 exposes the `Storage` class but no `localStorage` instance. Install an in-memory polyfill:

```typescript
/**
 * Web test setup (T067, DS-047).
 *
 * Installs an in-memory localStorage/sessionStorage polyfill for jsdom.
 * Tests can then stub fetch and create fake ConnectedAPI instances without
 * needing a real backend.
 */

import { beforeAll } from "vitest";

class InMemoryStorage implements Storage {
  private data = new Map<string, string>();

  readonly length: number = 0;

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new InMemoryStorage(),
    writable: true,
  });

  Object.defineProperty(globalThis, "sessionStorage", {
    value: new InMemoryStorage(),
    writable: true,
  });
});
```

**Key points:**
- Installed in `beforeAll()` to run once per test suite
- Implements the `Storage` interface for full compatibility
- Used by web component and E2E simulation tests
- Enables deterministic testing of localStorage-dependent features

### Client Authentication Testing

Test client auth with injected mock `fetch` and fake `ConnectedAPI`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { useAuth } from "../../src/hooks/useAuth.js";

describe("Client auth — with mocked fetch (T065)", () => {
  it("authenticates and stores credentials in localStorage", async () => {
    // Arrange: mock fetch to return a fake token
    const mockFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ token: "jwt-xyz", userId: "user-456" }),
      } as unknown as Response),
    );

    vi.stubGlobal("fetch", mockFetch);

    // Create a fake ConnectedAPI that uses the mocked fetch
    const api = new ConnectedAPI("http://localhost:8080", mockFetch);

    // Act: call login
    const result = await api.authenticate("user@example.com", "password");

    // Assert
    expect(result.token).toBe("jwt-xyz");
    expect(localStorage.getItem("auth-token")).toBe("jwt-xyz");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/auth/login"),
      expect.any(Object),
    );

    vi.unstubAllGlobals();
  });
});
```

**Key characteristics:**
- **No live backend**: `fetch` is mocked via `vi.stubGlobal()`
- **Injected ConnectedAPI**: created with fake fetch, fully deterministic
- **localStorage tested**: credentials persisted and can be verified
- **Call assertions**: verify the right endpoints were called with correct payloads

## Mocking & Test Doubles

### Strategy: Injection Over Mocking

Nyx prefers **dependency injection** over mocking frameworks:

```typescript
// ✅ Good: Inject a test double
const client = new McpClient({
  sessionFactory: () => Promise.resolve(okSession), // ← Injected
});

// ❌ Avoid: Mock the class itself
vi.mock("./McpClient", () => ({ /* ... */ }));
```

### Test Doubles (Stubs/Fakes)

| Service | Test Double | Location |
|---------|------------|----------|
| MCP Session | `okSession`, `stuckSession`, `inertMcpSession` | In test file or `tests/stubs.ts` |
| Database | `stubDb()` | In test file (returns minimal QueryResult) |
| SessionStore | In-memory `Map`-based store (`InMemoryAuthStore`) | In `tests/auth/helpers.ts` |
| ProjectStore | In-memory store with clock (`InMemoryProjectStore`) | In `tests/projects/helpers.ts` |
| CompileClient | Fake client with hardcoded responses (`FakeCompileClient`) | In `tests/compile/helpers.ts` |
| Artifact fetch | Mock R2 responses (`makeArtifactFetch`) | In `tests/compile/helpers.ts` |
| Environment | `validEnv(overrides)` | Test helper function |
| Web globals | `vi.stubGlobal()` | In-place within test |

### Example: MCP Client Stubs

```typescript
/** A session that answers immediately and echoes tool calls back. */
const okSession: McpSession = {
  ping: () => Promise.resolve(),
  callTool: (name, args) => Promise.resolve({ echoed: { name, args } }),
  close: () => Promise.resolve(),
};

/** A session whose ping and callTool never settle (simulates a stuck server). */
const stuckSession: McpSession = {
  ping: () => new Promise<void>(() => undefined),
  callTool: () => new Promise<unknown>(() => undefined),
  close: () => Promise.resolve(),
};

const okFactory: McpSessionFactory = () => Promise.resolve(okSession);
const stuckFactory: McpSessionFactory = () => Promise.resolve(stuckSession);

// Use in tests:
const client = new McpClient({
  sessionFactory: okFactory, // ← Test double injected
  timeoutMs: 40,
});
```

### Example: Environment Builder

```typescript
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/nyx_test",
    MCP_TOOLCHAIN_URL: "http://toolchain.test.local/mcp",
    MCP_TOME_URL: "http://tome.test.local/mcp",
    PROVER_URL: "http://prover.test.local",
    DEPLOY_KEY: "test-deploy-key",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_ACCOUNT_ID: "test-account-id",
    MODEL_ROUTING: JSON.stringify({
      supervisor: { provider: "anthropic", model: "claude" },
      // ...
    }),
    ...overrides, // ← Allow selective overrides
  };
}

// Usage in tests:
const config = loadConfig(validEnv());
const config2 = loadConfig(validEnv({ PORT: "3000" }));
const config3 = loadConfig(validEnv({ DATABASE_URL: undefined }));
```

### Example: Compile Client & Artifact Fetch Fakes

```typescript
/**
 * Fake Compile Service client for orchestrator tests.
 * Returns hardcoded responses (check OK/failed, job succeeded/queued/failed).
 */
export class FakeCompileClient implements CompileClient {
  private checkResponse: CheckResponse;
  private pollSequence: CompileJob[];
  private pollIndex = 0;

  constructor(config: FakeCompileConfig, clock: Clock) {
    this.checkResponse = config.check ?? CHECK_OK;
    this.pollSequence = config.polls ?? [succeededJob()];
  }

  async check(): Promise<CheckResponse> {
    return this.checkResponse;
  }

  async compile(): Promise<CompileSubmitResponse> {
    return { jobId: "job-123", status: "queued", sourceHash: "abc" };
  }

  async pollCompile(): Promise<CompileJob> {
    const job = this.pollSequence[this.pollIndex];
    this.pollIndex = Math.min(this.pollIndex + 1, this.pollSequence.length - 1);
    return job;
  }

  async version(): Promise<CompilerVersions> {
    return COMPILER_VERSIONS;
  }
}

/**
 * Mock R2 fetch for verify-before-announce tests.
 * Simulates present/absent/incomplete/invalid manifests and artifacts.
 */
export function makeArtifactFetch(config: ArtifactFetchConfig = {}): Mock<typeof fetch> {
  const fetchMock = vi.fn(async (input: string | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("manifest.json")) {
      if (!config.manifest?.present) {
        return new Response("Not Found", { status: 404 });
      }
      if (!config.manifest?.valid) {
        return new Response("invalid json", { status: 200 });
      }
      return new Response(JSON.stringify(SAMPLE_MANIFEST), { status: 200 });
    }

    if (!config.manifest?.complete) {
      return new Response("Not Found", { status: 404 }); // ← Incomplete upload
    }

    return new Response("", { status: 200 }); // ← File found
  });

  return fetchMock;
}
```

## Test Data & Fixtures

### Factories (Recommended)

Create reusable test data via factory functions:

```typescript
function baseRouting(): TestRouting {
  return {
    supervisor: { provider: "anthropic", model: "model-supervisor" },
    scaffolding: { provider: "openai", model: "model-scaffolding" },
    planning: { provider: "gemini", model: "model-planning" },
    implementation: { provider: "openrouter", model: "vendor/model-impl" },
    review: {
      provider: "openai-compatible",
      model: "local-review",
      baseUrl: "https://infer.internal/v1",
    },
  };
}

function routingJson(routing: TestRouting = baseRouting()): string {
  return JSON.stringify(routing);
}

// Usage:
const json = routingJson(); // ✅ Full routing
const json2 = routingJson({ ...baseRouting(), planning: { provider: "anthropic", model: "x" } }); // ✅ Override
```

### Fixtures (Rarely Needed)

For static, unchanging test data, use `tests/fixtures/`:

```typescript
// tests/fixtures/sampleProject.json
{
  "id": "proj-12345",
  "name": "Sample Project",
  "created": 1_752_000_000_000
}
```

Prefer factories over fixtures; fixtures get stale.

## Database Testing

### Unit Tests: No Real Database

Unit tests run WITHOUT `DATABASE_URL` set:

```typescript
// config.test.ts — fully deterministic, validates schema parsing
const config = loadConfig(validEnv()); // No real DB needed
```

### Integration Tests: Stubbed DB

Integration tests use a `stubDb()` that returns minimal results:

```typescript
function stubDb(): Queryable {
  return {
    query: <R extends QueryResultRow>(): Promise<QueryResult<R>> =>
      Promise.resolve({
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        rows: [{ ok: 1 } as unknown as R],
        fields: [],
      }),
  };
}
```

### Live Database Tests (Gated on `DATABASE_URL`)

See **Live Database Tests** section above.

## Determinism Guarantee

**All tests must be deterministic.** This means:

- ✅ No external HTTP requests (stub MCP clients, mock fetch)
- ✅ No database I/O (use stubDb or gated live DB tests)
- ✅ No file I/O (mock fs or use in-memory store)
- ✅ No time-dependent logic (use `vi.useFakeTimers()` or injected clock)
- ✅ No random data (seed Random or use factories)
- ✅ Parallel execution safe (no shared state between tests)

**Why**: Tests must pass in CI without external services. Deterministic tests are:
- Fast (no network/DB latency)
- Reliable (no flakiness from external timeouts)
- Isolated (can run in parallel)
- Clear (failures point to code, not infrastructure)

### Injectable Clock & Delay for Bounded-Wait Testing

The compile pipeline uses injected `clock` and `delay` to test bounded max wait without real sleeps:

```typescript
interface RunCompileJobOptions {
  readonly now?: () => number;           // Monotonic clock (defaults to Date.now)
  readonly delay?: (ms: number) => Promise<void>; // Sleep impl (defaults to setTimeout)
  readonly pollIntervalMs?: number;      // Poll cadence (defaults to 1000ms)
  readonly maxWaitMs?: number;           // Bounded max wait (defaults to 300_000ms)
}

// In tests: advance clock synchronously
const clock: Clock = { now: 0 };

const advancingDelay = (clock: Clock) => async (ms: number) => {
  clock.now += ms;
};

// A hung job raises CompileJobTimeoutError without sleeping
await expect(runCompileJob(client, req, {
  now: () => clock.now,
  delay: advancingDelay(clock),
  maxWaitMs: 5_000,
})).rejects.toBeInstanceOf(CompileJobTimeoutError);
```

**Key benefits:**
- No real `setTimeout` sleeps (tests run instantly)
- Time advances deterministically with each poll
- Bounded max wait is proven with hard assertions
- No infinite loops or hidden hangs

## Coverage Requirements

Coverage tracking is **not yet enforced** in this repo, but the following are recommended:

| Metric | Target |
|--------|--------|
| Line coverage | 80%+ |
| Branch coverage | 75%+ |
| Function coverage | 80%+ |

### Coverage Exclusions

Files/patterns to exclude:

- `src/generated/` — Auto-generated code
- `*.config.ts`, `*.config.mjs` — Configuration files
- `src/types/` — Type definitions only
- `src/index.ts` (re-exports) — Trivial re-export files

## CI Integration

### Test Pipeline

Tests run as part of the pre-commit hook and CI:

| Stage | Command | Blocking |
|-------|---------|----------|
| Pre-commit hook | `pnpm typecheck` | Yes (blocks commit) |
| Pre-commit hook | `lint-staged` (includes test fix) | Yes (blocks commit) |
| CI (PR gate) | `pnpm test` | Yes (blocks merge) |
| CI (PR gate) | `pnpm typecheck` | Yes (blocks merge) |
| CI (PR gate) | `pnpm lint` | Yes (blocks merge) |

### Per-Package Test Commands

Each package defines a `test` script in its `package.json`:

```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

Empty packages use:

```json
{
  "scripts": {
    "test": "vitest run --passWithNoTests"
  }
}
```

## Special Testing Patterns

### Config Validation Testing

Test config loader with both valid and invalid environments:

```typescript
describe("loadConfig — invalid env", () => {
  it("throws ConfigValidationError naming every missing variable", () => {
    const vars = issuesFor(validEnv({ DATABASE_URL: undefined, DEPLOY_KEY: undefined }));
    expect(vars).toContain("DATABASE_URL");
    expect(vars).toContain("DEPLOY_KEY");
  });
});
```

Use a helper that catches errors and extracts structured issues:

```typescript
function issuesFor(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.issues.map((issue) => issue.variable);
    }
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}
```

### Timeout Testing

Test that operations fail gracefully on timeout (not hang):

```typescript
it("rejects a call against a stuck transport with McpTimeoutError, not a hang", async () => {
  await expect(makeClient(stuckFactory).call("compile", {})).rejects.toBeInstanceOf(
    McpTimeoutError,
  );
});

// The stuckFactory returns a session that never resolves:
const stuckSession: McpSession = {
  ping: () => new Promise<void>(() => undefined), // ← Never settles
  callTool: () => new Promise<unknown>(() => undefined),
  close: () => Promise.resolve(),
};
```

### Type Testing

Use `expectTypeOf` from Vitest to assert types at compile time:

```typescript
import { expectTypeOf } from "vitest";
import type { ProjectId } from "./index.js";

it("ProjectId is a branded string", () => {
  expectTypeOf<ProjectId>().toMatchTypeOf<string>();
});
```

## Test Documentation

Every test suite should have a JSDoc header:

```typescript
/**
 * Boot-config tests (T015, DS-003).
 *
 * Fully deterministic: no external services, no process exit. Valid env yields
 * a typed frozen Config (defaults + overrides); invalid/missing vars throw a
 * named ConfigValidationError that lists every offender.
 */
```

Document:
- Task/decision references (e.g., T015, DS-003)
- Key invariants (deterministic, no side effects)
- What's tested (happy path, error cases, contracts)
- Any special setup/teardown

## Verification Boundaries (Owner-Gated)

Internal cryptographic logic (Schnorr signature generation, ledger-v8 keypair operations) is tested with **synthetic keypairs via execution**. The byte-level round-trip from real Lace `signData()` output to Midnight ledger-v8 verification is **unverified** and owner-gated; Nyx assumes Lace and ledger-v8 are correct.

The **R2 integrity verification** (verify-before-announce) is tested against mocked responses. Real R2 read verification (that files are actually present and fetchable) is owner-gated and verified via the orchestrator's `verifyPrefix()` method mock patterns in tests.

```typescript
// ✅ Verified: signature round-trip with synthetic keys
const sig = signData(message, sampleSigningKey()); // Execution-tested
expect(verifySignature(message, sig, signatureVerifyingKey(...))).toBe(true);

// ⚠️  Owner-gated, unverified: Lace byte output
// Nyx trusts that lace.signData() produces bytes matching ledger-v8's verifier.
const laceSig = await lace.signData(message); // ← Unverified

// ✅ Verified: verify-before-announce with mocked R2
// Tests assert that manifest fetch + HEAD for artifacts happens before artifacts:ready.
const { orchestrator, emitted, artifactFetch } = makeHarness({
  clientConfig: { check: CHECK_OK, polls: [succeededJob()] },
  artifact: { manifest: { present: true, valid: true, complete: true } },
});
expect(emitted).toEqual([{ urlPrefix: result.urlPrefix }]);

// ⚠️  Owner-gated, unverified: Real R2 responses
// Nyx trusts that the real R2 API returns correct 200/404 for HEAD requests.
```

---

## What Does NOT Belong Here

- Code style rules → CONVENTIONS.md
- Security testing → SECURITY.md
- Architecture patterns → ARCHITECTURE.md
- CI/CD pipeline details → (covered only briefly above; see GitHub Actions config)

---

*This document describes HOW to test. Update when testing strategy changes.*
