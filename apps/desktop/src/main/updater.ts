import { app, ipcMain, powerMonitor } from "electron";
import electronUpdater from "electron-updater";
import type { DesktopUpdateState } from "../shared/update.js";
import { DesktopUpdaterController } from "./updater-controller.js";

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface DesktopUpdaterService {
  check(manual: boolean): Promise<void>;
  dispose(): void;
}

export function registerDesktopUpdater(options: {
  broadcast: (channel: string, payload: unknown) => void;
  beforeInstall: () => Promise<void>;
}): DesktopUpdaterService {
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = console;
  const controller = new DesktopUpdaterController({
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === "darwin",
    updater: autoUpdater,
    broadcast: (state) =>
      options.broadcast("catamorphic:update-state-changed", state),
    beforeInstall: options.beforeInstall,
  });

  ipcMain.handle("catamorphic:update-state", () => controller.current());
  ipcMain.handle("catamorphic:update-check", () => controller.check(true));
  ipcMain.handle("catamorphic:update-download", () => controller.download());
  ipcMain.handle("catamorphic:update-install", () => controller.install());

  const supported = app.isPackaged && process.platform === "darwin";
  const initialTimer = supported
    ? setTimeout(() => void controller.check(false), INITIAL_CHECK_DELAY_MS)
    : null;
  initialTimer?.unref();
  const interval = supported
    ? setInterval(() => void controller.check(false), CHECK_INTERVAL_MS)
    : null;
  interval?.unref();
  const onResume = () => void controller.check(false);
  if (supported) powerMonitor.on("resume", onResume);

  return {
    check: (manual) => controller.check(manual),
    dispose() {
      if (initialTimer) clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
      if (supported) powerMonitor.removeListener("resume", onResume);
      for (const channel of [
        "catamorphic:update-state",
        "catamorphic:update-check",
        "catamorphic:update-download",
        "catamorphic:update-install",
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}

export type { DesktopUpdateState };
