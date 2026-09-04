// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEnablementPanel } from "./workflow-enablement-panel.js";

const preview = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock("@catamorphic/react", () => ({
  useEnvironments: () => ({
    data: {
      defaultEnvironment: "local",
      items: [
        {
          name: "local",
          label: "This Mac",
          allowed: true,
          compatible: true,
        },
      ],
    },
  }),
  useWorkflowEnablements: () => ({
    data: [
      {
        id: "enablement-1",
        projectId: "project-1",
        workflowName: "watchInbox",
        deploymentArtifactId: "artifact-1",
        commitSha: "b".repeat(40),
        remoteBranch: "main",
        environment: "local",
        owner: { type: "member", externalUserId: "alice" },
        connections: [],
        capabilities: [],
        consentDigest: "c".repeat(64),
        status: "active",
        suspensionReason: null,
        updateAvailable: true,
        temporary: false,
        expiresAt: null,
        revision: 1,
        triggers: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
      },
    ],
  }),
  usePreviewWorkflowEnablement: () => ({
    mutateAsync: preview,
    isPending: false,
    error: null,
  }),
  useCreateWorkflowEnablement: () => ({
    mutateAsync: create,
    isPending: false,
    error: null,
  }),
  useUpdateWorkflowEnablement: () => ({
    mutateAsync: update,
    isPending: false,
    error: null,
  }),
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  preview.mockReset();
  create.mockReset();
  update.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkflowEnablementPanel", () => {
  it("shows the pinned revision and reviews an update before applying it", async () => {
    preview.mockResolvedValue({
      projectId: "project-1",
      workflowName: "watchInbox",
      deploymentArtifactId: "artifact-2",
      deploymentArtifactDigest: "digest-2",
      commitSha: "a".repeat(40),
      remoteBranch: "main",
      environment: "local",
      owner: { type: "member", externalUserId: "alice" },
      connections: [],
      capabilities: ["messages.search"],
      consentDigest: "d".repeat(64),
      triggerCount: 1,
    });
    await act(async () => {
      root.render(
        <WorkflowEnablementPanel
          projectId="project-1"
          workflowName="watchInbox"
          onClose={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("bbbbbbbbbbbb");
    expect(container.textContent).toContain("update available");
    const reviewButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review update",
    );
    await act(async () => reviewButton?.click());

    expect(container.textContent).toContain("aaaaaaaaaaaa");
    expect(container.textContent).toContain("messages.search");
    expect(update).not.toHaveBeenCalled();

    const confirmButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Confirm update"),
    );
    expect(confirmButton).toBeDefined();
    await act(async () => confirmButton?.click());
    expect(update).toHaveBeenCalledWith({
      enablementId: "enablement-1",
      action: "update-deployment",
      consentDigest: "d".repeat(64),
    });
  });
});
