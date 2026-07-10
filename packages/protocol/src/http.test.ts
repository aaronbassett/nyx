import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AuthLogoutResponseSchema,
  AuthNonceResponseSchema,
  AuthSessionResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  CreateCloneTokenResponseSchema,
  CreateDepositRequestSchema,
  CreateDepositResponseSchema,
  CreateProjectRequestSchema,
  DepositStatusResponseSchema,
  LedgerResponseSchema,
  ListDeploysResponseSchema,
  ListProjectsResponseSchema,
  ProjectChatResponseSchema,
  ProjectFileResponseSchema,
  ProjectManifestResponseSchema,
  ProverTokenResponseSchema,
  RevokeCloneTokenResponseSchema,
  UpdateProjectRequestSchema,
  type LedgerResponse,
} from "./index.js";

const now = 1_752_000_000_000;

describe("auth DTOs", () => {
  it("parses a nonce response", () => {
    const result = AuthNonceResponseSchema.safeParse({ nonce: "abc123", expiresAt: now });
    expect(result.success).toBe(true);
  });

  it("rejects a nonce response with an ISO-string expiry", () => {
    const result = AuthNonceResponseSchema.safeParse({
      nonce: "abc123",
      expiresAt: "2026-07-10T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("parses a verify request and response", () => {
    expect(
      AuthVerifyRequestSchema.safeParse({
        address: "mn_addr_test1qexample",
        signature: "sig-bytes-hex",
        message: "nyx.example wants you to sign in",
        verifyingKey: "vk-bytes-hex",
      }).success,
    ).toBe(true);
    expect(AuthVerifyResponseSchema.safeParse({ address: "mn_addr_test1qexample" }).success).toBe(
      true,
    );
  });

  it("rejects a verify request missing the signature", () => {
    const result = AuthVerifyRequestSchema.safeParse({
      address: "mn_addr_test1qexample",
      message: "nyx.example wants you to sign in",
      verifyingKey: "vk-bytes-hex",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a verify request missing the verifying key (needed for the key↔address binding)", () => {
    const result = AuthVerifyRequestSchema.safeParse({
      address: "mn_addr_test1qexample",
      signature: "sig-bytes-hex",
      message: "nyx.example wants you to sign in",
    });
    expect(result.success).toBe(false);
  });

  it("parses a session response", () => {
    expect(AuthSessionResponseSchema.safeParse({ address: "mn_addr_test1qexample" }).success).toBe(
      true,
    );
  });

  it("parses an empty logout response", () => {
    expect(AuthLogoutResponseSchema.safeParse({}).success).toBe(true);
  });
});

describe("project & file DTOs", () => {
  const project = {
    id: "proj-1",
    ownerAddress: "mn_addr_test1qexample",
    name: "zk-todo",
    createdAt: now,
  };

  it("parses a project list including a soft-deleted project", () => {
    const result = ListProjectsResponseSchema.safeParse([
      project,
      { ...project, id: "proj-2", deletedAt: now },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects an empty project name on create and update", () => {
    expect(CreateProjectRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts an empty PATCH body (partial update)", () => {
    expect(UpdateProjectRequestSchema.safeParse({}).success).toBe(true);
  });

  it("parses a manifest and rejects rows missing contentHash", () => {
    expect(
      ProjectManifestResponseSchema.safeParse([{ path: "src/App.tsx", contentHash: "sha256-abc" }])
        .success,
    ).toBe(true);
    expect(ProjectManifestResponseSchema.safeParse([{ path: "src/App.tsx" }]).success).toBe(false);
  });

  it("parses a file response", () => {
    expect(
      ProjectFileResponseSchema.safeParse({ path: "src/App.tsx", content: "export {};" }).success,
    ).toBe(true);
  });

  it("parses chat history and rejects unknown roles", () => {
    expect(
      ProjectChatResponseSchema.safeParse([
        { seq: 0, role: "user", content: "build me a counter", createdAt: now },
        { seq: 1, role: "assistant", content: "On it.", turnId: "turn-1", createdAt: now },
        {
          seq: 2,
          role: "supervisor",
          content: "Compiling contract…",
          turnId: "turn-1",
          createdAt: now,
        },
      ]).success,
    ).toBe(true);
    expect(
      ProjectChatResponseSchema.safeParse([
        { seq: 0, role: "system", content: "nope", createdAt: now },
      ]).success,
    ).toBe(false);
  });
});

describe("ledger & deposit DTOs", () => {
  it("parses a ledger response with bigint amounts", () => {
    const response: unknown = {
      available: 750n,
      reserved: 250n,
      entries: [
        {
          id: 1n,
          accountAddress: "mn_addr_test1qexample",
          kind: "deposit_credit",
          amount: 1_000n,
          ref: "dep-1",
        },
        { id: 2n, accountAddress: "mn_addr_test1qexample", kind: "reserve", amount: -250n },
      ],
    };
    const result = LedgerResponseSchema.safeParse(response);
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    if (result.success) {
      expectTypeOf(result.data).toEqualTypeOf<LedgerResponse>();
      expect(result.data.available + result.data.reserved).toBe(1_000n);
    }
  });

  it("rejects ledger amounts sent as JSON numbers", () => {
    const result = LedgerResponseSchema.safeParse({ available: 750, reserved: 250, entries: [] });
    expect(result.success).toBe(false);
  });

  it("rejects unknown ledger entry kinds", () => {
    const result = LedgerResponseSchema.safeParse({
      available: 0n,
      reserved: 0n,
      entries: [{ id: 1n, accountAddress: "mn_addr_test1qexample", kind: "burn", amount: 1n }],
    });
    expect(result.success).toBe(false);
  });

  it("requires deposit amounts to be strictly positive bigints", () => {
    expect(CreateDepositRequestSchema.safeParse({ amount: 100n }).success).toBe(true);
    expect(CreateDepositRequestSchema.safeParse({ amount: 0n }).success).toBe(false);
    expect(CreateDepositRequestSchema.safeParse({ amount: -5n }).success).toBe(false);
    expect(CreateDepositRequestSchema.safeParse({ amount: 100 }).success).toBe(false);
  });

  it("parses deposit creation and status responses", () => {
    expect(
      CreateDepositResponseSchema.safeParse({ depositRef: "dep-1", expiresAt: now }).success,
    ).toBe(true);
    expect(DepositStatusResponseSchema.safeParse({ status: "preregistered" }).success).toBe(true);
    expect(
      DepositStatusResponseSchema.safeParse({ status: "credited", txRef: "0xabc" }).success,
    ).toBe(true);
    expect(DepositStatusResponseSchema.safeParse({ status: "orphaned" }).success).toBe(false);
  });
});

describe("deploy read DTOs", () => {
  it("parses deploy registry rows", () => {
    const result = ListDeploysResponseSchema.safeParse([
      {
        projectId: "proj-1",
        address: "mn_contract_addr_example",
        version: 12n,
        status: "active",
        deployedAt: now,
        txRef: "0xabc",
      },
      {
        projectId: "proj-1",
        address: "mn_contract_addr_old",
        version: 7n,
        status: "superseded",
        deployedAt: now - 1_000,
        txRef: "0xdef",
      },
    ]);
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  it("rejects unknown registry statuses and non-bigint versions", () => {
    const row = {
      projectId: "proj-1",
      address: "mn_contract_addr_example",
      version: 12n,
      status: "active",
      deployedAt: now,
      txRef: "0xabc",
    };
    expect(ListDeploysResponseSchema.safeParse([{ ...row, status: "pending" }]).success).toBe(
      false,
    );
    expect(ListDeploysResponseSchema.safeParse([{ ...row, version: 12 }]).success).toBe(false);
  });
});

describe("handoff & prover DTOs", () => {
  it("parses clone-token mint and revoke responses", () => {
    expect(CreateCloneTokenResponseSchema.safeParse({ cloneToken: "ct_abc123" }).success).toBe(
      true,
    );
    expect(CreateCloneTokenResponseSchema.safeParse({ cloneToken: "" }).success).toBe(false);
    expect(RevokeCloneTokenResponseSchema.safeParse({}).success).toBe(true);
  });

  it("parses a proving token response", () => {
    expect(
      ProverTokenResponseSchema.safeParse({ token: "pt_abc123", expiresAt: now }).success,
    ).toBe(true);
    expect(ProverTokenResponseSchema.safeParse({ token: "pt_abc123" }).success).toBe(false);
  });
});
