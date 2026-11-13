import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";

let app: AppHandle;
let projectRoot: string;
let server: http.Server;
let fail = false;
let version = 1;
let delay = 700;
let requests = 0;
async function click(selector: string) {
  // A control that just appeared may still be opening. Finish the sidebar's
  // finite motion before measuring: a reachable point can move between the
  // measurement and mouse release, especially after another card closes.
  const point = await app.waitFor<{ x: number; y: number }>(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const sidebar=el.closest('[data-sidebar]');if(sidebar?.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:false})()`,
    { label: `${selector} reachable` },
  );
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
}
beforeAll(async () => {
  app = await launchApp();
  server = http.createServer((_req, res) => {
    requests++;
    setTimeout(() => {
      res.statusCode = fail ? 503 : 200;
      res.end(
        JSON.stringify({
          items: [
            {
              id: "service",
              label: `Service item ${version}`,
              description: "Loaded from HTTP",
              icon: "Globe",
            },
          ],
        }),
      );
    }, delay);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  projectRoot = path.join(app.userDataDir, "live-source-project");
  await createProjectWorkspace({
    app,
    name: "Live sources",
    rootPath: projectRoot,
  });
  fs.mkdirSync(path.join(projectRoot, ".work"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "todo-data"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "todo-data", "todos.json"),
    JSON.stringify([{ id: "todo", text: "Plan the week", done: false }]),
  );
  // Each module lives in a folder of its own, its package.json declaring
  // all it reaches (ADR 0277).
  const writeModule = (name: string, access: object, source: string) => {
    const dir = path.join(projectRoot, ".work", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, private: true, catamorphic: { access } }),
    );
    fs.writeFileSync(path.join(dir, "index.ts"), source);
  };
  writeModule(
    "todos",
    { writes: ["todo-data"] },
    `
    import {watch,writeFileSync} from 'node:fs'; import {readFile,writeFile,rename} from 'node:fs/promises';
    export default {
      async load(){await new Promise(r=>setTimeout(r,250));return {items:JSON.parse(await readFile('todo-data/todos.json','utf8')).map(t=>({id:t.id,label:t.text,icon:t.done?'CircleCheck':'Circle',description:t.done?'Completed':'Due tomorrow',descriptionVisibility:'hover',actions:[{action:'toggle',label:t.done?'Reopen':'Complete',icon:'Check'}],menu:[{action:'fail',label:'Fail write'}]}))}},
      subscribe({invalidate}){writeFileSync('todo-data/subscribed','yes');const w=watch('todo-data',(event,n)=>{if(event==='rename'||!n||n==='todos.json')invalidate()});return()=>{w.close();writeFileSync('todo-data/subscribed','no')}},
      async action({itemId,action}){await new Promise(r=>setTimeout(r,400));if(action==='fail')throw Error('Write unavailable');const ts=JSON.parse(await readFile('todo-data/todos.json','utf8'));ts.find(t=>t.id===itemId).done=!ts.find(t=>t.id===itemId).done;await writeFile('todo-data/todos.tmp',JSON.stringify(ts));await rename('todo-data/todos.tmp','todo-data/todos.json')}
    };`,
  );
  writeModule(
    "http",
    { hosts: [`127.0.0.1:${address.port}`] },
    `export default {async load({signal}){const r=await fetch('http://127.0.0.1:${address.port}',{signal});if(!r.ok)throw Error('Service unavailable: '+r.status);return r.json()}}`,
  );
  // Work's tabs, sorted by name: a module wrapping one of Work's lists.
  writeModule(
    "sorted-tabs",
    { lists: ["tabs"] },
    `export default {
      async load({work,parentId,cursor}){const page=await work.read({source:'tabs',parentId,cursor});return {...page,items:[...page.items].sort((a,b)=>a.label.localeCompare(b.label))}},
      action:({work,itemId,action,mode,values})=>work.execute({source:'tabs',itemId,action,mode,values})
    };`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work/workspace.js"),
    `module.exports={sidebars: {left:[{id:'live',title:'Sources',icon:'ListTodo',sections:[{id:'todos',title:'My todos',source:'.work/todos/index.ts',height:180},{id:'http',title:'Service',source:'.work/http/index.ts',height:120,headerActions:[{label:'Refresh Service',action:'refresh',icon:'RefreshCw'}]},{id:'sorted-tabs',title:'Sorted tabs',source:'.work/sorted-tabs/index.ts'}]},{id:'other',title:'Other',icon:'Folder',sections:[{id:'files',source:'work:files'}]}],right:[] }};`,
  );
  await app.reload();
  // Each asks before it runs, and nothing of it runs until allowed.
  const sections = ["todos", "http", "sorted-tabs"];
  for (const id of sections)
    await app.waitFor(
      `!!document.querySelector('[data-sidebar-section="${id}"] [data-testid="module-access-request"]')`,
      { label: `${id} asks for its access` },
    );
  expect(fs.existsSync(path.join(projectRoot, "todo-data", "subscribed"))).toBe(
    false,
  );
  expect(requests).toBe(0);
  for (const id of sections) {
    await click(
      `[data-sidebar-section="${id}"] [data-testid="module-access-allow"]`,
    );
    await app.waitFor(
      `!document.querySelector('[data-sidebar-section="${id}"] [data-testid="module-access-request"]')`,
      { label: `${id} allowed and its request closed` },
    );
  }
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="todos"]') && !document.querySelector('[data-testid="module-access-request"]')`,
  );
});
afterAll(async () => {
  await app?.stop();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

it("loads file and HTTP rows in native animated trees", async () => {
  await app.waitFor(
    `document.body.innerText.includes('Service item 1') && document.body.innerText.includes('Plan the week')`,
  );
  expect(
    await app.eval(
      `!!document.querySelector('[data-sidebar-source="todos"] [role="tree"]')`,
    ),
  ).toBe(true);
  await app.waitFor(
    `document.querySelector('[data-sidebar-source="todos"]')?.getAttribute('aria-busy')==='false'`,
  );
});
it("gives a long label its whole row until hover or keyboard focus reveals secondary text", async () => {
  const selector =
    '[data-sidebar-source="todos"] [data-sidebar-item-id="todo"]';
  const primary = `${selector} [data-tree-primary]`;
  const description = `${selector} [data-description-visibility="hover"]`;
  const label = `${primary} > .truncate`;
  await app.waitFor(`!!document.querySelector(${JSON.stringify(description)})`);
  await app.movePointer({ x: 700, y: 400 });
  await app.eval(`document.activeElement?.blur()`);
  await app.waitFor(
    `(()=>{const el=document.querySelector(${JSON.stringify(description)});return el&&el.getBoundingClientRect().width<1&&getComputedStyle(el).opacity==='0'})()`,
  );
  const mediaRoot = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
  const media = mediaRoot
    ? path.join(mediaRoot, "sidebar-customization")
    : undefined;
  if (media) fs.mkdirSync(media, { recursive: true });
  const clip = await app.eval<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).closest('[data-sidebar]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:Math.min(r.height,400)}})()`,
  );
  const capture = async (name: string) => {
    if (!media) return;
    const shot = await app.cdp("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 2 },
    });
    if (
      !shot ||
      typeof shot !== "object" ||
      !("data" in shot) ||
      typeof shot.data !== "string"
    )
      throw new Error("Missing screenshot");
    fs.writeFileSync(
      path.join(media, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
  };
  await capture("rest");
  const frames: Array<{ file: string; at: number }> = [];
  const off = app.onCdpEvent("Page.screencastFrame", (event) => {
    if (!event || typeof event !== "object" || !("sessionId" in event)) return;
    void app
      .cdp("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => {});
    if (
      !media ||
      !("data" in event) ||
      typeof event.data !== "string" ||
      !("metadata" in event) ||
      !event.metadata ||
      typeof event.metadata !== "object" ||
      !("timestamp" in event.metadata) ||
      typeof event.metadata.timestamp !== "number"
    )
      return;
    const file = `frame-${frames.length}.png`;
    fs.writeFileSync(path.join(media, file), Buffer.from(event.data, "base64"));
    frames.push({ file, at: event.metadata.timestamp });
  });
  if (media)
    await app.cdp("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  const rest = await app.eval<number>(
    `document.querySelector(${JSON.stringify(label)}).getBoundingClientRect().width`,
  );
  const point = await app.eval<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector(${JSON.stringify(primary)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await app.movePointer(point);
  await app.waitFor(
    `(()=>{const el=document.querySelector(${JSON.stringify(description)});return el&&el.getBoundingClientRect().width>20&&getComputedStyle(el).opacity==='1'})()`,
  );
  expect(
    await app.eval<number>(
      `document.querySelector(${JSON.stringify(label)}).getBoundingClientRect().width`,
    ),
  ).toBeLessThan(rest - 20);
  await capture("hover");
  await app.movePointer({ x: 700, y: 400 });
  await app.waitFor(
    `getComputedStyle(document.querySelector(${JSON.stringify(description)})).opacity==='0'`,
  );
  // Focus begins from outside the row, then real Tab establishes keyboard modality.
  await app.eval(
    `(()=>{const start=document.createElement('button');start.id='sidebar-focus-start';start.style.position='fixed';start.style.left='600px';start.textContent='Start';document.querySelector(${JSON.stringify(primary)}).before(start);start.focus()})()`,
  );
  await app.press("Tab");
  await app.waitFor(
    `document.activeElement?.matches(${JSON.stringify(primary)})&&getComputedStyle(document.querySelector(${JSON.stringify(description)})).opacity==='1'`,
  );
  await capture("keyboard");
  if (media) {
    await app.cdp("Page.stopScreencast");
    fs.writeFileSync(
      path.join(media, "motion.json"),
      JSON.stringify({ clip, frames }),
    );
  }
  off();
  await app.eval(
    `document.activeElement?.blur();document.getElementById('sidebar-focus-start')?.remove()`,
  );
});
it("writes a todo with visible busy feedback and follows external atomic edits", async () => {
  await click('[data-sidebar-source="todos"] [aria-label="Complete"]');
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="todos"] [aria-busy="true"]')`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="todos"] [aria-label="Reopen"]')`,
  );
  expect(
    JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, "todo-data", "todos.json"),
        "utf8",
      ),
    )[0].done,
  ).toBe(true);
  fs.writeFileSync(
    path.join(projectRoot, "todo-data", "todos.tmp"),
    JSON.stringify([
      { id: "todo", text: "Plan revised", done: true },
      { id: "review", text: "Review notes", done: false },
    ]),
  );
  fs.renameSync(
    path.join(projectRoot, "todo-data", "todos.tmp"),
    path.join(projectRoot, "todo-data", "todos.json"),
  );
  await app.waitFor(
    `document.body.innerText.includes('Plan revised') && document.body.innerText.includes('Review notes')`,
  );
});
it("shows failed write feedback without losing the item", async () => {
  await click('[aria-label="More actions for Plan revised"]');
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-menu] [role="menuitem"]')`,
  );
  await click('[data-sidebar-menu] [role="menuitem"]');
  await app.waitFor(`document.body.innerText.includes('Write unavailable')`);
  expect(
    await app.eval(
      `document.querySelector('[data-sidebar-source="todos"]').innerText`,
    ),
  ).toContain("Plan revised");
});
it("retains HTTP rows during refresh, reports failure, and retries without reopening", async () => {
  await app.waitFor(
    `document.querySelector('[data-sidebar-source="http"]')?.getAttribute('aria-busy')==='false'`,
  );
  const beforeRefresh = requests;
  version = 2;
  delay = 1200;
  await click('[aria-label="Refresh Service"]');
  await app.waitFor(
    `document.querySelector('[data-sidebar-source="http"]')?.getAttribute('aria-busy')==='true'`,
  );
  expect(
    await app.eval(
      `document.querySelector('[data-sidebar-source="http"]').innerText`,
    ),
  ).toContain("Service item 1");
  await app.waitFor(
    `document.body.innerText.includes('Service item 2') && document.querySelector('[data-sidebar-source="http"]')?.getAttribute('aria-busy')==='false'`,
  );
  expect(requests - beforeRefresh).toBe(1);
  const beforeFailure = requests;
  fail = true;
  await click('[aria-label="Refresh Service"]');
  await app.waitFor(
    `document.body.innerText.includes('Service unavailable: 503') && document.querySelector('[data-sidebar-source="http"]')?.getAttribute('aria-busy')==='false'`,
  );
  expect(requests - beforeFailure).toBe(1);
  expect(
    await app.eval(
      `document.querySelector('[data-sidebar-source="http"]').innerText`,
    ),
  ).toContain("Service item 2");
  const beforeRetry = requests;
  fail = false;
  version = 3;
  delay = 50;
  await click('[data-sidebar-section="http"] [role="alert"] button');
  await app.waitFor(
    `document.body.innerText.includes('Service item 3') && !document.querySelector('[data-sidebar-source="http"] [role="alert"]') && document.querySelector('[data-sidebar-source="http"]')?.getAttribute('aria-busy')==='false'`,
  );
  expect(requests - beforeRetry).toBe(1);
});
it("releases hidden sources and virtualizes a large file-backed list", async () => {
  await click('[role="tab"][aria-label="Other"]');
  await app.waitFor(
    `document.querySelector('[role="tab"][aria-label="Other"]')?.getAttribute('aria-selected')==='true'`,
  );
  await expect
    .poll(() =>
      fs.readFileSync(
        path.join(projectRoot, "todo-data", "subscribed"),
        "utf8",
      ),
    )
    .toBe("no");
  const before = requests;
  fs.writeFileSync(
    path.join(projectRoot, "todo-data", "todos.json"),
    JSON.stringify(
      Array.from({ length: 500 }, (_, i) => ({
        id: `item-${i}`,
        text: `Task ${i}`,
        done: false,
      })),
    ),
  );
  await click('[role="tab"][aria-label="Sources"]');
  await app.waitFor(`document.body.innerText.includes('Task 0')`);
  const rows = await app.eval<number>(
    `document.querySelector('[data-sidebar-source="todos"]').querySelectorAll('[data-sidebar-item-id]').length`,
  );
  expect(rows).toBeLessThan(60);
  expect(rows).toBeGreaterThan(0);
  expect(requests - before).toBeLessThanOrEqual(1);
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  // The previous rows ("Plan revised", "Review notes") leave in place as
  // inert exiting rows above the new ones, which then slide up. Act on the
  // first new row once the list has settled, not on whichever "Complete"
  // button comes first in the DOM.
  await app.waitFor(`(() => {
    const rows = [...document.querySelectorAll('[data-sidebar-source="todos"] [role="treeitem"]')];
    return rows.length > 0 && rows.every(row => !row.inert && row.getAnimations().every(a => a.playState !== 'running'));
  })()`);
  await click(
    '[data-sidebar-source="todos"] [data-sidebar-item-id="item-0"] [aria-label="Complete"]',
  );
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="todos"] [data-sidebar-item-id="item-0"] [aria-label="Reopen"]')`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});
it("sorts Work's tabs in a module, follows them live and closes through them", async () => {
  const sorted =
    '[data-workspace-visible=true] [data-sidebar-source="sorted-tabs"]';
  const labels = () =>
    app.eval<string[]>(
      `[...document.querySelectorAll('${sorted} [data-sidebar-item-id]')].map(row => row.querySelector('[data-tree-primary]').textContent.trim())`,
    );
  const strip = () =>
    app.eval<string[]>(
      `[...document.querySelectorAll('[data-workspace-visible=true] [data-tab-orientation] [data-point-key]')].map(tab => tab.dataset.pointKey)`,
    );
  await app.eval(
    `document.querySelector('[data-workspace-visible=true] aside footer button[aria-label=Settings]').click()`,
  );
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  // The strip has Settings, then the New Tab; the module lists them by name.
  await app.waitFor(
    `document.querySelectorAll('${sorted} [data-sidebar-item-id]').length === document.querySelectorAll('[data-workspace-visible=true] [data-tab-orientation] [data-point-key]').length && document.querySelectorAll('${sorted} [data-sidebar-item-id]').length >= 2`,
    { label: "every tab listed" },
  );
  // Work list updates coalesce before the module reads again. The same row
  // count can precede the refreshed labels and their sorted order.
  await app.waitFor(
    `(()=>{const labels=[...document.querySelectorAll('${sorted} [data-sidebar-item-id]')].map(row=>row.querySelector('[data-tree-primary]').textContent.trim());return labels.every((label,index)=>index===0||labels[index-1].localeCompare(label)<=0)})()`,
    { label: "source sort applied" },
  );
  const listed = await labels();
  expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
  expect((await strip()).length).toBe(listed.length);
  // Its rows are the tabs: an agent points at them by tab key, and the close
  // action goes through the module to Work's list.
  const settings = await app.eval<string>(
    `document.querySelector('${sorted} [data-point-key^="settings:"]').dataset.pointKey`,
  );
  await app.eval(
    `document.querySelector('${sorted} [data-point-key="${settings}"] button[aria-label^="Close"]').click()`,
  );
  await app.waitFor(
    `!document.querySelector('[data-workspace-visible=true] [data-tab-orientation] [data-point-key="${settings}"]') && !document.querySelector('${sorted} [data-point-key="${settings}"]')`,
    { label: "the tab closed through the module, and gone from its list" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
it("asks again when a module's access grows, naming only what is new", async () => {
  const http = '[data-sidebar-section="http"]';
  const manifest = path.join(projectRoot, ".work/http/package.json");
  const declared = JSON.parse(fs.readFileSync(manifest, "utf8"));
  declared.catamorphic.access.hosts.push("api.example.test");
  fs.writeFileSync(manifest, JSON.stringify(declared));
  await app.waitFor(
    `document.querySelector('${http} [data-testid="module-access-request"]')?.textContent.includes('now also wants to')`,
    { label: "the widened module asks again" },
  );
  expect(
    await app.eval<string>(
      `document.querySelector('${http} [data-testid="module-access-request"] ul').textContent`,
    ),
  ).toBe("Reach api.example.test");
  await click(`${http} [data-testid="module-access-allow"]`);
  await app.waitFor(
    `!document.querySelector('${http} [data-testid="module-access-request"]') && document.querySelector('[data-sidebar-source="http"]')?.innerText.includes('Service item')`,
    { label: "allowed, it runs again" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
