// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatTimeline,
  type ChatTimelineMessage,
  toTimeline,
} from "./chat-timeline.js";

const note = (id: string, content: string, tools = 1): ChatTimelineMessage =>
  ({
    id,
    role: "assistant",
    content,
    metadata: {
      status: "completed",
      events: Array.from({ length: tools }, () => ({
        type: "command",
        content: `run-${id}`,
      })),
    },
  }) as ChatTimelineMessage;
const messages = [
  { id: "u1", role: "user", content: "Do the thing" } as ChatTimelineMessage,
  note("a1", "Looking at the code."),
  note("a2", "Found it.\n\nThe bug is in the parser."),
  note("a3", "All fixed."),
];

describe("ChatTimeline work display", () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(async () => {});

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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
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

  const articles = () =>
    [...container.querySelectorAll("article")].map(
      (article) =>
        article.querySelector(".cat-markdown:not([data-testid])")?.textContent,
    );

  it("shows only the answer by default, with the notes under its steps", async () => {
    await act(async () => root.render(<ChatTimeline messages={messages} />));
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(articles().at(-1)).toBe("All fixed.");
    expect(container.querySelectorAll('[data-step-kind="note"]')).toHaveLength(
      2,
    );
  });

  it("keeps every note in place when asked to", async () => {
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={messages}
          workDisplay={{ live: "all", settled: "keep" }}
        />,
      ),
    );
    expect(container.querySelectorAll("article")).toHaveLength(4);
    expect(container.querySelectorAll('[data-step-kind="note"]')).toHaveLength(
      0,
    );
  });

  it("folds notes into the answer's steps, in order, once settled", async () => {
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={messages}
          workDisplay={{ live: "all", settled: "collapse" }}
        />,
      ),
    );
    // The user message and the answer; the notes are steps now.
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(articles().at(-1)).toBe("All fixed.");
    expect(
      [...container.querySelectorAll('[data-testid="chat-step"]')].map((step) =>
        step.getAttribute("data-step-kind"),
      ),
    ).toEqual(["command", "note", "command", "note", "command"]);
    expect(
      container.querySelector('[data-testid="chat-turn-steps-toggle"]')
        ?.textContent,
    ).toBe("5 steps");
    // Folded notes stay addressable by message id (focus, deep links).
    expect(
      container.querySelector('[data-step-kind="note"][data-message-id="a2"]'),
    ).not.toBeNull();
  });

  it("shows only the latest note while the turn runs", async () => {
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={messages}
          working
          workDisplay={{ live: "latest", settled: "keep" }}
        />,
      ),
    );
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(articles().at(-1)).toBe("All fixed.");
    // Settled with "keep": every note returns to its place.
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={messages}
          working={false}
          workDisplay={{ live: "latest", settled: "keep" }}
        />,
      ),
    );
    expect(container.querySelectorAll("article")).toHaveLength(4);
  });

  const running = (
    id: string,
    events: Record<string, unknown>[],
  ): ChatTimelineMessage =>
    ({
      id,
      role: "assistant",
      content: "Running tests",
      metadata: { status: "in_progress", events },
    }) as ChatTimelineMessage;
  const toggles = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-turn-steps-toggle"]',
      ),
    ].map((toggle) => toggle.getAttribute("aria-expanded"));

  it("streams the work open while the turn runs, then folds it away", async () => {
    const now = Date.now();
    const live = [
      ...messages.slice(0, 3),
      running("p", [
        {
          type: "command",
          content: "bun test",
          toolUseId: "t1",
          at: now - 5000,
          endedAt: now - 1000,
        },
        {
          type: "command",
          content: "bun run lint",
          toolUseId: "t2",
          at: now - 3000,
        },
      ]),
    ];
    await act(async () =>
      root.render(
        <ChatTimeline messages={live} working activity="Running tests" />,
      ),
    );
    // Every note stays in place, each with its steps open, and the steps
    // since the latest note follow them with no prose of their own.
    expect(articles().filter(Boolean)).toEqual([
      "Looking at the code.",
      "Found it.\nThe bug is in the parser.",
    ]);
    expect(toggles()).toEqual(["true"]);
    const liveWork = container.querySelector("[data-live-work]");
    expect(liveWork?.textContent).not.toContain("Running tests");
    expect(
      [...(liveWork?.querySelectorAll('[data-testid="chat-step"]') ?? [])].map(
        (step) => [step.textContent, step.hasAttribute("data-running")],
      ),
    ).toEqual([
      ["$ bun test4s", false],
      ["$ bun run lint3s", true],
    ]);
    expect(liveWork?.querySelector("[data-testid=chat-copy]")).toBeNull();

    // Settled: the work folds under the answer, closed.
    await act(async () => root.render(<ChatTimeline messages={messages} />));
    expect(toggles()).toEqual(["false"]);
  });

  it("keeps the reader's choice to close the work while it runs", async () => {
    const live = [
      ...messages.slice(0, 2),
      running("p", [
        { type: "command", content: "one", at: Date.now() },
        { type: "command", content: "two", at: Date.now() },
      ]),
    ];
    await act(async () =>
      root.render(<ChatTimeline messages={live} working activity="Working" />),
    );
    expect(toggles()).toEqual(["true"]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          "[data-live-work] [data-testid=chat-turn-steps-toggle]",
        )
        ?.click(),
    );
    const more = [
      ...live.slice(0, 2),
      running("p", [
        { type: "command", content: "one", at: Date.now() },
        { type: "command", content: "two", at: Date.now() },
        { type: "command", content: "three", at: Date.now() },
      ]),
    ];
    await act(async () =>
      root.render(<ChatTimeline messages={more} working activity="Working" />),
    );
    expect(toggles()).toEqual(["false"]);
  });

  it("hides an in-progress message until it has steps", () => {
    const persisted = (steps: Record<string, unknown>[]) =>
      [running("p", steps)] as unknown as Parameters<typeof toTimeline>[0];
    expect(toTimeline(persisted([]), [], "Thinking...").messages).toEqual([]);
    expect(
      toTimeline(
        persisted([{ type: "command", content: "ls" }]),
        [],
        "Working",
      ).messages.map((message) => message.id),
    ).toEqual(["p"]);
  });

  it("shows a lone step as its own row, with how long it took", async () => {
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={[
            messages[0] as ChatTimelineMessage,
            {
              id: "a1",
              role: "assistant",
              content: "Done.",
              metadata: {
                status: "completed",
                changedFiles: [],
                events: [
                  {
                    type: "command",
                    content: "bun test",
                    at: 1000,
                    endedAt: 48_500,
                    status: "ended",
                  },
                ],
              },
            } as ChatTimelineMessage,
          ]}
        />,
      ),
    );
    expect(toggles()).toEqual([]);
    expect(
      container.querySelector('[data-testid="chat-step-duration"]')
        ?.textContent,
    ).toBe("47s");
  });

  it("counts the turn's time and says when it has gone quiet", async () => {
    const now = Date.now();
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={[messages[0] as ChatTimelineMessage]}
          working
          activity="Running tests"
          activityStartedAt={new Date(now - 134_000).toISOString()}
          activityUpdatedAt={new Date(now - 10_000).toISOString()}
        />,
      ),
    );
    const elapsed = () =>
      container.querySelector('[data-testid="chat-activity-elapsed"]')
        ?.textContent;
    const stalled = () =>
      container.querySelector('[data-testid="chat-activity-stalled"]');
    expect(elapsed()).toBe("2m 14s");
    expect(stalled()).toBeNull();
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={[messages[0] as ChatTimelineMessage]}
          working
          activity="Running tests"
          activityStartedAt={new Date(now - 134_000).toISOString()}
          activityUpdatedAt={new Date(now - 45_000).toISOString()}
        />,
      ),
    );
    expect(stalled()?.textContent).toBe("No updates for 45s");
  });

  it("says what an interruption stopped and what it left changed", async () => {
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={[
            messages[0] as ChatTimelineMessage,
            {
              id: "a1",
              role: "assistant",
              content: "Interrupted.",
              metadata: {
                status: "failed",
                interrupted: true,
                changedFiles: [
                  { path: "src/parser.ts", kind: "modified" },
                  { path: "src/lexer.ts", kind: "modified" },
                ],
                events: [
                  { type: "file_edit", filePath: "src/parser.ts", at: 1000 },
                  {
                    type: "command",
                    content: "bun test",
                    description: "Run the tests",
                    toolUseId: "t1",
                    at: 2000,
                  },
                  { type: "error", content: "Interrupted.", at: 74_000 },
                ],
              },
            } as ChatTimelineMessage,
          ]}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="chat-interrupted-step"]')
        ?.textContent,
    ).toBe("While: Run the tests (1m 12s)");
    expect(
      container.querySelector('[data-testid="chat-interrupted-files"]')
        ?.textContent,
    ).toBe("Left 2 changed files: parser.ts, lexer.ts");
    // The work it did stays readable.
    expect(
      container.querySelectorAll('[data-testid="chat-step"]'),
    ).toHaveLength(2);
  });

  it("keeps steps out of text selection and copies the reply's Markdown", async () => {
    await act(async () =>
      root.render(
        <ChatTimeline
          messages={messages}
          workDisplay={{ live: "all", settled: "keep" }}
        />,
      ),
    );
    for (const steps of container.querySelectorAll(
      '[data-testid="chat-turn-steps"]',
    ))
      expect(steps.className).toContain("select-none");
    const copy = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-copy"]',
      ),
    ];
    expect(copy).toHaveLength(3);
    await act(async () => copy[1]?.click());
    expect(writeText).toHaveBeenCalledWith(
      "Found it.\n\nThe bug is in the parser.",
    );
  });
});
