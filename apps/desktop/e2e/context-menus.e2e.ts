import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  pointerOnPage,
  setReactValueJs,
} from "./harness.js";

/**
 * Menus hold the window while open, as native menus do (ADR 0221): a press
 * anywhere else, a web page included, only closes them, and a menu goes
 * with the sidebar row it belongs to. Every bookmark edits its name and
 * address in one dialog. A page's right-click names what was clicked (a
 * link, an email address, an image, selected text, a text field, the
 * page) and the window draws that menu where the click was.
 */
let app: AppHandle;
let origin: string;
const IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#e8a33d"/></svg>`;
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/cat.svg")) {
    response.setHeader("Content-Type", "image/svg+xml");
    response.end(IMAGE);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  if (request.url?.startsWith("/next")) {
    response.end("<title>Next page</title><p>Next</p>");
    return;
  }
  response.end(`<title>Menu lab</title>
<body style="font:16px sans-serif;margin:0;padding:24px;height:1400px">
  <p id="text">Catamorphisms fold any structure into one value.</p>
  <p><a id="link" href="/next">A link</a></p>
  <p><a id="mail" href="mailto:ada@example.test?subject=Hello">Write to Ada</a></p>
  <p><a id="phone" href="tel:+15550100">Call the desk</a></p>
  <p><img id="image" src="/cat.svg" width="80" height="60" alt="Cat"></p>
  <p><input id="field" value="" style="width:260px"></p>
  <p id="blank" style="height:120px"></p>
  <script>
    window.__presses = 0;
    addEventListener('pointerdown', () => { window.__presses += 1; }, true);
  </script>
</body>`);
});

const mac = process.platform === "darwin";
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
const view = `[...document.querySelectorAll('webview')].find(w => w.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
const inPage = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);
const loaded = (title: string) =>
  app.waitFor(
    `(() => { const page = ${view}; try { return page.getTitle() === ${JSON.stringify(title)} && !page.isLoading(); } catch { return false; } })()`,
    { label: `${title} loaded`, timeoutMs: 30_000 },
  );
/** Where an element of the page is, in window coordinates. */
const pagePoint = async (selector: string, dx = 0.5, dy = 0.5) => {
  const box = await inPage<{ x: number; y: number }>(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.left + box.width * ${dx}, y: box.top + box.height * ${dy} };
  })()`);
  const page = await app.eval<{ x: number; y: number; zoom: number }>(
    `(() => { const page = ${view}; const box = page.getBoundingClientRect(); return { x: box.left, y: box.top, zoom: page.getZoomFactor() }; })()`,
  );
  return {
    x: Math.round(page.x + box.x * page.zoom),
    y: Math.round(page.y + box.y * page.zoom),
  };
};
const mouse = async (
  point: { x: number; y: number },
  button: "left" | "right",
) => {
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button,
      clickCount: 1,
    });
};
const menu = "document.querySelector('[data-sidebar-menu]')";
/** The open menu's entries: label, and whether it can be picked. */
const entries = () =>
  app.eval<string[]>(
    `[...${menu}.querySelectorAll('button, hr')].map(node => node.tagName === 'HR' ? '—' : node.disabled ? node.textContent.trim() + ' (off)' : node.textContent.trim())`,
  );
/**
 * The open menu has a corner at the pointer: it extends right and down from
 * it, or flips left or up where the window ends.
 */
const expectAtPointer = async (point: { x: number; y: number }) => {
  const box = await app.eval<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>(
    `(() => { const r = ${menu}.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`,
  );
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  expect(
    near(box.left, point.x) || near(box.right, point.x),
    `menu ${JSON.stringify(box)} at ${point.x}`,
  ).toBe(true);
  expect(
    near(box.top, point.y) || near(box.bottom, point.y),
    `menu ${JSON.stringify(box)} at ${point.y}`,
  ).toBe(true);
};
/**
 * A link's menu: its own group first and Inspect last. On macOS a
 * right-click also selects the word under it, as it does in Chrome, so the
 * selection's group (Copy, Search, Look up) may come between.
 */
const expectLinkMenu = async (group: string[]) => {
  const shown = await entries();
  expect(shown.slice(0, group.length + 1)).toEqual([...group, "—"]);
  expect(shown.at(-1)).toBe("Inspect");
  if (!mac) expect(shown).toHaveLength(group.length + 2);
};
const settled = () =>
  app.waitFor(
    `!!${menu} && ${menu}.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished')`,
    { label: "menu settled" },
  );
