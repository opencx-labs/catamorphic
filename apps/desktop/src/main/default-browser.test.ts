import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: {},
  ipcMain: {},
  shell: {},
}));

import {
  defaultBrowserState,
  externalBrowserUrl,
  requestDefaultBrowser,
} from "./default-browser.js";

describe("default browser", () => {
  it("requires both web protocols and never registers a development executable", async () => {
    const isDefault = vi.fn((scheme: string) => scheme === "https");
    expect(defaultBrowserState({ packaged: true, isDefault }).isDefault).toBe(
      false,
    );
    const setDefault = vi.fn(() => true);
    const result = await requestDefaultBrowser({
      packaged: false,
      platform: "darwin",
      isDefault,
      setDefault,
      openSettings: vi.fn(),
    });
    expect(result.available).toBe(false);
    expect(setDefault).not.toHaveBeenCalled();
  });
  it("does not report a successful request as OS confirmation", async () => {
    const setDefault = vi.fn(() => true);
    const result = await requestDefaultBrowser({
      packaged: true,
      platform: "darwin",
      isDefault: () => false,
      setDefault,
      openSettings: vi.fn(),
    });
    expect(setDefault.mock.calls).toEqual([["http"], ["https"]]);
    expect(result.isDefault).toBe(false);
  });
  it("opens Windows default apps when user choice is still required", async () => {
    const openSettings = vi.fn();
    await requestDefaultBrowser({
      packaged: true,
      platform: "win32",
      isDefault: () => false,
      setDefault: () => true,
      openSettings,
    });
    expect(openSettings).toHaveBeenCalledWith("ms-settings:defaultapps");
  });
  it("does not prompt again when already the default", async () => {
    const setDefault = vi.fn();
    expect(
      (
        await requestDefaultBrowser({
          packaged: true,
          platform: "darwin",
          isDefault: () => true,
          setDefault,
          openSettings: vi.fn(),
        })
      ).isDefault,
    ).toBe(true);
    expect(setDefault).not.toHaveBeenCalled();
  });
  it("accepts web links only, rejecting credentials and executable protocols", () => {
    expect(externalBrowserUrl("https://example.com/path?q=hello#world")).toBe(
      "https://example.com/path?q=hello#world",
    );
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "work://connect",
      "https://user:password@example.com",
      "--inspect=1234",
      "/some/file",
    ])
      expect(externalBrowserUrl(value)).toBeNull();
  });
});
