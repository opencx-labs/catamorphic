// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "./chat-timeline.js";

describe("ChatTimeline queue editing", () => {
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

  it("keeps the edit held when focus is lost without a destination", async () => {
    const holds: Array<string | null> = [];
    await act(async () => {
      root.render(
        <ChatTimeline
          messages={[]}
          activity="Working"
          queue={[
            {
              id: "queued-1",
              content: "wrong words",
              attachments: [],
            },
          ]}
          onHoldQueued={(id) => holds.push(id)}
        />,
      );
    });
    const editButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]',
    );
    await act(async () => editButton?.click());
    const editor = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-queued-edit"]',
    );
    expect(editor).not.toBeNull();
    expect(holds).toEqual(["queued-1"]);

    await act(async () => {
      editor?.dispatchEvent(
        new FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });

    expect(container.querySelector('[data-testid="chat-queued-edit"]')).toBe(
      editor,
    );
    expect(holds).toEqual(["queued-1"]);
  });

  it("keeps partial prose separate from a failed turn's recovery card", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          messages={[
            {
              id: "user-1",
              role: "user",
              content: "Finish the task.",
            },
            {
              id: "failed-1",
              role: "assistant",
              content: "Provider connection closed",
              metadata: {
                status: "failed",
                partialContent: "I finished the useful part.",
              },
            },
          ]}
          activity=""
          onRetry={() => undefined}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="chat-partial-response"]')
        ?.textContent,
    ).toContain("I finished the useful part.");
    const errorCard = container.querySelector(
      '[data-testid="chat-error-card"]',
    );
    expect(errorCard?.textContent).toContain("Provider connection closed");
    expect(errorCard?.textContent).not.toContain("I finished the useful part.");
    expect(
      container.querySelector('[data-testid="chat-retry"]'),
    ).not.toBeNull();
  });

  it("renders desktop todo tools as readable progress instead of JSON", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          messages={[
            {
              id: "assistant-1",
              role: "assistant",
              content: "I updated the plan.",
              metadata: {
                events: [
                  {
                    type: "tool_call",
                    toolName: "update_todo_list",
                    toolInput: {
                      items: [
                        {
                          title: "Inspect the project",
                          description: "Find the right extension points.",
                          status: "completed",
                        },
                        {
                          title: "Verify the result",
                          description: "Run the focused checks.",
                          status: "in_progress",
                        },
                      ],
                    },
                    toolResult: { completed: 1, total: 2 },
                  },
                ],
              },
            },
          ]}
        />,
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-turn-steps-toggle"]',
        )
        ?.click();
    });
    const step = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-step"] button',
    );
    expect(step?.textContent).toContain("Updated the todo list");
    await act(async () => step?.click());
    const detail = container.querySelector('[data-testid="chat-step-detail"]');
    expect(detail?.textContent).toContain("✓ Inspect the project");
    expect(detail?.textContent).toContain("● Verify the result");
    expect(detail?.textContent).toContain("1 of 2 complete");
    expect(detail?.textContent).not.toContain('"items"');
    expect(detail?.className).toContain("font-sans");
  });
});
