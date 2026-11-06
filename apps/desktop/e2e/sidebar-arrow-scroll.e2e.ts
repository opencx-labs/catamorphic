import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";
import { writeSidebarSections } from "./sidebar-config.js";

let app: AppHandle;
const section =
  '[data-workspace-visible="true"] [data-sidebar-section="files"]';
const viewport = `document.querySelector('${section} [data-tree-viewport]')`;
const row = (index: number) =>
  `${viewport}.querySelector('[data-tree-id="item-${String(index).padStart(2, "0")}.txt"]')`;
const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
const sample = `(()=>{
  const view=${viewport},ring=view.querySelector('[data-tree-focus]');
  const active=document.activeElement?.closest('[data-tree-id]');
  const panel=view.closest('.sidebar-tab-panel');
  return {top:view.scrollTop,panel:panel.scrollTop,ring:ring?.getBoundingClientRect().top??null,row:active?.getBoundingClientRect().top??null,id:active?.dataset.treeId??null};
})()`;
type Frame = {
  at: number;
  top: number;
  panel: number;
  ring: number;
  row: number;
  id: string;
};
const settle = () =>
  app.waitFor(
    `!${viewport}.hasAttribute('data-tree-revealing') && ${viewport}.getAnimations({subtree:true}).every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity)`,
  );
const place = async (index: number) => {
  await app.eval(`${viewport}.scrollTop=0`);
  await app.waitFor(`!!${row(0)}`);
  await app.eval(`${row(0)}.focus({preventScroll:true,focusVisible:true})`);
  await app.press("Home");
  for (let i = 0; i < index; i++) await app.press("ArrowDown");
  await settle();
};
const observe = () =>
  app.eval(`window.__arrowFrames=[{at:performance.now(),...${sample}}];window.__arrowDone=new Promise(resolve=>{
  const start=performance.now();const frame=()=>{window.__arrowFrames.push({at:performance.now(),...${sample}});if(performance.now()-start<400)requestAnimationFrame(frame);else resolve(window.__arrowFrames)};requestAnimationFrame(frame);
});true`);
const frames = () => app.eval<Frame[]>("window.__arrowDone");
const visible = () =>
  app.eval<boolean>(`(()=>{
  const view=${viewport},panel=view.closest('.sidebar-tab-panel'),row=document.activeElement;
  const box=row.getBoundingClientRect(),inner=view.getBoundingClientRect(),outer=panel.getBoundingClientRect();
  return box.top>=Math.max(inner.top,outer.top)-1&&box.bottom<=Math.min(inner.bottom,outer.bottom)+1;
})()`);

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const root = path.join(app.userDataDir, "arrow-list");
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 40; i++)
    fs.writeFileSync(
      path.join(root, `item-${String(i).padStart(2, "0")}.txt`),
      `Fixture ${i}\n`,
    );
  await createProjectWorkspace({
    app,
    name: "Sidebar arrow motion",
    rootPath: root,
    importExisting: true,
  });
  await writeSidebarSections(app, [
    { id: "files", source: "work:files", height: 196, collapsed: false },
  ]);
  await app.reload();
  await app.waitFor(`!!${row(0)}`);
  await app.eval("window.catamorphicDesktop.devWindow('setSize',1100,850)");
  await app.waitFor(
    `document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity)`,
  );
});
afterAll(async () => {
  try {
    expect(app?.getRendererErrors() ?? []).toEqual([]);
  } finally {
    await app?.stop();
  }
});

