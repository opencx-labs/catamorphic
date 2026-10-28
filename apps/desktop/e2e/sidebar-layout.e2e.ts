import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
/**
 * What draws a sidebar row's keyboard ring, as page script: the row itself,
 * or in a list (the kit tree) the list's one ring on its focused row.
 */
const ringOf =
  "((row) => row && (row.closest('[data-tree-viewport]') ? row.closest('[role=tree]')?.querySelector('[data-tree-focus]') ?? null : row))";

beforeAll(async () => {
  app = await launchApp();
  await app.eval(
    "window.__sidebarErrors = []; window.addEventListener('error', event => window.__sidebarErrors.push(event.message + ' ' + event.error?.stack)); window.addEventListener('unhandledrejection', event => window.__sidebarErrors.push(String(event.reason)))",
  );
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Create or import project')",
  );
  await run("button('Create or import project').click()");
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
        "window.catamorphicDesktop.getPrefs().then(p => ({tabPlacement:p.tabPlacement,contentFrame:p.contentFrame}))",
      ),
    ).toEqual({ tabPlacement: "top", contentFrame: false });
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
    await app.waitFor(
      "!!document.querySelector('main [data-tab-orientation=horizontal]')",
      { label: "tabs back on top" },
    );
  });

  it("switches the theme and moves existing tabs through Settings without losing their keys", async () => {
    await run("button('Settings').click()");
    // The New Tab the app opened with closes once Settings shows in its
    // place; its tab stays in the strip while it animates out.
    await app.waitFor(
      "!!document.querySelector('select[name=tabPlacement]') && !!document.querySelector('[data-tab-orientation] [data-point-key^=\"settings:\"]') && !document.querySelector('[data-tab-orientation] [data-point-key^=\"palette:\"]')",
    );
    const before = await run<string[]>(
      "return [...document.querySelectorAll('[data-tab-orientation] [data-point-key]')].map(e => e.dataset.pointKey)",
    );
    await run(
      "button('Work Light').click(); setReactValue($('select[name=tabPlacement]'), 'sidebar')",
    );
    await app.waitFor(
      "document.documentElement.dataset.theme === 'light' && !!document.querySelector('aside [data-sidebar-section=tabs] [data-sidebar-item-id]')",
    );
    // The tabs are the Tabs section's rows now (ADR 0234), same keys.
    expect(
      await app.waitFor<string[]>(
        `(() => { const keys = [...document.querySelectorAll('aside [data-sidebar-section=tabs] [data-sidebar-item-id]')].filter(e => !e.closest('[data-tree-exiting]')).map(e => e.dataset.sidebarItemId); return JSON.stringify(keys) === ${JSON.stringify(JSON.stringify(before))} && keys; })()`,
        { label: "the same tabs listed in the sidebar" },
      ),
    ).toEqual(before);
    expect(await run("return !!$('[data-tab-orientation]')")).toBe(false);
    expect(
      await app.eval(
        "window.catamorphicDesktop.getPrefs().then(p => p.tabPlacement)",
      ),
    ).toBe("sidebar");
    expect(
      await run(
        "return getComputedStyle($('aside .sidebar-inner')).backgroundColor !== getComputedStyle($('main')).backgroundColor",
      ),
    ).toBe(false);
  });

  it("keeps the header title-only while the sidebar is collapsed", async () => {
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      "document.querySelector('aside').dataset.motion === 'closed' && document.querySelector('aside').dataset.settled === 'true'",
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
        "return getComputedStyle($('main')).backgroundColor === getComputedStyle($('aside .sidebar-inner')).backgroundColor",
      ),
    ).toBe(true);
    await run("$('button[aria-label=\"Expand sidebar\"]').click()");
    await app.waitFor(
      "document.querySelector('aside').dataset.motion === 'open' && document.querySelector('aside').dataset.settled === 'true' && !!document.querySelector('aside [data-sidebar-section=tabs] [data-sidebar-item-id]')",
    );
  });

  it("creates a folder and a bookmark through the sidebar", async () => {
    // The Bookmarks section's header actions ask for their values first.
    await run(
      "$('[data-sidebar-section=bookmarks] button[aria-label=\"New bookmark folder\"]').click()",
    );
    await app.waitFor("!!document.querySelector('input[name=label]')");
    await run(
      "setReactValue($('input[name=label]'), 'Dev'); button('Create').click()",
    );
    await app.waitFor(
      "!!document.querySelector('[data-point-key=\"sidebar:Dev\"]') && !document.querySelector('input[name=label]')",
    );
    // A folder's own menu adds a bookmark into it.
    await run("$('button[aria-label=\"More actions for Dev\"]').click()");
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    await run("button('Add bookmark…').click()");
    await app.waitFor("!!document.querySelector('input[name=url]')");
    await run(
      "setReactValue($('input[name=url]'), 'http://example.test'); setReactValue($('input[name=label]'), 'Reference'); button('Add').click()",
    );
    await app.waitFor("!document.querySelector('input[name=url]')");
    await run("$('button[aria-label=\"Expand Dev\"]').click()");
    await app.waitFor(
      "!!document.querySelector('[data-point-key=\"sidebar:Reference\"]')",
    );
    expect(
      await run(
        "return $('[data-point-key=\"sidebar:Reference\"]').closest('[aria-hidden]')?.getAttribute('aria-hidden') ?? 'false'",
      ),
    ).toBe("false");
  });

  it("lets its items leave before it does, and brings them back when it opens mid-close", async () => {
    const aside = "document.querySelector('aside[data-sidebar=left]')";
    // The leave runs on Web Animations; the panel's slide is a transition.
    const leaving = `(element) => element.getAnimations({ subtree: true }).filter((animation) => animation.id === 'sidebar-leave')`;
    const read = () =>
      app.eval<{
        row: string | undefined;
        rate: number | undefined;
        threads: number;
        delay: number | undefined;
      }>(`(() => {
        const aside = ${aside};
        const slide = aside.querySelector('.sidebar-inner').getAnimations()
          .find((animation) => animation.transitionProperty === 'transform');
        const row = [...aside.querySelectorAll('[data-sidebar-item-id]')]
          .find((row) => (${leaving})(row).length > 0);
        return {
          row: row?.dataset.sidebarItemId,
          rate: row && (${leaving})(row)[0].playbackRate,
          threads: aside.querySelectorAll('.sidebar-traces > .sidebar-trace').length,
          delay: slide?.effect.getTiming().delay,
        };
      })()`);
    // Anything in the rows drawn less than opaque, as styled at rest.
    const dimmed = () =>
      app.eval<string[]>(
        `[...${aside}.querySelectorAll('[data-tree-primary], [data-tree-primary] *')].filter((element) => element.checkVisibility() && getComputedStyle(element).opacity !== '1').map((element) => element.outerHTML.slice(0, 80) + ' ' + getComputedStyle(element).opacity)`,
      );
    // What the last test set moving (its dialog closing, the folder
    // opening) ends first: an animation still running when the timeline is
    // slowed below can stall there, and leave a row clipped under its section.
    await app.waitFor(
      "document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)",
      { label: "the window at rest before time slows" },
    );
    const before = await dimmed();
    // Slowed, so the close can be read while it runs.
    await app.cdp("Animation.enable");
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 0.1 });
    try {
      await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
      await app.waitFor(
        `${aside}.dataset.motion === 'closing' && (${leaving})(${aside}).length > 0`,
        { label: "items leaving" },
      );
      const closing = await read();
      expect(closing.row).toBeTruthy();
      expect(closing.rate).toBe(1);
      expect(closing.threads).toBeGreaterThan(0);
      // The panel follows the items a beat later.
      expect(closing.delay).toBe(100);
      // Opened mid-close (the toggle rides away with the panel, so by its
      // shortcut), the items come back from where they are: that the leave
      // plays back is pinned in tabbed-sidebar-leave.test.tsx; here, that
      // everything ends where it was.
      await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'b', bubbles: true, cancelable: true,
        ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
      })); true`);
    } finally {
      await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
      await app.cdp("Animation.disable");
    }
    await app.waitFor(
      `${aside}.dataset.motion === 'open' && ${aside}.dataset.settled === 'true' && (${leaving})(${aside}).length === 0`,
      { label: "items back" },
    );
    expect(await app.eval(`!!${aside}.querySelector('.sidebar-traces')`)).toBe(
      false,
    );
    expect(await dimmed()).toEqual(before);
    // Closed all the way, nothing is left behind once it has gone.
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      `${aside}.dataset.motion === 'closed' && ${aside}.dataset.settled === 'true'`,
    );
    expect(
      await app.eval(
        `(${leaving})(${aside}).length + ${aside}.querySelectorAll('.sidebar-traces').length`,
      ),
    ).toBe(0);
    await run("$('button[aria-label=\"Expand sidebar\"]').click()");
    await app.waitFor(
      `${aside}.dataset.motion === 'open' && ${aside}.dataset.settled === 'true'`,
    );
    // Every item shows as it did before the close.
    expect(await dimmed()).toEqual(before);
  });

  it("draws one keyboard-led ring: none after right-click and Escape, the accent at once on Tab", async () => {
    // The row may still be sliding into its expanded folder.
    const point = await app
      .waitFor<{ x: number; y: number }>(
        "(() => { const el = document.querySelector('[data-point-key=\"sidebar:Reference\"] [data-tree-primary]'); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return el.contains(document.elementFromPoint(x, y)) ? { x, y } : false })()",
        { label: "Reference row reachable" },
      )
      .catch(async (error: unknown) => {
        // What stands where the row should be, for a failure to point at.
        const state = await app.eval(`(() => {
          const el = document.querySelector('[data-point-key="sidebar:Reference"] [data-tree-primary]');
          const r = el?.getBoundingClientRect();
          const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const aside = document.querySelector('aside[data-sidebar=left]');
          const scroller = el?.closest('[data-sidebar-scroll], .overflow-y-auto, .overflow-auto');
          return {
            rect: r && { x: r.x, y: r.y, width: r.width, height: r.height },
            viewport: { width: innerWidth, height: innerHeight },
            hit: hit ? hit.outerHTML.slice(0, 200) : null,
            hidden: el?.closest('[aria-hidden="true"], [inert]')?.outerHTML.slice(0, 120) ?? null,
            aside: aside && { ...aside.dataset },
            scroller: scroller && { top: scroller.scrollTop, height: scroller.clientHeight },
            running: [...document.getAnimations()].filter((animation) => animation.playState === 'running').map((animation) => animation.id || animation.animationName || animation.transitionProperty).slice(0, 10),
          };
        })()`);
        throw new Error(`${String(error)}; state: ${JSON.stringify(state)}`);
      });
    for (const type of ["mousePressed", "mouseReleased"])
      await app.cdp("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "right",
        clickCount: 1,
      });
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    await app.press("Escape");
    await app.waitFor(
      "!!document.activeElement?.closest('[data-point-key=\"sidebar:Reference\"]')",
      { label: "focus returned to the row" },
    );
    // Chromium turns :focus-visible on after the key; the pointer led, so no
    // ring and no focus-opened preview.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      await run(
        `const row = document.activeElement.closest('[data-sidebar-item-id]'); const ring = ${ringOf}(row); return [document.documentElement.dataset.focusModality, ring ? getComputedStyle(ring).outlineStyle : 'none', !!document.querySelector('[data-resource-inspector][data-open=true]')]`,
      ),
    ).toEqual(["pointer", "none", false]);
    // Sample every frame after Tab: the ring is the accent from its first
    // frame, never faded in from the text color.
    await run(
      `const probe = document.createElement('i'); probe.style.color = 'var(--color-accent)'; document.body.append(probe); window.__accent = getComputedStyle(probe).color; probe.remove(); window.__rings = []; const t0 = performance.now(); const tick = () => { const ring = ${ringOf}(document.querySelector('[data-sidebar-item-id]:has(:focus-visible)')); if (ring) { const style = getComputedStyle(ring); if (style.outlineStyle !== 'none') window.__rings.push(style.outlineColor); } if (performance.now() - t0 < 600) requestAnimationFrame(tick); }; requestAnimationFrame(tick);`,
    );
    await app.press("Tab");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const rings = await app.eval<{ accent: string; colors: string[] }>(
      "({ accent: window.__accent, colors: [...new Set(window.__rings)] })",
    );
    expect(rings.colors).toEqual([rings.accent]);
    expect(
      await app.eval("document.documentElement.dataset.focusModality"),
    ).toBe("keyboard");
    await run("document.activeElement.blur()");
  });

  it("pins a bookmark as a tile", async () => {
    const tiles = "[data-sidebar-section=pinned] ul[aria-label=Tiles]";
    await run("$('button[aria-label=\"More actions for Reference\"]').click()");
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    await run("button('Pin across projects').click()");
    await app.waitFor(
      `!!document.querySelector('${tiles} [data-point-key="sidebar:Reference"]')`,
    );
    expect(await run(`return getComputedStyle($('${tiles}')).display`)).toBe(
      "grid",
    );
    const tileCenters = await run<[number, number]>(
      `const tile = $('${tiles} [data-point-key]'); return [tile, tile.querySelector('button').firstElementChild].map(e => {const r=e.getBoundingClientRect(); return r.x+r.width/2})`,
    );
    expect(Math.abs(tileCenters[0] - tileCenters[1])).toBeLessThanOrEqual(1);
    // Tiles have no hover dots; their menu opens on right-click.
    await run(
      `const tile=$('${tiles} [data-point-key="sidebar:Reference"] button'); const r=tile.getBoundingClientRect(); tile.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.x+r.width/2, clientY:r.y+r.height/2}))`,
    );
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    expect(
      await run(
        "const r=$('[data-sidebar-menu]').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8 && r.bottom <= innerHeight - 8",
      ),
    ).toBe(true);
    await app.press("Escape");
  });

  it("removes a folder while keeping its remaining bookmarks", async () => {
    const tiles = "[data-sidebar-section=pinned] ul[aria-label=Tiles]";
    // Reference is still a pinned tile here: right-click opens its menu.
    await run(
      `const tile=$('${tiles} [data-point-key="sidebar:Reference"] button'); const r=tile.getBoundingClientRect(); tile.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:r.x+r.width/2, clientY:r.y+r.height/2}))`,
    );
    await app.waitFor("!!document.querySelector('[data-sidebar-menu]')");
    // The emptied pinned section collapses through intermediate heights and
    // stays mounted, instead of vanishing in one frame.
    await run(
      "const box = $('[data-sidebar-widget=pinned] [data-collapsible]'); window.__pinnedBox = box; window.__pinnedHeights = []; const t0 = performance.now(); const tick = () => { window.__pinnedHeights.push(Math.round(box.getBoundingClientRect().height)); if (performance.now() - t0 < 1500) requestAnimationFrame(tick); }; requestAnimationFrame(tick);",
    );
    await run("button('Unpin').click()");
    await app.waitFor(`!document.querySelector('${tiles} [data-point-key]')`);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const collapse = await app.eval<{
      heights: number[];
      connected: boolean;
      state: string;
    }>(
      "({ heights: window.__pinnedHeights, connected: window.__pinnedBox.isConnected, state: window.__pinnedBox.dataset.collapsible })",
    );
    const start = Math.max(...collapse.heights);
    expect(start).toBeGreaterThan(20);
    expect(collapse.heights.at(-1)).toBe(0);
    expect(
      collapse.heights.filter((height) => height > 0 && height < start).length,
    ).toBeGreaterThan(2);
    expect(collapse).toMatchObject({ connected: true, state: "closed" });
    // Unpinned, it is the project's again, at the top; Edit renames it.
    await run("$('button[aria-label=\"More actions for Reference\"]').click()");
    await run("button('Edit…').click()");
    await app.waitFor(
      "document.querySelector('input[name=label]')?.value === 'Reference'",
    );
    await run(
      "setReactValue($('input[name=label]'), 'Reference docs'); button('Save').click()",
    );
    await app.waitFor(
      "!!document.querySelector('[data-point-key=\"sidebar:Reference docs\"]') && !document.querySelector('input[name=label]')",
    );
    await run("$('button[aria-label=\"More actions for Dev\"]').click()");
    await run("button('Add bookmark…').click()");
    await app.waitFor("!!document.querySelector('input[name=url]')");
    await run(
      "setReactValue($('input[name=url]'), 'http://second.test'); setReactValue($('input[name=label]'), 'Second'); button('Add').click()",
    );
    await app.waitFor("!document.querySelector('input[name=url]')");
    await run("$('button[aria-label=\"More actions for Dev\"]').click()");
    await run("button('Remove folder, keep bookmarks').click()");
    await app.waitFor(
      "!document.querySelector('[data-point-key=\"sidebar:Dev\"]')",
    );
    expect(
      await run(
        "return [!!$('[data-point-key=\"sidebar:Reference docs\"]'), !!$('[data-point-key=\"sidebar:Second\"]')]",
      ),
    ).toEqual([true, true]);
  });

  it("keeps the profile switcher at the bottom and closes a tab from its row", async () => {
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
    // The sidebar's own toggle slides away with it; measure the one left.
    await app.waitFor(
      "document.querySelector('aside').dataset.motion === 'closed' && document.querySelector('aside').dataset.settled === 'true'",
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
    const listedTabs =
      "[...document.querySelectorAll('aside [data-sidebar-section=tabs] [data-sidebar-item-id]')].filter(e => !e.closest('[data-tree-exiting]')).length";
    const tabRows = `return ${listedTabs}`;
    const tabCount = await run<number>(tabRows);
    // New tab is the Tabs section's header action.
    await app.waitFor(
      "document.querySelector('aside').dataset.settled === 'true'",
    );
    await run(
      "$('aside [data-sidebar-section=tabs] button[data-header-action=\"command:new-tab\"]').click()",
    );
    await app.waitFor(
      "document.activeElement?.matches('textarea[placeholder*=\"Search or ask\"]')",
    );
    expect(await app.eval("window.__sidebarErrors")).toEqual([]);
    await app.waitFor(`${listedTabs} === ${tabCount + 1}`, {
      label: "the new tab listed",
    });
    expect(await run<number>(tabRows)).toBe(tabCount + 1);
    await run(
      "[...document.querySelectorAll('aside button')].find(b => b.textContent.includes('Header check')).click()",
    );
    await app.waitFor(
      "!!document.querySelector('aside [data-browser-toolbar]')",
    );
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    // Collapsed with the header in the sidebar, the sidebar reveals itself
    // whenever the OS pointer is at the window's left edge, wherever an
    // earlier suite on this display left it. Park it over the content.
    await app.movePointer({ x: 400, y: 100 });
    await run("$('button[aria-label=\"Collapse sidebar\"]').click()");
    await app.waitFor(
      "document.querySelector('aside').dataset.motion === 'closed' && document.querySelector('aside').dataset.settled === 'true' && document.querySelector('aside').getBoundingClientRect().width === 0",
    );
    expect(
      await run(
        "const r = $('.workspace-content').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]",
      ),
    ).toEqual(
      await app.eval(
        "[0, 0, innerWidth - document.querySelector('[data-sidebar=right]').getBoundingClientRect().width, innerHeight]",
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
    // slides over it. Those coordinates remain inside where it lands.
    await run(
      "$('webview').dispatchEvent(new PointerEvent('pointerover', {bubbles:true,clientX:3,clientY:innerHeight/2})); $('webview').dispatchEvent(new PointerEvent('pointerover', {bubbles:true,clientX:200,clientY:innerHeight/2}))",
    );
    // Over the page, not beside it: the aside takes no space.
    await app.waitFor(
      "(() => { const aside = document.querySelector('aside'); const panel = aside.firstElementChild.getBoundingClientRect(); return aside.dataset.motion === 'open' && aside.dataset.docked === 'false' && aside.getBoundingClientRect().width === 0 && panel.left === 0 && panel.width === 260 })()",
    );
    expect(await run("return $('aside').dataset.sidebarRevealed")).toBe("true");
    expect(
      await run(
        "const r = $('.workspace-content').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]",
      ),
    ).toEqual(
      await app.eval(
        "[0, 0, innerWidth - document.querySelector('[data-sidebar=right]').getBoundingClientRect().width, innerHeight]",
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
    // A keyboard reveal hands focus to the sidebar it revealed.
    await app.waitFor(
      "document.activeElement?.closest('aside') && document.activeElement.getAttribute('aria-label') === 'Expand sidebar'",
      { label: "focus moves into the revealed sidebar" },
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
      "document.querySelector('aside').getAttribute('aria-hidden') === 'true' && document.querySelector('aside').dataset.motion === 'closed' && document.querySelector('aside').dataset.settled === 'true'",
    );
    // Hold the address unavailable across frames, as while its sidebar
    // arrives. One scheduled focus attempt cannot complete this handoff.
    await run(
      "const style = document.createElement('style'); style.id = 'address-not-ready'; style.textContent = 'aside input[aria-label=\"Address and search bar\"] { visibility: hidden !important; }'; document.head.append(style)",
    );
    try {
      await app.press("l", process.platform === "darwin" ? 4 : 2);
      await app.waitFor(
        "document.querySelector('aside').getAttribute('aria-hidden') === 'false'",
      );
      await app.eval(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      expect(
        await run(
          "return document.activeElement === $('aside input[aria-label=\"Address and search bar\"]')",
        ),
      ).toBe(false);
    } finally {
      await run("$('#address-not-ready')?.remove()");
    }
    await app.waitFor(
      "(() => { const input = document.querySelector('aside input[aria-label=\"Address and search bar\"]'); return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length; })()",
      { label: "the available address bar takes focus and selects its URL" },
    );
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
    await app.insertText("typed.example");
    expect(
      await run(
        "return $('aside input[aria-label=\"Address and search bar\"]').value",
      ),
    ).toBe("typed.example");
    await app.press("Escape");
    // A pending request yields when the person tabs somewhere else. Making
    // the field available later must not take that focus back.
    await run(
      "const style = document.createElement('style'); style.id = 'address-not-ready'; style.textContent = 'aside input[aria-label=\"Address and search bar\"] { visibility: hidden !important; }'; document.head.append(style)",
    );
    try {
      await app.press("l", process.platform === "darwin" ? 4 : 2);
      await run("$('button[aria-label=\"Collapse sidebar\"]').focus()");
      await app.press("Tab");
      await run("document.activeElement.dataset.e2eFocusOwner = 'kept'");
    } finally {
      await run("$('#address-not-ready')?.remove()");
    }
    await app.eval(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    expect(
      await run(
        "return document.activeElement === $('[data-e2e-focus-owner=kept]') && document.activeElement !== document.body",
      ),
    ).toBe(true);
    await run(
      "$('[data-e2e-focus-owner=kept]').removeAttribute('data-e2e-focus-owner')",
    );
    // A programmatic foreground change is not another key or pointer
    // action. Cancel before paint rather than relying on that input guard.
    await run(
      "const style = document.createElement('style'); style.id = 'address-not-ready'; style.textContent = 'aside input[aria-label=\"Address and search bar\"] { visibility: hidden !important; }'; document.head.append(style)",
    );
    try {
      await app.press("l", process.platform === "darwin" ? 4 : 2);
      await run("button('Settings').click()");
      await app.waitFor(
        "!!document.querySelector('select[name=tabPlacement]')",
      );
      await run(
        "$('select[name=tabPlacement]').focus(); document.activeElement.dataset.e2eFocusOwner = 'settings'",
      );
    } finally {
      await run("$('#address-not-ready')?.remove()");
    }
    await app.eval(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    expect(
      await run(
        "return document.activeElement === $('[data-e2e-focus-owner=settings]')",
      ),
    ).toBe(true);
    await run(
      "$('[data-e2e-focus-owner=settings]').removeAttribute('data-e2e-focus-owner'); [...document.querySelectorAll('aside button')].find(button => button.textContent.includes('Header check')).click()",
    );
    await app.waitFor(
      "!!document.querySelector('aside [data-browser-toolbar]')",
    );
    // Cmd+L also reverses a collapse; the guest keeps its identity.
    await app.waitFor(
      "!document.documentElement.hasAttribute('data-content-settling') && document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)",
      { label: "the returned browser is at rest before reversing its sidebar" },
    );
    const collapsePoint = await app.waitFor<{ x: number; y: number }>(
      "(() => { const aside = document.querySelector('aside'); if (aside.dataset.settled !== 'true') return false; const button = aside.querySelector('button[aria-label=\"Collapse sidebar\"]'); const r = button.getBoundingClientRect(); const x = r.x+r.width/2; const y = r.y+r.height/2; return button.contains(document.elementFromPoint(x,y)) && {x,y}; })()",
    );
    await app.cdp("Animation.enable");
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 0.1 });
    try {
      await app.clickPointer(collapsePoint);
      await app.waitFor(
        "document.querySelector('aside').dataset.motion === 'closing'",
      );
      await app.press("l", process.platform === "darwin" ? 4 : 2);
    } finally {
      await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
      await app.cdp("Animation.disable");
    }
    await app.waitFor(
      "document.activeElement?.getAttribute('aria-label') === 'Address and search bar'",
      {
        label: "Cmd+L focuses the address while reversing the closing sidebar",
      },
    );
    expect(await run("return $('webview').getWebContentsId()")).toBe(guest);
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

  it("opens a customization chat whose visible message is prose plus a config pill", async () => {
    await run("$('button[aria-label=\"Customize sidebar\"]').click()");
    await app.waitFor("!!document.querySelector('[data-composer-input]')");
    await app.waitFor(
      "document.body.innerText.includes('Help me customize my left sidebar')",
    );
    await app.waitFor("!!document.querySelector('[data-pill-kind=\"path\"]')");
    // The message as the person sees it. The fake agent's reply echoes every
    // attachment it received, so the rest of the page may hold the context.
    const text = await app.waitFor<string>(
      "[...document.querySelectorAll('[data-user-message]')].map((el) => el.innerText).find((t) => t.includes('Help me customize my left sidebar'))",
    );
    // Structured context never appears in the user-visible message.
    expect(text).not.toContain("Current layout:");
    expect(text).not.toContain("module.exports");
    expect(text).not.toContain('"sections"');
    expect(
      await app.eval(
        "document.querySelector('[data-pill-kind=\"path\"]').textContent",
      ),
    ).toContain("workspace.js");
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
  await app.reload();
  await app.waitFor("!!window.catamorphicDesktop");
  expect(
    await app.eval(
      "window.catamorphicDesktop.getPrefs().then(prefs => prefs.githubCliEnabled)",
    ),
  ).toBe(false);
});
