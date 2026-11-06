// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button";

describe("CopyButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn();

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(<CopyButton value="/projects/alpha" label="Copy path" />),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const button = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Copy path"]');
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const press = () =>
    act(async () => {
      button()?.click();
      await Promise.resolve();
    });

  it("says a copy failed, visibly and aloud", async () => {
    writeText.mockRejectedValue(new Error("Document is not focused"));
    await press();
    expect(button()?.dataset.copyFailed).toBe("true");
    expect(button()?.dataset.copied).toBeUndefined();
    expect(status()).toBe("Could not copy");
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(button()?.dataset.copyFailed).toBeUndefined();
  });

  it("starts its moment again and is heard again on a second copy", async () => {
    writeText.mockResolvedValue(undefined);
    await press();
    expect(button()?.dataset.copied).toBe("true");
    const first = status();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await press();
    expect(status()).not.toBe(first);
    expect(status()?.trim()).toBe("Copied");
    // 1.5s from the second press, not the first.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(button()?.dataset.copied).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(button()?.dataset.copied).toBeUndefined();
  });
});
