import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let projectId: string;
let personalFile: string;
const helpers = `
${setReactValueJs}
const input=()=>[...document.querySelectorAll('[aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0);
const key=(key, mods={})=>input().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...mods}));
const rows=()=>[...input().closest('[role="dialog"]').querySelectorAll('[role="option"]')];
`;
const run = <T>(code: string) => app.eval<T>(`(()=>{${helpers};${code}})()`);
const wait = (code: string) => app.waitFor(`(()=>{${helpers};${code}})()`);
const open = async () => {
  // Wait for the previous overlay's exit before opening another one.
  await wait(`return !input()`);
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  await wait(`return document.activeElement === input()`);
};
const type = (text: string) =>
  run(`setReactValue(input(),${JSON.stringify(text)})`);
const destination = async (id: string) => {
  await app.waitFor(
    `document.querySelector('[data-setting-id="${id}"]')?.dataset.settingsTarget==='true'`,
  );
  // The row is scrolled into view and kept there while the content above
  // it settles; the wait covers that beat instead of one frame.
  await app.waitFor(
    `(()=>{const row=document.querySelector('[data-setting-id="${id}"]');const root=document.querySelector('[data-settings-scroll]');if(!row||!root)return false;const a=row.getBoundingClientRect(),b=root.getBoundingClientRect();return a.top>=b.top && a.top<b.bottom})()`,
    { label: `${id} row in view` },
  );
  const ring = await app.eval<{ width: number; offset: number }>(`(() => {
    const row = document.querySelector('[data-setting-id="${id}"]');
    const style = getComputedStyle(row);
    return {width:parseFloat(style.outlineWidth),offset:parseFloat(style.outlineOffset)};
  })()`);
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.offset).toBeLessThanOrEqual(-ring.width);
};
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Settings palette',rootPath:${JSON.stringify(`${app.userDataDir}/settings-palette-project`)}})`,
  );
  projectId = project.id;
  const profileId = await app.eval<string>(
    `window.catamorphicDesktop.profilesList().then(data => data.profiles.find(profile => profile.projectIds.includes(${JSON.stringify(projectId)}))?.id ?? data.defaultProfileId)`,
  );
  personalFile = `${app.userDataDir}/profiles/${profileId}/settings-projects/${projectId}.json`;
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Settings palette')`);
  // Close the startup New Tab so all following searches use the overlay.
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1300,900)`);
});
afterAll(async () => {
  await app?.stop();
});
it("finds a setting in ordinary search and opens its control", async () => {
  await open();
  await type("framed content");
  await wait(`return rows()[0]?.textContent.includes('Framed content')`);
  await run(`key('Enter')`);
  await destination("contentFrame");
  expect(
    await app.eval(
      `(()=>{const row=document.querySelector('[data-setting-id="contentFrame"]');const a=row.getBoundingClientRect(), text=row.querySelector('label').getBoundingClientRect(), control=row.querySelector('input').getBoundingClientRect();return {left:text.left-a.left,right:a.right-control.right,top:text.top-a.top}})()`,
    ),
  ).toMatchObject({ left: 8, right: 8 });
  expect(await app.eval(`document.activeElement?.getAttribute('name')`)).toBe(
    "contentFrame",
  );
});
it("settings Space scopes search and reuses Settings for advanced colors", async () => {
  await open();
  await type("settings");
  await run(`key(' ')`);
  await wait(`return input().placeholder==='Search settings…'`);
  await type("accent color");
  await wait(`return rows()[0]?.textContent.includes('Accent color')`);
  expect(
    await run(
      `return rows().every(row=>row.textContent.includes('Settings ·'))`,
    ),
  ).toBe(true);
  await wait(
    `return input().closest('[role="dialog"]').getAnimations({subtree:true}).every(animation=>animation.playState!=='running')`,
  );
  await app.screenshot("/tmp/palette-settings-scope.png");
  await run(`key('Enter')`);
  await destination("theme.overrides.accent");
  expect(
    await app.eval(
      `document.querySelectorAll('[data-point-key="settings:settings"]').length`,
    ),
  ).toBe(1);
  await wait(
    `return !input() && [...document.querySelectorAll('[role="dialog"]')].filter(dialog=>dialog.querySelector('[aria-label="Search commands, pages, and more"]')).every(dialog=>getComputedStyle(dialog.parentElement).opacity==='0')`,
  );
  expect(
    await app.eval(
      `document.querySelector('[aria-label="Settings categories"] [aria-current="location"]')?.textContent`,
    ),
  ).toBe("Appearance");
  await app.screenshot("/tmp/palette-settings-destination.png");
});
it("supports repeated destinations and leaving the mode", async () => {
  await open();
  await type("settings");
  await run(`key('Tab')`);
  await wait(`return input().placeholder==='Search settings…'`);
  await run(`key('Backspace')`);
  await wait(`return input().placeholder!=='Search settings…'`);
  await type("new tab shortcut");
  await wait(`return rows()[0]?.textContent.includes('New tab shortcut')`);
  await run(`key('Enter')`);
  await destination("shortcut.new-tab");
  await open();
  await type("framed content");
  await wait(`return rows()[0]?.textContent.includes('Framed content')`);
  await run(`key('Enter')`);
  await destination("contentFrame");
});
it("keeps the first shortcut highlight inside its clipped list and clears it without changing row corners", async () => {
  await open();
  await type("configure agent shortcut");
  await wait(`return rows()[0]?.textContent.includes('Configure agent')`);
  await run(`key('Enter')`);
  await destination("shortcut.configure-agent");
  const before = await app.eval<string>(`(() => {
    const row = document.querySelector('[data-setting-id="shortcut.configure-agent"]');
    row.tabIndex = -1;
    row.focus({preventScroll:true});
    document.documentElement.dataset.focusModality = 'keyboard';
    return getComputedStyle(row).borderRadius;
  })()`);
  // The destination remains fully inset even if the row itself receives focus.
  await destination("shortcut.configure-agent");
  await wait(
    `return !input() && [...document.querySelectorAll('[role="dialog"]')].filter(dialog=>dialog.querySelector('[aria-label="Search commands, pages, and more"]')).every(dialog=>getComputedStyle(dialog.parentElement).opacity==='0')`,
  );
  await app.screenshot(
    path.join(
      process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp",
      "settings-shortcut-highlight.png",
    ),
  );
  await open();
  await type("framed content");
  await wait(`return rows()[0]?.textContent.includes('Framed content')`);
  await run(`key('Enter')`);
  await destination("contentFrame");
  expect(
    await app.eval(`(() => {
    const row = document.querySelector('[data-setting-id="shortcut.configure-agent"]');
    return !row.hasAttribute('data-settings-target') && getComputedStyle(row).borderRadius === ${JSON.stringify(before)};
  })()`),
  ).toBe(true);
});
it("offers the actual desktop host skill and lets a project agent edit its scoped JSON file", async () => {
  await open();
  await type(">configuring-catamorphic-desktop");
  await wait(
    `return rows().some(row=>row.dataset.itemId==='skill:configuring-catamorphic-desktop')`,
  );
  await run(
    `rows().find(row=>row.dataset.itemId==='skill:configuring-catamorphic-desktop').dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}))`,
  );
  await app.waitFor(
    `document.body?.innerText.includes('skill loaded: configuring-catamorphic-desktop (source:host')`,
  );
  await open();
  await type("agent");
  await run(`key(' ')`);
  await wait(`return input().dataset.placeholder==='Message the agent…'`);
  await type("E2E enable personal framed content");
  await wait(
    `return rows()[0]?.textContent.includes('Ask agent') && !rows()[0]?.textContent.includes('E2E enable personal framed content')`,
  );
  await run(`key('Enter')`);
  await app.waitFor(
    `document.body?.innerText.includes('Personal framed content updated by editing its JSON file.')`,
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>({value:s.values.contentFrame,source:s.sources.contentFrame}))`,
    ),
  ).toEqual({ value: true, source: "personal" });
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps valid file settings active through invalid edits and reports recovery in the UI", async () => {
  await open();
  await type("framed content");
  await wait(`return rows()[0]?.textContent.includes('Framed content')`);
  await run(`key('Enter')`);
  await destination("contentFrame");
  await app.waitFor(
    `(()=>{const input=document.querySelector('[name="contentFrame"]');const rect=input.getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===input})()`,
  );
  await app.waitFor(
    `!document.getAnimations().some(animation=>animation.playState==='running')`,
  );
  await app.screenshot("/tmp/settings-files-spacing-dark.png");
  fs.writeFileSync(personalFile, '{"contentFrame":');
  await app.waitFor(
    `document.querySelector('[data-config-errors]')?.textContent.includes(${JSON.stringify(personalFile)})`,
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>s.values.contentFrame)`,
    ),
  ).toBe(true);
  fs.writeFileSync(personalFile, "{}");
  await app.waitFor(`!document.querySelector('[data-config-errors]')`);
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>s.values.contentFrame)`,
    ),
  ).toBe(false);
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
  );
  await app.waitFor(`document.documentElement.dataset.theme==='light'`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',900,760)`);
  await app.waitFor(`window.innerWidth===900`);
  await app.waitFor(
    `!document.getAnimations().some(animation=>animation.playState==='running')`,
  );
  await app.screenshot("/tmp/settings-files-compact-light.png");
  expect(app.getRendererErrors()).toEqual([]);
});