const closed = () =>
  app.waitFor(`!${menu} && !document.querySelector('[data-menu-shield]')`, {
    label: "menu closed",
  });
const pick = async (label: string) => {
  await settled();
  await run(
    `[...${menu}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`,
  );
  await closed();
};
const pageMenuAt = async (selector: string, dx = 0.5, dy = 0.5) => {
  const point = await pagePoint(selector, dx, dy);
  await pointerOnPage(app, { view, selector, point });
  await mouse(point, "right");
  await app.waitFor(`${menu}?.getAttribute('aria-label') === 'Page'`, {
    label: `page menu on ${selector}`,
  });
  await settled();
  return point;
};
/** Waits until the page's text field holds `value`. */
const fieldHolds = (value: string) =>
  app.waitFor(
    `${view}.executeJavaScript("document.getElementById('field').value", true).then(value => value === ${JSON.stringify(value)})`,
    { label: `field holds ${value}` },
  );
/** Empty the field, then paste into it from its own menu. */
const pasteIntoField = async () => {
  await inPage(
    "(() => { const field = document.getElementById('field'); field.value = ''; field.focus(); return true; })()",
  );
  await pageMenuAt("#field");
  await pick("Paste");
};
const scope = "window.__scope";

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
  await run("setReactValue($('[data-testid=project-name-input]'), 'Menus')");
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  await app.waitFor(
    "!!document.querySelector('textarea[placeholder*=\"Search or ask\"]')",
  );
  await app.waitFor(
    "window.catamorphicDesktop.getPrefs().then(prefs => Boolean(prefs.lastProjectId))",
  );
  await app.eval(`(async () => {
    const api = window.catamorphicDesktop;
    ${scope} = { profileId: await api.windowProfile(), projectId: (await api.getPrefs()).lastProjectId };
    await api.bookmarksAdd({ ...${scope}, label: 'Docs', url: ${JSON.stringify(`${origin}/docs`)} });
    const pinned = await api.bookmarksAdd({ ...${scope}, label: 'Pinned site', url: ${JSON.stringify(`${origin}/pinned`)} });
    await api.bookmarksPin({ ...${scope}, id: pinned.id });
    return true;
  })()`);
  await run(
    `const input = $('textarea[placeholder*="Search or ask"]'); input.focus(); setReactValue(input, ${JSON.stringify(`${origin}/lab`)})`,
  );
  await app.waitFor(
    "document.activeElement?.matches('textarea[aria-label=\"Search commands, pages, and more\"]') && document.activeElement.closest('[role=dialog]').querySelector('[data-item-id=web]')?.getAttribute('aria-selected') === 'true'",
  );
  await app.press("Enter");
  await loaded("Menu lab");
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const row = (label: string) =>
  `document.querySelector('[data-point-key="sidebar:${label}"]')`;
