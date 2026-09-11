import fs from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let projectId: string;
let personalFile: string;
const helpers = `
${setReactValueJs}
const input=()=>[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0);
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
  expect(
    await app.eval(
      `(()=>{const row=document.querySelector('[data-setting-id="${id}"]');const root=document.querySelector('[data-settings-scroll]');const a=row.getBoundingClientRect(),b=root.getBoundingClientRect();return a.top>=b.top && a.top<b.bottom})()`,
    ),
  ).toBe(true);
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
  await type("tab frame");
  await wait(`return rows()[0]?.textContent.includes('Tab frame')`);
  await run(`key('Enter')`);
  await destination("tabFrame");
  expect(
    await app.eval(
      `(()=>{const row=document.querySelector('[data-setting-id="tabFrame"]');const a=row.getBoundingClientRect(), text=row.querySelector('label').getBoundingClientRect(), control=row.querySelector('input').getBoundingClientRect();return {left:text.left-a.left,right:a.right-control.right,top:text.top-a.top}})()`,
    ),
  ).toMatchObject({ left: 8, right: 8 });
  expect(await app.eval(`document.activeElement?.getAttribute('name')`)).toBe(
    "tabFrame",
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
    `return !input() && [...document.querySelectorAll('[role="dialog"]')].filter(dialog=>dialog.querySelector('textarea[aria-label="Search commands, pages, and more"]')).every(dialog=>getComputedStyle(dialog.parentElement).opacity==='0')`,
  );
  expect(
    await app.eval(
      `document.querySelector('[aria-label="Settings categories"] [aria-current="location"]')?.textContent`,
    ),
  ).toBe("Appearance");
  await app.screenshot("/tmp/palette-settings-destination.png");
});
it("clears shortcut filters and supports repeated destinations and leaving the mode", async () => {
  await app.eval(
    `(()=>{${setReactValueJs};setReactValue(document.querySelector('[aria-label="Search keyboard shortcuts"]'),'no-match-at-all')})()`,
  );
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
  expect(
    await app.eval(
      `document.querySelector('[aria-label="Search keyboard shortcuts"]').value`,
    ),
  ).toBe("");
  await open();
  await type("tab frame");
  await wait(`return rows()[0]?.textContent.includes('Tab frame')`);
  await run(`key('Enter')`);
  await destination("tabFrame");
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
  await wait(`return input().placeholder==='Message the agent…'`);
  await type("E2E enable personal tab frame");
  await wait(
    `return rows()[0]?.textContent.includes('Ask agent') && !rows()[0]?.textContent.includes('E2E enable personal tab frame')`,
  );
  await run(`key('Enter')`);
  await app.waitFor(
    `document.body?.innerText.includes('Personal tab frame updated by editing its JSON file.')`,
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>({value:s.values.tabFrame,source:s.sources.tabFrame}))`,
    ),
  ).toEqual({ value: true, source: "personal" });
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps valid file settings active through invalid edits and reports recovery in the UI", async () => {
  await open();
  await type("tab frame");
  await wait(`return rows()[0]?.textContent.includes('Tab frame')`);
  await run(`key('Enter')`);
  await destination("tabFrame");
  await app.waitFor(
    `(()=>{const input=document.querySelector('[name="tabFrame"]');const rect=input.getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===input})()`,
  );
  await app.waitFor(
    `!document.getAnimations().some(animation=>animation.playState==='running')`,
  );
  await app.screenshot("/tmp/settings-files-spacing-dark.png");
  fs.writeFileSync(personalFile, '{"tabFrame":');
  await app.waitFor(
    `document.querySelector('[data-config-errors]')?.textContent.includes(${JSON.stringify(personalFile)})`,
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>s.values.tabFrame)`,
    ),
  ).toBe(true);
  fs.writeFileSync(personalFile, "{}");
  await app.waitFor(`!document.querySelector('[data-config-errors]')`);
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>s.values.tabFrame)`,
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
