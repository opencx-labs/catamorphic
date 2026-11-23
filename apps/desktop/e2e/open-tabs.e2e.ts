import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyUtilityWorkspace } from "../src/renderer/lib/workspace-state.js";
import {
  type AppHandle,
  launchApp,
  openProjectSwitcher,
  setReactValueJs,
  waitForProjectWorkspace,
} from "./harness.js";

/**
 * A page already open in a tab opens there (`switchToOpenTab`): a bookmark,
 * a page's link to a new window, Cmd+P. A new tab asked for on purpose (a
 * New Tab's palette) opens the page again. The palette lists an open
 * bookmarked page once, by the bookmark's name.
 */
let app: AppHandle;
let origin: string;
let projectId: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url?.startsWith("/a")) {
    response.end("<title>Alpha docs</title><h1>Alpha</h1>");
    return;
  }
  response.end(
    `<title>Beta page</title><h1>Beta</h1><p><a id="out" href="/a" target="_blank" style="font-size:28px">Alpha in a new window</a></p>`,
  );
});

const mac = process.platform === "darwin";
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
const view = `[...document.querySelectorAll('webview')].find(w => w.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
const showing = (title: string) =>
  app.waitFor(
    `(() => { const page = ${view}; try { return page.getTitle() === ${JSON.stringify(title)} && !page.isLoading(); } catch { return false; } })()`,
    { label: `${title} in front`, timeoutMs: 30_000 },
  );
const browserTabsJs = `document.querySelectorAll('[data-tab-orientation] [data-point-key^="browser:"]').length`;
const browserTabs = () => app.eval<number>(browserTabsJs);
const selectTab = (title: string) =>
  run(`
    const item = [...document.querySelectorAll('[data-tab-orientation] [data-point-key^="browser:"]')].find((tab) => tab.textContent.includes(${JSON.stringify(title)}));
    [...(item?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().length > 0)?.click();
    return Boolean(item);
  `);
const shortcut = (key: string) =>
  app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    ...(${mac} ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
const paletteInput = `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find((el) => !el.closest('[inert]') && el.checkVisibility())`;
/** The palette's rows for `query`, once its first row names `first`. */
const rowsFor = async (query: string, first: string) => {
  await app.waitFor(`document.activeElement === ${paletteInput}`, {
    label: "palette focused",
  });
  await app.insertText(query);
  return app.waitFor<string[]>(
    `(() => { const rows = [...document.activeElement.closest('[role="dialog"]').querySelectorAll('[role="option"]')].map((row) => row.textContent.trim()); return rows[0]?.includes(${JSON.stringify(first)}) && rows; })()`,
    { label: `${first} first for ${query}` },
  );
};
const openAddress = async (url: string) => {
  await shortcut("t");
  await app.waitFor(`!!${paletteInput}`, { label: "New Tab" });
  await run(
    `const input = ${paletteInput}; input.focus(); setReactValue(input, ${JSON.stringify(url)})`,
  );
  await app.waitFor(
    `document.activeElement === ${paletteInput} && document.activeElement.closest('[role="dialog"]').querySelector('[data-item-id=web]')?.getAttribute('aria-selected') === 'true'`,
    { label: "address row selected" },
  );
  await app.press("Enter");
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await openProjectSwitcher(app);
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New project')",
  );
  await run("button('New project').click()");
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run("setReactValue($('[data-testid=project-name-input]'), 'Tabs')");
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  projectId = await waitForProjectWorkspace({ app, name: "Tabs" });
  await app.eval(`(async () => {
    const api = window.catamorphicDesktop;
    const scope = { profileId: await api.windowProfile(), projectId: ${JSON.stringify(projectId)} };
    await api.bookmarksAdd({ ...scope, label: 'Team wiki', url: ${JSON.stringify(`${origin}/a`)} });
    return true;
  })()`);
  await openAddress(`${origin}/a`);
  await showing("Alpha docs");
  await openAddress(`${origin}/b`);
  await showing("Beta page");
  expect(await browserTabs()).toBe(2);
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("a page already open in a tab", () => {
  it("opens there from its bookmark", async () => {
    await run(
      `$('[data-point-key="sidebar:Team wiki"] [data-tree-primary]').click(); return true;`,
    );
    await showing("Alpha docs");
    expect(await browserTabs()).toBe(2);
  });

  it("opens there from a page's link to a new window", async () => {
    expect(await selectTab("Beta page")).toBe(true);
    await showing("Beta page");
    // The page follows its link as a person's click does: with a user
    // gesture, so the new window it asks for comes as a foreground tab.
    // (Synthetic presses on a page just brought to the front are timing
    // sensitive, on macOS most of all; the menu tests cover the pointer.)
    await app.eval(
      `${view}.executeJavaScript("document.getElementById('out').click(); true", true)`,
    );
    await showing("Alpha docs");
    expect(await browserTabs()).toBe(2);
  });

  it("is one row in Cmd+P, named as its bookmark, and Enter goes to it", async () => {
    expect(await selectTab("Beta page")).toBe(true);
    await showing("Beta page");
    await shortcut("p");
    const rows = await rowsFor("Team wiki", "Team wiki");
    // One destination: the open tab, named as its bookmark (the rest are
    // searching the web for the words and sending them to the agent).
    const ids = await app.eval<string[]>(
      `[...document.activeElement.closest('[role="dialog"]').querySelectorAll('[role="option"]')].map((row) => row.dataset.itemId).filter((id) => id !== 'web' && id !== 'send-to-agent')`,
    );
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^open-tab:browser:/);
    expect(rows[0]).toContain("Open tab");
    await app.press("Enter");
    await showing("Alpha docs");
    expect(await browserTabs()).toBe(2);
  });

  it("opens again from a New Tab's palette, which asked for a new tab", async () => {
    await shortcut("t");
    await rowsFor("Team wiki", "Team wiki");
    await app.press("Enter");
    await app.waitFor(
      `document.querySelectorAll('[data-tab-orientation] [data-point-key^="browser:"]').length === 3`,
      { label: "a third page tab" },
    );
    await showing("Alpha docs");
  });

  it("opens where it is clicked with the setting off", async () => {
    await app.eval(
      "window.catamorphicDesktop.setPrefs({ switchToOpenTab: false })",
    );
    const before = await browserTabs();
    const betaOpen = `[...document.querySelectorAll('[data-tab-orientation] [data-point-key^="browser:"]')].some((tab) => tab.textContent.includes('Beta page'))`;
    // The window resolves its settings (project overrides included) after
    // the change; until then a click still goes to the open tab, which is
    // harmless to repeat. Once the setting lands, the bookmark replaces the
    // page in front, as before.
    for (let attempt = 0; await app.eval<boolean>(betaOpen); attempt += 1) {
      if (attempt === 10) throw new Error("The setting never applied");
      expect(await selectTab("Beta page")).toBe(true);
      await showing("Beta page");
      await run(
        `$('[data-point-key="sidebar:Team wiki"] [data-tree-primary]').click(); return true;`,
      );
      await showing("Alpha docs");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(await browserTabs()).toBe(before);
    await app.eval(
      "window.catamorphicDesktop.setPrefs({ switchToOpenTab: true })",
    );
  });
});

it("fits unpinned tabs to the room and keeps narrow tabs usable", async () => {
  const stripSelector =
    '[data-workspace-visible="true"] [data-tab-orientation="horizontal"]';
  const strip = `document.querySelector(${JSON.stringify(stripSelector)})`;
  const metrics = () =>
    run<{
      overflow: boolean;
      pin: number;
      widths: number[];
      namedNarrowTabs: number;
      inactiveCloses: number;
    }>(`
    const strip = ${strip};
    const tabs = [...strip.querySelectorAll('[data-point-key^="browser:"]:not([aria-hidden])')];
    const pin = tabs.shift();
    const narrow = tabs.filter(tab => tab.hasAttribute('data-tab-narrow'));
    return {
      overflow: strip.scrollWidth > strip.clientWidth + 1,
      pin: pin.getBoundingClientRect().width,
      widths: tabs.map(tab => tab.getBoundingClientRect().width),
      namedNarrowTabs: narrow.filter(tab => tab.querySelector('.workspace-tab-label').getAttribute('aria-label')?.startsWith('A long page title')).length,
      inactiveCloses: narrow.filter(tab => !tab.hasAttribute('data-tab-active') && getComputedStyle(tab.querySelector('.workspace-tab-close')).display !== 'none').length,
    };
  `);
  await app.eval(`(async () => {
    const api = window.catamorphicDesktop;
    const projectId = ${JSON.stringify(projectId)};
    const snapshot = ${JSON.stringify(emptyUtilityWorkspace())};
    const profileId = await api.windowProfile();
    snapshot.browsers = Array.from({length: 13}, (_, index) => ({
      localId: 'width-' + index, profileId, title: 'Page', label: 'A long page title ' + index,
      initialUrl: ${JSON.stringify(`${origin}/a`)}, url: ${JSON.stringify(`${origin}/a`)}, faviconUrl: null,
    }));
    snapshot.activeTabKey = 'browser:width-1';
    snapshot.pinnedTabKeys = ['browser:width-0'];
    await api.workspaceStateSet(projectId, snapshot);
    await api.setPrefs({tabOverflow:'scroll',tabAlignment:'start',tabPlacement:'top'});
    await api.devWindow('setSize', 1280, 850);
  })()`);
  await app.reload();
  await waitForProjectWorkspace({ app, name: "Tabs" });
  await app.waitFor(
    `(() => {
    const tabs = [...(${strip}?.querySelectorAll('[data-point-key^="browser:"]') ?? [])];
    return tabs.length === 13 && tabs.every(tab =>
      tab.getAnimations().every(animation => animation.playState !== 'running' && !animation.pending)
    );
  })()`,
    { label: "the tab strip finished its entrance animations" },
  );
  await expect.poll(async () => (await metrics()).overflow).toBe(true);
  const initial = await metrics();

  await app.eval("window.catamorphicDesktop.setPrefs({tabOverflow:'shrink'})");
  await app.waitFor(`${strip}?.dataset.tabOverflow === 'shrink'`);
  await expect.poll(async () => (await metrics()).overflow).toBe(false);
  const fitted = await metrics();
  expect(fitted.pin).toBeCloseTo(initial.pin, 0);
  expect(Math.max(...fitted.widths) - Math.min(...fitted.widths)).toBeLessThan(
    1,
  );
  expect(fitted.widths[0]).toBeLessThan(initial.widths[0] ?? 0);

  await app.eval("window.catamorphicDesktop.devWindow('setSize',740,850)");
  await expect.poll(async () => (await metrics()).namedNarrowTabs).toBe(12);
  const narrow = await metrics();
  expect(narrow.inactiveCloses).toBe(0);
  expect(Math.min(...narrow.widths)).toBeGreaterThanOrEqual(36);
  const active = `${strip}.querySelector('[data-tab-narrow][data-tab-active]')`;
  const point = await app.eval<{ x: number; y: number }>(
    `(()=>{const r=${active}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
  );
  await app.movePointer(point);
  await app.waitFor(
    `getComputedStyle(${active}.querySelector('.workspace-tab-close')).opacity === '1'`,
    { label: "active icon-only tab shows its close button on hover" },
  );

  await app.eval("window.catamorphicDesktop.devWindow('setSize',580,850)");
  await expect.poll(async () => (await metrics()).overflow).toBe(true);
  await app.eval("window.catamorphicDesktop.setPrefs({tabOverflow:'scroll'})");
  await app.waitFor(
    `${strip}?.dataset.tabOverflow === 'scroll' && !${strip}.querySelector('[data-tab-narrow]')`,
    { label: "scroll mode clears every icon-only state" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
