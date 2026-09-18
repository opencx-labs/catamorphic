import fs from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let projectId: string;
let root: string;
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  root = `${app.userDataDir}/settings-project`;
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Inherited settings',rootPath:${JSON.stringify(root)}})`,
  );
  projectId = project.id;
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Inherited settings')`);
  await app.eval(`document.querySelector('[aria-label="Settings"]').click()`);
  await app.waitFor(`!!document.querySelector('[data-settings-layout]')`);
  await app.eval(
    `([...document.querySelectorAll('nav[aria-label="Settings categories"] button')].find(b=>b.textContent.trim()==='Workspace')).click()`,
  );
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1300,900)`);
});
afterAll(async () => {
  await app?.stop();
});
const chooseScope = async (value: string) => {
  await app.eval(
    `(()=>{const input=document.querySelector('[aria-label="Settings scope"]');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await app.waitFor(
    `!!document.querySelector('[name="contentFrame"]') && !document.querySelector('[name="contentFrame"]').disabled`,
  );
};
it("edits and resets profile and personal choices through the real Settings UI", async () => {
  expect(
    await app.eval(`document.querySelector('[name="contentFrame"]').checked`),
  ).toBe(false);
  await app.eval(`document.querySelector('[name="contentFrame"]').click()`);
  await app.waitFor(
    `!!document.querySelector('[aria-label="Reset Framed content to inherited"]')`,
  );
  await chooseScope("personal");
  await app.waitFor(
    `document.querySelector('[data-setting="contentFrame"]').textContent.includes('From profile')`,
  );
  expect(
    await app.eval(`document.querySelector('[name="contentFrame"]').checked`),
  ).toBe(true);
  await app.eval(`document.querySelector('[name="contentFrame"]').click()`);
  await app.waitFor(
    `!!document.querySelector('[aria-label="Reset Framed content to inherited"]')`,
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>s.sources.contentFrame)`,
    ),
  ).toBe("personal");
  await app.screenshot("/tmp/settings-personal-overrides.png");
  await app.eval(
    `document.querySelector('[aria-label="Reset Framed content to inherited"]').click()`,
  );
  await app.waitFor(
    `document.querySelector('[name="contentFrame"]').checked && !document.querySelector('[aria-label="Reset Framed content to inherited"]')`,
  );
});
it("shared file edits apply live, reset inherits them, and reload preserves sources", async () => {
  fs.mkdirSync(`${root}/.catamorphic`, { recursive: true });
  fs.writeFileSync(
    `${root}/.catamorphic/settings.json`,
    JSON.stringify({ contentFrame: false }),
  );
  await app.waitFor(
    `!document.querySelector('[name="contentFrame"]').checked && document.querySelector('[data-setting="contentFrame"]').textContent.includes('From project')`,
  );
  await app.eval(`document.querySelector('[name="contentFrame"]').click()`);
  await app.waitFor(
    `!!document.querySelector('[aria-label="Reset Framed content to inherited"]')`,
  );
  await app.eval(
    `document.querySelector('[aria-label="Reset Framed content to inherited"]').click()`,
  );
  await app.waitFor(`!document.querySelector('[name="contentFrame"]').checked`);
  await chooseScope("project");
  await app.screenshot("/tmp/settings-project-defaults.png");
  await app.eval(
    `document.querySelector('[aria-label="Reset Framed content to inherited"]').click()`,
  );
  await app.waitFor(`document.querySelector('[name="contentFrame"]').checked`);
  await app.reload();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  expect(
    await app.eval(
      `window.catamorphicDesktop.getSettings({projectId:${JSON.stringify(projectId)}}).then(s=>({value:s.values.contentFrame,source:s.sources.contentFrame}))`,
    ),
  ).toEqual({ value: true, source: "profile" });
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps inherited controls usable in the compact light settings view", async () => {
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
  );
  await app.waitFor(`document.documentElement.dataset.theme === "light"`);
  // Leave both sidebars open so scope selectors and Reset rows must fit
  // the narrow Settings surface, including platforms with wider controls.
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',840,600)`);
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await app.eval(`document.querySelector('[aria-label="Settings"]').click()`);
  await app.waitFor(
    `!!document.querySelector('[aria-label="Settings category"]')`,
  );
  await app.eval(
    `(()=>{const input=document.querySelector('[aria-label="Settings category"]');input.value='workspace';input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await app.waitFor(`!!document.querySelector('[name="contentFrame"]')`);
  await chooseScope("personal");
  await app.waitFor(
    `document.querySelector('[data-setting="contentFrame"]').textContent.includes('From profile')`,
  );
  expect(
    await app.eval(
      `(()=>{const container=document.querySelector('[data-settings-scroll]');return container.scrollWidth<=container.clientWidth;})()`,
    ),
  ).toBe(true);
  await app.screenshot("/tmp/settings-inheritance-compact-light.png");
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps checkbox rows and neighboring controls stable while changing and resetting overrides", async () => {
  await chooseScope("profile");
  await app.eval(
    `document.querySelector('[aria-label="Collapse right sidebar"]')?.click()`,
  );
  for (const width of [720, 900]) {
    await app.eval(
      `window.catamorphicDesktop.setSettings({projectId:${JSON.stringify(projectId)},scope:'profile',patch:{contentFrame:true}})`,
    );
    await app.waitFor(
      `document.querySelector('[data-setting="contentFrame"]').textContent.includes('Custom for profile') && !document.querySelector('[name="contentFrame"]').disabled`,
    );
    await app.eval(
      `window.catamorphicDesktop.devWindow('setSize',${width},760)`,
    );
    await app.eval(
      `document.querySelector('[name="contentFrame"]').scrollIntoView({block:'center'})`,
    );
    const geometry = () =>
      app.eval<number[]>(
        `(()=>{const row=document.querySelector('[data-setting="contentFrame"]');const r=row.getBoundingClientRect();const control=row.querySelector('input').getBoundingClientRect();return [r.height,r.right-control.right,control.y-r.y,row.lastElementChild.getBoundingClientRect().width,document.querySelector('[data-setting="contentPadding"]').getBoundingClientRect().top-r.top]})()`,
      );
    // Names every row between the two anchors with its height, so a
    // mismatch says which neighbour moved instead of only that one did.
    const rows = () =>
      app.eval<string>(
        `JSON.stringify([...document.querySelectorAll('[data-setting]')].map(row => [row.dataset.setting, Math.round(row.getBoundingClientRect().height), row.querySelector('p')?.textContent?.trim().slice(0, 60)]))`,
      );
    // The fifth reading is the gap to the next row: the Reset control must
    // not push it. Rows further away wrap differently per platform font at
    // this width and are not what this test guards.
    // Neighbouring rows finish loading their status lines asynchronously;
    // measure once two readings a beat apart agree.
    let before = await geometry();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await app.eval("new Promise((resolve) => setTimeout(resolve, 250))");
      const next = await geometry();
      if (JSON.stringify(next) === JSON.stringify(before)) break;
      before = next;
    }
    const rowsBefore = await rows();
    await app.screenshot(`/tmp/settings-checkbox-before-${width}.png`);
    await app.eval(
      `document.querySelector('[aria-label="Reset Framed content to inherited"]').click()`,
    );
    await app.waitFor(
      `!document.querySelector('[aria-label="Reset Framed content to inherited"]') && !document.querySelector('[name="contentFrame"]').disabled`,
    );
    await app.screenshot(`/tmp/settings-checkbox-reset-${width}.png`);
    expect(
      await geometry(),
      `before ${rowsBefore}\nafter ${await rows()}`,
    ).toEqual(before);
    await app.eval(`document.querySelector('[name="contentFrame"]').click()`);
    await app.waitFor(
      `!!document.querySelector('[aria-label="Reset Framed content to inherited"]') && !document.querySelector('[name="contentFrame"]').disabled`,
    );
    expect(
      await geometry(),
      `before ${rowsBefore}\nafter ${await rows()}`,
    ).toEqual(before);
  }
});

it("previews content padding smoothly in both directions and honors reduced motion", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  for (const padding of [0, 6]) {
    const previous = padding === 0 ? 6 : 0;
    await app.waitFor(
      `(()=>{const input=document.querySelector('[name="contentPadding"]');return input && !input.disabled && input.valueAsNumber === ${previous} && parseFloat(getComputedStyle(document.querySelector('.workspace-surface')).marginTop) === ${previous};})()`,
      { label: "saved content padding before sampling the next transition" },
    );
    const samples = await app.eval<number[]>(`new Promise(resolve=>{
      const surface=document.querySelector('.workspace-surface');
      const input=document.querySelector('[name="contentPadding"]');
      const margins=[];
      const start=performance.now();
      const sample=()=>{
        margins.push(parseFloat(getComputedStyle(surface).marginTop));
        if(performance.now()-start<800)requestAnimationFrame(sample);
        else resolve(margins);
      };
      sample();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(padding.toString())});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })`);
    expect(samples[0]).toBe(previous);
    expect(samples.at(-1)).toBe(padding);
    expect(samples.some((margin) => margin > 0 && margin < 6)).toBe(true);
  }
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  // Reduced motion collapses every transition to an instant (a hair above
  // zero so transitionend still fires).
  expect(
    Number.parseFloat(
      await app.eval(
        `getComputedStyle(document.querySelector('.workspace-surface')).transitionDuration`,
      ),
    ),
  ).toBeLessThanOrEqual(0.001);
  expect(app.getRendererErrors()).toEqual([]);
});

it("edits workspace padding, rounding and dividers independently and persists them", async () => {
  const run = <T>(body: string) =>
    app.eval<T>(
      `(() => { ${setReactValueJs} const $ = s => document.querySelector(s); ${body} })()`,
    );
  await chooseScope("profile");
  await app.eval(
    `document.querySelector('[aria-label="Expand right sidebar"]')?.click()`,
  );
  await app.waitFor("!!document.querySelector('input[name=contentPadding]')");
  await app.eval(
    "window.catamorphicDesktop.setPrefs({contentPadding:12,contentRadius:20,sidebarDividers:false})",
  );
  await app.waitFor(
    "getComputedStyle(document.querySelector('main')).marginTop === '12px'",
  );
  expect(await run("return getComputedStyle($('main')).borderRadius")).toBe(
    "20px",
  );
  expect(
    await run(
      "return getComputedStyle($('[data-sidebar=right]')).borderLeftWidth",
    ),
  ).toBe("0px");
  expect(
    await run(
      "return !!$('[data-sidebar=right] button[aria-label=\"Collapse right sidebar\"]')",
    ),
  ).toBe(true);
  for (const placement of ["top", "sidebar"]) {
    await app.eval(
      `window.catamorphicDesktop.setPrefs({tabPlacement:'${placement}'})`,
    );
    await app.waitFor(
      `document.querySelector('main').dataset.tabLayout === '${placement}'`,
    );
    expect(await run("return getComputedStyle($('main')).borderRadius")).toBe(
      "20px",
    );
  }
  await run("setReactValue($('input[name=contentRadius]'), '0')");
  await app.waitFor(
    "getComputedStyle(document.querySelector('main')).borderRadius === '0px'",
  );
  await run("$('input[name=sidebarDividers]').click()");
  await app.waitFor(
    "getComputedStyle(document.querySelector('[data-sidebar=right]')).borderLeftWidth === '1px'",
  );
  await app.reload();
  await app.waitFor(
    "document.querySelector('main') && getComputedStyle(document.querySelector('main')).borderRadius === '0px'",
  );
  expect(await run("return getComputedStyle($('main')).marginTop")).toBe(
    "12px",
  );
});
