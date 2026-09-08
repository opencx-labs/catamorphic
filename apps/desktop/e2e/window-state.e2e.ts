import { afterAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Window placement survives a relaunch: maximized stays maximized, a
 * resized window comes back at its size. Driven through the dev-only
 * window IPC (CDP can't reach Electron's window geometry).
 */

let app: AppHandle | undefined;

afterAll(async () => {
  await app?.stop();
});

const geometry = () =>
  (app as AppHandle).eval<{
    width: number;
    height: number;
    maximized: boolean;
    focused: boolean;
    focusable: boolean;
    opacity: number;
  }>(`window.catamorphicDesktop.devWindow('get')`);

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("window state", () => {
  it("a maximized window relaunches maximized", async () => {
    app = await launchApp();
    await (app as AppHandle).eval(
      `window.catamorphicDesktop.devWindow('maximize')`,
    );
    await settle();
    expect((await geometry()).maximized).toBe(true);
    // In Linux CI the private display isolates physical input; windows must
    // remain managed for native maximize/restore behavior to be testable.
    if (
      process.platform !== "linux" ||
      process.env.CATAMORPHIC_E2E_VIRTUAL_DISPLAY !== "1"
    ) {
      expect(await geometry()).toMatchObject({
        focused: false,
        focusable: false,
        opacity: process.env.CATAMORPHIC_E2E_REVEAL_WINDOWS === "1" ? 1 : 0,
      });
    }
    expect(await app.eval("document.hasFocus()")).toBe(true);
    const { userDataDir } = app;
    await app.kill();

    app = await launchApp({ userDataDir });
    expect((await geometry()).maximized).toBe(true);
  }, 180_000);

  it("a resized window relaunches at its size", async () => {
    await (app as AppHandle).eval(
      `window.catamorphicDesktop.devWindow('setSize', 1000, 650)`,
    );
    await settle();
    const before = await geometry();
    expect(before.maximized).toBe(false);
    expect([before.width, before.height]).toEqual([1000, 650]);
    const { userDataDir } = app as AppHandle;
    await (app as AppHandle).kill();

    app = await launchApp({ userDataDir });
    const after = await geometry();
    expect(after.maximized).toBe(false);
    expect([after.width, after.height]).toEqual([1000, 650]);
  }, 180_000);
});
