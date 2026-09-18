// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { BrowserImportDialog } from "./browser-import.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    browserImportList: vi.fn(),
    browserImportRun: vi.fn(),
    browserImportPasswords: vi.fn(),
  },
}));
vi.mock("./shortcut-hint.js", () => ({
  ShortcutHint: ({ children }: { children: React.ReactNode }) => children,
}));
const browser = {
  id: "chrome",
  label: "Google Chrome",
  profiles: [
    {
      id: "Default",
      name: "Work",
      bookmarkCount: 2,
      hasHistory: true,
      hasPasswords: true,
      hasSessions: true,
    },
  ],
};
let container: HTMLDivElement;
let root: Root;
const close = vi.fn();
const complete = vi.fn();
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  vi.mocked(desktopApi.browserImportList).mockResolvedValue([browser]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});
const render = () =>
  act(async () => {
    root.render(
      <BrowserImportDialog
        open
        profileId="destination"
        onClose={close}
        onComplete={complete}
      />,
    );
  });
const start = () =>
  container.querySelector<HTMLButtonElement>(
    '[data-testid="browser-import-start"]',
  );

describe("shared browser import", () => {
  it("lets users select categories before touching source data", async () => {
    await render();
    expect(desktopApi.browserImportRun).not.toHaveBeenCalled();
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="Passwords"]')
        ?.click();
      container
        .querySelector<HTMLInputElement>('[aria-label="Signed-in sessions"]')
        ?.click();
    });
    vi.mocked(desktopApi.browserImportRun).mockResolvedValue({
      cancelled: false,
    });
    await act(async () => start()?.click());
    expect(desktopApi.browserImportRun).toHaveBeenCalledWith({
      browserId: "chrome",
      sourceProfileId: "Default",
      targetProfileId: "destination",
      categories: ["bookmarks", "history"],
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it("offers only available categories without unsupported-item messaging", async () => {
    vi.mocked(desktopApi.browserImportList).mockResolvedValue([
      {
        ...browser,
        profiles: [
          {
            ...browser.profiles[0],
            id: "Default",
            name: "Work",
            bookmarkCount: 0,
            hasPasswords: false,
            hasSessions: false,
          },
        ],
      },
    ]);
    await render();
    expect(container.querySelector('[aria-label="Bookmarks"]')).toBeNull();
    expect(container.querySelector('[aria-label="Passwords"]')).toBeNull();
    expect(container.querySelector('[aria-label="History"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(
      /unsupported|skipped|could not import/i,
    );
  });
  it("keeps selection and close controls stable during an import and prevents duplicate starts", async () => {
    let finish: (result: { cancelled: boolean }) => void = () => {};
    vi.mocked(desktopApi.browserImportRun).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => {
      start()?.click();
      start()?.click();
    });
    expect(desktopApi.browserImportRun).toHaveBeenCalledOnce();
    expect(start()?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Close import"]')
        ?.disabled,
    ).toBe(true);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish({ cancelled: false }));
    expect(complete).toHaveBeenCalledOnce();
  });
  it("allows retry after cancellation or a whole-operation failure without marking import done", async () => {
    vi.mocked(desktopApi.browserImportRun).mockResolvedValueOnce({
      cancelled: true,
    });
    await render();
    await act(async () => start()?.click());
    expect(complete).not.toHaveBeenCalled();
    expect(start()?.disabled).toBe(false);
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[aria-label="Passwords"]')
        ?.click(),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    vi.mocked(desktopApi.browserImportRun).mockRejectedValueOnce(
      new Error("Close the source browser and try again."),
    );
    await act(async () => start()?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "try again",
    );
    expect(close).not.toHaveBeenCalled();
  });
  it("shows an actionable unlock failure without Electron IPC internals or marking completion", async () => {
    vi.mocked(desktopApi.browserImportRun).mockResolvedValue({
      cancelled: false,
      error:
        "macOS could not unlock this browser's encryption key. Check Keychain Access.",
    });
    await render();
    await act(async () => start()?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Check Keychain Access",
    );
    expect(container.textContent).not.toMatch(
      /remote method|browser-import-run/,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(start()?.disabled).toBe(false);
  });
});
