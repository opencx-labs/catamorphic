// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline, plainLine } from "./chat-timeline.js";
import {
  input,
  reply,
  timelineOf,
  toolCall,
  turn,
} from "./timeline-fixtures.js";

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
          turns={[]}
          activity="Working"
          queue={[
            {
              turn: turn("queued-1", 2, { status: "queued", attemptCount: 0 }),
              item: input("queued-1", "wrong words"),
            },
          ]}
          onHoldQueued={(id) => {
            holds.push(id);
          }}
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

  it("renders desktop todo tools as readable progress instead of JSON", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          turns={timelineOf({
            turns: [turn("t1", 1)],
            items: [
              input("t1", "Plan it"),
              toolCall("todo", "t1", {
                tool: "mcp__workspace__update_todo_list",
                server: "workspace",
                input: {
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
                result: { completed: 1, total: 2 },
              }),
              toolCall("other", "t1"),
              reply("a1", "t1", "I updated the plan."),
            ],
          })}
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
  it("preserves a focused resource link when the host refreshes chat callbacks", async () => {
    const opens = vi.fn();
    const render = (revision: number) =>
      root.render(
        <ChatTimeline
          turns={timelineOf({
            turns: [turn("t1", 1)],
            items: [
              input("t1", "Where is it?"),
              reply("reply", "t1", "[Source](file:source.ts)"),
            ],
          })}
          onLinkClick={(url) => opens(revision, url)}
          renderLink={({ href, children, onOpen }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                onOpen(href, event);
              }}
            >
              {children}
            </a>
          )}
        />,
      );
    await act(async () => render(1));
    const link = container.querySelector("a");
    if (!link) throw new Error("Missing link");
    link.focus();
    await act(async () => render(2));
    expect(container.querySelector("a")).toBe(link);
    expect(document.activeElement).toBe(link);
    await act(async () => link.click());
    expect(opens).toHaveBeenCalledWith(2, "file:source.ts");
  });

  it("says a held message is held, not queued", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          turns={[]}
          queue={[
            {
              turn: turn("held-1", 2, { status: "held", attemptCount: 0 }),
              item: input("held-1", "being edited elsewhere"),
            },
            {
              turn: turn("queued-2", 3, { status: "queued", attemptCount: 0 }),
              item: input("queued-2", "after it"),
            },
          ]}
        />,
      );
    });
    const labels = [
      ...container.querySelectorAll('[data-testid="chat-queued-message"]'),
    ].map((bubble) => bubble.textContent ?? "");
    expect(labels[0]).toContain("Held");
    expect(labels[1]).toContain("Queued");
  });

  it("stops the turn waiting to retry by name", async () => {
    const stopped = vi.fn();
    await act(async () => {
      root.render(
        <ChatTimeline
          turns={timelineOf({
            turns: [
              turn("t1", 1, {
                status: "queued",
                retryAt: new Date(Date.now() + 30_000).toISOString(),
                error: { message: "Rate limited" },
              }),
            ],
            items: [input("t1", "first")],
          })}
          onStopRetrying={stopped}
        />,
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="stop-retrying"]')
        ?.click(),
    );
    expect(stopped).toHaveBeenCalledWith("t1");
  });

  it("withdraws the message about to start", async () => {
    const cancelled = vi.fn(() => true);
    await act(async () => {
      root.render(
        <ChatTimeline
          turns={timelineOf({
            turns: [turn("t1", 1, { status: "queued", attemptCount: 0 })],
            items: [input("t1", "go")],
          })}
          activity="Waiting for agent"
          onCancelQueued={cancelled}
        />,
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-cancel-starting"]',
        )
        ?.click(),
    );
    expect(cancelled).toHaveBeenCalledWith("t1");
  });
});

describe("note step labels", () => {
  it("read as plain text, without markdown syntax", () => {
    expect(
      plainLine(
        "[text-pill selection sel.md:5-5] Second paragraph with **bold** words.",
      ),
    ).toBe(
      "[text-pill selection sel.md:5-5] Second paragraph with bold words.",
    );
    expect(plainLine("Ran `bun test` and read [the log](https://x.test)")).toBe(
      "Ran bun test and read the log",
    );
    expect(plainLine("An _emphasised_ word and snake_case_name stay")).toBe(
      "An emphasised word and snake_case_name stay",
    );
  });
});
