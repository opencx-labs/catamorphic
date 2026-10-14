import fs from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * The macOS close, minimize and full screen buttons follow the profile's
 * `windowButtons` preference, from Settings or from an edit of prefs.json
 * (what a person's agent does). The chrome gives their corner back while
 * they are hidden. Other platforms draw a native frame and offer nothing.
 */

const mac = process.platform === "darwin";
let app: AppHandle;
let prefsFile: string;
const helpers = `
${setReactValueJs}
const $ = s => document.querySelector(s);
const input=()=>[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0);
const key=(key, mods={})=>input().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...mods}));
const rows=()=>[...input().closest('[role="dialog"]').querySelectorAll('[role="option"]')];
const headerInset=()=>getComputedStyle($('[data-sidebar="left"] button[aria-label="Collapse sidebar"]').closest('.app-drag')).paddingLeft;
const projectInHeader=()=>!!$('[data-sidebar="left"] [data-sidebar-project]').closest('.app-drag');
`;
const run = <T>(code: string) => app.eval<T>(`(()=>{${helpers};${code}})()`);
const wait = (code: string, label?: string) =>
  app.waitFor(`(()=>{${helpers};${code}})()`, label ? { label } : undefined);
/** What the window draws: null where the OS frame owns the buttons. */
const drawn = () =>
  app.eval<boolean | null>(
    "window.catamorphicDesktop.devWindow('get').then(state => state.windowButtons)",
  );
const poll = <T>(read: () => Promise<T>) =>
  expect.poll(read, { timeout: 10_000, interval: 100 });
/** An edit of the profile's preferences file, as an agent makes one. */
const editPrefs = (patch: Record<string, unknown>) => {
  const current: Record<string, unknown> = fs.existsSync(prefsFile)
    ? JSON.parse(fs.readFileSync(prefsFile, "utf8"))
    : {};
  const next = { ...current, ...patch };
  for (const [name, value] of Object.entries(patch))
    if (value === undefined) delete next[name];
  fs.writeFileSync(`${prefsFile}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(`${prefsFile}.tmp`, prefsFile);
};
const searchPalette = async (text: string) => {
  await wait("return !input()");
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',metaKey:${mac},ctrlKey:${!mac},bubbles:true}))`,
  );
  await wait("return document.activeElement === input()");
  await run(`setReactValue(input(),${JSON.stringify(text)})`);
  await wait(`return rows().length > 0`);
};

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Chrome corner',rootPath:${JSON.stringify(`${app.userDataDir}/chrome-corner-project`)}})`,
  );
  const profileId = await app.eval<string>(
    `window.catamorphicDesktop.profilesList().then(data => data.profiles.find(profile => profile.projectIds.includes(${JSON.stringify(project.id)}))?.id ?? data.defaultProfileId)`,
  );
  prefsFile = `${app.userDataDir}/profiles/${profileId}/prefs.json`;
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Chrome corner')`);
  // Close the startup New Tab so searches use the palette overlay.
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:${mac},ctrlKey:${!mac},bubbles:true}))`,
  );
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1300,900)`);
});
afterAll(async () => {
  await app?.stop();
});

