import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extensionIdFromKey, keyHash } from "../src/main/extensions/crx.js";
import { buildCrx } from "../src/main/extensions/crx-builder.js";
import { type AppHandle, type FrameHandle, launchApp } from "./harness.js";

/**
 * Chrome extensions (ADR 0203). A test extension loaded unpacked runs its
 * content script and request rules in a tab, sets its badge, opens its
 * popup and side panel, sees the tab through chrome.tabs and hears its
 * events; turning it off and removing it take it away. A second extension
 * installs from a local stand-in for the Chrome Web Store: the store page
 * asks, Work shows its own dialog, then downloads and verifies a package
 * signed by the store's (test) key.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4z8DwnxLMMGrAqAHDxQAA2l8v8T9FSd0AAAAASUVORK5CYII=",
  "base64",
);

const TEST_EXTENSION: Record<string, string | Buffer> = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Work Test Extension",
    version: "1.0",
    description: "Exercises the extension APIs Work hosts.",
    icons: { 16: "icon.png", 48: "icon.png" },
    action: { default_popup: "popup.html", default_title: "Work Test" },
    background: { service_worker: "sw.js" },
    permissions: [
      "storage",
      "tabs",
      "contextMenus",
      "declarativeNetRequest",
      "sidePanel",
      "webNavigation",
      "nativeMessaging",
      "debugger",
      "identity",
      "tabGroups",
    ],
    optional_permissions: ["bookmarks"],
    host_permissions: ["http://127.0.0.1/*"],
    commands: {
      _execute_action: { suggested_key: { default: "Alt+Shift+P" } },
      "say-hello": {
        suggested_key: { default: "Alt+Shift+A" },
        description: "Say hello",
      },
    },
    side_panel: { default_path: "panel.html" },
    content_scripts: [
      {
        matches: ["http://127.0.0.1/*"],
        js: ["content.js"],
        run_at: "document_end",
      },
    ],
    declarative_net_request: {
      rule_resources: [{ id: "lab", enabled: true, path: "rules.json" }],
    },
  }),
  "icon.png": PNG,
  "rules.json": JSON.stringify([
    {
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: { urlFilter: "/blocked.js", resourceTypes: ["script"] },
    },
  ]),
  "sw.js": `
let writes = Promise.resolve();
const log = (entry) => {
  writes = writes
    .then(() => chrome.storage.local.get({ log: [] }))
    .then(({ log }) => chrome.storage.local.set({ log: [...log, entry].slice(-100) }));
};
chrome.runtime.onInstalled.addListener((details) => {
  log({ event: "installed", reason: details.reason });
  chrome.contextMenus.create({ id: "work-test", title: "Work Test: %s", contexts: ["selection"] });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.url) log({ event: "updated", tabId, url: tab.url });
});
chrome.tabs.onCreated.addListener((tab) => log({ event: "created", tabId: tab.id }));
chrome.tabs.onActivated.addListener(({ tabId }) => log({ event: "activated", tabId }));
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) log({ event: "navigated", url: details.url });
});
chrome.commands.onCommand.addListener((name, tab) => log({ event: "command", name, tabId: tab && tab.id }));
chrome.debugger.onDetach.addListener((source, reason) => log({ event: "detached", tabId: source.tabId, reason }));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === "who") {
    reply({ tab: sender.tab ? sender.tab.id : null, url: sender.url });
    return;
  }
  if (message.type !== "count") return;
  chrome.action.setBadgeText({ text: String(message.count), tabId: sender.tab.id });
  chrome.action.setBadgeBackgroundColor({ color: "#d63c0c" });
  reply({ ok: true });
});
`,
  "content.js": `
document.documentElement.dataset.workTest = "ran";
chrome.runtime.sendMessage({ type: "count", count: document.querySelectorAll("p").length });
`,
  "popup.html": `<!doctype html><html><body style="width:240px;margin:12px">
<p id="tab">…</p><p id="sync">…</p>
<button id="panel">Panel</button><button id="open">Open</button>
<script src="popup.js"></script></body></html>`,
  "popup.js": `
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  document.getElementById("tab").textContent = tab ? tab.url : "none";
  document.body.dataset.tabId = tab ? String(tab.id) : "";
});
chrome.storage.sync.set({ opened: true })
  .then(() => chrome.storage.sync.get("opened"))
  .then((value) => { document.getElementById("sync").textContent = "sync:" + value.opened; });
document.getElementById("panel").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
};
document.getElementById("open").onclick = async () => {
  const tab = await chrome.tabs.create({ url: document.body.dataset.next });
  document.body.dataset.created = String(tab.id);
};
`,
  "panel.html": `<!doctype html><html><body><h1>Work test panel</h1><p id="tab">…</p>
<script src="panel.js"></script></body></html>`,
  "panel.js": `
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  document.getElementById("tab").textContent = tab ? tab.url : "none";
});
`,
};

const STORE_EXTENSION: Record<string, string> = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Store Test Extension",
    version: "2.1",
    description: "Installs from the stand-in store.",
    permissions: ["storage", "notifications"],
    host_permissions: ["https://example.com/*"],
    action: { default_title: "Store Test" },
  }),
};

function writeFolder(dir: string, files: Record<string, string | Buffer>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
}

const developer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publisher = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = (key: crypto.KeyObject) =>
  key.export({ format: "der", type: "spki" }) as Buffer;
const storeId = extensionIdFromKey(spki(developer.publicKey));
const storeCrx = buildCrx({
  archive: Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(STORE_EXTENSION).map(([name, text]) => [
          name,
          strToU8(text),
        ]),
      ),
    ),
  ),
  developerKey: developer.privateKey,
  publisherKey: publisher.privateKey,
});

let app: AppHandle;
let origin: string;
let storeOrigin: string;
let work: string;
let extensionDir: string;
const headers: string[] = [];

const server = http.createServer((request, response) => {
  if (request.url === "/blocked.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end("window.blockedLoaded = true;");
    return;
  }
  if (request.url?.startsWith("/auth")) {
    // A sign-in page that hands the extension its code, as an OAuth
    // provider does: by redirecting to the extension's chromiumapp.org URL.
    const id = new URL(request.url, "http://lab").searchParams.get("ext");
    response.writeHead(302, {
      Location: `https://${id}.chromiumapp.org/done?code=granted`,
    });
    response.end();
    return;
  }
  if (request.url?.startsWith("/page"))
    headers.push(String(request.headers["sec-ch-ua"] ?? ""));
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Lab</title><p>one</p><p>two</p><p>three</p>
<script src="/blocked.js"></script>
<script>setTimeout(() => { document.title = window.blockedLoaded ? "Lab loaded" : "Lab blocked"; }, 200);</script>`);
});

// The stand-in store: a detail page that asks the way the real one does,
// the update service's answer, and the signed package.
const store = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://store");
  if (url.pathname === "/service/update2/crx") {
    response.setHeader("Content-Type", "text/xml");
    const wanted = url.searchParams
      .getAll("x")
      .map((x) => new URLSearchParams(x));
    response.end(
      `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">${wanted
        .map((query) => {
          const id = query.get("id");
          if (id !== storeId || query.get("v") === "2.1")
            return `<app appid="${id}" status="ok"><updatecheck status="noupdate"/></app>`;
          return `<app appid="${id}" status="ok"><updatecheck codebase="${storeOrigin}/package.crx" hash_sha256="${crypto.createHash("sha256").update(storeCrx).digest("hex")}" size="${storeCrx.length}" status="ok" version="2.1"/></app>`;
        })
        .join("")}</gupdate>`,
    );
    return;
  }
  if (url.pathname === "/package.crx") {
    response.setHeader("Content-Type", "application/x-chrome-extension");
    response.end(storeCrx);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Store</title><button id="add">Add to Chrome</button><script>
    window.install = async () => {
      const result = await chrome.webstorePrivate.beginInstallWithManifest3({
        id: ${JSON.stringify(storeId)},
        manifest: ${JSON.stringify(STORE_EXTENSION["manifest.json"])},
        localizedName: "Store Test Extension",
      });
      document.title = "begin:" + result;
      if (result !== "success") return;
      const done = await chrome.webstorePrivate.completeInstall(${JSON.stringify(storeId)});
      document.title = "done:" + done + ":" + await chrome.webstorePrivate.getExtensionStatus(${JSON.stringify(storeId)});
    };
  </script>`);
});

const listen = async (target: http.Server) => {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
};

beforeAll(async () => {
  origin = await listen(server);
  storeOrigin = await listen(store);
  work = fs.mkdtempSync(path.join(os.tmpdir(), "work-extensions-"));
  extensionDir = path.join(work, "work-test-extension");
  writeFolder(extensionDir, TEST_EXTENSION);
  fs.writeFileSync(path.join(work, "pick"), extensionDir);
  app = await launchApp({
    urls: [`${origin}/page`],
    sandboxedRenderers: true,
    env: {
      CATAMORPHIC_E2E_PICK_FILE: path.join(work, "pick"),
      CATAMORPHIC_E2E_WEBSTORE_ORIGIN: storeOrigin,
      CATAMORPHIC_E2E_WEBSTORE_UPDATE_URL: `${storeOrigin}/service/update2/crx`,
      CATAMORPHIC_E2E_WEBSTORE_PUBLISHER_KEY_HASH: keyHash(
        spki(publisher.publicKey),
      ),
    },
  });
});

afterAll(async () => {
  await app?.stop();
  server.close();
  store.close();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

const click = (selector: string) =>
  app.eval(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`,
  );
const pageView = `[...document.querySelectorAll('webview')].find((view) => (view.getAttribute('src') || '').includes('/page'))`;
const guestTitle = () =>
  app.eval<string>(
    `(() => { try { return ${pageView}?.getTitle() ?? ''; } catch { return ''; } })()`,
  );
/** Alt+Shift+key typed into the page, through main's before-input-event. */
const typeInPage = (keyCode: string) =>
  app.eval(
    `(() => { const view = ${pageView}; view.focus(); view.sendInputEvent({ type: 'keyDown', keyCode: '${keyCode}', modifiers: ['alt', 'shift'] }); view.sendInputEvent({ type: 'keyUp', keyCode: '${keyCode}', modifiers: ['alt', 'shift'] }); return true; })()`,
  );
