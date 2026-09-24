import { CatamorphicError } from "@catamorphic/react";
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEnablementPanel } from "./workflow-enablement-panel.js";

const preview = vi.fn();
const create = vi.fn();
const update = vi.fn();
const rotate = vi.fn();
const deploy = vi.fn();
let canManageProjectAutomations = false;
let enablementItems: unknown[] = [];
const memberEnablement = {
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
  permissions: [],
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
};

vi.mock("@catamorphic/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@catamorphic/react")>()),
  useConnectionAuthorizationStatus: () => ({ data: undefined, error: null }),
  useAuthorizeConnection: () => ({
    mutateAsync: async () => ({
      authorizationId: "authorization",
      challenge: {
        kind: "form",
        fields: [
          {
            name: "key",
            label: "Account key",
            type: "password",
            required: true,
          },
        ],
      },
    }),
    isPending: false,
    error: null,
  }),
  useCompleteConnectionAuthorization: () => ({
    mutateAsync: async () => ({}),
    isPending: false,
    error: null,
  }),
  useEnvironments: () => ({
    data: {
      defaultEnvironment: "local",
      items: [
        {
          name: "local",
          label: "This Mac",
          allowed: true,
          compatible: true,
          available: true,
          reasons: [],
        },
      ],
    },
  }),
  useWorkflowEnablements: () => ({
    data: { items: enablementItems, canManageProjectAutomations },
    isSuccess: true,
  }),
  useWebhooks: () => ({
    data: canManageProjectAutomations
      ? [
          {
            name: "github",
            url: "https://brain.example/api/hooks/project-1/github/token",
            workflows: ["watchInbox"],
            listening: false,
            verified: true,
          },
        ]
      : undefined,
  }),
  useDeployProject: () => ({
    mutateAsync: deploy,
    isPending: false,
    error: null,
  }),
  useRotateWebhook: () => ({
    mutateAsync: rotate,
    isPending: false,
    error: null,
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
  rotate.mockReset();
  deploy.mockReset();
  canManageProjectAutomations = false;
  enablementItems = [memberEnablement];
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
      permissions: [],
      consentDigest: "d".repeat(64),
      triggerCount: 1,
      triggers: [{ kind: "schedule", config: { cron: "0 9 * * *" } }],
      connectionLabels: {},
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

it("returns to exact consent review after account authorization without enabling automatically", async () => {
  preview.mockRejectedValueOnce(
    new CatamorphicError({
      code: "authentication_required",
      details: {
        environment: "local",
        requirements: [
          {
            alias: "directory",
            providerKind: "company",
            principalKinds: ["member"],
          },
        ],
      },
    }),
  );
  preview.mockResolvedValueOnce({
    projectId: "project-1",
    workflowName: "watchInbox",
    commitSha: "e".repeat(40),
    environment: "local",
    owner: { type: "member", externalUserId: "alice" },
    connections: [
      {
        alias: "directory",
        connectionId: "account",
        providerKind: "company",
        principalKind: "member",
      },
    ],
    connectionLabels: { account: "Alice at Company" },
    capabilities: ["messages.search"],
    permissions: ["sessions:write"],
    triggers: [{ kind: "schedule", config: { cron: "0 9 * * *" } }],
    consentDigest: "reviewed-digest",
  });
  await act(async () =>
    root.render(
      <WorkflowEnablementPanel
        projectId="project-1"
        workflowName="watchInbox"
        onClose={() => {}}
      />,
    ),
  );
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(text),
    );
  await act(async () => button("Review update")?.click());
  expect(container.textContent).toContain("review and confirm");
  await act(async () => button("Authenticate")?.click());
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(container.textContent).toContain("Alice at Company");
  expect(container.textContent).toContain("eeeeeeeeeeee");
  // Declared permissions read as plain words in the consent (ADR 0158).
  expect(
    container.querySelector('[data-testid="consent-permissions"]')?.textContent,
  ).toBe("Post into anyone's chat");
  expect(create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  await act(async () => button("Confirm update")?.click());
  expect(update).toHaveBeenCalledWith({
    enablementId: "enablement-1",
    action: "update-deployment",
    consentDigest: "reviewed-digest",
  });
});

it("enables a workflow for the project and shows its webhook URL to automation managers", async () => {
  canManageProjectAutomations = true;
  enablementItems = [];
  preview.mockResolvedValueOnce({
    projectId: "project-1",
    workflowName: "watchInbox",
    commitSha: "f".repeat(40),
    environment: "local",
    owner: { type: "project" },
    connections: [],
    connectionLabels: {},
    capabilities: [],
    permissions: [],
    triggers: [
      {
        kind: "webhook",
        config: {
          name: "github",
          verify: { secret: "GITHUB_SECRET", header: "x-hub-signature-256" },
        },
      },
    ],
    consentDigest: "project-digest",
  });
  await act(async () =>
    root.render(
      <WorkflowEnablementPanel
        projectId="project-1"
        workflowName="watchInbox"
        onClose={() => {}}
      />,
    ),
  );
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith(text),
    );
  expect(
    container.querySelector<HTMLInputElement>(
      'input[aria-label="github webhook URL"]',
    )?.value,
  ).toBe("https://brain.example/api/hooks/project-1/github/token");
  expect(container.textContent).toContain("Enable to start receiving");

  await act(async () => button("The project")?.click());
  await act(async () => button("Enable for the project")?.click());
  expect(preview).toHaveBeenCalledWith({
    workflowName: "watchInbox",
    environment: "local",
    owner: { type: "project" },
  });
  expect(container.textContent).toContain("The project");
  expect(container.textContent).toContain("Webhook github (signed)");

  await act(async () => button("Confirm and enable")?.click());
  expect(create).toHaveBeenCalledWith({
    workflowName: "watchInbox",
    environment: "local",
    owner: { type: "project" },
    connectionSelections: {},
    consentDigest: "project-digest",
  });
});

it("shows the project's automation to members without letting them manage it", async () => {
  enablementItems = [
    { ...memberEnablement, owner: { type: "project" }, updateAvailable: false },
  ];
  await act(async () =>
    root.render(
      <WorkflowEnablementPanel
        projectId="project-1"
        workflowName="watchInbox"
        onClose={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("For the project");
  expect(container.textContent).not.toContain("The project");
  expect(
    [...container.querySelectorAll("button")].some((item) =>
      item.textContent?.startsWith("Pause"),
    ),
  ).toBe(false);
  expect(container.textContent).toContain("Enable for me");
});

it("offers to publish a saved workflow before turning it on", async () => {
  canManageProjectAutomations = true;
  enablementItems = [];
  preview.mockRejectedValueOnce(
    new CatamorphicError({
      code: "conflict",
      message:
        "This workflow isn't in the project's published version yet. Publish the project's changes, then turn it on.",
      details: { reason: "not_published" },
    }),
  );
  preview.mockResolvedValueOnce({
    projectId: "project-1",
    workflowName: "watchInbox",
    commitSha: "a".repeat(40),
    environment: "local",
    owner: { type: "member", externalUserId: "alice" },
    connections: [],
    connectionLabels: {},
    capabilities: [],
    permissions: [],
    triggers: [],
    consentDigest: "after-publish",
  });
  deploy.mockResolvedValueOnce({ status: "deployed" });
  await act(async () =>
    root.render(
      <WorkflowEnablementPanel
        projectId="project-1"
        workflowName="watchInbox"
        onClose={() => {}}
      />,
    ),
  );
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith(text),
    );
  await act(async () => button("Enable for me")?.click());
  expect(
    container.querySelector('[data-testid="workflow-not-published"]')
      ?.textContent,
  ).toContain("published version");
  expect(button("Enable for me")).toBeUndefined();
  await act(async () => button("Publish changes and continue")?.click());
  expect(deploy).toHaveBeenCalledTimes(1);
  expect(preview).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Consent summary");
});
