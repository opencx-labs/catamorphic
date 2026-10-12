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
    // The project switcher moves up into the row the buttons kept.
    expect(await run("return projectInHeader()")).toBe(true);
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