const inPage = (code: string) =>
  app.eval(`${pageView}.executeJavaScript(${JSON.stringify(code)}, true)`);
const openPalettePage = async (label: string) => {
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'p', bubbles: true, cancelable: true,
    ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  await app.waitFor(
    `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].some((el) => document.activeElement === el)`,
    { label: "palette open" },
  );
  await app.insertText(label);
  await app.waitFor(
    `document.activeElement.closest('[role="dialog"]')?.querySelector('[role="option"]')?.textContent.startsWith(${JSON.stringify(label)})`,
    { label: `${label} row first` },
  );
  await app.press("Enter");
};
const card = `document.querySelector('[data-testid="extension-card"]')`;
/** The first browser tab in the strip (its titled button, not its close). */
const selectFirstBrowserTab = async () => {
  const selected = await app.eval<boolean>(`(() => {
    const item = document.querySelector('[data-point-key^="browser:"]');
    const button = [...(item?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().length > 0);
    button?.click();
    return Boolean(button);
  })()`);
  expect(selected).toBe(true);
};
let extensionId = "";
let popup: FrameHandle | null = null;

describe("an unpacked extension", () => {
  it("loads from developer mode, and can't ask for more out of the blue", async () => {
    await app.waitFor(
      `(() => { try { return ${pageView}?.getTitle() === 'Lab blocked' || ${pageView}?.getTitle() === 'Lab loaded'; } catch { return false; } })()`,
      { label: "page loaded" },
    );
    // Before any extension, the page's script loads.
    expect(await guestTitle()).toBe("Lab loaded");
    await openPalettePage("Extensions");
    await app.waitFor(
      `document.querySelector('[data-testid="extensions-developer-mode"]')?.disabled === false`,
      { label: "extensions page loaded" },
    );
    await click('[data-testid="extensions-developer-mode"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="extensions-load-unpacked"]')`,
      { label: "developer mode on" },
    );
    await click('[data-testid="extensions-load-unpacked"]');
    await app.waitFor(
      `${card}?.querySelector('[data-testid="extension-card-name"]')?.textContent === 'Work Test Extension'`,
      { label: "extension listed" },
    );
    extensionId = await app.eval<string>(`${card}.dataset.extensionId`);
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(await app.eval(`${card}.dataset.enabled`)).toBe("true");
    // Pin it, then go back to the page and reload it: the content script,
    // the badge it asked for and the blocked script all show.
    // On and off is a switch; pinning is the card's pin button.
    expect(
      await app.eval(
        `${card}.querySelector('[data-testid="extension-card-enabled"]').getAttribute('role')`,
      ),
    ).toBe("switch");
    await click('[data-testid="extension-card-pin"]');
    await app.waitFor(
      `${card}.querySelector('[data-testid="extension-card-pin"]').getAttribute('aria-pressed') === 'true'`,
      { label: "pinned" },
    );
    // Nothing the person did asks for it yet: as in Chrome, it may not ask.
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    // Electron fires no runtime.onInstalled; Work does, once per version,
    // and the managed storage area exists (empty, as without policy).
    await worker.waitFor(
      `chrome.storage.local.get('log').then(({ log }) => (log || []).some((entry) => entry.event === 'installed' && entry.reason === 'install'))`,
      { label: "runtime.onInstalled delivered" },
    );
    expect(
      await worker.eval(
        "chrome.storage.managed.get().then((v) => JSON.stringify(v))",
      ),
    ).toBe("{}");
    expect(
      await worker.eval(
        "chrome.permissions.request({ permissions: ['bookmarks'] }).then(() => 'asked', (error) => error.message)",
      ),
    ).toContain("user gesture");
    worker.close();
  });

  it("blocks requests, sets the brand headers and shows its badge", async () => {
    // The profile's workspace shows one surface at a time: the tab's page
    // comes back when the tab does.
    await selectFirstBrowserTab();
    await app.waitFor(
      `(() => { try { return ${pageView}?.getTitle() === 'Lab blocked'; } catch { return false; } })()`,
      { label: "page back" },
    );
    headers.length = 0;
    // A marker the reload clears, so the waits below see the new document.
    await inPage("document.title = 'Reloading'; true");
    await app.eval(`${pageView}.reload(); true`);
    await app.waitFor(
      `(() => { try { return ${pageView}?.getTitle() === 'Lab blocked'; } catch { return false; } })()`,
      { label: "script blocked by the extension's rules" },
    );
    // The new document's request reached the lab with its headers.
    expect(headers.length).toBeGreaterThan(0);
    expect(await inPage("document.documentElement.dataset.workTest")).toBe(
      "ran",
    );
    // The brand rewrite moved to the hidden extension and still applies.
    expect(headers.at(-1)).toContain('"Google Chrome"');
    await app.waitFor(
      `document.querySelector('[data-testid="extension-action"][data-extension-id="${extensionId}"] [data-testid="extension-badge"]')?.textContent === '3'`,
      { label: "badge shows the paragraph count" },
    );
  });

  it("opens its popup, which sees the tab and storage.sync", async () => {
    await click(
      `[data-testid="extension-action"][data-extension-id="${extensionId}"]`,
    );
    await app.waitFor(
      `!!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "popup shown",
      },
    );
    popup = await app.connectToFrame(`${extensionId}/popup.html`);
    await popup.waitFor(
      `document.getElementById('tab').textContent === ${JSON.stringify(`${origin}/page`)}`,
      { label: "popup reads the active tab" },
    );
    await popup.waitFor(
      `document.getElementById('sync').textContent === 'sync:true'`,
      {
        label: "storage.sync round trip",
      },
    );
    // To its worker the popup is its own page, not a tab, as in Chrome
    // (Electron names a tab for any page in a webview); a content script
    // still comes from its tab (the badge above).
    const sender = await popup.eval<{ tab: number | null; url: string }>(
      "chrome.runtime.sendMessage({ type: 'who' })",
    );
    expect(sender.tab).toBeNull();
    expect(sender.url).toContain("/popup.html");
    // It sized itself to its page (240px body + margins).
    const width = await app.eval<number>(
      `document.querySelector('[data-testid="extension-popup"]').getBoundingClientRect().width`,
    );
    expect(width).toBeGreaterThan(250);
    expect(width).toBeLessThan(300);
    // Escape closes it, as in Chrome; the next click opens it again.
    await app.press("Escape");
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "popup closed on Escape",
      },
    );
    popup.close();
    await click(
      `[data-testid="extension-action"][data-extension-id="${extensionId}"]`,
    );
    await app.waitFor(
      `!!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "popup shown again",
      },
    );
    popup = await app.connectToFrame(`${extensionId}/popup.html`);
    await popup.waitFor(
      `document.getElementById('sync').textContent === 'sync:true'`,
    );
  });

  it("creates a tab with chrome.tabs.create", async () => {
    if (!popup) throw new Error("No popup");
    const before = await app.eval<number>(
      `document.querySelectorAll('webview').length`,
    );
    await popup.eval(
      `document.body.dataset.next = ${JSON.stringify(`${origin}/page?second`)}; document.getElementById('open').click(); true`,
    );
    await popup.waitFor(`!!document.body.dataset.created`, {
      label: "tab created",
    });
    await app.waitFor(
      `[...document.querySelectorAll('webview')].some((view) => (view.getAttribute('src') || '').endsWith('/page?second')) && document.querySelectorAll('webview').length > ${before}`,
      { label: "new tab in the workspace" },
    );
    popup.close();
    popup = null;
  });

  it("hears tab events in its service worker", async () => {
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    const logged = (condition: string, label: string) =>
      worker
        .waitFor(
          `chrome.storage.local.get('log').then(({ log }) => (log || []).some((entry) => ${condition}))`,
          { label },
        )
        .catch(async (error: unknown) => {
          const log = await worker.eval(
            "chrome.storage.local.get('log').then(({ log }) => JSON.stringify(log))",
          );
          throw new Error(`${String(error)}; log: ${String(log)}`);
        });
    await logged("entry.event === 'created'", "tabs.onCreated");
    await logged(
      "entry.event === 'updated' && entry.url.endsWith('/page?second')",
      "tabs.onUpdated",
    );
    await logged("entry.event === 'navigated'", "webNavigation.onCompleted");
    const tabs = await worker.eval<{ url: string; active: boolean }[]>(
      `chrome.tabs.query({}).then((tabs) => tabs.map(({ url, active }) => ({ url, active })))`,
    );
    expect(tabs.map((tab) => tab.url)).toEqual(
      expect.arrayContaining([`${origin}/page`, `${origin}/page?second`]),
    );
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    const windows = await worker.eval<number>(
      `chrome.windows.getAll().then((windows) => windows.length)`,
    );
    expect(windows).toBe(1);
    worker.close();
  });

  it("opens its side panel beside the tab", async () => {
    // Back to the first tab, open the popup, ask for the panel.
    await selectFirstBrowserTab();
    await click(
      `[data-testid="extension-action"][data-extension-id="${extensionId}"]`,
    );
    const frame = await app.connectToFrame(`${extensionId}/popup.html`);
    await frame.waitFor(
      `document.body.dataset.tabId !== undefined && document.body.dataset.tabId !== ''`,
    );
    await frame.eval(`document.getElementById('panel').click(); true`);
    frame.close();
    await app.waitFor(
      `!!document.querySelector('[data-testid="extension-side-panel"][data-extension-id="${extensionId}"]')`,
      { label: "side panel open" },
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "popup closed itself",
      },
    );
    const panel = await app.connectToFrame(`${extensionId}/panel.html`);
    await panel.waitFor(
      `document.getElementById('tab').textContent === ${JSON.stringify(`${origin}/page`)}`,
      { label: "panel reads its tab" },
    );
    panel.close();
    await click('[data-testid="extension-side-panel-close"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-side-panel"]')`,
      {
        label: "side panel closed",
      },
    );
  });

  it("runs its keyboard shortcuts from the page", async () => {
    await selectFirstBrowserTab();
    await app.waitFor(
      `(() => { try { return ${pageView}?.getTitle() === 'Lab blocked'; } catch { return false; } })()`,
      { label: "page back" },
    );
    // Keys typed into the page, through main's before-input-event: the
    // command's own shortcut, then the action's.
    await typeInPage("A");
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    await worker.waitFor(
      `chrome.storage.local.get('log').then(({ log }) => (log || []).some((entry) => entry.event === 'command' && entry.name === 'say-hello'))`,
      { label: "command reached the worker" },
    );
    expect(
      await worker.eval(
        "chrome.commands.getAll().then((commands) => commands.map((command) => command.name + '=' + command.shortcut).sort().join(','))",
      ),
    ).toBe("_execute_action=Alt+Shift+P,say-hello=Alt+Shift+A");
    worker.close();
    await typeInPage("P");
    await app.waitFor(
      `!!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "action shortcut opens the popup",
      },
    );
    const shortcutPopup = await app.connectToFrame(`${extensionId}/popup.html`);
    await shortcutPopup.waitFor("document.hasFocus()", {
      label: "popup took focus from the page",
    });
    shortcutPopup.close();
    // Escape reaching the page closes it too: a loading page can take
    // focus back from a popup.
    await app.eval(
      `(() => { const view = ${pageView}; view.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); view.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); return true; })()`,
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "Escape in the page closes the popup",
      },
    );
    await typeInPage("P");
    await app.waitFor(
      `!!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "action shortcut opens the popup again",
      },
    );
    // A click back in the page closes it.
    await app.eval(
      `(() => { const view = ${pageView}; for (const type of ['mouseDown', 'mouseUp']) view.sendInputEvent({ type, x: 40, y: 40, button: 'left', clickCount: 1 }); return true; })()`,
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-popup"]')`,
      {
        label: "popup closed when the page took focus",
      },
    );
  });

  it("asks before an optional permission and then offers its API", async () => {
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    expect(await worker.eval("typeof chrome.bookmarks")).toBe("undefined");
    // Right after the person ran one of its commands, it may ask (out of
    // the blue it may not: see the first test).
    await typeInPage("A");
    const granted = worker.eval(
      "chrome.permissions.request({ permissions: ['bookmarks'] })",
    );
    await app.waitFor(
      `document.querySelector('[data-testid="extension-prompt"]')?.dataset.kind === 'permissions'`,
      { label: "permission prompt" },
    );
    expect(
      await app.eval<string>(
        `document.querySelector('[data-testid="extension-prompt-warnings"]').textContent`,
      ),
    ).toContain("Read and change your bookmarks");
    await click('[data-testid="extension-prompt-accept"]');
    expect(await granted).toBe(true);
    await worker.waitFor("typeof chrome.bookmarks === 'object'", {
      label: "bookmarks API installed",
    });
    expect(
      await worker.eval(
        "chrome.bookmarks.getTree().then(([root]) => root.children.map((child) => child.title).join(','))",
      ),
    ).toBe("Bookmarks bar,Other bookmarks");
    expect(
      await worker.eval(
        "chrome.permissions.contains({ permissions: ['bookmarks'] })",
      ),
    ).toBe(true);
    worker.close();
  });

  it("drives a tab through the debugger while the tab says so", async () => {
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    const title = await worker.eval(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      return result.result.value;
    })()`);
    expect(title).toBe("Lab blocked");
    await app.waitFor(
      `document.querySelector('[data-testid="extension-debugging"]')?.textContent.includes('Work Test Extension')`,
      { label: "debugging bar" },
    );
    expect(
      await worker.eval(`(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return chrome.debugger.sendCommand({ tabId: tab.id }, 'Target.createTarget', { url: 'about:blank' }).then(() => 'ran', (error) => error.message);
      })()`),
    ).toBe("Target.createTarget is not allowed");
    await click('[data-testid="extension-debugging-stop"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-debugging"]')`,
      {
        label: "bar gone after Stop",
      },
    );
    await worker.waitFor(
      `chrome.storage.local.get('log').then(({ log }) => (log || []).some((entry) => entry.event === 'detached' && entry.reason === 'canceled_by_user'))`,
      { label: "extension told it was stopped" },
    );
    // A page that leaves the web (here for the store, which no extension
    // may drive) ends the session before the store loads.
    await app.eval(`window.__labView = ${pageView}; true`);
    await worker.eval(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      // Navigating after the command answers: the session ends with it.
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: ${JSON.stringify(`setTimeout(() => { location.href = ${JSON.stringify(`${storeOrigin}/`)}; }, 50); true`)} });
      return true;
    })()`);
    await worker.waitFor(
      `chrome.storage.local.get('log').then(({ log }) => (log || []).some((entry) => entry.event === 'detached' && entry.reason === 'target_closed'))`,
      { label: "session ended when the page left the web" },
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-debugging"]')`,
      { label: "bar gone when the page left the web" },
    );
    await app.waitFor(
      `(() => { try { return window.__labView.getTitle() === 'Store'; } catch { return false; } })()`,
      { label: "the store loaded" },
    );
    await app.eval("window.__labView.goBack(); true");
    await app.waitFor(
      `(() => { try { return window.__labView.getTitle() === 'Lab blocked'; } catch { return false; } })()`,
      { label: "back on the lab page" },
    );
    worker.close();
  });

  it("signs in through launchWebAuthFlow and groups tabs", async () => {
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    expect(
      await worker.eval(
        `chrome.identity.launchWebAuthFlow({ url: ${JSON.stringify(`${origin}/auth`)} + '?ext=' + chrome.runtime.id, interactive: true })`,
      ),
    ).toBe(`https://${extensionId}.chromiumapp.org/done?code=granted`);
    expect(
      await worker.eval(`(async () => {
        const tabs = await chrome.tabs.query({});
        const groupId = await chrome.tabs.group({ tabIds: tabs.map((tab) => tab.id) });
        await chrome.tabGroups.update(groupId, { title: 'Work', color: 'orange' });
        const group = await chrome.tabGroups.get(groupId);
        const grouped = await chrome.tabs.query({ groupId });
        return group.title + ':' + group.color + ':' + (grouped.length === tabs.length);
      })()`),
    ).toBe("Work:orange:true");
    worker.close();
  });

  it("talks to a native host registered for it", async () => {
    // A host that echoes each message, registered in Work's own folder for
    // this extension only, as an app's installer would.
    const host = path.join(work, "echo-host.mjs");
    fs.writeFileSync(
      host,
      `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
    buffer = buffer.subarray(4 + length);
    const body = Buffer.from(JSON.stringify({ echo: message, origin: process.argv[2] }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([header, body]));
  }
});
`,
    );
    fs.chmodSync(host, 0o755);
    const hosts = path.join(app.userDataDir, "NativeMessagingHosts");
    fs.mkdirSync(hosts, { recursive: true });
    fs.writeFileSync(
      path.join(hosts, "com.work.echo.json"),
      JSON.stringify({
        name: "com.work.echo",
        description: "Echo",
        path: host,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }),
    );
    fs.writeFileSync(
      path.join(hosts, "com.work.other.json"),
      JSON.stringify({
        name: "com.work.other",
        path: host,
        type: "stdio",
        allowed_origins: [
          "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/",
        ],
      }),
    );
    const worker = await app.connectToFrame(`${extensionId}/sw.js`);
    expect(
      await worker.eval(
        `chrome.runtime.sendNativeMessage('com.work.echo', { ping: 1 })`,
      ),
    ).toEqual({
      echo: { ping: 1 },
      origin: `chrome-extension://${extensionId}/`,
    });
    expect(
      await worker.eval(`new Promise((resolve) => {
        const port = chrome.runtime.connectNative('com.work.echo');
        port.onMessage.addListener((message) => { port.disconnect(); resolve(message.echo); });
        port.postMessage({ over: 'port' });
      })`),
    ).toEqual({ over: "port" });
    expect(
      await worker.eval(
        `chrome.runtime.sendNativeMessage('com.work.other', {}).then(() => 'answered', (error) => error.message)`,
      ),
    ).toBe("Access to the specified native messaging host is forbidden.");
    worker.close();
  });

  it("unpins and pins again from the toolbar's extensions menu", async () => {
    await selectFirstBrowserTab();
    // Hidden tabs keep their toolbars, as they last were: this tab's counts.
    const button = `[...document.querySelectorAll('[data-testid="extension-action"][data-extension-id="${extensionId}"]')].find((node) => node.checkVisibility({ visibilityProperty: true }))`;
    const menuPin = `document.querySelector('[data-testid="extensions-menu"] [data-testid="extensions-menu-item"][data-extension-id="${extensionId}"]')?.parentElement.querySelector('[data-testid="extensions-menu-pin"]')`;
    await app.waitFor(`!!${button}`, { label: "pinned button in the toolbar" });
    await click('[data-testid="extensions-button"]');
    await app.waitFor(`${menuPin}?.getAttribute('aria-pressed') === 'true'`, {
      label: "menu shows it pinned",
    });
    await app.eval(`${menuPin}.click(); true`);
    await app.waitFor(`!${button}`, { label: "unpinned from the toolbar" });
    await app.waitFor(`${menuPin}?.getAttribute('aria-pressed') === 'false'`);
    await app.eval(`${menuPin}.click(); true`);
    await app.waitFor(`!!${button}`, { label: "pinned again" });
    await app.press("Escape");
  });

  it("turns off and is removed after the person confirms", async () => {
    await openPalettePage("Extensions");
    await app.waitFor(`!!${card}`, { label: "extensions page again" });
    await click('[data-testid="extension-card-enabled"]');
    await app.waitFor(`${card}.dataset.enabled === 'false'`, {
      label: "turned off",
    });
    await app.waitFor(
      `!document.querySelector('[data-testid="extension-action"][data-extension-id="${extensionId}"]')`,
      { label: "toolbar button gone" },
    );
    await click('[data-testid="extension-card-remove"]');
    await app.waitFor(
      `document.querySelector('[data-testid="extension-prompt"]')?.dataset.kind === 'remove'`,
      { label: "remove confirmation" },
    );
    await click('[data-testid="extension-prompt-accept"]');
    await app.waitFor(`!${card}`, { label: "extension removed" });
    // The folder it loaded from is the developer's and stays.
    expect(fs.existsSync(path.join(extensionDir, "manifest.json"))).toBe(true);
    expect(app.getRendererErrors()).toEqual([]);
  });
});

