// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatActivity,
  combineSignals,
  SignalBadge,
  SignalGlyph,
} from "./chat-signals.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("SignalBadge", () => {
  it("renders workflow attention as a pulse ahead of ordinary unread", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    cleanup = () => act(() => root.unmount());
    act(() => {
      root.render(
        <SignalBadge signals={{ attention: true, unread: true }} size="sm" />,
      );
    });

    const pulse = container.querySelector(
      '.animate-pulse[aria-hidden="false"]',
    );
    expect(pulse?.getAttribute("aria-hidden")).toBe("false");
    const unread = container.querySelector(".bg-accent:not(.animate-pulse)");
    expect(unread?.getAttribute("aria-hidden")).toBe("true");
  });
});

it("stops all status animations when a chat settles", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  const render = (working: boolean, attention: boolean) =>
    act(() =>
      root.render(
        <>
          <SignalGlyph activity={working ? "working" : null}>
            <span>Chat</span>
          </SignalGlyph>
          <SignalBadge signals={{ attention }} />
        </>,
      ),
    );
  render(true, true);
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  expect(
    container.querySelectorAll('.animate-pulse[aria-hidden="true"]'),
  ).toHaveLength(0);
  render(false, false);
  expect(
    container.querySelectorAll(".animate-spin, .animate-pulse"),
  ).toHaveLength(0);
});

it("shows a question instead of a spinner while a running turn awaits input", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() =>
    root.render(
      <>
        <SignalGlyph
          activity={chatActivity({
            working: true,
            awaitingInput: true,
            waitingNow: null,
            leftRunning: null,
          })}
        >
          <span>Chat</span>
        </SignalGlyph>
        <SignalBadge signals={{ working: true, awaitingInput: true }} />
      </>,
    ),
  );
  expect(container.querySelector(".animate-spin")).toBeNull();
  expect(
    container.querySelector('[aria-hidden="false"]')?.textContent,
  ).toContain("?");
});

it("keeps the icon while working, with the spinner on its corner", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  const render = (working: boolean) =>
    act(() =>
      root.render(
        <SignalGlyph activity={working ? "working" : null}>
          <span data-testid="icon">Chat</span>
        </SignalGlyph>,
      ),
    );
  render(true);
  const icon = container.querySelector('[data-testid="icon"]');
  const cutout = icon?.closest(".signal-cutout");
  expect(cutout?.hasAttribute("data-cut")).toBe(true);
  expect(cutout?.className).not.toContain("opacity-0");
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  render(false);
  expect(cutout?.hasAttribute("data-cut")).toBe(false);
  expect(container.querySelector('[data-testid="icon"]')).toBe(icon);
});

it("keeps a reply's dot while the agent works again", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  act(() =>
    root.render(
      <>
        <SignalGlyph activity="working">
          <span>Chat</span>
        </SignalGlyph>
        <SignalBadge signals={{ working: true, unread: true }} size="sm" />
      </>,
    ),
  );
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  const shown = container.querySelectorAll('[aria-hidden="false"]');
  expect(shown).toHaveLength(1);
  expect(shown[0]?.className).toContain("bg-accent");
  expect(shown[0]?.className).not.toContain("animate-pulse");
  expect(shown[0]?.textContent).toBe("");
});

it("says what a chat waits on while it is not working", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  const render = (working: boolean) =>
    act(() =>
      root.render(
        <SignalGlyph activity={working ? "working" : "watch"}>
          <span>Chat</span>
        </SignalGlyph>,
      ),
    );
  render(false);
  const corner = container.querySelector("[data-activity]");
  expect(corner?.getAttribute("data-activity")).toBe("watch");
  expect(container.querySelector(".signal-cutout[data-cut]")).not.toBeNull();
  expect(container.querySelector(".animate-spin")).toBeNull();
  // Working takes the corner; the watch shows again once it settles.
  render(true);
  expect(corner?.getAttribute("data-activity")).toBe("working");
  expect(container.querySelector(".animate-spin")).not.toBeNull();
});

it("names one mark per corner, the most telling first", () => {
  const mark = (
    working: boolean,
    rest: Partial<Parameters<typeof chatActivity>[0]> = {},
  ) =>
    chatActivity({
      working,
      awaitingInput: false,
      waitingNow: null,
      leftRunning: null,
      ...rest,
    });
  expect(mark(true, { leftRunning: "watch" })).toBe("working");
  expect(mark(true, { awaitingInput: true })).toBeNull();
  // A turn that only waits shows what it waits on, not the spinner.
  expect(mark(true, { waitingNow: "subagent" })).toBe("subagent");
  expect(mark(false, { leftRunning: "command" })).toBe("command");
  expect(mark(false)).toBeNull();
  expect(
    combineSignals([
      { activity: "command" },
      { activity: "subagent" },
      { activity: "watch" },
    ]).activity,
  ).toBe("watch");
  expect(
    combineSignals([{ activity: "watch" }, { activity: "working" }]).activity,
  ).toBe("working");
  expect(combineSignals([{ working: true }, {}]).activity).toBeNull();
});
