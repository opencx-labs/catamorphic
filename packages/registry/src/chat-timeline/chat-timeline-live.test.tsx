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
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("says a silence before the first step on a line of its own", async () => {
    const quiet = timelineOf({
      turns: [running({ startedAt: iso(-40_000), activityAt: null })],
      items: [input("t1", "Fix the parser")],
    });
    await render({ timeline: quiet, activity: "Working" });
    const line = $('[data-testid="chat-turn-line"]');
    expect(line?.textContent).toContain("No updates for 40s");
    // Above the activity line, which is still only the spinner and words.
    expect(
      line?.compareDocumentPosition(
        $('[data-testid="chat-activity"]') ?? document.body,
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // A turn that is not quiet has no such line.
    await render({
      timeline: timelineOf({
        turns: [running({ startedAt: iso(-4_000), activityAt: null })],
        items: [input("t1", "Fix the parser")],
      }),
      activity: "Working",
    });
    await wait(250);
    expect($('[data-testid="chat-turn-line"]')).toBeNull();
    expect(clocks()).toHaveLength(0);
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
});
