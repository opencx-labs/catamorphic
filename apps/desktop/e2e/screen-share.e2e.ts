import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Screen sharing (ADR 0150): a page's getDisplayMedia opens the app's
 * picker; a screen, a window, or one of the window's tabs can be shared,
 * tab audio rides along when asked for, and cancelling refuses the
 * request the way Chrome does (NotAllowedError).
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Share Lab</title><script>
    let shared = null;
    window.share = (constraints) => {
      document.title = "asking";
      navigator.mediaDevices.getDisplayMedia(constraints).then((stream) => {
        shared = stream;
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        document.title = "share:" + settings.displaySurface + ":" +
          stream.getAudioTracks().length + "a:" + (settings.width > 0 ? "sized" : "empty");
      }, (error) => { document.title = "share:" + error.name; });
    };
    window.stopShare = () => { shared?.getTracks().forEach((t) => t.stop()); shared = null; };
  </script>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/share`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = `document.querySelector('webview')`;
const inGuest = (code: string) =>
  app.eval(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
const picker = `document.querySelector('[data-testid="screen-share-picker"]')`;
const click = (selector: string) =>
  app.eval(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
const waitForPicker = () =>
  app.waitFor(`!!${picker}`, { label: "screen share picker" });
const waitForResult = (label: string) =>
  app.waitFor(`${guest}.getTitle().startsWith('share:')`, { label });
const title = () => app.eval<string>(`${guest}.getTitle()`);

describe("screen sharing", () => {
  it("getDisplayMedia opens the picker with the asking tab listed", async () => {
    await app.waitFor(`${guest}?.getTitle?.() === 'Share Lab'`);
    await inGuest("share({ video: true }); true");
    await waitForPicker();
    await app.waitFor(
      `!!document.querySelector('[data-testid="screen-share-tabs"] [data-testid="screen-share-source"]')`,
      { label: "tab row" },
    );
    const text = await app.eval<string>(`${picker}.textContent`);
    expect(text).toContain("Choose what to share");
    expect(text).toContain("This tab");
    expect(
      await app.eval(
        `document.querySelector('[data-testid="screen-share-tabs"] [data-testid="screen-share-source"]').dataset.sourceId`,
      ),
    ).toMatch(/^tab:\d+$/);
    // Nothing chosen yet: Share waits.
    expect(
      await app.eval(
        `document.querySelector('[data-testid="screen-share-confirm"]').disabled`,
      ),
    ).toBe(true);
  });

  it("cancelling refuses the request like Chrome", async () => {
    await click('[data-testid="screen-share-cancel"]');
    await waitForResult("cancel result");
    expect(await title()).toBe("share:NotAllowedError");
    await app.waitFor(`!${picker}`, { label: "picker closed" });
  });

  it("shares an entire screen", async () => {
    await inGuest("share({ video: true }); true");
    await waitForPicker();
    await click('[data-testid="screen-share-kind-screen"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="screen-share-screens"] [data-testid="screen-share-source"]')`,
      { label: "screen source", timeoutMs: 30_000 },
    );
    await click(
      '[data-testid="screen-share-screens"] [data-testid="screen-share-source"]',
    );
    await click('[data-testid="screen-share-confirm"]');
    await waitForResult("screen share result");
    expect(await title()).toBe("share:monitor:0a:sized");
    await inGuest("stopShare(); true");
  });

  it("shares the asking tab with its audio", async () => {
    await inGuest("share({ video: true, audio: true }); true");
    await waitForPicker();
    await app.waitFor(
      `!!document.querySelector('[data-testid="screen-share-tabs"] [data-testid="screen-share-source"]')`,
      { label: "tab row" },
    );
    await click(
      '[data-testid="screen-share-tabs"] [data-testid="screen-share-source"]',
    );
    await click('[data-testid="screen-share-confirm"]');
    await waitForResult("tab share result");
    expect(await title()).toBe("share:browser:1a:sized");
    await inGuest("stopShare(); true");
    expect(app.getRendererErrors()).toEqual([]);
  });
});
