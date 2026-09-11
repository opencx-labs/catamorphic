import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;

async function checkFromPalette() {
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'p', metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform), bubbles: true, cancelable: true
  }));`);
  await app.waitFor(`(() => {
    const input = document.querySelector('[aria-hidden="false"] [aria-label="Command palette"] textarea');
    return input && !input.closest('[inert]') && document.activeElement === input;
  })()`);
  await app.eval(`(() => {
    ${setReactValueJs}
    setReactValue(document.querySelector('[aria-hidden="false"] [aria-label="Command palette"] textarea'), 'Check for updates');
  })()`);
  await app.waitFor(`!![...document.querySelectorAll('[aria-hidden="false"] [aria-label="Command palette"] [role="option"][aria-selected="true"]')]
    .find(el => el.textContent.includes('Check for updates'))`);
  await app.press("Enter");
  await app.waitFor(`document.querySelector('[data-testid="desktop-update-banner"]')
    ?.textContent.includes('Updates are unavailable here')`);
  await app.eval(
    `document.querySelector('[aria-label="Dismiss update message"]').click()`,
  );
}

describe("project loading and update access", () => {
  beforeAll(async () => {
    app = await launchApp();
  });
  afterAll(async () => {
    await app?.stop();
  });

  it("checks for updates from Cmd+P before any project exists", async () => {
    await app.waitFor(
      `!!document.querySelector('[data-testid="empty-start-agent"]')`,
    );
    await checkFromPalette();
  });

  it("restores the selected project and offers retry instead of onboarding on load failure", async () => {
    await app.eval(
      `window.catamorphicDesktop.createProject({
      name: 'reopen-project', rootPath: ${JSON.stringify(`${app.userDataDir}/reopen-project`)}
    })`,
    );
    await app.eval("location.reload()");
    await app.waitFor(`document.body?.innerText.includes('reopen-project')`, {
      timeoutMs: 30_000,
    });
    await checkFromPalette();

    await app.blockRequests(["*/api/projects*"]);
    expect(
      await app.eval(`window.catamorphicDesktop.getServerState().then(({url}) =>
      fetch(url + '/api/projects').then(response => response.status).catch(() => 'blocked'))`),
    ).toBe("blocked");
    await app.eval("location.reload()");
    await app.waitFor(
      `!!document.querySelector('[data-testid="project-load-error"]')`,
      {
        timeoutMs: 30_000,
      },
    );
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="empty-start-agent"]')`,
      ),
    ).toBe(false);
    await checkFromPalette();
    if (process.env.CATAMORPHIC_REOPEN_SCREENSHOT)
      await app.screenshot(process.env.CATAMORPHIC_REOPEN_SCREENSHOT);
    await app.blockRequests([]);
    await app.eval(`[...document.querySelectorAll('button')]
      .find(el => el.textContent.includes('Retry loading projects')).click()`);
    await app.waitFor(`!document.querySelector('[data-testid="project-load-error"]') &&
      document.body?.innerText.includes('reopen-project')`);

    const { userDataDir } = app;
    await app.kill();
    app = await launchApp({ userDataDir });
    await app.waitFor(`document.body?.innerText.includes('reopen-project')`, {
      timeoutMs: 30_000,
    });
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="empty-start-agent"]')`,
      ),
    ).toBe(false);
  });
});
