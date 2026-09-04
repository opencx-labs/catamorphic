// @vitest-environment jsdom

import type { AgentSession } from "@catamorphic/react/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionInspectorContent } from "./session-inspector.js";

const session: AgentSession = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  externalUserId: "member-1",
  provider: "claude-code",
  source: "slack",
  providerSessionId: null,
  sandboxId: null,
  environment: "customer-success",
  allocationId: null,
  agentId: "project:alpha:csm",
  modelEffort: null,
  title: "Prepare Acme QBR",
  icon: null,
  forkedFromSessionId: null,
  parentSessionId: null,
  visibility: "promoted",
  archivedAt: null,
  status: "active",
  activity: "Drafting the executive summary",
  todos: [],
  authorityHostId: "company-server",
  authorityRevision: 1,
  authoritySeenAt: null,
  mirrorMessageCount: 0,
  handoffStatus: "none",
  handoffDestinationHostId: null,
  attentionRevision: 0,
  attentionSeenRevision: 0,
  attentionRequired: false,
  resumable: true,
  pausedAt: null,
  running: false,
  baseCommitSha: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:01:00.000Z",
};

describe("SessionInspectorContent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("shows durable provenance and contextual session actions", async () => {
    const onFork = vi.fn();
    const onArchive = vi.fn();
    await act(async () => {
      root.render(
        <SessionInspectorContent
          session={session}
          fallbackTitle="Chat"
          agentName="Customer success"
          checkout={null}
          incognito={false}
          onFork={onFork}
          onArchive={onArchive}
        />,
      );
    });

    expect(container.textContent).toContain("Prepare Acme QBR");
    expect(container.textContent).toContain("Slack");
    expect(container.textContent).toContain("customer-success");
    const buttons = [...container.querySelectorAll("button")];
    await act(async () =>
      buttons.find((button) => button.textContent === "Fork")?.click(),
    );
    await act(async () =>
      buttons.find((button) => button.textContent === "Archive")?.click(),
    );
    expect(onFork).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledOnce();
  });
});