it.skipIf(!mac)(
  "hides the buttons from Settings and gives their corner back",
  async () => {
    expect(await drawn()).toBe(true);
    expect(await run("return headerInset()")).toBe("86px");
    expect(await run("return projectInHeader()")).toBe(false);

    await searchPalette("window buttons");
    expect(await run("return rows()[0].textContent")).toContain(
      "Window buttons",
    );
    await run("key('Enter')");
    await app.waitFor(
      `document.querySelector('[data-setting-id="windowButtons"]')?.dataset.settingsTarget === 'true'`,
      { label: "palette opens the Window buttons row" },
    );
    expect(
      await app.eval(
        `document.querySelector('[data-setting-id="windowButtons"]').closest('section').querySelector('h2').textContent`,
      ),
    ).toBe("Window");
    expect(
      await app.eval(
        `document.querySelector('[name="windowButtons"]').checked`,
      ),
    ).toBe(true);

    await app.eval(`document.querySelector('[name="windowButtons"]').click()`);
    await wait(
      "return $('[data-window-buttons]').dataset.windowButtons === 'off'",
      "the chrome gives the corner back",
    );
    await poll(drawn).toBe(false);
    expect(await run("return headerInset()")).toBe("12px");
    // The project switcher moves up into the row the buttons kept, and
    // heads the sidebar across it, not only as wide as its name.
    expect(await run("return projectInHeader()")).toBe(true);
    expect(
      await run(
        `const row=$('[data-sidebar="left"] [data-sidebar-project]').closest('.app-drag').getBoundingClientRect();const trigger=$('[data-sidebar="left"] [aria-label="Switch project"]').getBoundingClientRect();const toggle=$('[data-sidebar="left"] button[aria-label="Collapse sidebar"]').getBoundingClientRect();return trigger.left - row.left <= 16 && toggle.left - trigger.right <= 12`,
      ),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(prefsFile, "utf8"))).toMatchObject({
      windowButtons: false,
    });
    await app.screenshot("/tmp/window-buttons-hidden.png");

    // Collapsed, the toggle the chrome shows starts at the window's edge.
    await app.eval("window.catamorphicDesktop.setPrefs({sidebarOpen:false})");
    const toggleLeft = () =>
      run<number | null>(
        `const button=[...document.querySelectorAll('button[aria-label="Expand sidebar"]')].find(b=>!b.closest('[inert]'));return button ? Math.round(button.getBoundingClientRect().left) : null`,
      );
    await poll(toggleLeft).toBeLessThan(20);
    await app.eval("window.catamorphicDesktop.setPrefs({sidebarOpen:true})");
    await wait(
      'return !!$(\'[data-sidebar="left"] button[aria-label="Collapse sidebar"]\')',
    );
    expect(app.getRendererErrors()).toEqual([]);
  },
);

it.skipIf(!mac)(
  "follows an agent's edits of the preferences file live",
  async () => {
    // Deleting the key resets it to the app default.
    editPrefs({ windowButtons: undefined });
    await wait(
      "return $('[data-window-buttons]').dataset.windowButtons === 'on'",
      "reset shows the buttons again",
    );
    await poll(drawn).toBe(true);
    expect(await run("return headerInset()")).toBe("86px");
    expect(await run("return projectInHeader()")).toBe(false);
    expect(
      await app.eval(
        `document.querySelector('[name="windowButtons"]').checked`,
      ),
    ).toBe(true);

    editPrefs({ windowButtons: false });
    await wait(
      "return $('[data-window-buttons]').dataset.windowButtons === 'off'",
      "the agent's edit hides the buttons",
    );
    await poll(drawn).toBe(false);
    expect(
      await app.eval(
        `document.querySelector('[name="windowButtons"]').checked`,
      ),
    ).toBe(false);

    // The collapsed sidebar that holds the header shows the buttons with
    // itself, unless the person turned them off. The OS pointer rests over
    // the content, away from the edge that reveals the sidebar.
    await app.movePointer({ x: 600, y: 300 });
    await app.eval(
      "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar',headerPlacement:'sidebar',sidebarOpen:false})",
    );
    await wait("return !!$('button[aria-label=\"Show sidebar\"]')");
    await run("$('button[aria-label=\"Show sidebar\"]').focus()");
    await wait(
      "return $('aside').dataset.sidebarRevealed === 'true'",
      "keyboard reveals the collapsed sidebar",
    );
    expect(await drawn()).toBe(false);
    editPrefs({ windowButtons: true });
    await poll(drawn).toBe(true);
    await run(
      "$('[aria-label=\"Settings categories\"]').querySelector('button').focus()",
    );
    await wait(
      "return $('aside').dataset.sidebarRevealed !== 'true'",
      "focus leaving the sidebar hides it",
    );
    await poll(drawn).toBe(false);
    await app.eval(
      "window.catamorphicDesktop.setPrefs({tabPlacement:'top',headerPlacement:'top',sidebarOpen:true})",
    );
    await poll(drawn).toBe(true);
    expect(app.getRendererErrors()).toEqual([]);
  },
);

