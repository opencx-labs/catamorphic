import { afterEach, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

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

/** Announce the update quit as the installer would, and wait for the exit. */
async function restartForUpdate(handle: AppHandle) {
  const pid = handle.processId;
  if (!pid) throw new Error("Missing app process id");
  // Fire and forget: the reply cannot arrive from a process that exits.
  // Even this evaluation's own reply races the exit: the app can close
  // its windows, and with them the CDP connection, before the answer is
  // delivered. A connection that closes because the app left is the
  // outcome under test, so the evaluation settles either way and the
  // process's exit is what the test judges.
  const request = handle
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
}

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const said = (text) =>
    $$('[role="log"] article').some((el) => el.textContent.includes(text));
`;

const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => (app as AppHandle).waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

describe("update restart", () => {
  it("hands a working agent back, and the relaunch continues it (ADR 0246)", async () => {
    app = await launchApp();
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await runWait(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await runWait(`
      setReactValue($('[data-testid="project-name-input"]'), 'update-continue');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    await runWait(`return !!byText('[role="tab"], button', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
    await runWait(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "chat dock open" });
    await runWait(`
      const input = visibleDock().querySelector('[data-composer-input]');
      setReactValue(input, 'work slowly and wait for interruption please');
      input.closest('form').requestSubmit();
      return true;
    `);
    await runWait(`return said('Working on it, give me a moment.');`, {
      timeoutMs: 30_000,
      label: "turn in flight before the restart",
    });
    const sessionId = await runWait<string>(
      `return window.catamorphicDesktop.getServerState().then(async ({ url }) => {
        const { items } = await fetch(url + '/api/projects').then((r) => r.json());
        const project = items.find((item) => item.name === 'update-continue');
        const sessions = await fetch(url + '/api/projects/' + project.id + '/agent/sessions')
          .then((r) => r.json());
        return sessions.items[0]?.id;
      });`,
      { label: "persisted session before the restart" },
    );
    const { userDataDir } = app;
    // Restart is never held for working agents.
    await restartForUpdate(app);
    await app.stop({ preserveUserData: true });

    app = await launchApp({ userDataDir });
    await runWait(
      `return window.catamorphicDesktop &&
              window.catamorphicDesktop.getServerState().then((s) => !!s.url);`,
      { timeoutMs: 60_000, label: "embedded server ready after the relaunch" },
    );
    // A turn handed back carries no lease to wait out: the relaunch
    // continues it at once, on the agent's own thread.
    await runWait(
      `return window.catamorphicDesktop.getServerState().then(async ({ url }) => {
        const { items } = await fetch(url + '/api/projects').then((r) => r.json());
        const project = items.find((item) => item.name === 'update-continue');
        const detail = await fetch(url + '/api/projects/' + project.id + '/agent/sessions/${sessionId}')
          .then((r) => r.json());
        const logged = detail.snapshot.items;
        return logged.some((item) => item.kind === 'notice' && item.code === 'turn_continued') &&
          logged.some((item) => item.kind === 'assistant_message' &&
            item.text.includes('You said: Your previous turn was interrupted'));
      });`,
      { timeoutMs: 60_000, label: "the relaunch continued the agent's turn" },
    );
  });

  it("exits with a project window open once the update quit is announced", async () => {
    app = await launchApp();
    await app.eval(`window.catamorphicDesktop.createProject({
      name: 'update-restart',
      rootPath: ${JSON.stringify(`${app.userDataDir}/update-restart`)}
    })`);
    await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
    await restartForUpdate(app);
    // stop() validates the exit status of the process that already left.
  });
});
