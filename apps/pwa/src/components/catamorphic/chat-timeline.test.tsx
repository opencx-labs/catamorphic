import type {
  AssistantMessageItem,
  ContextHandoffItem,
  NoticeItem,
  ReasoningItem,
  TimelineTurn,
  Turn,
  UserMessageItem,
  WorkItem,
} from "@catamorphic/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ChatTimeline } from "./chat-timeline.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The identity and placement every item carries. */
type ItemCommon = Omit<ReasoningItem, "kind" | "text">;

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const AT = "2026-10-01T10:00:00.000Z";
const after = (seconds: number) =>
  new Date(Date.parse(AT) + seconds * 1000).toISOString();

function common(id: string, turnId: string | null): ItemCommon {
  return {
    id,
    sessionId: "s",
    turnId,
    attemptId: null,
    parentItemId: null,
    position: 1,
    status: "completed",
    nativeRef: null,
    createdAt: AT,
    updatedAt: AT,
    startedAt: AT,
    endedAt: AT,
  };
}

function turn(id: string, overrides: Partial<Turn> = {}): Turn {
  return {
    id,
    sessionId: "s",
    ordinal: 1,
    status: "completed",
    inputItemId: `${id}:in`,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 1,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: AT,
    startedAt: AT,
    completedAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const input = (turnId: string, text: string): UserMessageItem => ({
  ...common(`${turnId}:in`, turnId),
  kind: "user_message",
  author: { kind: "user", externalUserId: "me" },
  text,
  attachments: [],
  dispatch: "queue",
  attention: null,
  idempotencyKey: null,
  metadata: {},
});

const reply = (turnId: string, text: string): AssistantMessageItem => ({
  ...common(`${turnId}:reply`, turnId),
  kind: "assistant_message",
  text,
  agentId: null,
});

const command: WorkItem = {
  ...common("t1:cmd", "t1"),
  endedAt: after(3),
  kind: "command",
  command: "ls -la",
  description: null,
  output: "12 files",
  exitCode: 0,
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function render(
  timeline: TimelineTurn[],
  props: Partial<Parameters<typeof ChatTimeline>[0]> = {},
) {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root?.render(<ChatTimeline timeline={timeline} {...props} />),
  );
  return node;
}

it("reads a turn as its message, timed steps, and answer with changed files", async () => {
  const node = await render([
    {
      key: "t1",
      turn: turn("t1", {
        outcome: {
          changedFiles: [{ path: "src/index.ts", kind: "modified" }],
          usage: { inputTokens: 1200, outputTokens: 300 },
        },
      }),
      entries: [
        { kind: "input", item: input("t1", "hello") },
        { kind: "reply", item: reply("t1", "Done."), steps: [command] },
      ],
    },
  ]);
  expect(node.textContent).toContain("hello");
  expect(node.textContent).toContain("1 step · 3s");
  expect(node.textContent).toContain("Done.");
  expect(node.textContent).toContain("src/index.ts");
  expect(node.textContent).toContain("1.5k tokens");
});

it("offers retry on the latest failed turn and marks undone and interrupted turns", async () => {
  const retry = vi.fn();
  const node = await render(
    [
      {
        key: "t0",
        turn: turn("t0", { status: "rolled_back" }),
        entries: [{ kind: "input", item: input("t0", "first") }],
      },
      {
        key: "t2",
        turn: turn("t2", { status: "interrupted", ordinal: 2 }),
        entries: [{ kind: "input", item: input("t2", "second") }],
      },
      {
        key: "t3",
        turn: turn("t3", {
          status: "failed",
          ordinal: 3,
          error: { message: "The provider is unavailable." },
        }),
        entries: [{ kind: "input", item: input("t3", "third") }],
      },
    ],
    { onRetry: retry },
  );
  expect(node.querySelector("[data-testid=chat-turn-undone]")).not.toBeNull();
  expect(node.querySelector("[data-testid=chat-interrupted]")).not.toBeNull();
  expect(node.textContent).toContain("The provider is unavailable.");
  await act(async () =>
    node.querySelector<HTMLButtonElement>("[data-testid=chat-retry]")?.click(),
  );
  expect(retry).toHaveBeenCalledWith("t3");
});

it("renders notices, handoffs and answered questions in place", async () => {
  const notice: NoticeItem = {
    ...common("n1", null),
    kind: "notice",
    code: "agent_changed",
    text: "Agent changed",
    data: { agentId: "helper" },
  };
  const handoff: ContextHandoffItem = {
    ...common("h1", "t1"),
    kind: "context_handoff",
    strategy: "full",
    fromProviderThreadIds: [],
    toProviderThreadId: "p",
    coveredTurnOrdinals: { from: 1, to: 3 },
    text: "Earlier, the person asked for a grid.",
  };
  const node = await render(
    [
      { key: "n1", turn: null, entries: [{ kind: "notice", item: notice }] },
      {
        key: "t1",
        turn: turn("t1"),
        entries: [
          { kind: "handoff", item: handoff },
          {
            kind: "answer",
            id: "a1",
            questions: [
              {
                question: "Which layout?",
                header: "Layout",
                multiSelect: false,
                options: [],
              },
            ],
            answers: ["Grid"],
            dismissed: false,
          },
          {
            kind: "answer",
            id: "a2",
            questions: [],
            answers: [],
            dismissed: true,
          },
        ],
      },
    ],
    { resolveAgentName: (id) => (id === "helper" ? "Helper" : undefined) },
  );
  expect(node.textContent).toContain("Switched to Helper");
  expect(node.textContent).toContain("Caught up on 3 earlier turns");
  expect(node.textContent).toContain("Which layout?");
  expect(node.textContent).toContain("Grid");
  expect(node.textContent).toContain("Questions dismissed");
});

it("shows failed sends with resend and dismiss", async () => {
  const resend = vi.fn();
  const node = await render([], {
    pending: [
      {
        commandId: "c1",
        text: "lost message",
        attachments: [],
        dispatch: "queue",
        status: "failed",
      },
    ],
    onResendFailed: resend,
    onDismissFailed: vi.fn(),
  });
  expect(node.textContent).toContain("lost message");
  await act(async () =>
    node.querySelector<HTMLButtonElement>("[data-testid=chat-resend]")?.click(),
  );
  expect(resend).toHaveBeenCalledWith("c1");
});

it("offers retry on the latest interrupted turn", async () => {
  const retry = vi.fn();
  const node = await render(
    [
      {
        key: "t1",
        turn: turn("t1", { status: "interrupted" }),
        entries: [{ kind: "input", item: input("t1", "stopped") }],
      },
    ],
    { onRetry: retry },
  );
  expect(node.querySelector("[data-testid=chat-interrupted]")).not.toBeNull();
  await act(async () =>
    node.querySelector<HTMLButtonElement>("[data-testid=chat-retry]")?.click(),
  );
  expect(retry).toHaveBeenCalledWith("t1");
});

it("stops the turn waiting to retry, not the one running", async () => {
  const interrupt = vi.fn();
  const node = await render(
    [
      {
        key: "t1",
        turn: turn("t1", {
          status: "queued",
          retryAt: after(30),
          error: { message: "Rate limited" },
        }),
        entries: [{ kind: "input", item: input("t1", "first") }],
      },
      {
        key: "t2",
        turn: turn("t2", { status: "running", ordinal: 2 }),
        entries: [{ kind: "input", item: input("t2", "second") }],
      },
    ],
    { onInterrupt: interrupt },
  );
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>("[data-testid=chat-stop-retrying]")
      ?.click(),
  );
  expect(interrupt).toHaveBeenCalledWith("t1");
});

it("withdraws the message about to start", async () => {
  const cancel = vi.fn(() => true);
  const node = await render(
    [
      {
        key: "t1",
        turn: turn("t1", { status: "queued", attemptCount: 0 }),
        entries: [{ kind: "input", item: input("t1", "go") }],
      },
    ],
    { activity: "Waiting for agent", onCancelQueued: cancel },
  );
  expect(node.textContent).toContain("Waiting for agent");
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>("[data-testid=chat-cancel-starting]")
      ?.click(),
  );
  expect(cancel).toHaveBeenCalledWith("t1");
});

it("offers undo only while nothing runs", async () => {
  const settled: TimelineTurn = {
    key: "t1",
    turn: turn("t1"),
    entries: [
      { kind: "input", item: input("t1", "hello") },
      { kind: "reply", item: reply("t1", "Done."), steps: [] },
    ],
  };
  const idle = await render([settled], { onRollback: vi.fn() });
  expect(idle.querySelector("[data-testid=chat-rollback]")).not.toBeNull();
  act(() => root?.unmount());
  const busy = await render(
    [
      settled,
      {
        key: "t2",
        turn: turn("t2", { status: "running", ordinal: 2 }),
        entries: [{ kind: "input", item: input("t2", "more") }],
      },
    ],
    { onRollback: vi.fn() },
  );
  expect(busy.querySelector("[data-testid=chat-rollback]")).toBeNull();
});