it.skipIf(mac)("offers nothing where the OS draws the frame", async () => {
  expect(await drawn()).toBe(null);
  // "window" finds Framed content; Window buttons would rank above it.
  await searchPalette("window");
  expect(
    await run(
      "return rows().some(row => row.textContent.includes('Window buttons'))",
    ),
  ).toBe(false);
  await run("key('Escape')");
  await app.eval(`document.querySelector('[aria-label="Settings"]').click()`);
  await app.waitFor(`!!document.querySelector('[data-settings-layout]')`);
  await app.eval(
    `([...document.querySelectorAll('nav[aria-label="Settings categories"] button')].find(b=>b.textContent.trim()==='Workspace')).click()`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-setting="contentFrame"]')`,
  );
  expect(
    await app.eval(
      `!!document.querySelector('[data-setting="windowButtons"]')`,
    ),
  ).toBe(false);

  // A hand edit changes nothing either; the dividers prove it was read.
  editPrefs({ windowButtons: false, sidebarDividers: true });
  await app.waitFor(
    "document.querySelector('[data-sidebar-dividers]').dataset.sidebarDividers === 'on'",
    { label: "the edited preferences reached the window" },
  );
  expect(
    await run("return $('[data-window-buttons]').dataset.windowButtons"),
  ).toBe("on");
  expect(await run("return headerInset()")).toBe("86px");
  expect(app.getRendererErrors()).toEqual([]);
});

/**
 * With the buttons hidden the project switcher spans the sidebar's top row,
 * so the window drags by the chrome's empty room instead, as Chrome's tab
 * strip does: the strip's spare end, or the title row. The renderer draws
 * the hidden-buttons layout only on macOS, which it reads from the
 * navigator, so elsewhere the test asks for macOS's.
 *
 * The drag area is worked out as Electron does: the boxes of everything
 * that says `app-region: drag` or `no-drag`, each over the ones before it
 * in the document, whatever is drawn on top.
 */
