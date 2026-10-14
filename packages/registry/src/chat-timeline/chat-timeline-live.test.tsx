// @vitest-environment jsdom

import type { Item, Turn } from "@catamorphic/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline, type ChatTimelineProps } from "./chat-timeline.js";
import {
  command,
  input,
  reply,
  timelineOf,
  toolCall,
  turn,
} from "./timeline-fixtures.js";
import type { WorkDisplay } from "./turn-rows.js";

/**
 * A running turn's live chrome: the activity line stays one quiet line
 * (spinner and words), and the turn's clock and silence sit on its latest
 * steps line, in every work display.
 */
describe("ChatTimeline live chrome", () => {
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
    // Fake timers first: they put back the stubs they replaced.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = (props: ChatTimelineProps) =>
    act(async () => root.render(<ChatTimeline {...props} />));
  const $ = (selector: string) =>
    container.querySelector<HTMLElement>(selector);
  const $$ = (selector: string) => [
    ...container.querySelectorAll<HTMLElement>(selector),
  ];
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

  const running = (overrides: Partial<Turn> = {}) =>
    turn("t1", 1, {
      status: "running",
      completedAt: null,
      startedAt: iso(-75_000),
      activityAt: iso(-2_000),
      ...overrides,
    });
  /** A note after two commands, then work since it. */
  const working: Item[] = [
    input("t1", "Fix the parser"),
    command("c1", "t1"),
    command("c2", "t1"),
    reply("n1", "t1", "The lexer drops empty input."),
    command("c3", "t1"),
    command("c4", "t1", { status: "in_progress", endedAt: null }),
  ];
  const clocks = () => $$('[role="log"] [role="timer"]');
  /** The steps line (`chat-turn-steps`) each clock sits on, by its row. */
  const clockRows = () =>
    clocks().map((clock) => {
      const article = clock.closest("article");
      return article?.hasAttribute("data-live-work")
        ? "live work"
        : (article?.getAttribute("data-message-id") ?? "elsewhere");
    });

  for (const live of ["all", "latest", "notes"] as const)
    it(`puts the clock on the latest steps line, never on the activity line (${live})`, async () => {
      const workDisplay: WorkDisplay = { live, settled: "collapse" };
      await render({
        timeline: timelineOf({ turns: [running()], items: working }),
        activity: "Running tests",
        workDisplay,
      });
      expect(clockRows()).toEqual(["live work"]);
      expect($('[data-testid="chat-activity-elapsed"]')?.textContent).toBe(
        "1m 15s",
      );
      // It holds the width of its longest reading in minutes, hidden.
      expect(
        $('[role="timer"] [aria-hidden] .cat-swap-text')?.textContent,
      ).toBe("00m 00s");
      expect($('[data-testid="chat-activity"] [role="timer"]')).toBeNull();
      // The line it sits on is open to the person, not folded away.
      expect(
        clocks()[0]
          ?.closest('[data-testid="chat-turn-steps"]')
          ?.querySelector('[data-testid="chat-turn-steps-toggle"]')
          ?.closest("[inert]"),
      ).toBeNull();
    });

  it("stays with the latest note's steps until more work follows it", async () => {
    const answered = working.slice(0, 4);
    await render({
      timeline: timelineOf({ turns: [running()], items: answered }),
      activity: "Writing",
    });
    expect(clockRows()).toEqual(["n1"]);
    // Work after the note takes the clock; the note's line lets it go.
    await render({
      timeline: timelineOf({ turns: [running()], items: working }),
      activity: "Running tests",
    });
    expect(clockRows()).toEqual(["n1", "live work"]);
    expect(
      $('[data-message-id="n1"] [data-testid="chat-turn-clock"]')?.className,
    ).toContain("opacity-0");
    await wait(250);
    expect(clockRows()).toEqual(["live work"]);
  });

  it("says a long silence beside the clock on the steps line", async () => {
    await render({
      timeline: timelineOf({
        turns: [running({ activityAt: iso(-45_000) })],
        items: working,
      }),
      activity: "Running tests",
    });
    const silence = $('[data-testid="chat-activity-stalled"]');
    expect(silence?.textContent).toBe("No updates for 45s");
    expect(silence?.closest("[data-live-work]")).not.toBeNull();
    expect($('[data-testid="chat-activity"]')?.textContent).toBe(
      "Running tests",
    );
  });

  it("keeps the first steps line's place from the start, the clock on it", async () => {
    // A message on its way: the place is kept, empty, as the line opens.
    await render({
      timeline: timelineOf({ turns: [], items: [] }),
      activity: "Sending message",
    });
    const line = () => $('[data-testid="chat-turn-line"]');
    expect(line()).not.toBeNull();
    expect(clocks()).toHaveLength(0);
    // It opens with the activity line, as one, not on its own.
    expect(line()?.closest(".cat-reveal")?.hasAttribute("data-entering")).toBe(
      false,
    );
    // The turn starts: the clock reads on it, above the activity line,
    // which is still only the spinner and its words.
    await render({
      timeline: timelineOf({
        turns: [running({ startedAt: iso(-4_000), activityAt: null })],
        items: [input("t1", "Fix the parser")],
      }),
      activity: "Working",
    });
    expect(clockRows()).toEqual(["elsewhere"]);
    expect(
      line()?.querySelector('[data-testid="chat-activity-elapsed"]')
        ?.textContent,
    ).toBe("4s");
    expect(
      line()?.compareDocumentPosition(
        $('[data-testid="chat-activity"]') ?? document.body,
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // And a long silence before the first step says so there.
    await render({
      timeline: timelineOf({
        turns: [running({ startedAt: iso(-40_000), activityAt: null })],
        items: [input("t1", "Fix the parser")],
      }),
      activity: "Working",
    });
    // (The clock last ticked as the turn started, a moment ago.)
    expect(line()?.textContent).toMatch(/No updates for (39|40)s/);
  });

  for (const live of ["all", "notes"] as const)
    it(`puts the first steps line in the turn line's place at once (${live})`, async () => {
      // Frames run when the test says: React's async act yields to the
      // event loop, so on a busy machine a message's entrance could play
      // out before its first pose is read.
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
      });
      const workDisplay: WorkDisplay = { live, settled: "collapse" };
      const items: Item[] = [
        input("t1", "Fix the parser"),
        reply("n1", "t1", "Reading the parser first."),
      ];
      await render({
        timeline: timelineOf({ turns: [running()], items }),
        activity: "Working",
        workDisplay,
      });
      expect($('[data-testid="chat-turn-line"]')).not.toBeNull();
      await render({
        timeline: timelineOf({
          turns: [running()],
          items: [...items, command("c1", "t1", { status: "in_progress" })],
        }),
        activity: "Reading files",
        workDisplay,
      });
      // The turn line is gone in the same render the steps line arrives.
      expect($('[data-testid="chat-turn-line"]')).toBeNull();
      const block = $('[data-live-work] [data-testid="chat-turn-steps"]');
      expect(clockRows()).toEqual(["live work"]);
      // The line neither opens nor rises: its message only fades in where
      // it is, as every message arrives.
      expect(block?.className).not.toContain("cat-step-in");
      const message = block?.closest("article")?.className ?? "";
      expect(message).not.toContain("translate-y");
      expect(message).toContain("opacity-0");
      expect(block?.closest(".cat-row")?.className).not.toContain("cat-gap-in");
      // Two frames: the hidden pose resolves, then the message fades in.
      await act(async () => {
        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();
      });
      await wait(50);
      expect(block?.closest("article")?.className).toContain("opacity-100");
      // Every step in view: the list opens its height under the line.
      const list = $('[data-live-work] [data-testid="chat-step"]')?.closest(
        ".grid",
      );
      if (live === "all") expect(list?.className).toContain("cat-step-in");
      else expect(list?.className).not.toContain("cat-step-in");
    });

  it("ends the activity line's opening as the first steps line takes the turn line's place", async () => {
    // Its opening transitions, as a renderer that stalled as the turn
    // started holds them: not yet played.
    const finished: string[] = [];
    const prototype: { getAnimations?: unknown } = Element.prototype;
    prototype.getAnimations = function (this: Element) {
      if (!this.matches(".cat-reveal")) return [];
      const owner = this.querySelector('[data-testid="chat-activity"]')
        ? "activity line"
        : "turn line";
      return ["grid-template-rows", "opacity", "margin-top"].map(
        (transitionProperty) => ({
          transitionProperty,
          playState: "idle",
          finish: () => finished.push(`${owner} ${transitionProperty}`),
        }),
      );
    };
    try {
      const items: Item[] = [
        input("t1", "Fix the parser"),
        reply("n1", "t1", "Reading the parser first."),
      ];
      await render({
        timeline: timelineOf({ turns: [running()], items }),
        activity: "Working",
      });
      await render({
        timeline: timelineOf({ turns: [running()], items }),
        activity: "Reading the parser",
      });
      expect(finished).toEqual([]);
      const stepped = [
        ...items,
        command("c1", "t1", { status: "in_progress" }),
      ];
      await render({
        timeline: timelineOf({ turns: [running()], items: stepped }),
        activity: "Reading files",
      });
      expect($('[data-testid="chat-turn-line"]')).toBeNull();
      expect(finished).toEqual([
        "activity line grid-template-rows",
        "activity line opacity",
        "activity line margin-top",
      ]);
      // Once: more steps leave its motion alone.
      await render({
        timeline: timelineOf({
          turns: [running()],
          items: [...stepped, command("c2", "t1", { status: "in_progress" })],
        }),
        activity: "Running tests",
      });
      expect(finished).toHaveLength(3);
    } finally {
      delete prototype.getAnimations;
    }
  });

  it("opens a row's gap with the work that joins the turn", async () => {
    const items: Item[] = [
      input("t1", "Fix the parser"),
      command("c1", "t1"),
      reply("n1", "t1", "The lexer drops empty input."),
    ];
    await render({
      timeline: timelineOf({ turns: [running()], items }),
      activity: "Writing",
    });
    expect($('[data-testid="chat-turn-line"]')).toBeNull();
    await render({
      timeline: timelineOf({
        turns: [running()],
        items: [...items, command("c2", "t1", { status: "in_progress" })],
      }),
      activity: "Running tests",
    });
    // A block after a note opens its height, the gap above it included.
    const block = $('[data-live-work] [data-testid="chat-turn-steps"]');
    expect(block?.className).toContain("cat-step-in");
    expect(block?.closest(".cat-row")?.className).toContain("cat-gap-in");
    // The rows already there keep still.
    expect(
      $('[data-message-id="n1"]')?.closest(".cat-row")?.className,
    ).not.toContain("cat-gap-in");
  });

  it("lets the clock go when the turn settles, and a lone step is its own row again", async () => {
    const items: Item[] = [
      input("t1", "Fix the parser"),
      command("c1", "t1", { status: "in_progress", endedAt: null }),
    ];
    await render({
      timeline: timelineOf({ turns: [running()], items }),
      activity: "Running tests",
    });
    expect(clocks()).toHaveLength(1);
    const settledItems: Item[] = [
      input("t1", "Fix the parser"),
      command("c1", "t1"),
      reply("a1", "t1", "Fixed."),
    ];
    await render({
      timeline: timelineOf({ turns: [turn("t1", 1)], items: settledItems }),
    });
    await wait(250);
    expect(clocks()).toHaveLength(0);
    expect(
      $('[data-testid="chat-turn-steps-toggle"]')?.closest("[inert]"),
    ).not.toBeNull();
  });

  it("closes the activity line before it goes", async () => {
    await render({
      timeline: timelineOf({ turns: [running()], items: working }),
      activity: "Running tests",
    });
    const line = $('[data-testid="chat-activity"]');
    await render({
      timeline: timelineOf({ turns: [running()], items: working }),
    });
    // Still there, closing: inert and hidden from assistive technology.
    expect($('[data-testid="chat-activity"]')).toBe(line);
    const reveal = line?.closest(".cat-reveal");
    expect(reveal?.hasAttribute("data-closed")).toBe(true);
    expect(reveal?.hasAttribute("inert")).toBe(true);
    await wait(250);
    expect($('[data-testid="chat-activity"]')).toBeNull();
  });

  it("opens the activity line from nothing only when it appears in a chat on screen", async () => {
    const timeline = timelineOf({ turns: [running()], items: working });
    const reveal = () =>
      $('[data-testid="chat-activity"]')?.closest(".cat-reveal");
    // A chat opened mid-turn has it open already.
    await render({ timeline, activity: "Running tests" });
    expect(reveal()?.hasAttribute("data-entering")).toBe(false);
    expect(reveal()?.hasAttribute("data-moving")).toBe(false);
    await render({ timeline });
    await wait(250);
    expect(reveal()).toBeUndefined();
    // Work starting in a chat on screen opens it, clipped while it moves.
    await render({ timeline, activity: "Running tests" });
    expect(reveal()?.hasAttribute("data-entering")).toBe(true);
    expect(reveal()?.hasAttribute("data-moving")).toBe(true);
    // Once open, it never opens again, wherever the chat goes meanwhile.
    await wait(350);
    expect(reveal()?.hasAttribute("data-entering")).toBe(false);
    expect(reveal()?.hasAttribute("data-moving")).toBe(false);
  });

  it("changes a folded count on a beat, its words read whole", async () => {
    const steps = (count: number): Item[] => [
      input("t1", "Fix the parser"),
      reply("n1", "t1", "Looking."),
      ...Array.from({ length: count }, (_, index) =>
        command(`w${index}`, "t1"),
      ),
    ];
    const notes: WorkDisplay = { live: "notes", settled: "collapse" };
    await render({
      timeline: timelineOf({ turns: [running()], items: steps(9) }),
      activity: "Running tests",
      workDisplay: notes,
    });
    const toggle = () =>
      $('[data-live-work] [data-testid="chat-turn-steps-toggle"]');
    const count = () =>
      $(
        '[data-live-work] [data-testid="chat-turn-steps-count"] .cat-swap-text',
      );
    expect(toggle()?.textContent).toBe("9 steps");
    await render({
      timeline: timelineOf({ turns: [running()], items: steps(10) }),
      activity: "Running tests",
      workDisplay: notes,
    });
    // The old number fades out first; the line still reads as one count.
    expect(count()?.className).toContain("cat-swap-out");
    expect(toggle()?.textContent).toBe("9 steps");
    // jsdom plays no CSS: end each beat as the browser would.
    for (const name of ["catamorphic-swap-out", "catamorphic-swap-in"])
      act(() => {
        const event = new Event("webkitAnimationEnd", { bubbles: true });
        Object.assign(event, { animationName: name });
        count()?.dispatchEvent(event);
      });
    expect(toggle()?.textContent).toBe("10 steps");
    expect(count()?.className).not.toMatch(/cat-swap-(out|in)/);
  });

  it("leaves a settled turn's steps alone while a later reply streams", async () => {
    const start = {
      tool: "run_background_command",
      input: { command: "bun run dev", description: "Start the dev server" },
    };
    const first: Item[] = [
      input("t1", "Read everything"),
      toolCall("b1", "t1", start),
      ...Array.from({ length: 20 }, (_, index) => toolCall(`r${index}`, "t1")),
      reply("a1", "t1", "Read."),
    ];
    const streaming = (text: string) =>
      timelineOf({
        turns: [turn("t1", 1), running({ id: "t2", ordinal: 2 })],
        items: [
          ...first,
          input("t2", "Now explain"),
          reply("a2", "t2", text, { status: "in_progress" }),
        ],
      });
    // The reducer hands back a turn it did not change as the same object.
    const settledTurn = streaming("").at(0);
    const at = (text: string) => {
      const timeline = streaming(text);
      return settledTurn ? [settledTurn, ...timeline.slice(1)] : timeline;
    };
    const backgroundCommands = [
      {
        kind: "command" as const,
        command: "bun run dev",
        description: "Start the dev server",
        status: "running" as const,
        exitCode: null,
      },
    ];
    // Every step row asks for its tool's icon as it renders.
    const resolveToolIcon = vi.fn(() => undefined);
    const props = {
      activity: "Writing",
      backgroundCommands,
      resolveToolIcon,
      workDisplay: { live: "all", settled: "keep" } as const,
    };
    await render({ ...props, timeline: at("The") });
    expect(resolveToolIcon.mock.calls.length).toBeGreaterThanOrEqual(20);
    resolveToolIcon.mockClear();
    for (const text of ["The parser", "The parser reads", "The parser reads."])
      await render({ ...props, timeline: at(text) });
    expect(resolveToolIcon.mock.calls.length).toBe(0);
  });
});
