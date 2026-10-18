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
  /**
   * Work is quitting to relaunch (installing an update, moving into
   * Applications): its shutdown hands working agents back for the next
   * launch instead of stopping them (ADR 0246).
   */
  restarting(): boolean;
  dispose(): void;
}

export function registerDesktopUpdater(options: {
  broadcast: (channel: string, payload: unknown) => void;
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
  let restarting = false;
  const controller = new DesktopUpdaterController({
    prepareInstall: () => preparation.prepare(),
    downloaded: {
      load: () => preferences.downloaded(),
      // Losing the record only costs a second download: never a failure.
      save: (version) => {
        try {
          preferences.saveDownloaded(version);
        } catch (error) {
          logger.warn(
            "[desktop] could not record the downloaded update",
            error,
          );
        }
      },
    },
    installedInPlace: () => app.isInApplicationsFolder(),
    // Electron moves the bundle (out of a disk image or App Translocation
    // too) and relaunches from Applications; false when the person declines.
    moveToApplications: async () => {
      restarting = true;
      try {
        restarting = app.moveToApplicationsFolder();
      } catch (error) {
        restarting = false;
        throw error;
      }
      return restarting;
    },
    currentVersion: app.getVersion(),
    channel,
    supported: app.isPackaged && process.platform === "darwin",
    logger,
    updater: Object.assign(autoUpdater, {
      // electron-updater returns its in-flight check to every caller until
      // it settles; a stuck one would block all later checks.
      abandonCheck: () => {
        if (!Reflect.has(autoUpdater, "checkForUpdatesPromise"))
          logger.warn(
            "[desktop] electron-updater no longer has checkForUpdatesPromise; a stuck check may block later ones",
          );
        Reflect.set(autoUpdater, "checkForUpdatesPromise", null);
      },
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
  const onBeforeQuitForUpdate = () => {
    restarting = true;
    markUpdateRestart(app.getPath("userData"));
  };
  // Squirrel failing to relaunch leaves Work running: a later Quit is an
  // ordinary one again, which stops agents rather than handing them back.
  const onUpdateError = () => {
    restarting = false;
  };
  // Every build listens: a development build's restart rehearsal (the e2e
  // suite's) announces the same quit.
  nativeUpdater.on("before-quit-for-update", onBeforeQuitForUpdate);
  nativeUpdater.on("error", onUpdateError);
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
    restarting: () => restarting,
    dispose() {
      preparation.dispose();
      schedule.dispose();
      if (supported) powerMonitor.removeListener("resume", onResume);
      nativeUpdater.removeListener(
        "before-quit-for-update",
        onBeforeQuitForUpdate,
      );
      nativeUpdater.removeListener("error", onUpdateError);
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
