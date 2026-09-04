// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SignalBadge } from "./chat-signals.js";

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
