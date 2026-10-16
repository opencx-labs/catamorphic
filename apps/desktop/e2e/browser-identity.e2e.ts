import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * A page meets Chrome: the request's User-Agent and, in JavaScript, the
 * user agent and its client hints are Chrome's, down to the reduced UA's
 * version (major.0.0.0) and the real full version in the hints that ask
 * for it, and Chrome's `window.chrome`, in the page and in a frame from
 * another origin. Google's supported-browser gate reads these. (Client
 * hint headers ride secure origins only, which this local server isn't.)
 */
let app: AppHandle;
let origin: string;
const requests: { url: string; userAgent: string }[] = [];
const server = http.createServer((request, response) => {
  requests.push({
    url: request.url ?? "",
    userAgent: String(request.headers["user-agent"] ?? ""),
  });
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/frame") {
    // Reports what a frame from another origin sees of the browser.
    response.end(`<script>
      parent.postMessage({
        members: Object.keys(window.chrome),
        app: typeof window.chrome.app,
        brands: navigator.userAgentData.brands.map((entry) => entry.brand),
      }, "*");
    </script>`);
    return;
  }
  // localhost, not 127.0.0.1: the frame is another site, in its own process.
  const frame = origin.replace("127.0.0.1", "localhost");
  response.end(`<title>Identity</title><p>who am I</p>
    <script>addEventListener("message", (event) => { window.frameReport = event.data; });</script>
    <iframe src="${frame}/frame"></iframe>`);
});
const view = `document.querySelector('webview')`;
const inGuest = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Identity lab',
    rootPath: ${JSON.stringify(`${app.userDataDir}/identity-lab`)}
  })`);
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Identity lab')`, {
    timeoutMs: 30_000,
    label: "project workspace",
  });
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', altKey: true, bubbles: true, cancelable: true,
    ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  await app.waitFor(
    `!!document.querySelector('input[aria-label="Address and search bar"]')`,
    { timeoutMs: 30_000, label: "browser address bar" },
  );
  await app.eval(`(() => {
    const input = document.querySelector('input[aria-label="Address and search bar"]');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`${origin}/identity`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await app.waitFor(
    `(() => { const page = ${view}; try { return page.getTitle() === 'Identity' && !page.isLoading(); } catch { return false; } })()`,
    { label: "identity page" },
  );
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("a page's view of the browser", () => {
  it("is Chrome's, in the request and in JavaScript", async () => {
    const chrome = /Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/;
    // The document's own request, not the favicon's.
    const request = requests
      .filter((entry) => entry.url === "/identity")
      .at(-1);
    expect(request?.userAgent).toMatch(chrome);
    expect(request?.userAgent).not.toMatch(/Electron|Work|catamorphic/i);
    const major = chrome.exec(request?.userAgent ?? "")?.[1];

    const page = await inGuest<{
      userAgent: string;
      brands: string[];
      json: string[];
      fullVersions: { brand: string; version: string }[];
    }>(`(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((entry) => entry.brand + '/' + entry.version),
      json: JSON.parse(JSON.stringify(navigator.userAgentData)).brands.map((entry) => entry.brand + '/' + entry.version),
      fullVersions: (await navigator.userAgentData.getHighEntropyValues(['fullVersionList'])).fullVersionList,
    }))()`);
    expect(page.userAgent).toBe(request?.userAgent);
    expect(page.brands).toContain(`Google Chrome/${major}`);
    // Serialized, it says the same (toJSON reads Chromium's own list).
    expect(page.json).toEqual(page.brands);
    const full = page.fullVersions.find(
      (entry) => entry.brand === "Google Chrome",
    )?.version;
    // The real version, not the reduced UA's zeros.
    expect(full).toMatch(new RegExp(`^${major}\\.0\\.[1-9]\\d*\\.\\d+$`));
  });

  // Google's sign-in turns away a browser that says it is Chrome without
  // `chrome.app` ("This browser or app may not be secure", ADR 0235), and
  // Electron's `window.chrome` is empty. The live check is
  // google-sign-in.e2e.ts.
  it("has Chrome's window.chrome", async () => {
    const page = await inGuest<{
      members: string[];
      app: string[];
      answers: unknown[];
      json: string;
      loadTimes: string[];
      csi: string[];
      loaded: boolean;
      functions: { name: string; own: string[]; native: boolean }[];
    }>(`(() => {
      const { app, loadTimes, csi } = window.chrome;
      const times = loadTimes();
      return {
        members: Object.keys(window.chrome),
        app: Object.keys(app),
        answers: [app.isInstalled, app.getDetails(), app.getIsInstalled(), app.runningState()],
        json: JSON.stringify(app),
        loadTimes: Object.keys(times),
        csi: Object.keys(csi()),
        loaded: times.finishLoadTime > times.requestTime,
        functions: [app.getDetails, loadTimes, csi].map((fn) => ({
          name: fn.name,
          own: Object.getOwnPropertyNames(fn).sort(),
          native: Function.prototype.toString.call(fn).includes('[native code]'),
        })),
      };
    })()`);
    expect(page.members).toEqual(["loadTimes", "csi", "app"]);
    expect(page.app).toEqual([
      "isInstalled",
      "getDetails",
      "getIsInstalled",
      "installState",
      "runningState",
      "InstallState",
      "RunningState",
    ]);
    expect(page.answers).toEqual([false, null, false, "cannot_run"]);
    expect(page.json).toBe(
      '{"isInstalled":false,"InstallState":{"DISABLED":"disabled","INSTALLED":"installed","NOT_INSTALLED":"not_installed"},"RunningState":{"CANNOT_RUN":"cannot_run","READY_TO_RUN":"ready_to_run","RUNNING":"running"}}',
    );
    expect(page.loadTimes).toEqual([
      "requestTime",
      "startLoadTime",
      "commitLoadTime",
      "finishDocumentLoadTime",
      "finishLoadTime",
      "firstPaintTime",
      "firstPaintAfterLoadTime",
      "navigationType",
      "wasFetchedViaSpdy",
      "wasNpnNegotiated",
      "npnNegotiatedProtocol",
      "wasAlternateProtocolAvailable",
      "connectionInfo",
    ]);
    expect(page.csi).toEqual(["startE", "onloadT", "pageT", "tran"]);
    expect(page.loaded).toBe(true);
    // Chrome's methods are named and have no prototype; loadTimes and csi
    // are anonymous constructors. None owns arguments or caller, and all
    // read as native code.
    expect(page.functions).toEqual([
      { name: "getDetails", own: ["length", "name"], native: true },
      { name: "", own: ["length", "name", "prototype"], native: true },
      { name: "", own: ["length", "name", "prototype"], native: true },
    ]);
  });

  it("is Chrome's in a frame from another origin, too", async () => {
    await app.waitFor(
      `${view}.executeJavaScript('!!window.frameReport', true)`,
      { label: "the frame's report" },
    );
    const frame = await inGuest<{
      members: string[];
      app: string;
      brands: string[];
    }>("window.frameReport");
    expect(frame.members).toEqual(["loadTimes", "csi", "app"]);
    expect(frame.app).toBe("object");
    expect(frame.brands).toContain("Google Chrome");
  });
});
