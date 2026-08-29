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
});
