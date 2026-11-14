import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Screen sharing (ADRs 0150, 0315): a page's getDisplayMedia opens the
 * app's picker; one of the window's tabs (a sleeping one too), a window or
 * a screen can be shared, the sound goes along when asked for and left
 * on, and cancelling refuses the request the way Chrome does
 * (NotAllowedError). A shared tab keeps painting while out of sight.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/background") {
    // A page that paints every frame, so a share of it has frames to send.
    response.end(`<title>Background Lab</title><body style="margin:0">
      <canvas id="c" width="320" height="200"></canvas><script>
      let i = 0; const c = document.getElementById("c").getContext("2d");
      const step = () => { i++; c.fillStyle = "hsl(" + (i * 7 % 360) + ",80%,50%)";
        c.fillRect(0, 0, 320, 200); requestAnimationFrame(step); };
      requestAnimationFrame(step);
    </script>`);
    return;
  }
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
    window.framesSent = () => shared?.getVideoTracks()[0]?.stats?.totalFrames ?? -1;
    window.stopShare = () => { shared?.getTracks().forEach((t) => t.stop()); shared = null; };
  </script>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  // A second tab sits in the background, restored asleep. A minute lasts
  // 25 ms, so once shared and let go it sleeps again within seconds (ADR
  // 0194).
  app = await launchApp({
    urls: [`${origin}/background`, `${origin}/share`],
    env: { CATAMORPHIC_E2E_TAB_SLEEP_MINUTE_MS: "25" },
  });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = `document.querySelector('webview[src$="/share"]')`;
const inGuest = <T = unknown>(code: string) =>
  app.eval<T>(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
const picker = `document.querySelector('[data-testid="screen-share-picker"]')`;
const click = (selector: string) =>
  app.eval(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
/** A picker row whose text matches `pattern` (a page never loaded is named by its address). */
const tabRow = (pattern: string) =>
  `[...document.querySelectorAll('[data-testid="screen-share-tabs"] [data-testid="screen-share-source"]')].find((row) => /${pattern}/i.test(row.textContent))`;
const tabButton = (pattern: string) =>
  `[...document.querySelectorAll('[data-tab-orientation] button')].find((b) => /${pattern}/i.test(b.textContent))`;
const backgroundPane = `document.querySelector('[data-surface-key] webview[src$="/background"]')`;
const waitForPicker = () =>
  app.waitFor(`!!${picker} && !${picker}.dataset.closing`, {
    label: "screen share picker",
  });
const waitForResult = (label: string) =>
  app.waitFor(`${guest}.getTitle().startsWith('share:')`, { label });
const title = () => app.eval<string>(`${guest}.getTitle()`);
const confirm = async () => {
  await app.waitFor(
    `!document.querySelector('[data-testid="screen-share-confirm"]').disabled`,
    { label: "share enabled" },
  );
  await click('[data-testid="screen-share-confirm"]');
};

describe("screen sharing", () => {
  it("getDisplayMedia lists every tab of the window, a sleeping one too", async () => {
    // getTitle throws until the guest is attached and dom-ready.
    await app.waitFor(
      `(() => { const view = ${guest}; try { return view.getTitle() === 'Share Lab' && !view.isLoading(); } catch { return false; } })()`,
      { label: "page ready" },
    );
    await inGuest("share({ video: true }); true");
    await waitForPicker();
    // The project's workspace restores its hidden tab asleep: it never
    // loaded, and the picker lists it all the same.
    await app.waitFor(`${tabRow("background")}?.dataset.asleep === ''`, {
      label: "sleeping tab listed",
    });
    const text = await app.eval<string>(`${picker}.textContent`);
    expect(text).toContain("Choose what to share");
    expect(text).toContain("This tab");
    // The page asked for no sound, so nothing offers it.
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="screen-share-audio"]')`,
      ),
    ).toBe(false);
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

  /** Shares Background Lab from the picker and checks it keeps painting. */
  const shareBackgroundTab = async () => {
    await app.eval(`${tabRow("background")}.click(); true`);
    await confirm();
    await waitForResult("background tab share result");
    expect(await title()).toBe("share:browser:0a:sized");
    // The tab stays laid out, transparent behind the one shown.
    expect(
      await app.eval(
        `(() => { const view = ${backgroundPane}; return view.style.display + ":" + view.closest('[data-surface-key]').classList.contains('opacity-0'); })()`,
      ),
    ).toBe("flex:true");
    const before = await inGuest<number>("framesSent()");
    await expect
      .poll(() => inGuest<number>("framesSent()"), { timeout: 10_000 })
      .toBeGreaterThan(before + 10);
    await app.waitFor(
      `!!${tabButton("background")}?.querySelector('[data-tab-shared]')`,
      { label: "tab marked shared" },
    );
  };

  it("shares the sleeping tab, which wakes and keeps painting out of sight", async () => {
    await inGuest("share({ video: true }); true");
    await waitForPicker();
    await app.waitFor(`!!${tabRow("background")}`, { label: "tab row" });
    await shareBackgroundTab();
  });

  it("lets the tab go when the share stops, so it sleeps again", async () => {
    await inGuest("stopShare(); true");
    await app.waitFor(
      `!${tabButton("background")}?.querySelector('[data-tab-shared]')`,
      { label: "share mark gone" },
    );
    await app.waitFor(
      `!!${tabButton("background")}?.querySelector('[data-tab-asleep]')`,
      { label: "background tab asleep", timeoutMs: 30_000 },
    );
  });

  it("shares the tab again after it slept", async () => {
    await inGuest("share({ video: true }); true");
    await waitForPicker();
    await app.waitFor(`${tabRow("background")}?.dataset.asleep === ''`, {
      label: "sleeping tab listed",
    });
    await shareBackgroundTab();
    await inGuest("stopShare(); true");
    await app.waitFor(
      `!${tabButton("background")}?.querySelector('[data-tab-shared]')`,
      { label: "share mark gone" },
    );
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
    await confirm();
    await waitForResult("screen share result");
    expect(await title()).toBe("share:monitor:0a:sized");
    await inGuest("stopShare(); true");
  });

  it("shares the asking tab with its audio, or without when unticked", async () => {
    await inGuest("share({ video: true, audio: true }); true");
    await waitForPicker();
    await app.waitFor(`!!${tabRow("This tab")}`, { label: "tab row" });
    expect(
      await app.eval(
        `document.querySelector('[data-testid="screen-share-audio"]').checked`,
      ),
    ).toBe(true);
    await app.eval(`${tabRow("This tab")}.click(); true`);
    await confirm();
    await waitForResult("tab share result");
    expect(await title()).toBe("share:browser:1a:sized");
    await inGuest("stopShare(); true");

    await inGuest("share({ video: true, audio: true }); true");
    await waitForPicker();
    await app.waitFor(`!!${tabRow("This tab")}`, { label: "tab row" });
    await click('[data-testid="screen-share-audio"]');
    await app.eval(`${tabRow("This tab")}.click(); true`);
    await confirm();
    await waitForResult("silent tab share result");
    expect(await title()).toBe("share:browser:0a:sized");
    await inGuest("stopShare(); true");
    expect(app.getRendererErrors()).toEqual([]);
  });
});
