import path from "node:path";
import {
  app,
  ipcMain,
  autoUpdater as nativeUpdater,
  powerMonitor,
} from "electron";
import electronUpdater from "electron-updater";
import type {
  DesktopUpdateChannel,
  DesktopUpdateState,
} from "../shared/update.js";
import {
  defaultDesktopUpdateChannel,
  UpdatePreferencesStore,
} from "./update-preferences.js";
import { createUpdatePreparation } from "./update-preparation.js";
import { DesktopUpdaterController } from "./updater-controller.js";

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface DesktopUpdaterService {
  check(manual: boolean): Promise<void>;
  channel(): DesktopUpdateChannel;
  setChannel(channel: DesktopUpdateChannel): Promise<boolean>;
  dispose(): void;
}

export function registerDesktopUpdater(options: {
  broadcast: (channel: string, payload: unknown) => void;
  canInstall: () => Promise<boolean>;
}): DesktopUpdaterService {
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = console;
  const preferences = new UpdatePreferencesStore(
    path.join(app.getPath("userData"), "updates.json"),
  );
  const channel = preferences.load(
    defaultDesktopUpdateChannel(app.getVersion()),
  );
  const preparation = createUpdatePreparation({ updater: nativeUpdater });
  const controller = new DesktopUpdaterController({
    prepareInstall: () => preparation.prepare(),
    canInstall: options.canInstall,
    currentVersion: app.getVersion(),
    channel,
    supported: app.isPackaged && process.platform === "darwin",
    updater: autoUpdater,
    broadcast: (state) =>
      options.broadcast("catamorphic:update-state-changed", state),
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
    channel: () => controller.current().channel,
    async setChannel(nextChannel) {
      if (!controller.setChannel(nextChannel)) return false;
      preferences.save(nextChannel);
      await controller.check(true);
      return true;
    },
    dispose() {
      preparation.dispose();
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
