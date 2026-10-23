// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainLine } from "./chat-steps.js";
import { ChatTimeline } from "./chat-timeline.js";
import {
  inbound,
  input,
  notification,
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

  it("folds repeated agent reports into one expandable activity with its harness mark", async () => {
    const from = {
      kind: "agent" as const,
      sessionId: "child",
      agentId: "reviewer",
    };
    const turns = timelineOf({
      turns: [turn("t1", 1)],
      items: [
        input("t1", "Review the change"),
        inbound("p1", "t1", "First check passed", { from, dispatch: "steer" }),
        toolCall("read", "t1"),
        inbound("p2", "t1", "Second check passed", { from, dispatch: "steer" }),
        inbound("attention", "t1", "Which release?", {
          from,
          dispatch: "steer",
          attention: "required",
        }),
        reply("done", "t1", "Waiting for your choice"),
      ],
    });
    await act(async () =>
      root.render(
        <ChatTimeline
          timeline={turns}
          resolveAgentName={() => "Reviewer"}
          renderAgentIcon={(id) => <span data-agent-mark={id}>C</span>}
        />,
      ),
    );
    const reports = container.querySelectorAll('[data-step-kind="agent"]');
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.textContent).toContain("Reviewer · 2 updates");
    expect(
      report?.querySelector('[data-agent-mark="reviewer"]'),
    ).not.toBeNull();
    const toggle = report?.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(
      report?.querySelector('[data-testid="chat-step-detail"]')?.textContent,
    ).toBe("First check passed\n\nSecond check passed");
    expect(report?.querySelector("a")?.getAttribute("href")).toBe(
      "session:child",
    );
    const visible = container.querySelectorAll(
      '[data-testid="chat-inbound-message"]',
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.textContent).toContain("Which release?");
    expect(visible[0]?.textContent).toContain("Attention requested");
    await act(async () => toggle?.click());
    await act(async () =>
      root.render(<ChatTimeline timeline={turns} focusMessageId="p2" />),
    );
    const linked = container.querySelector('[data-message-id="p2"]');
    expect(linked?.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(linked?.textContent).toContain("Second check passed");
  });

  it("keeps the edit held when focus is lost without a destination", async () => {
    const holds: Array<string | null> = [];
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          queue={[
            {
              turn: turn("queued-1", 2, { status: "queued", attemptCount: 0 }),
              item: input("queued-1", "wrong words"),
              joined: [],
            },
          ]}
          onEditQueued={() => true}
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

  it("keeps each attachment where it sits through an edit, and an unchanged edit edits nothing", async () => {
    const marker = "\uFFFC";
    const attachment = (name: string) => ({
      kind: "text" as const,
      name,
      text: name,
      source: { type: "paste" as const },
    });
    const edits: string[] = [];
    const holds: Array<string | null> = [];
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          queue={[
            {
              turn: turn("queued-2", 2, { status: "queued", attemptCount: 0 }),
              item: input("queued-2", `${marker} compare with ${marker}`, {
                attachments: [attachment("a.ts"), attachment("b.ts")],
              }),
              joined: [],
            },
          ]}
          onEditQueued={(_turnId, text) => {
            edits.push(text);
            return true;
          }}
          onHoldQueued={(id) => {
            holds.push(id);
          }}
        />,
      );
    });
    const openEditor = async () => {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Edit queued message"]',
          )
          ?.click(),
      );
      return container.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-queued-edit"]',
      );
    };
    const press = (editor: HTMLTextAreaElement | null) =>
      act(async () => {
        editor?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
    // The draft names each attachment where it sits.
    const editor = await openEditor();
    expect(editor?.value).toBe("[a.ts] compare with [b.ts]");
    // Saved unchanged, it only lets the turn go.
    await press(editor);
    expect(edits).toEqual([]);
    expect(holds).toEqual(["queued-2", null]);
    // Edited, each attachment keeps its place in the words.
    const again = await openEditor();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(again, "[a.ts] differs from [b.ts] here");
      again?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(again);
    expect(edits).toEqual([`${marker} differs from ${marker} here`]);
  });

  it("renders desktop todo tools as readable progress instead of JSON", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={timelineOf({
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
          timeline={timelineOf({
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
          timeline={[]}
          queue={[
            {
              turn: turn("held-1", 2, { status: "held", attemptCount: 0 }),
              item: input("held-1", "being edited elsewhere"),
              joined: [],
            },
            {
              turn: turn("queued-2", 3, { status: "queued", attemptCount: 0 }),
              item: input("queued-2", "after it"),
              joined: [],
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
          timeline={timelineOf({
            turns: [
              turn("t1", 1, {
                status: "queued",
                retryAt: new Date(Date.now() + 30_000).toISOString(),
                error: { message: "Rate limited" },
              }),
            ],
            items: [input("t1", "first")],
          })}
          onInterrupt={stopped}
        />,
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-stop-retrying"]')
        ?.click(),
    );
    expect(stopped).toHaveBeenCalledWith("t1");
  });

  it("withdraws the message about to start", async () => {
    const cancelled = vi.fn(() => true);
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={timelineOf({
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

describe("ChatTimeline inputs that are not the person's (ADR 0217)", () => {
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

  it("reads them as rows, never as the person's bubble, each opening to its source", async () => {
    const opened: string[] = [];
    const notified = notification(
      "n1",
      "t1",
      "Start the worker failed (exit 1)",
      {
        task: {
          type: "background_command",
          id: "cmd-1",
          title: "Start the worker",
          status: "failed",
        },
      },
    );
    const turns = timelineOf({
      turns: [
        turn("t1", 1, { inputItemId: "n1" }),
        turn("t2", 2, { inputItemId: "m1" }),
      ],
      items: [
        notified,
        reply("r1", "t1", "The worker needs a Node runtime."),
        inbound("m1", "t2", "Review PR #12\nIt touches billing."),
        reply("r2", "t2", "Reviewed."),
      ],
    });
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={turns}
          onLinkClick={(url) => {
            opened.push(url);
          }}
        />,
      );
    });
    expect(container.querySelector("[data-user-message]")).toBeNull();
    const row = container.querySelector("[data-testid=chat-task-notification]");
    expect(row?.getAttribute("data-task-status")).toBe("failed");
    expect(row?.textContent).toContain("Start the worker failed (exit 1)");
    await act(async () => row?.querySelector("button")?.click());
    await act(async () => row?.querySelector("a")?.click());
    expect(opened).toEqual(["terminal:worker"]);
    const message = container.querySelector(
      "[data-testid=chat-inbound-message]",
    );
    expect(message?.getAttribute("data-sender-kind")).toBe("workflow");
    expect(message?.textContent).toContain("Pr review");
    expect(message?.textContent).toContain("Review PR #12");
  });

  it("folds a notification that reached the working turn into its steps", async () => {
    const turns = timelineOf({
      turns: [turn("t1", 1)],
      items: [
        input("t1", "Start the worker and fix what breaks"),
        toolCall("c1", "t1"),
        notification(
          "n1",
          "t1",
          "Start the worker printed what you were waiting for",
          {
            dispatch: "steer",
          },
        ),
        reply("r1", "t1", "Fixed the debugger flag."),
      ],
    });
    await act(async () => {
      root.render(<ChatTimeline timeline={turns} />);
    });
    expect(
      container.querySelector("[data-testid=chat-task-notification]"),
    ).toBeNull();
    const step = container.querySelector('[data-step-kind="notification"]');
    expect(step?.textContent).toContain(
      "Start the worker printed what you were waiting for",
    );
  });

  it("queues them as one line that cannot be edited", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          queue={[
            {
              turn: turn("q1", 2, {
                status: "queued",
                attemptCount: 0,
                inputItemId: "n1",
              }),
              item: notification(
                "n1",
                "q1",
                "Start the worker printed what you were waiting for",
              ),
              joined: [notification("n2", "q1", "Start the worker finished")],
            },
          ]}
          onEditQueued={() => true}
          onCancelQueued={() => true}
        />,
      );
    });
    const queued = container.querySelector("[data-testid=chat-queued-input]");
    expect(queued?.textContent).toContain(
      "Start the worker printed what you were waiting for",
    );
    expect(queued?.textContent).toContain("and 1 more");
    expect(
      container.querySelector('[aria-label="Edit queued message"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Remove from queue"]'),
    ).not.toBeNull();
  });
});

describe("ChatTimeline queue sending", () => {
  let container: HTMLDivElement;
  let root: Root;
  const queuedOne = () => ({
    turn: turn("queued-1", 2, { status: "queued" as const, attemptCount: 0 }),
    item: input("queued-1", "urgent now"),
    joined: [],
  });

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
    vi.restoreAllMocks();
    // A test's motion stub ends with it, even when it fails.
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("shows its controls to the left of its state, at the bubble's right edge", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          queue={[queuedOne()]}
          onEditQueued={() => true}
          onCancelQueued={() => true}
          onSendQueuedNow={() => true}
        />,
      );
    });
    const state = container.querySelector('[data-testid="chat-queued-state"]');
    const footer = state?.parentElement;
    expect(state?.textContent).toBe("Queued");
    expect(footer?.lastElementChild).toBe(state);
    expect(footer?.className).toContain("justify-end");
    for (const label of [
      "Edit queued message",
      "Delete queued message",
      "Send queued message now",
    ]) {
      const button = container.querySelector(`[aria-label="${label}"]`);
      expect(
        button &&
          state &&
          button.compareDocumentPosition(state) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Its colour and ground ease in under the pointer.
      expect(button?.className).toContain("transition-[color,background-color");
      expect(button?.className).toMatch(/hover:bg-/);
    }
  });

  it("looks sent while sending, and queued again when the send fails", async () => {
    let finish: (sent: boolean) => void = () => undefined;
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          queue={[queuedOne()]}
          onSendQueuedNow={() =>
            new Promise<boolean>((resolve) => {
              finish = resolve;
            })
          }
        />,
      );
    });
    const bubble = () =>
      container.querySelector<HTMLElement>(
        '[data-testid="chat-queued-message"]',
      );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Send queued message now"]',
        )
        ?.click(),
    );
    expect(bubble()?.dataset.sending).toBe("true");
    expect(bubble()?.textContent).toContain("Sending");
    expect(bubble()?.firstElementChild?.className).not.toContain(
      "border-dashed",
    );
    await act(async () => finish(false));
    expect(bubble()?.dataset.sending).toBeUndefined();
    expect(bubble()?.textContent).toContain("Queued");
  });

  it("hands its place to its message when its turn starts", async () => {
    const at = (top: number) => ({
      top,
      bottom: top + 40,
      left: 100,
      right: 400,
      width: 300,
      height: 40,
      x: 100,
      y: top,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        // The bubble sits lower than where its message lands.
        return this.closest('[data-testid="chat-queued-message"]')
          ? at(500)
          : at(300);
      },
    );
    const animate = vi.fn();
    Reflect.set(HTMLElement.prototype, "animate", animate);
    await act(async () => {
      root.render(
        <ChatTimeline timeline={[]} activity="Working" queue={[queuedOne()]} />,
      );
    });
    // Its turn starts: it leaves the queue and its message joins the log.
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={timelineOf({
            turns: [turn("queued-1", 2, { status: "running" })],
            items: [input("queued-1", "urgent now")],
          })}
          activity="Working"
          queue={[]}
        />,
      );
    });
    const message = container.querySelector("[data-user-message]");
    // Already shown, not rising in anew.
    expect(message?.className).not.toContain("opacity-0");
    expect(message?.className).not.toContain("translate-y-1");
    expect(animate).toHaveBeenCalledWith(
      [{ translate: "0px 200px" }, { translate: "0px 0px" }],
      expect.objectContaining({ duration: 250 }),
    );
  });

  it("waits looking sent, with nothing to edit, when it interrupts (⌘↵)", async () => {
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          queue={[
            {
              ...queuedOne(),
              turn: turn("queued-1", 2, {
                status: "queued",
                attemptCount: 0,
                dispatch: "interrupt",
              }),
            },
          ]}
          onEditQueued={() => true}
          onSendQueuedNow={() => true}
          onCancelQueued={() => true}
        />,
      );
    });
    const bubble = container.querySelector<HTMLElement>(
      '[data-testid="chat-queued-message"]',
    );
    expect(bubble?.dataset.sending).toBe("true");
    expect(
      bubble?.querySelector('[data-testid="chat-queued-state"]')?.textContent,
    ).toBe("Sending");
    expect(
      container.querySelector('[aria-label="Edit queued message"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Send queued message now"]'),
    ).toBeNull();
    // The agent may be slow to stop: until it does, the message can still
    // be withdrawn.
    expect(
      container.querySelector('[aria-label="Delete queued message"]'),
    ).not.toBeNull();
  });

  it("takes over from its pending bubble when it waits behind the running turn", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        // The pending bubble sat higher than where the queue shows it.
        const top = this.closest('[data-testid="chat-queued-message"]')
          ? 520
          : 480;
        return {
          top,
          bottom: top + 40,
          left: 100,
          right: 400,
          width: 300,
          height: 40,
          x: 100,
          y: top,
          toJSON: () => ({}),
        };
      },
    );
    const animate = vi.fn();
    Reflect.set(HTMLElement.prototype, "animate", animate);
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          pending={[
            {
              commandId: "c1",
              text: "urgent now",
              attachments: [],
              dispatch: "interrupt",
              status: "sending",
            },
          ]}
        />,
      );
    });
    // The server holds it as an interrupting turn waiting for the agent;
    // the send is still pending here when the queue first shows it.
    await act(async () => {
      root.render(
        <ChatTimeline
          timeline={[]}
          activity="Working"
          pending={[
            {
              commandId: "c1",
              text: "urgent now",
              attachments: [],
              dispatch: "interrupt",
              status: "sent",
            },
          ]}
          queue={[
            {
              turn: turn("queued-1", 2, {
                status: "queued",
                attemptCount: 0,
                dispatch: "interrupt",
              }),
              item: input("queued-1", "urgent now", {
                idempotencyKey: "user:s:c1",
              }),
              joined: [],
            },
          ]}
        />,
      );
    });
    const bubble = container.querySelector(
      '[data-testid="chat-queued-message"]',
    );
    // One bubble for the message: the pending one gave way in that render.
    expect(container.querySelectorAll("[data-pending-message]")).toHaveLength(
      0,
    );
    // Already shown, no entrance of its own.
    expect(bubble?.className).toContain("opacity-100");
    expect(bubble?.className).not.toContain("transition-[opacity");
    expect(animate).toHaveBeenCalledWith(
      [{ translate: "0px -40px" }, { translate: "0px 0px" }],
      expect.objectContaining({ duration: 250 }),
    );
  });
});
