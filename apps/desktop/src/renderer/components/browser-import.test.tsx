// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopApi,
  type NativePasswordImportResult,
} from "../lib/desktop-api.js";
import { BrowserImport } from "./browser-import.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    browserImportSupport: vi.fn(),
    browserImportList: vi.fn(),
    browserImportRun: vi.fn(),
    browserImportPasswords: vi.fn(),
    browserImportNativePasswords: vi.fn(),
  },
}));
vi.mock("./shortcut-hint.js", () => ({
  ShortcutHint: ({ children }: { children: React.ReactNode }) => children,
}));
const browser = {
  id: "chrome",
  label: "Google Chrome",
  supportsPasswordImport: true,
  profiles: [
    { id: "Default", name: "Work", bookmarkCount: 2, hasPasswords: true },
  ],
};
const empty: NativePasswordImportResult = {
  imported: 0,
  existing: 0,
  invalid: 0,
  failed: 0,
  cancelled: false,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  vi.mocked(desktopApi.browserImportList).mockResolvedValue([browser]);
  vi.mocked(desktopApi.browserImportSupport).mockResolvedValue({
    available: true,
    reason: null,
  });
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
    root.render(<BrowserImport />);
  });
const nativeButton = () =>
  container.querySelector<HTMLButtonElement>(
    '[aria-label="Import passwords from Google Chrome, Work"]',
  );

describe("browser import settings", () => {
  it("offers direct import only when main reports platform support, keeping CSV available", async () => {
    vi.mocked(desktopApi.browserImportSupport).mockResolvedValue({
      available: false,
      reason: "Direct password import requires macOS 11 or later.",
    });
    await render();
    expect(nativeButton()).toBeNull();
    expect(container.textContent).toContain("macOS 11 or later");
    expect(container.textContent).toContain("Import CSV");
    expect(
      container.querySelector(
        '[aria-label="Import bookmarks from Google Chrome, Work"]',
      ),
    ).not.toBeNull();
  });
  it("disables direct import for profiles without password stores", async () => {
    vi.mocked(desktopApi.browserImportList).mockResolvedValue([
      {
        ...browser,
        profiles: [
          {
            id: "Default",
            name: "Work",
            bookmarkCount: 2,
            hasPasswords: false,
          },
        ],
      },
    ]);
    await render();
    expect(nativeButton()?.disabled).toBe(true);
  });
  it("shows progress, prevents duplicate actions, and reports meaningful partial results", async () => {
    let finish: (result: NativePasswordImportResult) => void = () => undefined;
    vi.mocked(desktopApi.browserImportNativePasswords).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => nativeButton()?.click());
    expect(nativeButton()?.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Keychain prompts",
    );
    expect(desktopApi.browserImportNativePasswords).toHaveBeenCalledWith({
      browserId: "chrome",
      profileId: "Default",
    });
    await act(async () =>
      finish({ ...empty, imported: 3, existing: 2, invalid: 1, failed: 4 }),
    );
    expect(container.textContent).toContain("Imported 3 passwords.");
    expect(container.textContent).toContain("Kept 2 existing accounts.");
    expect(container.textContent).toContain("Could not decrypt 4 entries.");
    expect(nativeButton()?.disabled).toBe(false);
  });
  it("lets the user retry after denial or cancellation", async () => {
    vi.mocked(desktopApi.browserImportNativePasswords).mockRejectedValueOnce(
      new Error("Keychain access denied"),
    );
    await render();
    await act(async () => nativeButton()?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Keychain access denied",
    );
    expect(nativeButton()?.disabled).toBe(false);
    vi.mocked(desktopApi.browserImportNativePasswords).mockResolvedValueOnce({
      ...empty,
      cancelled: true,
    });
    await act(async () => nativeButton()?.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Password import cancelled.");
  });
});