it("reveals the next row progressively while its ring reaches the lower edge", async () => {
  const edge = await app.eval<number>(
    `(()=>{const view=${viewport};return Math.floor((view.clientHeight-(parseFloat(getComputedStyle(view).scrollPaddingBottom)||0))/28)-1})()`,
  );
  await place(edge);
  const before = await app.eval<{ top: number; ring: number }>(sample);
  const captured: { file: string; at: number }[] = [];
  const schema = z.object({
    data: z.string(),
    sessionId: z.number(),
    metadata: z.object({ timestamp: z.number() }),
  });
  const unsubscribe = app.onCdpEvent("Page.screencastFrame", (value) => {
    const frame = schema.parse(value);
    if (artifacts) {
      const file = `arrow-edge-${String(captured.length).padStart(4, "0")}.png`;
      fs.writeFileSync(
        path.join(artifacts, file),
        Buffer.from(frame.data, "base64"),
      );
      captured.push({ file, at: frame.metadata.timestamp });
    }
    void app.cdp("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await app.cdp("Page.startScreencast", { format: "png", everyNthFrame: 2 });
  let movement: Frame[] = [];
  try {
    await observe();
    await app.press("ArrowDown");
    movement = await frames();
  } finally {
    await app.cdp("Page.stopScreencast");
    unsubscribe();
  }
  if (artifacts) {
    fs.writeFileSync(
      path.join(artifacts, "arrow-edge-frames.json"),
      JSON.stringify(captured),
    );
    fs.writeFileSync(
      path.join(artifacts, "arrow-edge-motion.json"),
      JSON.stringify(movement),
    );
    await app.screenshot(path.join(artifacts, "arrow-edge-settled.png"));
  }
  const last = movement.at(-1);
  expect(last).toBeDefined();
  if (!last) throw Error("No captured motion");
  expect(last.top).toBeGreaterThan(before.top);
  expect(
    movement.some((frame) => frame.top > before.top && frame.top < last.top),
  ).toBe(true);
  expect(
    Math.min(...movement.map((frame) => frame.ring)),
  ).toBeGreaterThanOrEqual(before.ring - 1);
  expect(Math.abs(last.ring - last.row)).toBeLessThan(1);
});

it("retargets repeated arrows and reversals, and yields to manual scrolling", async () => {
  await place(4);
  for (let i = 0; i < 14; i++) await app.press("ArrowDown");
  for (let i = 0; i < 3; i++) await app.press("ArrowUp");
  await settle();
  const state = await app.eval<{ id: string; ring: number; row: number }>(
    sample,
  );
  expect(state.id).toBe("item-15.txt");
  expect(Math.abs(state.ring - state.row)).toBeLessThan(1);
  await app.press("ArrowDown");
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 100,
    y: 350,
    deltaX: 0,
    deltaY: -70,
  });
  await app.waitFor(`!${viewport}.hasAttribute('data-tree-revealing')`);
  await app.eval(`${viewport}.scrollTop=0`);
  await app.eval("new Promise(r=>setTimeout(r,250))");
  expect(await app.eval(`${viewport}.scrollTop`)).toBe(0);
});

it("follows the ring at the upper edge and when only the outer panel scrolls", async () => {
  await place(12);
  // Put the focused row just below the upper fade, with room to scroll up.
  await app.eval(
    `(()=>{const view=${viewport};view.scrollTop=12*28-(parseFloat(getComputedStyle(view).scrollPaddingTop)||0)})()`,
  );
  const before = await app.eval<{ top: number; ring: number }>(sample);
  await observe();
  await app.press("ArrowUp");
  const up = await frames();
  const last = up.at(-1);
  if (!last) throw Error("No upward frames");
  expect(last.top).toBeLessThan(before.top);
  expect(
    up.some((frame) => frame.top < before.top && frame.top > last.top),
  ).toBe(true);
  expect(Math.max(...up.map((frame) => frame.ring))).toBeLessThanOrEqual(
    before.ring + 1,
  );
  expect(Math.abs(last.ring - last.row)).toBeLessThan(1);
  // The list fits its rows; this time its containing panel is the scroller.
  await writeSidebarSections(app, [
    { id: "files", source: "work:files", height: 1120, collapsed: false },
  ]);
  await app.reload();
  await app.waitFor(`!!${row(0)}`);
  await place(0);
  await app.eval(`${viewport}.closest('.sidebar-tab-panel').scrollTop=0`);
  try {
    const edge = await app.eval<number>(
      `(()=>{const view=${viewport},panel=view.closest('.sidebar-tab-panel'),padding=parseFloat(getComputedStyle(panel).scrollPaddingBottom)||0;return Math.floor((panel.getBoundingClientRect().bottom-padding-view.getBoundingClientRect().top)/28)-1})()`,
    );
    for (let i = 0; i < edge; i++) await app.press("ArrowDown");
    await settle();
    const start = await app.eval<{ panel: number; ring: number }>(sample);
    await observe();
    await app.press("ArrowDown");
    const outer = await frames();
    const end = outer.at(-1);
    if (!end) throw Error("No panel frames");
    expect(end.panel).toBeGreaterThan(start.panel);
    expect(
      outer.some(
        (frame) => frame.panel > start.panel && frame.panel < end.panel,
      ),
    ).toBe(true);
    expect(
      Math.min(...outer.map((frame) => frame.ring)),
    ).toBeGreaterThanOrEqual(start.ring - 1);
    expect(Math.abs(end.ring - end.row)).toBeLessThan(1);
  } finally {
    await writeSidebarSections(app, [
      { id: "files", source: "work:files", height: 196, collapsed: false },
    ]);
    await app.reload();
    await app.waitFor(`!!${row(0)}`);
  }
});

it("keeps immediate focus for a jump beyond the virtual window", async () => {
  await place(0);
  await app.press("End");
  expect(await app.eval(`document.activeElement===${row(39)}`)).toBe(true);
  await settle();
  const state = await app.eval<{ top: number; ring: number; row: number }>(
    sample,
  );
  expect(state.top).toBeGreaterThan(800);
  expect(Math.abs(state.ring - state.row)).toBeLessThan(1);
  expect(await visible()).toBe(true);
  await app.press("PageUp");
  expect(await app.eval(`document.activeElement===${row(32)}`)).toBe(true);
  await settle();
  expect(await visible()).toBe(true);
});

it("coordinates nested scrollports without moving their clipping frames", async () => {
  await place(0);
  await app.eval(
    `(()=>{const view=${viewport},panel=view.closest('.sidebar-tab-panel'),section=document.querySelector('${section}');section.style.marginTop=Math.max(0,panel.getBoundingClientRect().bottom-view.getBoundingClientRect().bottom+56)+'px';panel.scrollTop=0})()`,
  );
  try {
    await place(5);
    const before = await app.eval<{ top: number; panel: number }>(sample);
    await observe();
    await app.press("ArrowDown");
    const movement = await frames();
    const last = movement.at(-1);
    if (!last) throw Error("No nested frames");
    expect(last.top).toBeGreaterThan(before.top);
    expect(last.panel).toBeGreaterThan(before.panel);
    expect(
      movement.some((frame) => frame.top > before.top && frame.top < last.top),
    ).toBe(true);
    expect(await visible()).toBe(true);
    expect(
      await app.eval(
        `(()=>{for(let node=${viewport}.parentElement;node&&!node.classList.contains('sidebar-tab-panel');node=node.parentElement)if(/^(clip|hidden)$/.test(getComputedStyle(node).overflowY)&&node.scrollTop!==0)return false;return true})()`,
      ),
    ).toBe(true);
  } finally {
    await app.eval(
      `document.querySelector('${section}').style.marginTop='';${viewport}.closest('.sidebar-tab-panel').scrollTop=0`,
    );
  }
});

it("reveals immediately under reduced motion and handles jumps beyond overscan", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await place(4);
    await app.press("End");
    await app.waitFor(`document.activeElement===${row(39)}`);
    await settle();
    expect(
      await app.eval(`${viewport}.hasAttribute('data-tree-revealing')`),
    ).toBe(false);
    const state = await app.eval<{ ring: number; row: number }>(sample);
    expect(Math.abs(state.ring - state.row)).toBeLessThan(1);
    expect(await visible()).toBe(true);
    await app.press("PageUp");
    await app.waitFor(`document.activeElement?.dataset.treeId==='item-32.txt'`);
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  }
});