/** Right-click a sidebar row at its middle, as the pointer would. */
const rowMenu = async (label: string) => {
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => { const el = ${row(label)}?.querySelector('[data-tree-primary], button'); if (!el) return false; const r = el.getBoundingClientRect(); const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); return r.width > 0 && el.contains(document.elementFromPoint(x, y)) && { x, y }; })()`,
    { label: `${label} row reachable` },
  );
  await mouse(point, "right");
  await app.waitFor(`!!${menu}`, { label: `${label} menu open` });
  await settled();
  return point;
};
const toggleSidebar = () =>
  app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'b', code: 'KeyB', bubbles: true, cancelable: true,
    ...(${mac} ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
const sidebarMotion = () =>
  app.eval<string>(
    "document.querySelector('aside[data-sidebar=left]').dataset.motion",
  );

describe("sidebar menus", () => {
  it("open at the pointer and offer each action once", async () => {
    const point = await rowMenu("Docs");
    await expectAtPointer(point);
    expect(await entries()).toEqual([
      "Open here",
      "Open in new tab",
      "Open to the side",
      "Open floating",
      "—",
      "Copy link",
      "Pin across projects",
      "Edit…",
      "—",
      "Delete",
    ]);
    await app.press("Escape");
    await closed();
  });

  it("give way to the menu of another row right-clicked while open", async () => {
    await rowMenu("Docs");
    const tile = await app.eval<{ x: number; y: number }>(
      `(() => { const r = ${row("Pinned site")}.querySelector('button').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    await mouse(tile, "right");
    await app.waitFor(
      `(() => { const menus = document.querySelectorAll('[data-sidebar-menu]'); return menus.length === 1 && menus[0].textContent.includes('Unpin'); })()`,
      { label: "the tile's menu replaced the row's" },
    );
    await app.press("Escape");
    await closed();
  });

  it("close with the sidebar", async () => {
    await rowMenu("Docs");
    await toggleSidebar();
    await closed();
    await app.waitFor(
      "document.querySelector('aside[data-sidebar=left]').dataset.motion === 'closed'",
      { label: "sidebar closed" },
    );
    await toggleSidebar();
    await app.waitFor(
      "document.querySelector('aside[data-sidebar=left]').dataset.motion === 'open' && document.querySelector('aside[data-sidebar=left]').dataset.settled === 'true'",
      { label: "sidebar open" },
    );
    expect(await sidebarMotion()).toBe("open");
  });

  it("close on a press in a web page, which the page never receives", async () => {
    await rowMenu("Docs");
    const before = await inPage<number>("window.__presses");
    await mouse(await pagePoint("#blank"), "left");
    await closed();
    expect(await inPage<number>("window.__presses")).toBe(before);
    // With the menu gone, the page takes presses again.
    await mouse(await pagePoint("#blank"), "left");
    await app.waitFor(
      `${view}.executeJavaScript('window.__presses', true).then(count => count === ${before + 1})`,
      { label: "page pressed" },
    );
  });
});

describe("bookmarks", () => {
  it("edit a pinned bookmark's name and address from its right-click menu", async () => {
    await rowMenu("Pinned site");
    expect(await entries()).toEqual([
      "Open here",
      "Open in new tab",
      "Open to the side",
      "Open floating",
      "—",
      "Copy link",
      "Unpin",
      "Edit…",
      "—",
      "Delete",
    ]);
    await pick("Edit…");
    await app.waitFor(
      "document.activeElement?.matches('input[name=bookmarkName]')",
      { label: "edit dialog focused on the name" },
    );
    expect(
      await run(
        "return [$('[role=dialog] h2').textContent, $('input[name=bookmarkName]').value, $('input[name=bookmarkUrl]').value]",
      ),
    ).toEqual(["Edit bookmark", "Pinned site", `${origin}/pinned`]);
    await run(
      "setReactValue($('input[name=bookmarkName]'), 'Team wiki'); setReactValue($('input[name=bookmarkUrl]'), 'wiki.example.test/home'); button('Save').click()",
    );
    await app.waitFor("!document.querySelector('input[name=bookmarkName]')", {
      label: "dialog closed",
    });
    await app.waitFor(`!!${row("Team wiki")}`, { label: "tile renamed" });
    const pinned = await app.eval<{ label: string; url: string }[]>(
      `window.catamorphicDesktop.bookmarksGet(${scope}).then(data => data.pinned.bookmarks.map(({ label, url }) => ({ label, url })))`,
    );
    expect(pinned).toEqual([
      { label: "Team wiki", url: "https://wiki.example.test/home" },
    ]);
  });

  it("refuse an address that is not a web page's and keep the dialog open", async () => {
    await rowMenu("Docs");
    await pick("Edit…");
    await app.waitFor("!!document.querySelector('input[name=bookmarkUrl]')");
    await run(
      "setReactValue($('input[name=bookmarkUrl]'), 'ftp://files.example.test'); button('Save').click()",
    );
    await app.waitFor(
      "document.querySelector('[role=dialog] [role=alert]')?.textContent === 'Enter an http or https address.'",
      { label: "address refused" },
    );
    await run("button('Cancel').click()");
    await app.waitFor("!document.querySelector('input[name=bookmarkUrl]')");
  });
});

