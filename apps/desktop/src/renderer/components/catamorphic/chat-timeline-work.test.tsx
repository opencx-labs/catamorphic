// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline, type ChatTimelineMessage } from "./chat-timeline.js";

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
