// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefaultBrowserState } from "../../shared/default-browser.js";
import { desktopApi } from "../lib/desktop-api.js";
import { DefaultBrowserButton } from "./default-browser.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    defaultBrowserState: vi.fn(),
    defaultBrowserRequest: vi.fn(),
  },
}));

const available = { available: true, isDefault: false };
const completed = { available: true, isDefault: true };

function deferred() {
  let resolve!: (value: DefaultBrowserState) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DefaultBrowserState>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DefaultBrowserButton request ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("ignores an old status response after changing the default browser", async () => {
    const initial = deferred();
    const request = deferred();
    vi.mocked(desktopApi.defaultBrowserState).mockReturnValue(initial.promise);
    vi.mocked(desktopApi.defaultBrowserRequest).mockReturnValue(
      request.promise,
    );
    await act(async () => root.render(<DefaultBrowserButton />));
    await act(async () => container.querySelector("button")?.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(desktopApi.defaultBrowserState).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(completed));
    await act(async () => initial.resolve(available));
    expect(container.querySelector("button")?.dataset.actionState).toBe("done");
    expect(container.querySelector("button")?.disabled).toBe(true);
  });

  it("ignores stale errors and clears an error after a successful focus refresh", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(desktopApi.defaultBrowserState)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockRejectedValueOnce(new Error("Temporarily unavailable"))
      .mockResolvedValue(available);
    await act(async () => root.render(<DefaultBrowserButton />));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => second.resolve(available));
    await act(async () => first.reject(new Error("Stale failure")));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Could not check",
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });
});
