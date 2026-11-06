// @vitest-environment jsdom

import type {
  InboundMessageItem,
  TaskNotificationItem,
} from "@catamorphic/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboundMessageRow, TaskNotificationRows } from "./session-input.js";

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
});

const common = {
  sessionId: "session",
  turnId: null,
  attemptId: null,
  parentItemId: null,
  position: 1,
  status: "completed" as const,
  nativeRef: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
  startedAt: null,
  endedAt: null,
  dispatch: "queue" as const,
  attention: null,
  idempotencyKey: null,
  deliveredBy: null,
  causation: [],
};

const inbound = (
  from: InboundMessageItem["from"],
  text = "Review PR #12\nIt touches the billing code.",
): InboundMessageItem => ({
  ...common,
  id: "inbound",
  kind: "inbound_message",
  from,
  text,
  attachments: [],
});

const notification = (
  id: string,
  summary: string,
  status: TaskNotificationItem["task"]["status"] = "update",
): TaskNotificationItem => ({
  ...common,
  id,
  kind: "task_notification",
  task: {
    type: "background_command",
    id: "cmd-1",
    title: "Dev server",
    status,
  },
  summary,
  detail: `Matching lines:\n${summary}`,
  source: { kind: "surface", key: "terminal:abc" },
});

it("names a workflow by its display name, or readably without one", async () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  const name = async (from: InboundMessageItem["from"]) => {
    await act(async () =>
      root.render(<InboundMessageRow item={inbound(from)} />),
    );
    return container.querySelector("button span.font-medium")?.textContent;
  };
  expect(
    await name({
      kind: "workflow",
      runId,
      workflowName: "staleChatNudge",
      displayName: "Nudge quiet chats",
    }),
  ).toBe("Nudge quiet chats");
  expect(
    await name({ kind: "workflow", runId, workflowName: "staleChatNudge" }),
  ).toBe("Stale chat nudge");
  expect(await name({ kind: "agent", sessionId: "s2", agentId: null })).toBe(
    "Another agent",
  );
  expect(await name({ kind: "assistant", externalUserId: "u" })).toBe(
    "Assistant",
  );
});

it("uses the host's harness icon for an agent update and keeps other sender icons", async () => {
  const renderAgentIcon = vi.fn((agentId: string | null) => (
    <span data-harness-icon={agentId} />
  ));
  await act(async () =>
    root.render(
      <InboundMessageRow
        item={inbound({ kind: "agent", sessionId: "s2", agentId: "codex" })}
        renderAgentIcon={renderAgentIcon}
      />,
    ),
  );
  expect(renderAgentIcon).toHaveBeenCalledWith("codex");
  expect(container.querySelector('[data-harness-icon="codex"]')).not.toBeNull();
  expect(container.querySelector(".lucide-bot")).toBeNull();

  renderAgentIcon.mockClear();
  await act(async () =>
    root.render(
      <InboundMessageRow
        item={inbound({ kind: "workflow", runId: "r", workflowName: "review" })}
        renderAgentIcon={renderAgentIcon}
      />,
    ),
  );
  expect(renderAgentIcon).not.toHaveBeenCalled();
  expect(container.querySelector(".lucide-workflow")).not.toBeNull();
});

it("opens to the whole message and links to where it came from", async () => {
  const onOpen = vi.fn();
  await act(async () =>
    root.render(
      <InboundMessageRow
        item={inbound({
          kind: "workflow",
          runId: "run-1",
          workflowName: "prReview",
        })}
        onOpen={onOpen}
      />,
    ),
  );
  const row = container.querySelector("[data-testid=chat-inbound-message]");
  expect(row?.getAttribute("data-sender-kind")).toBe("workflow");
  expect(row?.querySelector("button")?.textContent).toContain("Review PR #12");
  await act(async () => row?.querySelector("button")?.click());
  expect(row?.textContent).toContain("It touches the billing code.");
  const links = [...(row?.querySelectorAll("a") ?? [])].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ]);
  expect(links).toEqual([
    ["Open run", "run:run-1"],
    ["Open workflow", "workflow:prReview"],
  ]);
  await act(async () => row?.querySelector("a")?.click());
  expect(onOpen).toHaveBeenCalledWith("run:run-1", expect.any(Object));
});

it("folds repeated news from one task into its latest row, linked to the task", async () => {
  await act(async () =>
    root.render(
      <TaskNotificationRows
        items={[
          notification("n1", "Dev server printed what you were waiting for"),
          notification("n2", "Dev server printed what you were waiting for"),
          notification("n3", "Dev server failed (exit 1)", "failed"),
        ]}
      />,
    ),
  );
  const rows = container.querySelectorAll(
    "[data-testid=chat-task-notification]",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.getAttribute("data-task-status")).toBe("failed");
  expect(rows[0]?.textContent).toContain("Dev server failed (exit 1)");
  expect(rows[0]?.textContent).toContain("3 times");
  expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe(
    "terminal:abc",
  );
  expect(rows[0]?.querySelector("a")?.textContent).toBe("Open terminal");
});

it("opens the folded notification a link points at, by its own id", async () => {
  await act(async () =>
    root.render(
      <TaskNotificationRows
        items={[
          notification("n1", "Dev server printed what you were waiting for"),
          notification("n2", "Dev server finished", "completed"),
        ]}
        focusMessageId="n1"
      />,
    ),
  );
  const row = container.querySelector("[data-message-id=n1]");
  expect(row?.getAttribute("data-testid")).toBe("chat-task-notification");
  expect(row?.querySelector("button")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
});

it("reads a line with nothing to open as a line, not a control", async () => {
  await act(async () =>
    root.render(
      <TaskNotificationRows
        items={[
          {
            ...notification("n1", "Deploy is live: done", "completed"),
            detail: "",
            source: null,
          },
        ]}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Deploy is live: done");
});

it("shows saved watcher status with a centered dot and leading disclosure", async () => {
  const item = notification("watch", "Deploy is live: done", "completed");
  item.task.type = "command_watch";
  await act(async () => root.render(<TaskNotificationRows items={[item]} />));
  const button = container.querySelector("button");
  expect(button?.textContent).toContain("Deploy is live · done");
  expect(
    button?.firstElementChild?.classList.contains("lucide-chevron-right"),
  ).toBe(true);
  expect(button?.querySelector(".lucide-hourglass")).not.toBeNull();
  await act(async () => button?.click());
  expect(button?.getAttribute("aria-expanded")).toBe("true");
});
