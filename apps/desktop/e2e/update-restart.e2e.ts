import { afterEach, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Electron's autoUpdater.quitAndInstall announces `before-quit-for-update`
 * and closes every window; the app must then exit so the installer can
 * run. Workspace windows hide instead of closing outside a quit, which
 * once cancelled that path silently and left "Preparing to restart" on
 * screen for good.
 */
let app: AppHandle | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("update restart", () => {
  it("exits with a project window open once the update quit is announced", async () => {
    app = await launchApp();
    await app.eval(`window.catamorphicDesktop.createProject({
      name: 'update-restart',
      rootPath: ${JSON.stringify(`${app.userDataDir}/update-restart`)}
    })`);
    await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
    const pid = app.processId;
    if (!pid) throw new Error("Missing app process id");
    // Fire and forget: the reply cannot arrive from a process that exits.
    // Even this evaluation's own reply races the exit: the app can close
    // its windows, and with them the CDP connection, before the answer is
    // delivered. A connection that closes because the app left is the
    // outcome under test, so the evaluation settles either way and the
    // process's exit is what the test judges.
    const request = app
      .eval(
        "(() => { void window.catamorphicDesktop.devUpdateRestart(); return true; })()",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    const deadline = Date.now() + 60_000;
    while (alive(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 250));
    expect(alive(pid)).toBe(false);
    const failed = await request;
    if (failed)
      expect(String(failed)).toContain(
        "CDP connection closed before the response",
      );
    // stop() validates the exit status of the process that already left.
  });
});
