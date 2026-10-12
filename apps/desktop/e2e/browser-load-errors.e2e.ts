import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * A page that failed to load keeps its error in place while the person
 * retries, as Chrome's error page does: the toolbar shows Stop, and the
 * error leaves only when another page commits or fails in its place. It
 * used to leave as the retry started, uncovering Chromium's own white error
 * page under it until the page arrived.
 */
let app: AppHandle;
let origin: string;
let requests = 0;
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/flaky")) {
    requests += 1;
    // The first two tries fail; the third answers after a pause.
    if (requests <= 2) {
      request.socket.destroy();
      return;
    }
    setTimeout(() => {
      response.setHeader("Content-Type", "text/html");
      response.end("<title>Back</title><p>Back online</p>");
    }, 1500);
    return;
  }
  response.statusCode = 404;
  response.end();
});

const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
const view = `[...document.querySelectorAll('webview')].find(w => w.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
const errorShown = `document.body.innerText.includes('This page didn’t load.')`;
const stopShown = `!!document.querySelector('button[aria-label="Stop"]')`;
const tryAgain = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Try again')`;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Create or import project')",
  );
  await run("button('Create or import project').click()");
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run("setReactValue($('[data-testid=project-name-input]'), 'Errors')");
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  await app.waitFor(
    "window.catamorphicDesktop.getPrefs().then(prefs => Boolean(prefs.lastProjectId))",
  );
  await app.waitFor(
    "!!document.querySelector('textarea[placeholder*=\"Search or ask\"]')",
  );
  await run(
    `const input = $('textarea[placeholder*="Search or ask"]'); input.focus(); setReactValue(input, ${JSON.stringify(`${origin}/flaky`)})`,
  );
  await app.waitFor(
    "document.activeElement?.matches('textarea[aria-label=\"Search commands, pages, and more\"]') && document.activeElement.closest('[role=dialog]').querySelector('[data-item-id=web]')?.getAttribute('aria-selected') === 'true'",
    { label: "address row selected" },
  );
  await app.press("Enter");
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("a page that failed to load", () => {
  it("shows its error, and keeps it while a reload fails again", async () => {
    await app.waitFor(errorShown, { label: "error shown", timeoutMs: 30_000 });
    await app.waitFor(`!${stopShown}`, { label: "done loading" });
    expect(requests).toBe(1);
    await run("$('button[aria-label=\"Reload\"]').click()");
    await expect.poll(() => requests, { timeout: 15_000 }).toBe(2);
    await app.waitFor(`${errorShown} && !${stopShown}`, {
      label: "error after the second failure",
    });
  });

  it("keeps its error while a retry loads, then gives way to the page", async () => {
    await run(`${tryAgain}.click()`);
    // The answer takes 1.5 s: the retry is under way, behind the error.
    await app.waitFor(stopShown, { label: "Stop while retrying" });
    expect(
      await app.eval<[boolean, boolean]>(
        `[${errorShown}, ${tryAgain}.disabled]`,
      ),
    ).toEqual([true, true]);
    await app.waitFor(
      `(() => { const page = ${view}; try { return page.getTitle() === 'Back'; } catch { return false; } })()`,
      { label: "page arrived", timeoutMs: 15_000 },
    );
    await app.waitFor(`!${errorShown}`, { label: "error gone" });
    expect(requests).toBe(3);
  });
});
