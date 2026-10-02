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
import { markUpdateRestart } from "./update-restart.js";
import { UpdateSchedule } from "./update-schedule.js";
import { DesktopUpdaterController } from "./updater-controller.js";
import { createUpdaterLog } from "./updater-log.js";

export interface DesktopUpdaterService {
  check(manual: boolean): Promise<boolean>;
  channel(): DesktopUpdateChannel;
  setChannel(channel: DesktopUpdateChannel): Promise<boolean>;
  dispose(): void;
}

export function registerDesktopUpdater(options: {
  broadcast: (channel: string, payload: unknown) => void;
  canInstall: () => Promise<boolean>;
}): DesktopUpdaterService {
  const { autoUpdater } = electronUpdater;
  const logger = createUpdaterLog(
    path.join(app.getPath("logs"), "updates.log"),
  );
  autoUpdater.logger = logger;
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
    installedInPlace: () => app.isInApplicationsFolder(),
    // Electron moves the bundle (out of a disk image or App Translocation
    // too) and relaunches from Applications; false when the person declines.
    moveToApplications: async () => app.moveToApplicationsFolder(),
    currentVersion: app.getVersion(),
    channel,
    supported: app.isPackaged && process.platform === "darwin",
    logger,
    updater: Object.assign(autoUpdater, {
      // electron-updater returns its in-flight check to every caller until
      // it settles; a stuck one would block all later checks.
      abandonCheck: () =>
        Reflect.set(autoUpdater, "checkForUpdatesPromise", null),
    }),
    broadcast: (state) =>
      options.broadcast("catamorphic:update-state-changed", state),
  });

  ipcMain.handle("catamorphic:update-state", () => controller.current());
  const checkNow = async (manual: boolean) => {
    const answered = await controller.check(manual);
    schedule.checked(answered);
    return answered;
  };
  ipcMain.handle("catamorphic:update-check", () => checkNow(true));
  ipcMain.handle("catamorphic:update-download", () => controller.download());
  ipcMain.handle("catamorphic:update-install", () => controller.install());
  ipcMain.handle("catamorphic:update-move", () => controller.move());

  const supported = app.isPackaged && process.platform === "darwin";
  // The installer relaunches the app in the background; the next launch
  // reads this marker and brings its window to the front.
  const onBeforeQuitForUpdate = () =>
    markUpdateRestart(app.getPath("userData"));
  if (supported)
    nativeUpdater.on("before-quit-for-update", onBeforeQuitForUpdate);
  // Shortly after launch, every six hours of wall-clock time, a minute
  // after waking, and again soon after a failure (update-schedule.ts).
  const schedule = new UpdateSchedule({
    check: () => {
      logger.info("[desktop] scheduled update check");
      return controller.check(false);
    },
  });
  if (supported) schedule.start();
  const onResume = () => schedule.resumed();
  if (supported) powerMonitor.on("resume", onResume);

  return {
    check: (manual) => checkNow(manual),
    channel: () => controller.current().channel,
    async setChannel(nextChannel) {
      if (!controller.setChannel(nextChannel)) return false;
      preferences.save(nextChannel);
      await checkNow(true);
      return true;
    },
    dispose() {
      preparation.dispose();
      schedule.dispose();
      if (supported) powerMonitor.removeListener("resume", onResume);
      if (supported)
        nativeUpdater.removeListener(
          "before-quit-for-update",
          onBeforeQuitForUpdate,
        );
      for (const channel of [
        "catamorphic:update-state",
        "catamorphic:update-check",
        "catamorphic:update-download",
        "catamorphic:update-install",
        "catamorphic:update-move",
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}

export type { DesktopUpdateState };
