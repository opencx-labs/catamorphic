// @vitest-environment jsdom

import {
  type AgentAttachment,
  ATTACHMENT_MARKER,
  CatamorphicError,
  type ContextHandoffItem,
  type Item,
  type TimelineTurn,
  type UserMessageItem,
} from "@catamorphic/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline, type ChatTimelineProps } from "./chat-timeline.js";
import {
  command,
  fileChange,
  inbound,
  input,
  notice,
  reply,
  timelineOf,
  toolCall,
  turn,
} from "./timeline-fixtures.js";

/**
 * What embedders other than the desktop rely on (the PWA, agent-chat):
 * the registry's own behaviors, its host slots, and that callbacks and
 * host inputs reach memoized rows.
 */
describe("ChatTimeline for embedders", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
      window.clearTimeout(handle),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = (props: ChatTimelineProps) =>
    act(async () => root.render(<ChatTimeline {...props} />));
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector);
  const $$ = (selector: string) => [...container.querySelectorAll(selector)];
  const click = (selector: string) =>
    act(async () => $<HTMLButtonElement>(selector)?.click());
  const openSteps = () => click('[data-testid="chat-turn-steps-toggle"]');
  const stepLabels = () =>
    $$('[data-testid="chat-step"] button').map(
      (button) => button.textContent ?? "",
    );

  it("reads a turn as its message, a timed step, and the answer", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "hello"),
          command("c1", "t1", {
            command: "ls -la",
            startedAt: "2026-10-01T10:00:00.000Z",
            endedAt: "2026-10-01T10:00:03.000Z",
          }),
          reply("a1", "t1", "Done."),
        ],
      }),
    });
    expect(container.textContent).toContain("hello");
    // A lone step is its own row, with how long it took.
    expect(stepLabels()).toEqual(["$ ls -la3s"]);
    expect(container.textContent).toContain("Done.");
  });

  it("marks undone and interrupted turns, and retries the latest failed one", async () => {
    const retry = vi.fn();
    await render({
      timeline: timelineOf({
        turns: [
          turn("t0", 1, { status: "rolled_back" }),
          turn("t2", 2, { status: "interrupted" }),
          turn("t3", 3, {
            status: "failed",
            error: { message: "The provider is unavailable." },
          }),
        ],
        items: [
          input("t0", "first"),
          input("t2", "second"),
          input("t3", "third"),
        ],
      }),
      onRetry: retry,
    });
    expect($('[data-testid="chat-undone-divider"]')).not.toBeNull();
    expect($('[data-testid="chat-interrupted"]')).not.toBeNull();
    expect(container.textContent).toContain("The provider is unavailable.");
    // Only the latest turn offers Retry.
    expect($$('[data-testid="chat-retry"]')).toHaveLength(1);
    await click('[data-testid="chat-retry"]');
    expect(retry).toHaveBeenCalledWith("t3");
  });

  it("offers Retry on the latest interrupted turn", async () => {
    const retry = vi.fn();
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1, { status: "interrupted" })],
        items: [input("t1", "stopped")],
      }),
      onRetry: retry,
    });
    await click('[data-testid="chat-retry"]');
    expect(retry).toHaveBeenCalledWith("t1");
  });

  describe("a chat its agent archived", () => {
    // Written once the turn has stopped (turn 1 ends at second 190).
    const archived = (by: string) =>
      notice(
        `archived-by-${by}`,
        "session_action",
        "Archived this session",
        {
          actor: { kind: "agent", sessionId: by, agentId: "claude" },
          sessionAction: {
            id: "a1",
            operation: "archive",
            status: "completed",
          },
        },
        195,
      );
    const agents = { resolveAgentName: () => "Claude" };

    it("ends the turn that archived it, with no interruption or Retry", async () => {
      await render({
        timeline: timelineOf({
          turns: [turn("t1", 1, { status: "interrupted" })],
          items: [input("t1", "Archive this chat"), archived("s")],
        }),
        onRetry: vi.fn(),
        ...agents,
      });
      expect($('[data-testid="chat-interrupted"]')).toBeNull();
      expect($('[data-testid="chat-retry"]')).toBeNull();
      expect($('[data-notice-code="session_action"]')?.textContent).toBe(
        "Claude archived this session",
      );
    });

    it("still says what the turn left changed", async () => {
      await render({
        timeline: timelineOf({
          turns: [
            turn("t1", 1, {
              status: "interrupted",
              outcome: {
                changedFiles: [
                  { path: "docs/plan.md", kind: "modified" },
                  { path: "notes.md", kind: "modified" },
                ],
              },
            }),
          ],
          items: [input("t1", "Wrap up and archive"), archived("s")],
        }),
        onRetry: vi.fn(),
        ...agents,
      });
      expect($('[data-testid="chat-interrupted"]')).toBeNull();
      expect($('[data-testid="chat-retry"]')).toBeNull();
      expect($('[data-testid="chat-interrupted-files"]')?.textContent).toBe(
        "Left 2 changed files: plan.md, notes.md",
      );
    });

    it("still shows a turn another chat's agent stopped as interrupted", async () => {
      await render({
        timeline: timelineOf({
          turns: [turn("t1", 1, { status: "interrupted" })],
          items: [input("t1", "Keep going"), archived("parent")],
        }),
        onRetry: vi.fn(),
        ...agents,
      });
      expect($('[data-testid="chat-interrupted"]')).not.toBeNull();
      expect($('[data-testid="chat-retry"]')).not.toBeNull();
    });

    it("keeps an action's failure, and words of the agent's own, as their own sentence", async () => {
      await render({
        timeline: timelineOf({
          turns: [turn("t1", 1)],
          items: [
            input("t1", "Wrap up"),
            notice(
              "failed",
              "session_action",
              "Archived this session failed: busy",
              {
                actor: { kind: "agent", sessionId: "s", agentId: "claude" },
                sessionAction: {
                  id: "a2",
                  operation: "archive",
                  status: "failed",
                },
              },
            ),
            notice("done", "session_action", "Reviewed pull request 7", {
              actor: { kind: "agent", sessionId: "s", agentId: "claude" },
              sessionAction: {
                id: "a3",
                operation: "complete",
                status: "completed",
              },
            }),
          ],
        }),
        ...agents,
      });
      expect(
        $$('[data-notice-code="session_action"]').map(
          (line) => line.textContent,
        ),
      ).toEqual([
        "Claude: Archived this session failed: busy",
        "Claude: Reviewed pull request 7",
      ]);
    });
  });

  it("renders notices, handoffs and answered questions in place", async () => {
    const handoff: ContextHandoffItem = {
      id: "h1",
      sessionId: "s",
      turnId: "t1",
      attemptId: null,
      parentItemId: null,
      position: 1,
      status: "completed",
      nativeRef: null,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
      startedAt: null,
      endedAt: null,
      kind: "context_handoff",
      strategy: "full",
      fromProviderThreadIds: [],
      toProviderThreadId: "p",
      coveredTurnOrdinals: { from: 1, to: 3 },
      text: "Earlier, the person asked for a grid.",
    };
    const timeline: TimelineTurn[] = [
      {
        key: "n1",
        turn: null,
        entries: [
          {
            kind: "notice",
            item: {
              ...handoff,
              id: "n1",
              turnId: null,
              kind: "notice",
              code: "agent_changed",
              text: "Agent changed",
              data: { agentId: "helper" },
            },
          },
        ],
      },
      {
        key: "t1",
        turn: turn("t1", 1),
        entries: [
          { kind: "handoff", item: handoff },
          {
            kind: "answer",
            id: "q1",
            requestId: "q1",
            questions: [
              {
                question: "Which layout?",
                header: "Layout",
                multiSelect: false,
                options: [],
              },
            ],
            answers: ["Grid"],
            attachments: [[]],
            dismissed: false,
          },
          {
            kind: "answer",
            id: "q2",
            requestId: "q2",
            questions: [],
            answers: [],
            attachments: [],
            dismissed: true,
          },
        ],
      },
    ];
    await render({
      timeline,
      resolveAgentName: (id) => (id === "helper" ? "Helper" : undefined),
    });
    expect($('[data-testid="chat-divider"]')?.textContent).toBe(
      "Switched to Helper",
    );
    expect(container.textContent).toContain(
      "Told the agent the conversation so far",
    );
    expect($('[data-testid="question-answer"]')?.textContent).toContain(
      "Which layout?",
    );
    expect(container.textContent).toContain("Grid");
    expect(container.textContent).toContain("Questions dismissed");
  });

  it("says an agent that missed part of the conversation was told what it missed", async () => {
    await render({
      timeline: [
        {
          key: "t1",
          turn: turn("t1", 1),
          entries: [
            {
              kind: "handoff",
              item: {
                id: "h1",
                sessionId: "s",
                turnId: "t1",
                attemptId: null,
                parentItemId: null,
                position: 1,
                status: "completed",
                nativeRef: null,
                createdAt: "2026-10-01T10:00:00.000Z",
                updatedAt: "2026-10-01T10:00:00.000Z",
                startedAt: null,
                endedAt: null,
                kind: "context_handoff",
                strategy: "delta",
                fromProviderThreadIds: [],
                toProviderThreadId: "p",
                coveredTurnOrdinals: { from: 2, to: 3 },
                text: "While you were away from this conversation, it continued.",
              },
            },
          ],
        },
      ],
    });
    expect($('[data-testid="chat-handoff"] button')?.textContent).toBe(
      "Told the agent what it missed",
    );
  });

  it("keeps a failed send with Send again and Dismiss", async () => {
    const resend = vi.fn();
    const dismiss = vi.fn();
    await render({
      timeline: [],
      pending: [
        {
          commandId: "c1",
          text: "lost message",
          attachments: [],
          dispatch: "queue",
          status: "failed",
          error: new CatamorphicError({ code: "network", message: "Offline" }),
        },
      ],
      onResendFailed: resend,
      onDismissFailed: dismiss,
    });
    expect(container.textContent).toContain("lost message");
    expect(container.textContent).toContain("Not sent: Offline");
    await click('[data-testid="chat-resend"]');
    expect(resend).toHaveBeenCalledWith("c1");
  });

  it("stops the turn waiting to retry, even when it is not the latest", async () => {
    const interrupt = vi.fn();
    await render({
      timeline: timelineOf({
        turns: [
          turn("t1", 1, {
            status: "queued",
            retryAt: new Date(Date.now() + 30_000).toISOString(),
            error: { message: "Rate limited" },
          }),
          turn("t2", 2, { status: "running", completedAt: null }),
        ],
        items: [input("t1", "first"), input("t2", "second")],
      }),
      onInterrupt: interrupt,
    });
    expect($('[data-testid="chat-auto-retry"]')?.textContent).toMatch(
      /Retrying in \d+s/,
    );
    await click('[data-testid="chat-stop-retrying"]');
    expect(interrupt).toHaveBeenCalledWith("t1");
  });

  it("offers Reconnect on a turn that failed on authentication", async () => {
    const reauth = vi.fn();
    await render({
      timeline: timelineOf({
        turns: [
          turn("t1", 1, {
            status: "failed",
            error: { message: "Sign in again.", kind: "auth" },
          }),
        ],
        items: [input("t1", "go")],
      }),
      onReauth: reauth,
      reauthLabel: "Sign in to Claude",
    });
    expect($('[data-testid="chat-reauth"]')?.textContent).toBe(
      "Sign in to Claude",
    );
    await click('[data-testid="chat-reauth"]');
    expect(reauth).toHaveBeenCalledWith("t1");
  });

  it("offers Restore to here only while nothing runs", async () => {
    const settled = timelineOf({
      turns: [turn("t1", 1)],
      items: [input("t1", "hello"), reply("a1", "t1", "Done.")],
    });
    await render({ timeline: settled, onRollback: vi.fn() });
    expect($('[data-testid="chat-restore"]')).not.toBeNull();
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1), turn("t2", 2, { status: "running" })],
        items: [input("t1", "hello"), input("t2", "more")],
      }),
      onRollback: vi.fn(),
    });
    expect($('[data-testid="chat-restore"]')).toBeNull();
    // Nor on a turn withdrawn before it ran.
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1, { status: "cancelled" })],
        items: [input("t1", "hello"), reply("a1", "t1", "Done.")],
      }),
      onRollback: vi.fn(),
    });
    expect($('[data-testid="chat-restore"]')).toBeNull();
  });

  it("says when Restore did not work, and keeps the choice open", async () => {
    const attempts: boolean[] = [false, true];
    const rollback = vi.fn((_turnId: string, _item: UserMessageItem) =>
      attempts.shift(),
    );
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [input("t1", "hello"), reply("a1", "t1", "Done.")],
      }),
      onRollback: rollback,
    });
    await click('[data-testid="chat-restore"]');
    await click('[data-testid="chat-restore-confirm-button"]');
    expect($('[data-testid="chat-restore-confirm"]')?.textContent).toContain(
      "That did not work. Try again.",
    );
    await click('[data-testid="chat-restore-confirm-button"]');
    expect($('[data-testid="chat-restore-confirm"]')).toBeNull();
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(rollback.mock.calls[0]?.[0]).toBe("t1");
  });

  it("reads Work's tools by their own words and hides bookkeeping", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Look around"),
          toolCall("title", "t1", {
            tool: "mcp__workspace__set_title",
            server: "workspace",
            input: { title: "Look around" },
          }),
          toolCall("tab", "t1", {
            tool: "mcp__workspace__read_tab",
            server: "workspace",
          }),
          toolCall("close", "t1", { tool: "close_questions" }),
          toolCall("issue", "t1", {
            tool: "mcp__linear__create_issue",
            server: "linear",
          }),
          toolCall("prs", "t1", {
            tool: "mcp__workspace__set_session_metadata",
            server: "workspace",
            input: { key: "pull_requests", value: [] },
          }),
          toolCall("meta", "t1", {
            tool: "set_session_metadata",
            input: { key: "deploy.preview", remove: true },
          }),
          // Without a value or remove: true the call only reads.
          toolCall("read-prs", "t1", {
            tool: "mcp__workspace__set_session_metadata",
            server: "workspace",
            input: { key: "pull_requests" },
          }),
          toolCall("read-meta", "t1", {
            tool: "set_session_metadata",
            input: { key: "deploy.preview" },
          }),
          reply("a1", "t1", "Done."),
        ],
      }),
    });
    await openSteps();
    expect(stepLabels()).toEqual([
      "Read a tab",
      "Closed its questions",
      "create_issue (linear)",
      "Updated pull requests",
      "Updated session details",
      "Checked pull requests",
      "Read session details",
    ]);
  });

  it("lets the agent's own words lead a tool's step", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Look"),
          toolCall("r1", "t1", {
            tool: "Read",
            description: "Read the parser",
          }),
          reply("a1", "t1", "Done."),
        ],
      }),
    });
    expect(stepLabels()).toEqual(["Read the parser"]);
  });

  it("says a failed command's exit code and marks the step failed", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Test it"),
          command("c1", "t1", {
            command: "bun test",
            output: "1 failing",
            exitCode: 2,
            status: "failed",
          }),
          reply("a1", "t1", "One test fails."),
        ],
      }),
    });
    const step = $('[data-testid="chat-step"]');
    expect(step?.getAttribute("data-step-status")).toBe("failed");
    expect(step?.querySelector("button")?.textContent).toBe("$ bun testFailed");
    await act(async () => step?.querySelector("button")?.click());
    expect($('[data-testid="chat-step-detail"]')?.textContent).toBe(
      "1 failing\n\nExit code 2",
    );
  });

  it("names both sides of a rename", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Rename it"),
          fileChange("f1", "t1", "src/new.ts", {
            change: "renamed",
            previousPath: "src/old.ts",
          }),
          reply("a1", "t1", "Renamed."),
        ],
      }),
    });
    expect(stepLabels()).toEqual(["Renamed src/old.ts to src/new.ts"]);
  });

  it("routes links in a folded note through the host", async () => {
    const opened = vi.fn();
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Read the spec"),
          command("c1", "t1"),
          reply("n1", "t1", "Reading it.\n\nSee [the spec](file:spec.md)."),
          command("c2", "t1"),
          reply("a1", "t1", "Done."),
        ],
      }),
      onLinkClick: opened,
    });
    await openSteps();
    const note = $('[data-step-kind="note"] button');
    await act(async () => note?.click());
    const link = $<HTMLAnchorElement>(
      '[data-step-kind="note"] [data-testid="chat-step-detail"] a',
    );
    expect(link?.getAttribute("href")).toBe("file:spec.md");
    await act(async () => link?.click());
    expect(opened).toHaveBeenCalledWith(
      "file:spec.md",
      expect.objectContaining({ metaKey: false }),
    );
  });

  it("keeps calling the latest callbacks after a re-render with the same items", async () => {
    const timeline = timelineOf({
      turns: [turn("t1", 1)],
      items: [
        input("t1", "Change it"),
        fileChange("f1", "t1", "src/a.ts"),
        reply("a1", "t1", "Changed."),
      ],
    });
    const first = { fork: vi.fn(), file: vi.fn(), rollback: vi.fn() };
    const second = {
      fork: vi.fn(),
      file: vi.fn(),
      rollback: vi.fn(() => true),
    };
    const props = (handlers: typeof first): ChatTimelineProps => ({
      timeline,
      onFork: handlers.fork,
      onFileClick: handlers.file,
      onRollback: handlers.rollback,
    });
    await render(props(first));
    const fork = $('[data-testid="chat-fork"]');
    await render(props(second));
    // The same nodes: the rows did not re-render, yet act on the latest.
    expect($('[data-testid="chat-fork"]')).toBe(fork);
    await click('[data-testid="chat-fork"]');
    await click('[data-step-kind="file_edit"] button');
    await click('[data-testid="chat-restore"]');
    await click('[data-testid="chat-restore-confirm-button"]');
    expect(first.fork).not.toHaveBeenCalled();
    expect(first.file).not.toHaveBeenCalled();
    expect(first.rollback).not.toHaveBeenCalled();
    expect(second.fork).toHaveBeenCalledWith("a1");
    expect(second.file).toHaveBeenCalledWith(
      "src/a.ts",
      expect.objectContaining({ metaKey: false }),
    );
    expect(second.rollback).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ id: "t1:input" }),
    );
  });

  it("shows a host input that arrives after the rows rendered", async () => {
    const timeline = timelineOf({
      turns: [turn("t1", 1)],
      items: [
        input("t1", "File it"),
        toolCall("issue", "t1", {
          tool: "mcp__linear__create_issue",
          server: "linear",
        }),
        reply("a1", "t1", "Filed."),
      ],
    });
    await render({ timeline });
    expect($('[data-testid="chat-step"] img')).toBeNull();
    // Connector icons load after the chat: settled replies still show them.
    const resolveToolIcon = (name: string) =>
      name === "linear/create_issue" ? "linear.svg" : undefined;
    await render({ timeline, resolveToolIcon });
    expect($('[data-testid="chat-step"] img')?.getAttribute("src")).toBe(
      "linear.svg",
    );
  });

  it("focuses and outlines an inbound message a deep link names", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    try {
      await render({
        timeline: timelineOf({
          turns: [turn("t1", 1, { inputItemId: "m1" })],
          items: [
            inbound("m1", "t1", "Review PR #12\nIt touches billing."),
            reply("r1", "t1", "Reviewed."),
          ],
        }),
        focusMessageId: "m1",
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      const row = $('[data-testid="chat-inbound-message"]');
      expect(row?.getAttribute("data-message-id")).toBe("m1");
      expect(document.activeElement).toBe(row);
      expect(row?.className).toContain("outline-accent");
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });

  it("is not empty while something waits in the queue", async () => {
    await render({
      timeline: [],
      emptyState: "Nothing yet",
      queue: [
        {
          turn: turn("q1", 1, { status: "queued", attemptCount: 0 }),
          item: input("q1", "later"),
          joined: [],
        },
      ],
    });
    expect(container.textContent).not.toContain("Nothing yet");
  });

  it("draws attachments as pills, in the words and in a strip", async () => {
    const paste: AgentAttachment = {
      kind: "text",
      name: "error.log",
      text: "boom",
      source: { type: "paste" },
    };
    const image: AgentAttachment = {
      kind: "image",
      name: "screen.png",
      mediaType: "image/png",
      dataBase64: "AAAA",
    };
    const items: Item[] = [
      input("t1", `See ${ATTACHMENT_MARKER} here`, {
        attachments: [paste, image],
      }),
      reply("a1", "t1", "Seen."),
    ];
    const timeline = timelineOf({ turns: [turn("t1", 1)], items });
    await render({ timeline });
    const message = $("[data-user-message]");
    const pills = [
      ...(message?.querySelectorAll('[data-testid="sent-pill"]') ?? []),
    ];
    expect(pills.map((pill) => pill.getAttribute("data-pill-kind"))).toEqual([
      "image",
      "paste",
    ]);
    expect(pills[0]?.querySelector("img")).not.toBeNull();
    // The strip, the words, then the time it was sent beside them.
    expect(message?.textContent).toBe(
      `screen.pngSee error.log here${message?.querySelector("time")?.textContent}`,
    );

    const places: string[] = [];
    await render({
      timeline,
      renderAttachment: (attachment, place) => {
        places.push(`${attachment.name}:${place}`);
        return <b data-testid="host-pill">{attachment.name}</b>;
      },
    });
    expect($$('[data-testid="host-pill"]')).toHaveLength(2);
    expect(places).toEqual(
      expect.arrayContaining(["screen.png:strip", "error.log:inline"]),
    );
  });

  it("names its controls through the host's hint", async () => {
    const hints: Array<{ label: string; shortcut?: string }> = [];
    function Hint({
      label,
      shortcut,
      children,
    }: {
      label: string;
      shortcut?: string;
      children: ReactNode;
    }) {
      hints.push({ label, shortcut });
      return <span data-hint={label}>{children}</span>;
    }
    const register = vi.fn();
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [input("t1", "hello"), reply("a1", "t1", "Done.")],
      }),
      Hint,
      onFork: () => undefined,
      onRollback: () => true,
      registerJumpToPreviousUserMessage: register,
    });
    expect(hints.map((hint) => hint.label)).toEqual(
      expect.arrayContaining([
        "Copy response",
        "Fork the chat from here",
        "Restore to here: undo this message and everything after it",
      ]),
    );
    expect(register).toHaveBeenCalledWith(expect.any(Function));
  });
});
