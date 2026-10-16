// @vitest-environment jsdom

import type { AgentSession } from "@catamorphic/react/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionInspectorContent } from "./session-inspector.js";

const session: AgentSession = {
  workStatus: "open",
  stateRevision: 0,
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  externalUserId: "member-1",
  owner: "member",
  source: "slack",
  sandboxId: null,
  environment: "customer-success",
  allocationId: null,
  agentId: "project:alpha:csm",
  harness: null,
  model: null,
  modelEffort: null,
  title: "Prepare Acme QBR",
  icon: null,
  forkedFromSessionId: null,
  imported: null,
  parentSessionId: null,
  visibility: "promoted",
  archivedAt: null,
  status: "active",
  activity: "Drafting the executive summary",
  todos: [],
  authorityHostId: "company-server",
  authorityRevision: 1,
  authoritySeenAt: "2026-09-01T00:00:00.000Z",
  mirrorSequence: 0,
  handoffStatus: "none",
  handoffDestinationHostId: null,
  attentionRevision: 0,
  attentionSeenRevision: 0,
  attentionRequired: false,
  resumable: true,
  pausedAt: null,
  running: false,
  key: null,
  keyWorkflows: [],
  placement: null,
  workspace: null,
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
    const onEditModel = vi.fn();
    const onEditEffort = vi.fn();
    await act(async () => {
      root.render(
        <SessionInspectorContent
          session={session}
          fallbackTitle="Chat"
          agentName="Customer success"
          model="claude-sonnet-5"
          effort="high"
          onEditModel={onEditModel}
          onEditEffort={onEditEffort}
          incognito={false}
          onFork={onFork}
          onArchive={onArchive}
        />,
      );
    });

    expect(container.textContent).toContain("Prepare Acme QBR");
    expect(container.textContent).toContain("Slack");
    expect(container.textContent).toContain("customer-success");
    expect(container.textContent).toContain("claude-sonnet-5");
    // The harness's own name for the level, as it is.
    expect(container.textContent).toContain("high");
    expect(container.textContent).not.toContain("High");
    const buttons = [...container.querySelectorAll("button")];
    await act(async () =>
      buttons
        .find((button) => button.textContent === "claude-sonnet-5")
        ?.click(),
    );
    await act(async () =>
      buttons.find((button) => button.textContent === "high")?.click(),
    );
    await act(async () =>
      buttons.find((button) => button.textContent === "Fork")?.click(),
    );
    await act(async () =>
      buttons.find((button) => button.textContent === "Archive")?.click(),
    );
    expect(onFork).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onEditModel).toHaveBeenCalledOnce();
    expect(onEditEffort).toHaveBeenCalledOnce();
  });

  it("shows the harness's permission mode apart from Work's sandboxing (ADR 0182)", async () => {
    const onEditPermissionMode = vi.fn();
    await act(async () => {
      root.render(
        <SessionInspectorContent
          session={session}
          fallbackTitle="Chat"
          agentName="Claude"
          permissionMode="Bypass permissions"
          sandboxing="Contained"
          onEditPermissionMode={onEditPermissionMode}
          incognito={false}
        />,
      );
    });
    const change = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change permission mode"]',
    );
    expect(change?.textContent).toBe("Bypass permissions");
    expect(container.textContent).toContain("Sandboxing");
    expect(container.textContent).toContain("Contained");
    expect(
      container.querySelector('button[aria-label="Change sandboxing"]'),
    ).toBeNull();
    await act(async () => change?.click());
    expect(onEditPermissionMode).toHaveBeenCalledOnce();

    // A definition's mode is shown, and says where it is set.
    await act(async () => {
      root.render(
        <SessionInspectorContent
          session={session}
          fallbackTitle="Chat"
          agentName="Reviewer"
          permissionMode="Plan"
          permissionModeDisabledReason="Set in the project's agent definition in .work/agents."
          incognito={false}
        />,
      );
    });
    const locked = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change permission mode"]',
    );
    expect(locked?.disabled).toBe(true);
    expect(locked?.textContent).toBe("Plan");
  });

  it("offers each fact's value to copy on its row, a model without its tag", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await act(async () => {
      root.render(
        <SessionInspectorContent
          session={session}
          fallbackTitle="Chat"
          agentName="Customer success"
          model="claude-sonnet-5"
          modelIsDefault
          effort="high"
          onEditModel={vi.fn()}
          environmentControl={
            <select aria-label="Environment">
              <option>Customer success team</option>
              <option>Support</option>
            </select>
          }
          environmentLabel="Customer success team"
          onManageConnections={vi.fn()}
          incognito={false}
        />,
      );
    });
    const rows = [...container.querySelectorAll("dl > div")];
    // Every fact but an action (Connections) has its copy, revealed while
    // its row is hovered.
    expect(
      rows.map((row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector('button[aria-label^="Copy "]')?.ariaLabel ?? null,
        row.hasAttribute("data-copyable"),
      ]),
    ).toEqual([
      ["Agent", "Copy agent", true],
      ["Model", "Copy model", true],
      ["Reasoning", "Copy reasoning", true],
      ["Source", "Copy source", true],
      ["Status", "Copy status", true],
      ["Environment", "Copy environment", true],
      ["Connections", null, false],
      ["Updated", "Copy update time", true],
    ]);
    const copy = (label: string) =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    // The model, not "default" after it; the environment as its picker names
    // it, not every option the picker lists.
    await act(async () => copy("Copy model")?.click());
    expect(writeText).toHaveBeenLastCalledWith("claude-sonnet-5");
    await act(async () => copy("Copy environment")?.click());
    expect(writeText).toHaveBeenLastCalledWith("Customer success team");
    await act(async () => copy("Copy source")?.click());
    expect(writeText).toHaveBeenLastCalledWith("Slack");
  });
});