it("drags the window by the chrome's empty room with the buttons hidden", async () => {
  if (!mac) {
    const userAgent = await app.eval<string>("navigator.userAgent");
    await app.cdp("Emulation.setUserAgentOverride", {
      userAgent,
      platform: "MacIntel",
    });
  }
  editPrefs({
    windowButtons: false,
    tabPlacement: "top",
    headerPlacement: "top",
    tabAlignment: "start",
    sidebarOpen: true,
  });
  if (!mac) await app.reload();
  const regions = `
    const $$ = (selector) => [...document.querySelectorAll(selector)];
    const regions = () => [...document.querySelectorAll('*')].flatMap((element) => {
      const style = getComputedStyle(element);
      const region = style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region');
      if (region !== 'drag' && region !== 'no-drag') return [];
      return [...element.getClientRects()].map((rect) => ({ drag: region === 'drag', rect }));
    });
    const drags = (list, x, y) => {
      let drag = false;
      for (const entry of list)
        if (x >= entry.rect.left && x < entry.rect.right && y >= entry.rect.top && y < entry.rect.bottom) drag = entry.drag;
      return drag;
    };
    /** The longest stretch along the row's middle that drags the window. */
    const dragRun = (from = 0, to = innerWidth) => {
      const list = regions();
      let best = 0, run = 0;
      for (let x = from; x < to; x += 2) {
        run = drags(list, x, 20) ? run + 2 : 0;
        best = Math.max(best, run);
      }
      return best;
    };
    /** Controls in the top row that must take presses, by their middles. */
    const pressable = (selector) => {
      const list = regions();
      return [...document.querySelectorAll(selector)].filter((element) => element.checkVisibility() && !element.closest('[inert]')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') ?? element.textContent.trim(), drags: drags(list, rect.left + rect.width / 2, rect.top + rect.height / 2) };
      });
    };
    const settled = () => !document.getAnimations().some((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);
  `;
  const inPage = <T>(code: string) =>
    app.eval<T>(`(()=>{${helpers};${regions};${code}})()`);
  const settle = (condition: string, label: string) =>
    app.waitFor(
      `(()=>{${helpers};${regions};return ${condition} && settled();})()`,
      {
        label,
      },
    );
  await settle(
    "$('[data-window-buttons]')?.dataset.windowButtons === 'off' && projectInHeader() && $('aside[data-sidebar=\"left\"]')?.dataset.settled === 'true'",
    "the hidden-buttons layout",
  );
  expect(
    await inPage(
      "return getComputedStyle($('.app-drag')).getPropertyValue('-webkit-app-region')",
    ),
  ).toBe("drag");
  // Two tabs, so a drag can move one: Settings and a New Tab.
  await inPage("$('button[aria-label=\"Settings\"]').click()");
  await settle(
    '!!$(\'[data-tab-orientation="horizontal"] [data-point-key^="settings:"]\')',
    "the Settings tab",
  );
  await inPage("$('button[aria-label=\"New tab\"]').click()");
  await settle(
    "$$('[data-tab-orientation=\"horizontal\"] [data-point-key]').length >= 2",
    "two tabs",
  );
  const strip = `$('[data-tab-orientation="horizontal"]')`;
  const controls = `[data-tab-orientation="horizontal"] [data-point-key] button, button[aria-label="New tab"], [data-sidebar="left"] [aria-label="Switch project"], button[aria-label$="sidebar"]`;
  const expectDragRoom = async (layout: string, min: number) => {
    const run = await inPage<number>("return dragRun()");
    expect(run, layout).toBeGreaterThanOrEqual(min);
    const presses = await inPage<{ label: string; drags: boolean }[]>(
      `return pressable(${JSON.stringify(controls)})`,
    );
    expect(presses.length, layout).toBeGreaterThan(0);
    expect(
      presses.filter((control) => control.drags),
      layout,
    ).toEqual([]);
  };

  // Tabs on top: the strip's end, after the last tab and its +, drags the
  // window; the tabs, the + and the toggles still take presses.
  await expectDragRoom("tabs on top", 300);
  expect(
    await inPage(
      `const plus = $('button[aria-label="New tab"]').getBoundingClientRect(); return drags(regions(), plus.right + 24, 20);`,
    ),
  ).toBe(true);

  // The switcher's own card opens beside the sidebar, clear of its toggle.
  const trigger = await inPage<{ x: number; y: number }>(
    `const rect = $('[data-sidebar="left"] [aria-label="Switch project"]').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 3), y: Math.round(rect.top + rect.height / 2) };`,
  );
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...trigger });
  await settle(
    '!!$(\'[data-resource-inspector][data-open="true"] [data-testid="project-inspector"]\')',
    "the current project's card",
  );
  expect(
    await inPage(`
      const card = $('[data-resource-inspector][data-open="true"]').getBoundingClientRect();
      const sidebar = $('[data-sidebar="left"] .sidebar-inner').getBoundingClientRect();
      const toggle = $('[data-sidebar="left"] button[aria-label="Collapse sidebar"]').getBoundingClientRect();
      const covers = card.left < toggle.right && card.right > toggle.left && card.top < toggle.bottom && card.bottom > toggle.top;
      return card.left >= sidebar.right && !covers;`),
  ).toBe(true);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 900,
    y: 500,
  });
  await settle("!$('[data-resource-inspector][data-open]')", "the card closed");

  // A dragged tab can still land at the strip's end: while it is dragged
  // that room is the strip's drop target, not the window's handle.
  const order = () =>
    inPage<string[]>(
      `return $$('[data-tab-orientation="horizontal"] [data-point-key]').map((tab) => tab.dataset.pointKey)`,
    );
  const before = await order();
  await inPage(`
    window.__tabDrag = new DataTransfer();
    ${strip}.querySelector('[data-point-key]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__tabDrag }));
    return true;`);
  await settle(
    "!!$('[data-tab-strip-room=\"end\"]') && getComputedStyle($('[data-tab-strip-room=\"end\"]')).getPropertyValue('-webkit-app-region') !== 'drag'",
    "the strip's end takes the drop",
  );
  await inPage(`
    const room = $('[data-tab-strip-room="end"]');
    const rect = room.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: window.__tabDrag, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    room.dispatchEvent(new DragEvent('dragover', init));
    room.dispatchEvent(new DragEvent('drop', init));
    ${strip}.querySelector('[data-point-key]').dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    delete window.__tabDrag;
    return true;`);
  await poll(order).toEqual([...before.slice(1), before[0]]);
  await settle(
    "getComputedStyle($('[data-tab-strip-room=\"end\"]')).getPropertyValue('-webkit-app-region') === 'drag'",
    "the strip's end drags the window again",
  );

  // Centred tabs sit between two such ends.
  await app.eval("window.catamorphicDesktop.setPrefs({tabAlignment:'center'})");
  await settle("!!$('[data-tab-strip-room=\"start\"]')", "centred tabs");
  expect(
    await inPage(`
      const start = $('[data-tab-strip-room="start"]').getBoundingClientRect();
      const end = $('[data-tab-strip-room="end"]').getBoundingClientRect();
      return Math.abs(start.width - end.width) <= 2 && start.width > 100;`),
  ).toBe(true);
  await expectDragRoom("centred tabs", 100);
  await app.eval("window.catamorphicDesktop.setPrefs({tabAlignment:'start'})");
  await settle("!$('[data-tab-strip-room=\"start\"]')", "tabs at the start");

  // The sidebar collapsed, the toggle moves into the chrome beside the tabs.
  await app.eval("window.catamorphicDesktop.setPrefs({sidebarOpen:false})");
  await settle(
    "$('aside[data-sidebar=\"left\"]')?.dataset.motion === 'closed'",
    "the sidebar collapsed",
  );
  await expectDragRoom("collapsed sidebar", 300);
  await app.eval("window.catamorphicDesktop.setPrefs({sidebarOpen:true})");
  await settle(
    "$('aside[data-sidebar=\"left\"]')?.dataset.settled === 'true' && $('aside[data-sidebar=\"left\"]')?.dataset.motion === 'open'",
    "the sidebar open",
  );

  // Tabs in the sidebar: the title row above the content drags.
  await app.eval(
    "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar'})",
  );
  await settle(
    "!!$('aside [data-tab-orientation=\"vertical\"]') && projectInHeader()",
    "tabs in the sidebar",
  );
  await expectDragRoom("tabs in the sidebar", 300);

  // The header in the sidebar too: the switcher goes back below the row,
  // whose room beside the toggle drags.
  await app.eval(
    "window.catamorphicDesktop.setPrefs({headerPlacement:'sidebar'})",
  );
  await settle(
    "!projectInHeader() && !$('main .workspace-chrome')",
    "the header in the sidebar",
  );
  const sidebar = await inPage<{ left: number; right: number }>(
    `const rect = $('[data-sidebar="left"] .sidebar-inner').getBoundingClientRect(); return { left: rect.left, right: rect.right };`,
  );
  expect(
    await inPage<number>(
      `return dragRun(${Math.round(sidebar.left)}, ${Math.round(sidebar.right)})`,
    ),
  ).toBeGreaterThanOrEqual(120);

  await app.eval(
    "window.catamorphicDesktop.setPrefs({tabPlacement:'top',headerPlacement:'top'})",
  );
  await settle("!!$('main .workspace-chrome')", "tabs on top again");
  expect(app.getRendererErrors()).toEqual([]);
});