describe("a Chrome Web Store install", () => {
  it("asks with Work's dialog, then installs the verified package", async () => {
    await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    })); true`);
    await app.waitFor(
      `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].some((el) => document.activeElement === el)`,
      { label: "palette open" },
    );
    await app.insertText(`${storeOrigin}/detail/store-test`);
    await app.waitFor(
      `!!document.activeElement.closest('[role="dialog"]')?.querySelector('[role="option"]')`,
      { label: "address row" },
    );
    await app.press("Enter");
    const storeView = `[...document.querySelectorAll('webview')].find((view) => (view.getAttribute('src') || '').startsWith(${JSON.stringify(storeOrigin)}))`;
    await app.waitFor(
      `(() => { try { return ${storeView}?.getTitle() === 'Store'; } catch { return false; } })()`,
      { label: "store page loaded" },
    );
    expect(
      await app.eval(
        // No gesture: one would leave the page activated for the next call.
        `${storeView}.executeJavaScript('typeof chrome.webstorePrivate', false)`,
      ),
    ).toBe("object");
    // A script on the page can't start an install by itself.
    expect(
      await app.eval<string>(
        `${storeView}.executeJavaScript("chrome.webstorePrivate.beginInstallWithManifest3({ id: 'x', manifest: '{}' })", false)`,
      ),
    ).toBe("user_gesture_required");
    await app.eval(`${storeView}.executeJavaScript('install(); true', true)`);
    await app.waitFor(
      `document.querySelector('[data-testid="extension-prompt"]')?.dataset.kind === 'install'`,
      { label: "install dialog" },
    );
    const warnings = await app.eval<string>(
      `document.querySelector('[data-testid="extension-prompt-warnings"]').textContent`,
    );
    expect(warnings).toContain("Read and change your data on example.com");
    expect(warnings).toContain("Display notifications");
    await click('[data-testid="extension-prompt-accept"]');
    await app.waitFor(
      `(() => { try { return ${storeView}.getTitle(); } catch { return ''; } })() === 'done:success:enabled'`,
      { label: "store sees it installed", timeoutMs: 30_000 },
    );
    await app.waitFor(
      `!!document.querySelector('[data-testid="extension-installed"]')`,
      {
        label: "installed notice",
      },
    );
    await openPalettePage("Extensions");
    await app.waitFor(
      `[...document.querySelectorAll('[data-testid="extension-card"]')].some((card) => card.dataset.extensionId === ${JSON.stringify(storeId)})`,
      { label: "store extension listed" },
    );
    // The installed copy carries the developer key, so its id is the store's.
    const installed = path.join(app.userDataDir, "profiles");
    const manifests = fs
      .readdirSync(installed, { recursive: true, encoding: "utf8" })
      .filter((file) =>
        file.endsWith(path.join(storeId, "2.1_0", "manifest.json")),
      );
    expect(manifests).toHaveLength(1);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(installed, manifests[0] ?? ""), "utf8"),
    ) as { key?: string };
    expect(extensionIdFromKey(Buffer.from(manifest.key ?? "", "base64"))).toBe(
      storeId,
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
