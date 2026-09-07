// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignalBadge, SignalGlyph } from "./chat-signals.js";

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
          <SignalGlyph working={working}>
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