describe("page menus", () => {
  it("open where the right-click was and give the page its focus back", async () => {
    const point = await pageMenuAt("#blank", 0.3, 0.5);
    await expectAtPointer(point);
    expect(await entries()).toEqual([
      "Back (off)",
      "Forward (off)",
      "Reload",
      "—",
      "Copy page address",
      "Print…",
      "View page source",
      "—",
      "Inspect",
    ]);
    await app.press("Escape");
    await closed();
    await app.waitFor(`document.activeElement === ${view}`, {
      label: "page focused again",
    });
    // A press elsewhere (here the sidebar) closes it the same way.
    await pageMenuAt("#blank", 0.3, 0.5);
    const sidebar = await app.eval<{ x: number; y: number }>(
      "(() => { const r = document.querySelector('aside[data-sidebar=left]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 120) }; })()",
    );
    await mouse(sidebar, "left");
    await closed();
    await app.waitFor(`document.activeElement === ${view}`, {
      label: "page focused after a press elsewhere",
    });
  });

  it("stay at the pointer on a zoomed page", async () => {
    await app.eval(`${view}.setZoomFactor(1.25); true`);
    await app.waitFor(`${view}.getZoomFactor() === 1.25`);
    const point = await pageMenuAt("#blank", 0.6, 0.6);
    await expectAtPointer(point);
    await app.press("Escape");
    await closed();
    await app.eval(`${view}.setZoomFactor(1); true`);
    await app.waitFor(`${view}.getZoomFactor() === 1`);
  });

  it("copy a link's address", async () => {
    await pageMenuAt("#link");
    await expectLinkMenu([
      "Open link in new tab",
      "Open link to the side",
      "Open link floating",
      "—",
      "Copy link address",
      "Download linked file",
    ]);
    await pick("Copy link address");
    await pasteIntoField();
    await fieldHolds(`${origin}/next`);
  });

  it("copy an email address and a phone number without their schemes", async () => {
    await pageMenuAt("#mail");
    await expectLinkMenu(["Send email", "Copy email address"]);
    await pick("Copy email address");
    await pasteIntoField();
    await fieldHolds("ada@example.test");
    await pageMenuAt("#phone");
    await expectLinkMenu(["Call", "Copy phone number"]);
    await pick("Copy phone number");
    await pasteIntoField();
    await fieldHolds("+15550100");
  });

  it("copy an image's address", async () => {
    await pageMenuAt("#image");
    expect(await entries()).toEqual([
      "Open image in new tab",
      "Download image",
      "Copy image",
      "Copy image address",
      "—",
      "Inspect",
    ]);
    await pick("Copy image address");
    await pasteIntoField();
    await fieldHolds(`${origin}/cat.svg`);
  });

  it("copy and search selected text", async () => {
    await inPage(
      "(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('text')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; })()",
    );
    await pageMenuAt("#text", 0.2, 0.5);
    const shown = await entries();
    expect(shown.slice(0, 2)).toEqual([
      "Copy",
      "Search Google for “Catamorphisms fold any…”",
    ]);
    expect(shown.at(-1)).toBe("Inspect");
    await pick("Copy");
    await pasteIntoField();
    await fieldHolds("Catamorphisms fold any structure into one value.");
  });

  it("edit a text field, with what cannot happen turned off", async () => {
    await inPage(
      "(() => { const field = document.getElementById('field'); field.value = 'abc'; field.focus(); field.setSelectionRange(3, 3); return true; })()",
    );
    await pageMenuAt("#field");
    const shown = await entries();
    expect(shown).toEqual(
      expect.arrayContaining(["Paste", "Paste and match style", "Select all"]),
    );
    // With nothing selected; on macOS the right-click selects the word.
    if (!mac)
      expect(shown).toEqual(
        expect.arrayContaining(["Cut (off)", "Copy (off)"]),
      );
    await pick("Select all");
    await app.waitFor(
      `${view}.executeJavaScript("(() => { const field = document.getElementById('field'); return document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === 3; })()", true)`,
      { label: "field selected and focused" },
    );
    await app.waitFor(`document.activeElement === ${view}`, {
      label: "page focused",
    });
  });

  it("open a link in a new tab", async () => {
    const tabs = await app.eval<number>(
      "document.querySelectorAll('[data-point-key^=\"browser:\"]').length",
    );
    await pageMenuAt("#link");
    await pick("Open link in new tab");
    await app.waitFor(
      `document.querySelectorAll('[data-point-key^="browser:"]').length === ${tabs + 1}`,
      { label: "link opened in a new tab" },
    );
    await loaded("Next page");
  });
});
