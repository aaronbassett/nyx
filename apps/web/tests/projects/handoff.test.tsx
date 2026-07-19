/**
 * US13 — HandoffPanel container + useHandoff (FR-074/FR-075/D49/D58/D59).
 *
 * Drives the real container against in-memory fake seams (no socket, no
 * network): Generate mints a token and shows the derived clone URL; Regenerate
 * replaces it; Revoke removes it and shows the revoked note; Copy invokes the
 * injected clipboard seam; the archive button invokes the injected download seam
 * with the client's archive URL; and a soft-deleted project shows the paused
 * explanation and NEVER touches the client (D49/FR-077).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HandoffPanel } from "@/projects/handoff";
import type { HandoffClient } from "@/projects/handoff-client";
import type { HandoffProject } from "@/projects/handoff";

afterEach(cleanup);

const GIT_BASE = "https://git.nyx.test";

function createFakeClient() {
  const mint = vi.fn(() => Promise.resolve({ cloneToken: "ct_generated" }));
  const revoke = vi.fn(() => Promise.resolve());
  const archiveUrl = vi.fn((id: string) => `/projects/${id}/archive`);
  const client: HandoffClient = {
    mintCloneToken: mint,
    revokeCloneToken: revoke,
    archiveUrl,
  };
  return { client, mint, revoke, archiveUrl };
}

const PROJECT: HandoffProject = { id: "p1", name: "My DApp" };

describe("HandoffPanel — clone URL management", () => {
  it("Generate mints a token and shows the derived clone URL (FR-075)", async () => {
    const fake = createFakeClient();
    render(<HandoffPanel client={fake.client} project={PROJECT} gitBaseUrl={GIT_BASE} />);

    expect(screen.queryByTestId("handoff-clone-url")).toBeNull();
    fireEvent.click(screen.getByTestId("handoff-clone-generate"));

    await waitFor(() => {
      expect(screen.getByTestId("handoff-clone-url").textContent).toBe(
        "https://git.nyx.test/git/ct_generated/",
      );
    });
    expect(fake.mint).toHaveBeenCalledWith("p1");
  });

  it("shows an existing clone URL from the injected initial token", () => {
    const fake = createFakeClient();
    render(
      <HandoffPanel
        client={fake.client}
        project={PROJECT}
        gitBaseUrl={GIT_BASE}
        initialCloneToken="ct_existing"
      />,
    );

    expect(screen.getByTestId("handoff-clone-url").textContent).toBe(
      "https://git.nyx.test/git/ct_existing/",
    );
  });

  it("Regenerate replaces the token (FR-075)", async () => {
    const fake = createFakeClient();
    fake.mint.mockResolvedValueOnce({ cloneToken: "ct_second" });
    render(
      <HandoffPanel
        client={fake.client}
        project={PROJECT}
        gitBaseUrl={GIT_BASE}
        initialCloneToken="ct_first"
      />,
    );

    expect(screen.getByTestId("handoff-clone-url").textContent).toBe(
      "https://git.nyx.test/git/ct_first/",
    );
    fireEvent.click(screen.getByTestId("handoff-clone-regenerate"));

    await waitFor(() => {
      expect(screen.getByTestId("handoff-clone-url").textContent).toBe(
        "https://git.nyx.test/git/ct_second/",
      );
    });
    expect(fake.mint).toHaveBeenCalledWith("p1");
  });

  it("Revoke removes the clone URL and shows the revoked note (SC-043)", async () => {
    const fake = createFakeClient();
    render(
      <HandoffPanel
        client={fake.client}
        project={PROJECT}
        gitBaseUrl={GIT_BASE}
        initialCloneToken="ct_live"
      />,
    );

    expect(screen.getByTestId("handoff-clone-url")).not.toBeNull();
    fireEvent.click(screen.getByTestId("handoff-clone-revoke"));

    await waitFor(() => {
      expect(screen.queryByTestId("handoff-clone-url")).toBeNull();
    });
    expect(screen.getByTestId("handoff-revoked-note")).not.toBeNull();
    expect(fake.revoke).toHaveBeenCalledWith("p1");
  });

  it("Copy invokes the injected clipboard seam with the clone URL", async () => {
    const fake = createFakeClient();
    const copyToClipboard = vi.fn(() => Promise.resolve());
    render(
      <HandoffPanel
        client={fake.client}
        project={PROJECT}
        gitBaseUrl={GIT_BASE}
        initialCloneToken="ct_copy"
        copyToClipboard={copyToClipboard}
      />,
    );

    fireEvent.click(screen.getByTestId("handoff-clone-copy"));

    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith("https://git.nyx.test/git/ct_copy/");
    });
    await waitFor(() => {
      expect(screen.getByTestId("handoff-copied")).not.toBeNull();
    });
  });

  it("surfaces a typed failure as an accessible alert without losing the token", async () => {
    const fake = createFakeClient();
    fake.mint.mockRejectedValueOnce(new Error("boom"));
    render(
      <HandoffPanel
        client={fake.client}
        project={PROJECT}
        gitBaseUrl={GIT_BASE}
        initialCloneToken="ct_keep"
      />,
    );

    fireEvent.click(screen.getByTestId("handoff-clone-regenerate"));

    await waitFor(() => {
      expect(screen.getByTestId("handoff-error").getAttribute("role")).toBe("alert");
    });
    // The prior token survives a failed regenerate.
    expect(screen.getByTestId("handoff-clone-url").textContent).toBe(
      "https://git.nyx.test/git/ct_keep/",
    );
  });
});

describe("HandoffPanel — archive download", () => {
  it("invokes the injected download seam with the client's archive URL (FR-074)", () => {
    const fake = createFakeClient();
    const triggerDownload = vi.fn();
    render(
      <HandoffPanel
        client={fake.client}
        project={PROJECT}
        gitBaseUrl={GIT_BASE}
        triggerDownload={triggerDownload}
      />,
    );

    fireEvent.click(screen.getByTestId("handoff-archive-download"));

    expect(fake.archiveUrl).toHaveBeenCalledWith("p1");
    expect(triggerDownload).toHaveBeenCalledWith("/projects/p1/archive");
  });
});

describe("HandoffPanel — soft-deleted disabled state", () => {
  it("shows the paused explanation and never calls the client (D49/FR-077)", () => {
    const fake = createFakeClient();
    const triggerDownload = vi.fn();
    const deleted: HandoffProject = {
      id: "p1",
      name: "My DApp",
      deletedAt: 1_752_883_200_000, // epoch-ms, matching the wire Project.deletedAt
    };
    render(
      <HandoffPanel
        client={fake.client}
        project={deleted}
        gitBaseUrl={GIT_BASE}
        triggerDownload={triggerDownload}
      />,
    );

    expect(screen.getByTestId("handoff-disabled").textContent).toContain(
      "Handoff is paused for deleted projects",
    );
    // None of the action affordances render, so nothing can reach the client.
    expect(screen.queryByTestId("handoff-clone-generate")).toBeNull();
    expect(screen.queryByTestId("handoff-archive-download")).toBeNull();
    expect(fake.mint).not.toHaveBeenCalled();
    expect(fake.revoke).not.toHaveBeenCalled();
    expect(fake.archiveUrl).not.toHaveBeenCalled();
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});
