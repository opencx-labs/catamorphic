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

describe("trackpad history gestures", () => {
  it("shows the back arrow as the gesture grows and navigates past the threshold", async () => {
    await ready("One");
    await inGuest("document.getElementById('next').click(); true");
    await ready("Two");
    await wheel(-40, 2);
    await app.waitFor(`${indicator}?.dataset.direction === 'back'`, {
      label: "back arrow shown",
    });
    await wheel(-40, 5);
    await ready("One");
    await app.waitFor(`!${indicator}`, {
      label: "arrow gone after navigating",
    });
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
