// @vitest-environment jsdom

import type { Item, Turn } from "@catamorphic/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline, type ChatTimelineProps } from "./chat-timeline.js";
import {
  command,
  fileChange,
  input,
  notice,
  reply,
  timelineOf,
  turn,
} from "./timeline-fixtures.js";

/** One turn: a question, three notes each after a command, the last the answer. */
const settledItems: Item[] = [
  input("t1", "Do the thing"),
  command("c1", "t1"),
  reply("a1", "t1", "Looking at the code."),
  command("c2", "t1"),
  reply("a2", "t1", "Found it.\n\nThe bug is in the parser."),
  command("c3", "t1"),
  reply("a3", "t1", "All fixed."),
];

function settled(overrides: Partial<Turn> = {}) {
  return timelineOf({ turns: [turn("t1", 1, overrides)], items: settledItems });
}

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

  const render = (props: ChatTimelineProps) =>
    act(async () => root.render(<ChatTimeline {...props} />));
  const articles = () =>
    [...container.querySelectorAll("article")].map(
      (article) =>
        article.querySelector(".cat-markdown:not([data-testid])")?.textContent,
    );
  const stepKinds = () =>
    [...container.querySelectorAll('[data-testid="chat-step"]')].map((step) =>
      step.getAttribute("data-step-kind"),
    );
  // A lone step keeps its toggle mounted but closed away and inert.
  const toggles = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-turn-steps-toggle"]',
      ),
    ]
      .filter((toggle) => !toggle.closest("[inert]"))
      .map((toggle) => toggle.getAttribute("aria-expanded"));

  it("reads a settled turn as the question and the answer, the notes under its steps", async () => {
    await render({ turns: settled() });
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(articles().at(-1)).toBe("All fixed.");
    expect(stepKinds()).toEqual([
      "command",
      "note",
      "command",
      "note",
      "command",
    ]);
    expect(
      container.querySelector('[data-testid="chat-turn-steps-toggle"]')
        ?.textContent,
    ).toBe("5 steps");
    // Folded notes stay addressable by item id (focus, deep links).
    expect(
      container.querySelector('[data-step-kind="note"][data-message-id="a2"]'),
    ).not.toBeNull();
  });

  it("keeps every note in place when asked to", async () => {
    await render({
      turns: settled(),
      workDisplay: { live: "all", settled: "keep" },
    });
    expect(container.querySelectorAll("article")).toHaveLength(4);
    expect(stepKinds()).not.toContain("note");
  });

  it("shows only the latest note while the turn runs, every note once it settles", async () => {
    const running = timelineOf({
      turns: [turn("t1", 1, { status: "running", completedAt: null })],
      items: settledItems,
    });
    await render({
      turns: running,
      activeTurnId: "t1",
      workDisplay: { live: "latest", settled: "keep" },
    });
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(articles().at(-1)).toBe("All fixed.");
    await render({
      turns: settled(),
      workDisplay: { live: "latest", settled: "keep" },
    });
    expect(container.querySelectorAll("article")).toHaveLength(4);
  });

  it("streams the work open while the turn runs, then folds it away", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const liveItems: Item[] = [
      ...settledItems.slice(0, 5),
      command("p1", "t1", {
        command: "bun test",
        startedAt: iso(now - 5000),
        endedAt: iso(now - 1000),
      }),
      command("p2", "t1", {
        command: "bun run lint",
        status: "in_progress",
        startedAt: iso(now - 3000),
        endedAt: null,
      }),
    ];
    await render({
      turns: timelineOf({
        turns: [turn("t1", 1, { status: "running", completedAt: null })],
        items: liveItems,
      }),
      activeTurnId: "t1",
      activity: "Running tests",
    });
    // Every note stays in place, and the work since the latest one
    // follows them, open, with no prose of its own.
    expect(articles().filter(Boolean)).toEqual([
      "Looking at the code.",
      "Found it.\nThe bug is in the parser.",
    ]);
    const liveWork = container.querySelector("[data-live-work]");
    expect(
      [...(liveWork?.querySelectorAll('[data-testid="chat-step"]') ?? [])].map(
        (step) => [step.textContent, step.hasAttribute("data-running")],
      ),
    ).toEqual([
      ["$ bun test4s", false],
      ["$ bun run lint3s", true],
    ]);
    expect(liveWork?.querySelector("[data-testid=chat-copy]")).toBeNull();
    const liveNode = liveWork;

    // The answer arrives after that work: the same node gains its prose.
    const answered: Item[] = [
      ...liveItems.slice(0, 6),
      { ...(liveItems[6] as Item), status: "completed" },
      reply("a3", "t1", "All fixed."),
    ];
    await render({
      turns: timelineOf({
        turns: [turn("t1", 1, { status: "running", completedAt: null })],
        items: answered,
      }),
      activeTurnId: "t1",
    });
    expect(container.querySelector('[data-message-id="a3"]')).toBe(liveNode);

    // Settled: the work folds under the answer, closed. The notes that were
    // in place close up on the way, then leave.
    await render({
      turns: timelineOf({ turns: [turn("t1", 1)], items: answered }),
    });
    expect(toggles()).toEqual(["false"]);
    expect(container.querySelectorAll(".animate-fold-away")).toHaveLength(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(container.querySelectorAll(".animate-fold-away")).toHaveLength(0);
    expect(container.querySelectorAll("article")).toHaveLength(2);
  });

  it("keeps the steps folded with Notes only, while the turn runs and after", async () => {
    const workDisplay = { live: "notes", settled: "collapse" } as const;
    await render({
      turns: timelineOf({
        turns: [turn("t1", 1, { status: "running", completedAt: null })],
        items: [...settledItems.slice(0, 5), command("c3", "t1")],
      }),
      activeTurnId: "t1",
      workDisplay,
    });
    // Every note in place, each one's steps behind a closed line, the
    // work since the latest note too: a lone step reads "1 step".
    expect(articles().filter(Boolean)).toEqual([
      "Looking at the code.",
      "Found it.\nThe bug is in the parser.",
    ]);
    expect(toggles()).toEqual(["false", "false", "false"]);
    expect(
      [
        ...container.querySelectorAll('[data-testid="chat-turn-steps-toggle"]'),
      ].map((toggle) => toggle.textContent),
    ).toEqual(["1 step", "1 step", "1 step"]);
    // Opening one by hand still works.
    const first = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-turn-steps-toggle"]',
    );
    await act(async () => first?.click());
    expect(toggles()).toEqual(["true", "false", "false"]);
    // Answered, the notes fold into the closed line above the answer.
    await render({ turns: settled(), workDisplay });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(toggles()).toEqual(["false"]);
  });

  it("shows a lone step as its own row, with how long it took", async () => {
    const start = Date.parse("2026-10-01T10:00:00.000Z");
    await render({
      turns: timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Run it"),
          command("c1", "t1", {
            command: "bun test",
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(start + 65_000).toISOString(),
          }),
          reply("a1", "t1", "Passed."),
        ],
      }),
    });
    expect(toggles()).toEqual([]);
    expect(
      container.querySelector('[data-testid="chat-step-duration"]')
        ?.textContent,
    ).toBe("1m 5s");
  });

  it("says what an interruption stopped and what it left changed", async () => {
    const start = Date.parse("2026-10-01T10:01:41.000Z");
    await render({
      turns: timelineOf({
        turns: [
          turn("t1", 1, {
            status: "interrupted",
            completedAt: new Date(start + 12_000).toISOString(),
            outcome: {
              changedFiles: [
                { path: "src/a.ts", kind: "modified" },
                { path: "src/b.ts", kind: "modified" },
              ],
            },
          }),
        ],
        items: [
          input("t1", "Fix it"),
          fileChange("f1", "t1", "src/a.ts"),
          command("c1", "t1", {
            command: "bun test",
            status: "cancelled",
            startedAt: new Date(start).toISOString(),
            endedAt: null,
          }),
        ],
      }),
      onRetry: () => {},
    });
    expect(
      container.querySelector('[data-testid="chat-interrupted-step"]')
        ?.textContent,
    ).toBe("While: $ bun test (12s)");
    expect(
      container.querySelector('[data-testid="chat-interrupted-files"]')
        ?.textContent,
    ).toBe("Left 2 changed files: a.ts, b.ts");
  });

  it("closes a failed turn with its error and Retry for that turn", async () => {
    const retried: string[] = [];
    await render({
      turns: timelineOf({
        turns: [
          turn("t1", 1, {
            status: "failed",
            error: { message: "Provider connection closed" },
          }),
        ],
        items: [
          input("t1", "Finish the task."),
          reply("a1", "t1", "I finished the useful part."),
        ],
      }),
      onRetry: (turnId) => retried.push(turnId),
    });
    const card = container.querySelector('[data-testid="chat-error-card"]');
    expect(card?.textContent).toContain("Provider connection closed");
    expect(card?.textContent).not.toContain("I finished the useful part.");
    expect(articles()).toContain("I finished the useful part.");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-retry"]')
        ?.click(),
    );
    expect(retried).toEqual(["t1"]);
  });

  it("offers Restore to here on a settled message, confirming first", async () => {
    const restored: string[] = [];
    await render({
      turns: settled(),
      onRollback: (turnId) => {
        restored.push(turnId);
        return true;
      },
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-restore"]')
        ?.click(),
    );
    expect(restored).toEqual([]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-restore-confirm-button"]',
        )
        ?.click(),
    );
    expect(restored).toEqual(["t1"]);
    // Not while something runs.
    await render({
      turns: settled(),
      activeTurnId: "t2",
      onRollback: () => true,
    });
    expect(container.querySelector('[data-testid="chat-restore"]')).toBeNull();
  });

  it("dims undone turns under a divider", async () => {
    await render({ turns: settled({ status: "rolled_back" }) });
    expect(
      container.querySelector('[data-testid="chat-undone-divider"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-turn-undone]")).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-restore"]')).toBeNull();
  });

  it("reads notices as calm dividers, naming a new agent", async () => {
    await render({
      turns: timelineOf({
        turns: [],
        items: [
          {
            ...notice("n1", "agent_changed", "Agent changed"),
            data: { agentId: "a" },
          } as Item,
          notice("n2", "session_fork", 'Forked from "Plan"'),
        ],
      }),
      resolveAgentName: (id) => (id === "a" ? "Reviewer" : undefined),
    });
    expect(
      [...container.querySelectorAll('[data-testid="chat-divider"]')].map(
        (line) => line.textContent,
      ),
    ).toEqual(["Switched to Reviewer", 'Forked from "Plan"']);
  });

  it("keeps a sent message's node when its item takes over", async () => {
    await render({
      turns: [],
      pending: [
        {
          commandId: "cmd-7",
          text: "Ship it",
          attachments: [],
          dispatch: "queue",
          status: "sent",
        },
      ],
    });
    const bubble = container.querySelector("[data-pending-message]");
    expect(bubble?.textContent).toContain("Ship it");
    await render({
      turns: timelineOf({
        turns: [turn("t1", 1, { status: "running", completedAt: null })],
        items: [input("t1", "Ship it", { idempotencyKey: "user:me:cmd-7" })],
      }),
      activeTurnId: "t1",
    });
    const article = container.querySelector("[data-user-message]");
    expect(article).toBe(bubble);
    expect(article?.hasAttribute("data-pending-message")).toBe(false);
  });

  it("keeps a failed send with Send again and Dismiss", async () => {
    const resent: string[] = [];
    await render({
      turns: [],
      pending: [
        {
          commandId: "cmd-1",
          text: "Hello there",
          attachments: [],
          dispatch: "queue",
          status: "failed",
        },
      ],
      onResendFailed: (commandId) => resent.push(commandId),
    });
    expect(container.textContent).toContain("Hello there");
    expect(container.textContent).toContain("Not sent");
    const again = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Send again",
    );
    await act(async () => again?.click());
    expect(resent).toEqual(["cmd-1"]);
  });

  it("keeps steps out of text selection and copies the reply's Markdown", async () => {
    await render({
      turns: settled(),
      workDisplay: { live: "all", settled: "keep" },
    });
    const steps = container.querySelector('[data-testid="chat-turn-steps"]');
    expect(steps?.className).toContain("select-none");
    const copy = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="chat-copy"]',
    );
    await act(async () => copy[1]?.click());
    expect(writeText).toHaveBeenCalledWith(
      "Found it.\n\nThe bug is in the parser.",
    );
  });
});
