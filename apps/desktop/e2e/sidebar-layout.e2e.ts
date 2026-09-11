import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );

beforeAll(async () => {
  app = await launchApp();
  await app.eval(
    "window.__sidebarErrors = []; window.addEventListener('error', event => window.__sidebarErrors.push(event.message + ' ' + event.error?.stack)); window.addEventListener('unhandledrejection', event => window.__sidebarErrors.push(String(event.reason)))",
  );
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New project')",
  );
  await run("button('New project').click()");
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Browser workspace')",
  );
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  await app.waitFor(
    "!!document.querySelector('textarea[placeholder*=\"Search or ask\"]')",
  );
});
afterAll(async () => {
  await app?.stop();
});

describe("configurable browser workspace", () => {
  it("keeps the empty header blank and places collapse inside the sidebar", async () => {
    expect(
      await app.eval(
        "window.catamorphicDesktop.getPrefs().then(p => ({tabPlacement:p.tabPlacement,tabFrame:p.tabFrame}))",
      ),
    ).toEqual({ tabPlacement: "top", tabFrame: false });
    await app.eval(
      "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar'})",
    );
    await app.waitFor("!!document.querySelector('[data-workspace-title]')");
    expect(
      await run("return $('[data-workspace-title]').textContent.trim()"),
    ).toBe("");
    expect(
      await run(
        "return !!$('.workspace-chrome button[aria-label=\"Collapse sidebar\"]')",
      ),
    ).toBe(false);
    expect(
      await run("return !!$('aside button[aria-label=\"Collapse sidebar\"]')"),
    ).toBe(true);
    await app.eval("window.catamorphicDesktop.setPrefs({tabPlacement:'top'})");
  });

  it("switches the theme and moves existing tabs through Settings without losing their keys", async () => {
    await run("button('Settings').click()");
    await app.waitFor("!!document.querySelector('select[name=tabPlacement]')");
    const before = await run<string[]>(
      "return [...document.querySelectorAll('[data-tab-orientation] > [data-point-key]')].map(e => e.dataset.pointKey)",
    );
    await run(
      "button('Catamorphic Light').click(); setReactValue($('select[name=tabPlacement]'), 'sidebar')",
    );
    await app.waitFor(
      "document.documentElement.dataset.theme === 'light' && !!document.querySelector('aside [data-tab-orientation=vertical]')",
    );
    expect(
      await run(
        "return [...document.querySelectorAll('[data-tab-orientation] > [data-point-key]')].map(e => e.dataset.pointKey)",
      ),
    ).toEqual(before);
    expect(
      await app.eval(
        "window.catamorphicDesktop.getPrefs().then(p => p.tabPlacement)",
      ),
    ).toBe("sidebar");
    expect(
      await run(
        "return getComputedStyle($('aside')).backgroundColor !== getComputedStyle($('main')).backgroundColor",
      ),
    ).toBe(false);
  });

  it("keeps the header title-only while the sidebar is collapsed", async () => {
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      "!!document.querySelector('button[aria-label=\"Expand sidebar\"]')",
    );
    expect(await run("return !!$('main [data-tab-orientation]')")).toBe(false);
    expect(
      await run("return $('[data-workspace-title]').textContent.trim()"),
    ).toBe("Settings");
    expect(
      await run(
        "return getComputedStyle($('.workspace-chrome')).borderBottomWidth",
      ),
    ).toBe("0px");
    expect(
      await run(
        "return getComputedStyle($('main')).backgroundColor === getComputedStyle($('aside')).backgroundColor",
      ),
    ).toBe(true);
    await run("$('button[aria-label=\"Expand sidebar\"]').click()");
    await app.waitFor(
      "!!document.querySelector('aside [data-tab-orientation=vertical]')",
    );
  });

  it("creates a folder and a bookmark through the sidebar", async () => {
    await run("$('button[aria-label=\"New bookmark folder\"]').click()");
    await app.waitFor("!!document.querySelector('input[name=bookmarkName]')");
    await run(
      "setReactValue($('input[name=bookmarkName]'), 'Dev'); button('Save').click()",
    );
    await app.waitFor(
      "!!document.querySelector('[data-point-key=\"sidebar:Dev\"]')",
    );
    await run("button('Add bookmark').click()");
    await app.waitFor("!!document.querySelector('input[name=bookmarkUrl]')");
    await run(
      "setReactValue($('input[name=bookmarkName]'), 'Reference'); setReactValue($('input[name=bookmarkUrl]'), 'http://example.test'); const select = $('select[name=bookmarkFolder]'); setReactValue(select, [...select.options].find(o => o.text === 'Dev').value); button('Save').click()",
    );
    await app.waitFor("!document.querySelector('input[name=bookmarkUrl]')");
    await run("$('[data-point-key=\"sidebar:Dev\"] button').click()");
    await app.waitFor(
      "!!document.querySelector('[data-point-key=\"sidebar:Reference\"]')",
    );
    expect(
      await run(
        "return $('[data-point-key=\"sidebar:Reference\"]').closest('[aria-hidden]').getAttribute('aria-hidden')",
      ),
    ).toBe("false");
  });

  it("pins a bookmark as a tile and can change favorites to list rows", async () => {
    await run("$('button[aria-label=\"More actions for Reference\"]').click()");
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    await run("button('Pin across projects').click()");
    await app.waitFor(
      '!!document.querySelector(\'[aria-label="Pinned bookmarks"] [data-point-key="sidebar:Reference"]\')',
    );
    expect(
      await run(
        "return getComputedStyle($('[aria-label=\"Pinned bookmarks\"]')).display",
      ),
    ).toBe("grid");
    const tileCenters = await run<[number, number]>(
      "const tile = $('[aria-label=\"Pinned bookmarks\"] [data-point-key]'); return [tile, tile.querySelector('button').firstElementChild].map(e => {const r=e.getBoundingClientRect(); return r.x+r.width/2})",
    );
    expect(Math.abs(tileCenters[0] - tileCenters[1])).toBeLessThanOrEqual(1);
    await run(
      "const target = $('[aria-label=\"Pinned bookmarks\"] button'); target.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))",
    );
    await app.waitFor("!!document.querySelector('[role=tooltip]')");
    expect(
      await run(
        "const r=$('[role=tooltip]').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8",
      ),
    ).toBe(true);
    await run(
      "$('[aria-label=\"Pinned bookmarks\"] button').dispatchEvent(new MouseEvent('mouseout', {bubbles:true}))",
    );
    await run("$('button[aria-label=\"More actions for Reference\"]').click()");
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    expect(
      await run(
        "const r=$('[data-sidebar-menu]').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8",
      ),
    ).toBe(true);
    await app.press("Escape");
    await run("setReactValue($('select[name=pinnedBookmarks]'), 'list')");
    await app.waitFor(
      "getComputedStyle(document.querySelector('[aria-label=\"Pinned bookmarks\"]')).display === 'flex'",
    );
    await run("setReactValue($('select[name=pinnedBookmarks]'), 'tiles')");
  });

  it("removes a folder while keeping its remaining bookmarks", async () => {
    await run("$('button[aria-label=\"More actions for Reference\"]').click()");
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    await run("button('Unpin').click()");
    await app.waitFor(
      "!document.querySelector('[aria-label=\"Pinned bookmarks\"] [data-point-key]')",
    );
    await run("$('button[aria-label=\"More actions for Reference\"]').click()");
    await run("button('Edit bookmark…').click()");
    await app.waitFor(
      "!!document.querySelector('select[name=bookmarkFolder]')",
    );
    await run(
      "const select = $('select[name=bookmarkFolder]'); setReactValue(select, [...select.options].find(o => o.text === 'Dev').value); button('Save').click()",
    );
    await app.waitFor("!document.querySelector('select[name=bookmarkFolder]')");
    await run("$('button[aria-label=\"More actions for Dev\"]').click()");
    await run("button('Remove folder, keep bookmarks').click()");
    await app.waitFor(
      "!document.querySelector('[data-point-key=\"sidebar:Dev\"]')",
    );
    expect(
      await run("return !!$('[data-point-key=\"sidebar:Reference\"]')"),
    ).toBe(true);
  });

  it("keeps the profile switcher at the bottom and closes vertical tabs", async () => {
    expect(
      await run(
        "return !!$('aside footer button[aria-label^=\"Switch profile:\"]')",
      ),
    ).toBe(true);
    await run("$('button[aria-label^=\"Switch profile:\"]').click()");
    expect(
      await run(
        "return $('button[aria-label^=\"Switch profile:\"]').getAttribute('aria-expanded')",
      ),
    ).toBe("true");
    await app.press("Escape");
    expect(
      await run(
        "return $('button[aria-label^=\"Switch profile:\"]').getAttribute('aria-expanded')",
      ),
    ).toBe("false");
    await run("$('button[aria-label=\"Close Settings\"]').click()");
    await app.waitFor(
      "!document.querySelector('button[aria-label=\"Close Settings\"]')",
    );
  });

  it("uses one browser header and retains the guest when changing layout", async () => {
    // Keep a real surface open: closing the last tab intentionally closes the window.
    await run("button('Settings').click()");
    await app.waitFor("!!document.querySelector('select[name=tabPlacement]')");
    await run(
      "window.dispatchEvent(new KeyboardEvent('keydown', {key:'t', metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform), altKey:true, bubbles:true, cancelable:true}))",
    );
    await app.waitFor(
      "!!document.querySelector('.workspace-chrome input[aria-label=\"Address and search bar\"]')",
    );
    await run(
      "const input = $('input[aria-label=\"Address and search bar\"]'); input.focus(); setReactValue(input, 'data:text/html,<title>Header check</title><h1>Same page</h1>'); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
    );
    await app.waitFor(
      "[...document.querySelectorAll('aside button')].some(b => b.textContent.includes('Header check'))",
    );
    const guest = await run("return $('webview').getWebContentsId()");
    expect(
      await run(
        "return document.querySelectorAll('[data-browser-toolbar]').length",
      ),
    ).toBe(1);
    await app.eval("window.catamorphicDesktop.setPrefs({tabPlacement:'top'})");
    await app.waitFor(
      "!!document.querySelector('main [data-tab-orientation=horizontal]')",
    );
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      "!!document.querySelector('button[aria-label=\"Expand sidebar\"]')",
    );
    await app.waitFor(
      "document.querySelector('[data-tab-orientation=horizontal]').getAnimations({subtree:true}).every(animation => animation.animationName !== 'tab-in' || animation.playState === 'finished')",
      { label: "tab entrance animation settled" },
    );
    const centers = await run<[number, number]>(
      "return [$('button[aria-label=\"Expand sidebar\"]'), $('[data-tab-orientation=horizontal] > [data-point-key]')].map(e => {const r=e.getBoundingClientRect(); return r.y+r.height/2})",
    );
    await run("$('button[aria-label=\"Expand sidebar\"]').click()");
    expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(1);
    await app.eval(
      "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar'})",
    );
    await app.waitFor(
      "!!document.querySelector('.workspace-chrome [data-browser-toolbar]')",
    );
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    await app.eval(
      "window.catamorphicDesktop.setPrefs({headerPlacement:'sidebar'})",
    );
    await app.waitFor(
      "!!document.querySelector('aside input[aria-label=\"Address and search bar\"]') && !!document.querySelector('[data-sidebar-navigation] button[aria-label=Back]')",
    );
    expect(await run("return !!$('main .workspace-chrome')")).toBe(false);
    expect(
      await run(
        "return $('.workspace-content').getBoundingClientRect().top < 10",
      ),
    ).toBe(true);
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    await app.waitFor(
      "document.querySelector('aside').getBoundingClientRect().width === 260",
    );
    const tabCount = await run<number>(
      "return document.querySelectorAll('[data-tab-orientation] > [data-point-key]').length",
    );
    await run(
      "const row = $('button[aria-label=\"New tab\"]').closest('[data-tab-orientation]').lastElementChild; const r = row.getBoundingClientRect(); const target = document.elementFromPoint(r.right-6,r.y+r.height/2); if (!target?.closest('button[aria-label=\"New tab\"]')) throw new Error('New Tab does not fill its row'); target.click()",
    );
    await app.waitFor(
      "document.activeElement?.matches('textarea[placeholder*=\"Search or ask\"]')",
    );
    expect(await app.eval("window.__sidebarErrors")).toEqual([]);
    expect(
      await run(
        "return document.querySelectorAll('[data-tab-orientation] > [data-point-key]').length",
      ),
    ).toBe(tabCount + 1);
    await run(
      "[...document.querySelectorAll('aside button')].find(b => b.textContent.includes('Header check')).click()",
    );
    await app.waitFor(
      "!!document.querySelector('aside [data-browser-toolbar]')",
    );
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      "document.querySelector('aside').getBoundingClientRect().width === 0",
    );
    expect(
      await run(
        "const r = $('.workspace-content').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]",
      ),
    ).toEqual(
      await app.eval(
        "[6, 6, innerWidth - document.querySelector('[data-sidebar=right]').getBoundingClientRect().width - 12, innerHeight - 12]",
      ),
    );
    expect(
      await run(
        "return getComputedStyle($('.workspace-content')).borderRadius",
      ),
    ).toBe("0px");
    expect(await run("return !!$('main .workspace-chrome')")).toBe(false);
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    expect(
      await run(
        "return !!document.elementFromPoint(90, 20)?.closest('aside, [data-sidebar-reveal-edge]')",
      ),
    ).toBe(false);
    const pointerY = await app.eval<number>("innerHeight / 2");
    await app.movePointer({ x: 3, y: pointerY });
    await app.waitFor(
      "document.querySelector('aside').dataset.sidebarRevealed === 'true'",
      { label: "native pointer reveals collapsed sidebar" },
    );
    // The compositor may still send guest entry events while the sidebar
    // animates over it. Those coordinates remain inside the revealed panel.
    await run(
      "$('webview').dispatchEvent(new PointerEvent('pointerover', {bubbles:true,clientX:3,clientY:innerHeight/2})); $('webview').dispatchEvent(new PointerEvent('pointerover', {bubbles:true,clientX:200,clientY:innerHeight/2}))",
    );
    await app.waitFor(
      "document.querySelector('aside').getBoundingClientRect().width === 260",
    );
    expect(await run("return $('aside').dataset.sidebarRevealed")).toBe("true");
    expect(
      await run(
        "const r = $('.workspace-content').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]",
      ),
    ).toEqual(
      await app.eval(
        "[6, 6, innerWidth - document.querySelector('[data-sidebar=right]').getBoundingClientRect().width - 12, innerHeight - 12]",
      ),
    );
    expect(
      await app.eval(
        "window.catamorphicDesktop.getPrefs().then(p => p.sidebarOpen)",
      ),
    ).toBe(false);
    await run(
      "$('aside input[aria-label=\"Address and search bar\"]').focus()",
    );
    await app.movePointer({ x: 400, y: 100 });
    expect(await run("return $('aside').getAttribute('aria-hidden')")).toBe(
      "false",
    );
    await run("$('webview').focus()");
    await app.waitFor(
      "document.querySelector('aside').getAttribute('aria-hidden') === 'true'",
    );
    await run("$('button[aria-label=\"Show sidebar\"]').focus()");
    await app.waitFor(
      "document.querySelector('aside').dataset.sidebarRevealed === 'true'",
    );
    await run("$('button[aria-label=\"Expand sidebar\"]').click()");
    await app.waitFor(
      "document.querySelector('aside').getAttribute('aria-hidden') === 'false'",
    );
    expect(await run("return $('aside').dataset.sidebarRevealed")).toBe(
      "false",
    );
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      "document.querySelector('aside').getAttribute('aria-hidden') === 'true'",
    );
    await run(
      "window.dispatchEvent(new KeyboardEvent('keydown', {key:'l',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true}))",
    );
    await app.waitFor(
      "document.querySelector('aside').getAttribute('aria-hidden') === 'false' && document.activeElement?.getAttribute('aria-label') === 'Address and search bar'",
    );
    await app.eval(
      "window.catamorphicDesktop.setPrefs({headerPlacement:'top'})",
    );
    await app.waitFor(
      "!!document.querySelector('.workspace-chrome [data-browser-toolbar]')",
    );
    await run("$('button[aria-label=\"Close Header check\"]').click()");
    await app.waitFor("!document.querySelector('[data-browser-toolbar]')");
  });

  it("aligns the compact footer controls", async () => {
    await app.waitFor(
      "!!document.querySelector('aside footer button[aria-label=Settings]') && !!document.querySelector('button[aria-label^=\"Switch profile:\"]')",
      { label: "profile footer after changing layout" },
    );
    const centers = await run<[number, number]>(
      "return [$('button[aria-label^=\"Switch profile:\"]'), $('aside footer button[aria-label=Settings]')].map(e => {const r=e.getBoundingClientRect(); return r.y+r.height/2})",
    );
    expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(1);
  });

  it("opens a customization chat with the live configuration path", async () => {
    await run("$('button[aria-label=\"Customize sidebar\"]').click()");
    await app.waitFor("!!document.querySelector('[data-composer-input]')");
    await app.waitFor(
      "document.body.innerText.includes('The live sidebar configuration file on this machine is')",
    );
    const file = await app.eval<string>(
      "window.catamorphicDesktop.sidebarConfigFile()",
    );
    expect(await app.eval("document.body.innerText")).toContain(file);
  });
});

it("does not use GitHub CLI for PRs without profile opt-in", async () => {
  await run("button('Settings').click()");
  await app.waitFor(
    "!!document.querySelector('[data-testid=github-cli-connection]')",
  );
  expect(
    await app.eval(
      "document.querySelector('[data-testid=github-cli-connection]').textContent.includes('Connect GitHub CLI')",
    ),
  ).toBe(true);
  await app.eval(
    "window.catamorphicDesktop.setPrefs({ githubCliEnabled: false })",
  );
  expect(
    await app.eval(
      "window.catamorphicDesktop.prList('unconfigured-project').then(() => 'unexpected success', error => error.message.includes('[github-cli-disabled]'))",
    ),
  ).toBe(true);
  await app.eval("location.reload()");
  await app.waitFor("!!window.catamorphicDesktop");
  expect(
    await app.eval(
      "window.catamorphicDesktop.getPrefs().then(prefs => prefs.githubCliEnabled)",
    ),
  ).toBe(false);
});
