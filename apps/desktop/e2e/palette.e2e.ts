import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let projectRoot: string;
const helpers = `
${setReactValueJs}
const input=()=>[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0);
const key=(key, mods={})=>input().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...mods}));
const rows=()=>[...input().closest('[role="dialog"]').querySelectorAll('[role="option"]')];
const labels=()=>rows().map(row=>row.textContent);
const chip=()=>input().closest('[role="dialog"]').querySelector('[data-testid="palette-mode-chip"]')?.textContent ?? null;
`;
const run = <T>(code: string) => app.eval<T>(`(()=>{${helpers};${code}})()`);
const wait = <T = unknown>(code: string, label?: string) =>
  app.waitFor<T>(`(()=>{${helpers};${code}})()`, label ? { label } : {});
const shortcut = (key: string) =>
  app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
const open = async () => {
  // Wait for the previous overlay's exit before opening another one.
  await wait(`return !input()`);
  await shortcut("p");
  await wait(`return document.activeElement === input()`);
};
const close = async () => {
  await run(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  );
  await wait(`return !input()`);
};
// Wait for list motion to settle, then capture the palette for review.
const shot = async (name: string) => {
  // FLIP starts its transition a frame after measuring; let it begin.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await wait(
    `return input().closest('[role="dialog"]').getAnimations({subtree:true}).every(animation=>animation.playState!=='running')`,
  );
  await app.screenshot(
    path.join(process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(), name),
  );
};
const type = (text: string) =>
  run(`setReactValue(input(),${JSON.stringify(text)})`);

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  projectRoot = path.join(app.userDataDir, "palette-project");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Palette ranking',rootPath:${JSON.stringify(projectRoot)}})`,
  );
  fs.mkdirSync(path.join(projectRoot, ".work"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "tickets.json"),
    JSON.stringify([
      { id: "t-101", title: "Checkout button misaligned", owner: "maya" },
      { id: "t-102", title: "Refund emails delayed", owner: "sam" },
      { id: "t-103", title: "Search results empty on mobile", owner: "maya" },
    ]),
  );
  // One module backs a sidebar section and a palette mode (ADR 0186).
  fs.writeFileSync(
    path.join(projectRoot, ".work/tickets.ts"),
    `import {readFile,appendFile} from 'node:fs/promises';
    export default {
      async load({query}){
        const all=JSON.parse(await readFile('tickets.json','utf8'));
        if(query!==undefined) await appendFile('queries.log',JSON.stringify(query)+'\\n');
        const shown=query?all.filter(t=>t.title.toLowerCase().includes(query.toLowerCase())):all;
        return {items:shown.map(t=>({id:t.id,label:t.title,description:t.id.toUpperCase(),keywords:[t.owner],
          actions:[{action:'run:claim',label:'Claim',icon:'Hand'}]}))};
      },
      async action({itemId,action}){ if(action==='claim') await appendFile('claimed.log',itemId+'\\n'); }
    };`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work/workspace.js"),
    `module.exports={sidebars: {left:[{id:'work',title:'Work',icon:'Ticket',sections:[
        {id:'tickets',type:'custom',title:'Tickets',source:{type:'custom',module:'.work/tickets.ts'},height:160},
        {id:'files',type:'files'}]}],
      right:[] },
      palette:{modes:[
        {id:'ticket-mode',trigger:'tickets',aliases:['tix'],title:'Tickets',description:'Find a ticket and claim it',icon:'Ticket',section:'tickets'},
        {id:'ticket-search',trigger:'find-ticket',title:'Ticket search',source:{type:'custom',module:'.work/tickets.ts'},search:'source'},
        {id:'runbooks',trigger:'runbooks',title:'Runbooks',items:[{label:'Deploy runbook',url:'https://runbooks.test/deploy',keywords:['release']}]},
        {id:'project-files',trigger:'pf',title:'Project files',section:'files'}
      ]}
    };`,
  );
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Palette ranking')`);
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="tickets"]')`,
  );
  // Close the startup New Tab so every search uses the overlay.
  await shortcut("w");
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1300,900)`);
});
afterAll(async () => {
  await app?.stop();
});

it("lists custom modes with the built-in ones and enters them by name", async () => {
  await open();
  await type("@");
  await wait(
    `return labels().some(label=>label.includes('Tickets') && label.includes('Find a ticket and claim it'))`,
    "custom mode in the @ list",
  );
  await shot("palette-modes.png");
  expect(
    await run(
      `return ['Search history','Search settings','Search sites','Search commands','Runbooks'].every(name=>labels().some(label=>label.includes(name)))`,
    ),
  ).toBe(true);
  await type("tix");
  await run(`key(' ')`);
  await wait(`return chip()==='Tickets'`, "alias enters the mode");
  await wait(
    `return labels().length===3 && labels()[0].includes('Checkout button misaligned')`,
    "module rows",
  );
  await shot("palette-custom-mode.png");
  // Palette search ranks loaded rows, keywords included.
  await type("sam");
  await wait(
    `return labels().length===1 && labels()[0].includes('Refund emails delayed')`,
  );
  await run(`key('Enter')`);
  await wait(`return !input()`);
  await expect
    .poll(() =>
      fs.existsSync(path.join(projectRoot, "claimed.log"))
        ? fs.readFileSync(path.join(projectRoot, "claimed.log"), "utf8")
        : "",
    )
    .toBe("t-102\n");
});

it("lists a built-in source through a mode, from the same data the sidebar shows", async () => {
  await open();
  await type("pf");
  await run(`key(' ')`);
  await wait(`return chip()==='Project files'`);
  await wait(
    `return labels().some(label=>label.includes('tickets.json'))`,
    "files source rows",
  );
  await type("tickets");
  await wait(`return labels()[0]?.includes('tickets.json')`);
  await close();
});

it("passes the typed query to sources that search", async () => {
  await open();
  await type("find-ticket");
  await run(`key('Tab')`);
  await wait(`return chip()==='Ticket search'`);
  await type("mobile");
  await wait(
    `return labels().length===1 && labels()[0].includes('Search results empty on mobile')`,
  );
  const queries = fs
    .readFileSync(path.join(projectRoot, "queries.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(queries.at(-1)).toBe("mobile");
  // Backspace on an empty input leaves the mode.
  await type("");
  await run(`key('Backspace')`);
  await wait(`return chip()===null`);
  await close();
});

it("keeps built-in modes one shape: sites and commands", async () => {
  await open();
  await type("sites");
  await run(`key(' ')`);
  await wait(`return chip()==='Sites'`);
  await wait(`return labels().length>0`);
  await run(`key('Backspace')`);
  await wait(`return chip()===null`);
  await type(">new terminal");
  await wait(`return labels()[0]?.includes('New terminal')`);
  expect(
    await run(
      `return labels().every(label=>!label.includes('Search the web'))`,
    ),
  ).toBe(true);
  await close();
});

it("ranks the app's own commands above pages and learns picks", async () => {
  await open();
  await type("runb");
  await wait(`return labels().length>0`);
  // Top-level rows exclude modes that did not opt in.
  expect(
    await run(`return labels().some(label=>label.includes('Deploy runbook'))`),
  ).toBe(false);
  await type("new");
  await wait(
    `return ['action:new-terminal-tab','action:new-editor-tab'].every(id=>rows().some(row=>row.dataset.itemId===id))`,
  );
  // Pick whichever of the two ranks lower for this query; next time it leads.
  const target = await run<string>(
    `const ids=rows().map(row=>row.dataset.itemId);return ids.indexOf('action:new-terminal-tab')<ids.indexOf('action:new-editor-tab')?'action:new-editor-tab':'action:new-terminal-tab'`,
  );
  const index = await run<number>(
    `return rows().findIndex(row=>row.dataset.itemId===${JSON.stringify(target)})`,
  );
  expect(index).toBeGreaterThan(0);
  for (let step = 0; step < index; step++) await run(`key('ArrowDown')`);
  await run(`key('Enter')`);
  await wait(`return !input()`);
  await open();
  await type("new");
  await wait(
    `return rows()[0]?.dataset.itemId===${JSON.stringify(target)}`,
    "picked row leads",
  );
  await close();
});

it("leads the empty palette with frequently used surfaces", async () => {
  for (let visit = 0; visit < 2; visit++) {
    await open();
    await type("usage");
    await wait(`return rows()[0]?.dataset.itemId==='tab:usage'`);
    await run(`key('Enter')`);
    await app.waitFor(
      `!!document.querySelector('[data-point-key="usage:usage"]') || document.body.innerText.includes('Tokens')`,
      { label: "usage surface open" },
    );
  }
  await open();
  await wait(
    `const dialog=input().closest('[role="dialog"]');return [...dialog.querySelectorAll('div')].some(el=>el.textContent==='Frequent') && rows().some(row=>row.dataset.itemId==='tab:usage')`,
    "Frequent group with Usage",
  );
  await shot("palette-frequent.png");
  const order = await run<string[]>(
    `return rows().map(row=>row.dataset.itemId)`,
  );
  // Frequent rows (at most six) lead, each listed once: the surface
  // visited from anywhere and the command picked in the previous test.
  expect(order.indexOf("tab:usage")).toBeLessThan(6);
  expect(
    order
      .slice(0, 6)
      .some((id) =>
        ["action:new-editor-tab", "action:new-terminal-tab"].includes(id),
      ),
  ).toBe(true);
  expect(order.filter((id) => id === "tab:usage")).toHaveLength(1);
  await close();
});
