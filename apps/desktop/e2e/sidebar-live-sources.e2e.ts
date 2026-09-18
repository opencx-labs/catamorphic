import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let projectRoot: string;
let server: http.Server;
let fail = false;
let version = 1;
let delay = 700;
let requests = 0;
async function click(selector: string) {
  const point = await app.eval<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();if(!r)throw Error('Missing control');return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
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
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Live sources',rootPath:${JSON.stringify(projectRoot)}})`,
  );
  fs.mkdirSync(path.join(projectRoot, ".catamorphic"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "todos.json"),
    JSON.stringify([{ id: "todo", text: "Plan the week", done: false }]),
  );
  fs.writeFileSync(
    path.join(projectRoot, ".catamorphic/todos.ts"),
    `
    import {watch} from 'node:fs'; import {readFile,writeFile,rename} from 'node:fs/promises';
    export default {
      async load(){await new Promise(r=>setTimeout(r,250));return {items:JSON.parse(await readFile('todos.json','utf8')).map(t=>({id:t.id,label:t.text,icon:t.done?'CircleCheck':'Circle',description:t.done?'Completed':undefined,actions:[{action:'run:toggle',label:t.done?'Reopen':'Complete',icon:'Check'}],menu:[{action:'run:fail',label:'Fail write'}]}))}},
      subscribe({invalidate}){void writeFile('subscribed','yes');const w=watch('.',(event,n)=>{if(event==='rename'||!n||n==='todos.json')invalidate()});return()=>{w.close();void writeFile('subscribed','no')}},
      async action({itemId,action}){await new Promise(r=>setTimeout(r,400));if(action==='fail')throw Error('Write unavailable');const ts=JSON.parse(await readFile('todos.json','utf8'));ts.find(t=>t.id===itemId).done=!ts.find(t=>t.id===itemId).done;await writeFile('todos.tmp',JSON.stringify(ts));await rename('todos.tmp','todos.json')}
    };`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".catamorphic/http.ts"),
    `export default {async load({signal}){const r=await fetch('http://127.0.0.1:${address.port}',{signal});if(!r.ok)throw Error('Service unavailable: '+r.status);return r.json()}}`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".catamorphic/sidebar.js"),
    `module.exports={left:[{id:'live',title:'Sources',icon:'ListTodo',sections:[{id:'todos',type:'custom',title:'My todos',source:{type:'custom',module:'.catamorphic/todos.ts'},height:180},{id:'http',type:'custom',title:'Service',source:{type:'custom',module:'.catamorphic/http.ts'},height:120}]},{id:'other',title:'Other',icon:'Folder',sections:[{id:'files',type:'files'}]}],right:[]};`,
  );
  await app.reload();
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="todos"]')`,
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
  expect(
    await app.eval(
      `document.querySelector('[data-sidebar-source="todos"]')?.getAttribute('aria-busy')`,
    ),
  ).toBe("false");
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
    JSON.parse(fs.readFileSync(path.join(projectRoot, "todos.json"), "utf8"))[0]
      .done,
  ).toBe(true);
  fs.writeFileSync(
    path.join(projectRoot, "todos.tmp"),
    JSON.stringify([
      { id: "todo", text: "Plan revised", done: true },
      { id: "review", text: "Review notes", done: false },
    ]),
  );
  fs.renameSync(
    path.join(projectRoot, "todos.tmp"),
    path.join(projectRoot, "todos.json"),
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
  await app.waitFor(`document.body.innerText.includes('Service item 2')`);
  fail = true;
  await click('[aria-label="Refresh Service"]');
  await app.waitFor(
    `document.body.innerText.includes('Service unavailable: 503')`,
  );
  expect(
    await app.eval(
      `document.querySelector('[data-sidebar-source="http"]').innerText`,
    ),
  ).toContain("Service item 2");
  fail = false;
  version = 3;
  delay = 50;
  await click('[data-sidebar-section="http"] [role="alert"] button');
  await app.waitFor(
    `document.body.innerText.includes('Service item 3') && !document.querySelector('[data-sidebar-source="http"] [role="alert"]')`,
  );
});
it("releases hidden sources and virtualizes a large file-backed list", async () => {
  await click('[role="tab"][aria-label="Other"]');
  await app.waitFor(
    `document.querySelector('[role="tab"][aria-label="Other"]')?.getAttribute('aria-selected')==='true'`,
  );
  await expect
    .poll(() => fs.readFileSync(path.join(projectRoot, "subscribed"), "utf8"))
    .toBe("no");
  const before = requests;
  fs.writeFileSync(
    path.join(projectRoot, "todos.json"),
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
  await click('[data-sidebar-source="todos"] [aria-label="Complete"]');
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="todos"] [aria-label="Reopen"]')`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});
