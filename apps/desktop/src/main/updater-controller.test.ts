import { describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../shared/update.js";
import {
  DesktopUpdaterController,
  type ProgressInfoLike,
  type UpdateInfoLike,
  type UpdaterAdapter,
} from "./updater-controller.js";

type EventName =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

class FakeUpdater implements UpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  fullChangelog = true;
  readonly checkForUpdates = vi.fn(async () => undefined);
  readonly downloadUpdate = vi.fn(async () => undefined);
  readonly quitAndInstall = vi.fn();
  private readonly listeners = new Map<
    EventName,
    Array<(...args: never[]) => void>
  >();

  on(event: "checking-for-update", listener: () => void): this;
  on(event: "update-available", listener: (info: UpdateInfoLike) => void): this;
  on(
    event: "update-not-available",
    listener: (info: UpdateInfoLike) => void,
  ): this;
  on(
    event: "download-progress",
    listener: (info: ProgressInfoLike) => void,
  ): this;
  on(
    event: "update-downloaded",
    listener: (info: UpdateInfoLike) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: EventName, listener: (...args: never[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  checking(): void {
    this.dispatch("checking-for-update");
  }

  available(version: string): void {
    this.dispatch("update-available", { version });
  }

  notAvailable(): void {
    this.dispatch("update-not-available", { version: "0.1.0-alpha.1" });
  }

  progress(percent: number): void {
    this.dispatch("download-progress", { percent });
  }

  downloaded(version: string): void {
    this.dispatch("update-downloaded", { version });
  }

  fail(message: string): void {
    this.dispatch("error", new Error(message));
  }

  private dispatch(event: EventName, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      if (value === undefined) listener();
      else Reflect.apply(listener, undefined, [value]);
    }
  }
}

function setup() {
  const updater = new FakeUpdater();
  const states: DesktopUpdateState[] = [];
  const beforeInstall = vi.fn(async () => undefined);
  const controller = new DesktopUpdaterController({
    currentVersion: "0.1.0-alpha.1",
    supported: true,
    updater,
    broadcast: (state) => states.push(state),
    beforeInstall,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
  return { updater, states, beforeInstall, controller };
}

describe("DesktopUpdaterController", () => {
  it("configures a user-controlled prerelease updater", () => {
    const { updater } = setup();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.fullChangelog).toBe(false);
  });

  it("keeps quiet background checks quiet when no update exists", async () => {
    const { controller, updater } = setup();

    const checking = controller.check(false);
    updater.checking();
    updater.notAvailable();
    await checking;

    expect(controller.current()).toEqual({
      phase: "idle",
      currentVersion: "0.1.0-alpha.1",
      manual: false,
    });
  });

  it("preserves an actionable update across later background checks", async () => {
    const { controller, updater } = setup();

    const checking = controller.check(false);
    updater.available("0.1.0-alpha.2");
    await checking;
    await controller.check(false);

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(controller.current()).toMatchObject({
      phase: "available",
      version: "0.1.0-alpha.2",
    });
  });

  it("makes an in-flight background check visible when requested manually", async () => {
    const { controller, updater } = setup();
    let finishCheck: (() => void) | undefined;
    updater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = () => resolve(undefined);
        }),
    );

    const background = controller.check(false);
    const manual = controller.check(true);
    expect(controller.current()).toMatchObject({
      phase: "checking",
      manual: true,
    });
    finishCheck?.();
    await Promise.all([background, manual]);
  });

  it("downloads and installs only after explicit actions", async () => {
    const { controller, updater, beforeInstall } = setup();

    const checking = controller.check(true);
    updater.available("0.1.0-alpha.2");
    await checking;
    expect(controller.current()).toMatchObject({
      phase: "available",
      manual: true,
      version: "0.1.0-alpha.2",
    });

    const downloading = controller.download();
    updater.progress(48.4);
    expect(controller.current()).toMatchObject({
      phase: "downloading",
      percent: 48.4,
    });
    updater.downloaded("0.1.0-alpha.2");
    await downloading;

    await controller.install();
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("surfaces manual failures but suppresses background failures", async () => {
    const { controller, updater } = setup();

    const background = controller.check(false);
    updater.fail("offline");
    await background;
    expect(controller.current().phase).toBe("idle");

    const manual = controller.check(true);
    updater.fail("still offline");
    await manual;
    expect(controller.current()).toMatchObject({
      phase: "error",
      manual: true,
      message: "still offline",
    });
  });
});
