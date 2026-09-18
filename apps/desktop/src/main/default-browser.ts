import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { DefaultBrowserState } from "../shared/default-browser.js";

const schemes = ["http", "https"];

export function defaultBrowserState({
  packaged,
  isDefault,
}: {
  packaged: boolean;
  isDefault: (scheme: string) => boolean;
}): DefaultBrowserState {
  return {
    available: packaged,
    isDefault: packaged && schemes.every(isDefault),
    ...(!packaged
      ? {
          reason: "Use the installed Work app to set your default browser.",
        }
      : {}),
  };
}

export async function requestDefaultBrowser({
  packaged,
  platform,
  isDefault,
  setDefault,
  openSettings,
}: {
  packaged: boolean;
  platform: string;
  isDefault: (scheme: string) => boolean;
  setDefault: (scheme: string) => boolean;
  openSettings: (url: string) => Promise<unknown>;
}): Promise<DefaultBrowserState> {
  const current = defaultBrowserState({ packaged, isDefault });
  if (!current.available || current.isDefault) return current;
  // Both protocols are required. A successful request is not confirmation:
  // the OS may still ask the user, or they may cancel its chooser.
  for (const scheme of schemes) setDefault(scheme);
  if (platform === "win32" && !schemes.every(isDefault))
    await openSettings("ms-settings:defaultapps");
  return defaultBrowserState({ packaged, isDefault });
}

export function registerDefaultBrowser() {
  const dependencies = {
    packaged: app.isPackaged,
    platform: process.platform,
    isDefault: (scheme: string) => app.isDefaultProtocolClient(scheme),
    setDefault: (scheme: string) => app.setAsDefaultProtocolClient(scheme),
    openSettings: (url: string) => shell.openExternal(url),
  };
  const ownsWindow = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Open this setting in Work.");
  };
  ipcMain.handle("catamorphic:default-browser-state", (event) => {
    ownsWindow(event);
    return defaultBrowserState(dependencies);
  });
  ipcMain.handle("catamorphic:default-browser-request", (event) => {
    ownsWindow(event);
    return requestDefaultBrowser(dependencies);
  });
}

export function externalBrowserUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
