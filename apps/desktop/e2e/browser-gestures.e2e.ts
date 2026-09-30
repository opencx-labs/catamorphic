import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Two-finger history swipe: horizontal trackpad scroll that the page
 * cannot consume pulls the previous (or next) page in once it crosses a
 * threshold, with an arrow that grows along the way. A page that can
 * still scroll sideways keeps the gesture for itself.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url?.startsWith("/wide")) {
    response.end(
      `<title>Wide</title><body style="margin:0"><div id="wide" style="overflow-x:auto;width:300px"><div style="width:2000px;height:200px">wide</div></div></body>`,
    );
    return;
  }
  const page = request.url?.startsWith("/two") ? "Two" : "One";
  response.end(`<title>${page}</title><a id="next" href="/two">next</a>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/one`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = `document.querySelector('webview')`;
const ready = (title: string) =>
  app.waitFor(
    `(() => { const view = ${guest}; try { return view.getTitle() === '${title}' && !view.isLoading(); } catch { return false; } })()`,
    { label: `${title} ready` },
  );
const inGuest = (code: string) =>
  app.eval(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
/** Trackpad-like pixel wheel ticks, sent from the guest page's own world. */
const wheel = (deltaX: number, ticks: number, target = "document.body") =>
  inGuest(
    `for (let i = 0; i < ${ticks}; i++) ${target}.dispatchEvent(new WheelEvent('wheel', { deltaX: ${deltaX}, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true })); true`,
  );
const indicator = `document.querySelector('[data-testid="browser-swipe-indicator"]')`;
/**
 * A gesture ends 200ms after its last tick and takes its arrow with it,
 * which is about one poll of waitFor: record every arrow the host draws
 * instead of sampling the page and hoping to land inside that window.
 */
const recordArrows = () =>
  app.eval(`(() => {
    window.__swipeArrows = [];
    window.__swipeObserver?.disconnect();
    window.__swipeObserver = new MutationObserver(() => {
      const arrow = ${indicator};
      if (!arrow) return;
      window.__swipeArrows.push(arrow.dataset.direction);
      if (window.__swipeArrows.length > 20) window.__swipeArrows.shift();
    });
    window.__swipeObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-direction'] });
    return true;
  })()`);
const stopRecordingArrows = () =>
  app.eval(
    "window.__swipeObserver?.disconnect(); delete window.__swipeObserver; delete window.__swipeArrows; true",
  );

it("waits on the theme's background while a page loads, never white", async () => {
  await ready("One");
  expect(
    await app.eval(
      `getComputedStyle(${guest}.parentElement).backgroundColor === getComputedStyle(document.body).backgroundColor`,
    ),
  ).toBe(true);
});

describe("trackpad history gestures", () => {
  it("shows the back arrow as the gesture grows and navigates past the threshold", async () => {
    await ready("One");
    await inGuest("document.getElementById('next').click(); true");
    await ready("Two");
    await recordArrows();
    // Short of the threshold: the arrow shows, the page stays.
    await wheel(-40, 2);
    await app.waitFor("window.__swipeArrows.includes('back')", {
      label: "back arrow shown",
    });
    expect(await inGuest("document.title")).toBe("Two");
    // The gesture accumulates across batches: 80px, a pause shorter than
    // the 200ms idle that ends a gesture, then 160px, which alone is short
    // of the 220px threshold. The pause runs in the page, so its timer
    // fires before the gesture's idle timer and the two batches are one
    // gesture however slow the test host is.
    await inGuest(`(async () => {
      const tick = () => document.body.dispatchEvent(new WheelEvent('wheel', { deltaX: -40, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true }));
      tick(); tick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      tick(); tick(); tick(); tick();
      return true;
    })()`);
    await ready("One");
    await app.waitFor(`!${indicator}`, {
      label: "arrow gone after navigating",
    });
    await stopRecordingArrows();
  });

  it("forward works the same way, and a page with no history shows no arrow", async () => {
    await wheel(40, 7);
    await ready("Two");
    // Nothing further forward: swiping shows nothing.
    await wheel(40, 3);
    expect(await app.eval(`!!${indicator}`)).toBe(false);
  });

  it("a horizontally scrollable page keeps the gesture", async () => {
    await inGuest(`location.href = ${JSON.stringify(`${origin}/wide`)}; true`);
    await ready("Wide");
    await wheel(40, 7, "document.getElementById('wide')");
    expect(await app.eval(`!!${indicator}`)).toBe(false);
    expect(await inGuest("document.title")).toBe("Wide");
  });
});

it("a tab reopened with Cmd+Shift+T keeps its way back", async () => {
  await ready("Wide");
  // The tab reads its back list a beat after each navigation.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const press = (key: string, shiftKey = false) =>
    app.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, shiftKey: ${shiftKey}, metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true }))`,
    );
  await press("w");
  await app.waitFor(`!${guest}`, { label: "browser tab closed" });
  await press("T", true);
  await ready("Wide");
  expect(await app.eval(`${guest}.canGoBack()`)).toBe(true);
  await app.eval(`${guest}.goBack()`);
  await ready("Two");
  expect(await app.eval(`${guest}.canGoForward()`)).toBe(true);
});
