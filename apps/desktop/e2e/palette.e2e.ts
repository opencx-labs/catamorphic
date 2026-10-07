import fs from "node:fs";
import http from "node:http";
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
  // The last answer is ranked locally at once; the source still gets the
  // query, debounced, and its answer replaces the list.
  await expect
    .poll(() =>
      fs
        .readFileSync(path.join(projectRoot, "queries.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1),
    )
    .toBe("mobile");
  await wait(
    `return labels().length===1 && labels()[0].includes('Search results empty on mobile')`,
  );
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
  expect(
    await run<number>(
      `return rows().findIndex(row=>row.dataset.itemId===${JSON.stringify(target)})`,
    ),
  ).toBeGreaterThan(0);
  // Rows can still re-rank as late sources arrive, so walk the highlight to
  // the target and press Enter only once it is the highlighted row.
  await wait(
    `const selected=rows().find(row=>row.getAttribute('aria-selected')==='true');
     if(selected?.dataset.itemId===${JSON.stringify(target)}){key('Enter');return true}
     key('ArrowDown');return false`,
    "target picked",
  );
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

it("switches to open tabs from search and the Tabs mode, above bookmarks and history", async () => {
  const server = http.createServer((request, response) => {
    const name = (request.url ?? "/").slice(1) || "index";
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<title>${name[0]?.toUpperCase()}${name.slice(1)} handbook</title><p>${name}</p>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    // A saved page nobody opened yet, in a folder of the imported library
    // and pinned too: pinning keeps the library copy.
    const { defaultProfileId } = await app.eval<{ defaultProfileId: string }>(
      "window.catamorphicDesktop.profilesList()",
    );
    const bookmarksFile = path.join(app.userDataDir, "bookmarks.json");
    const saved = fs.existsSync(bookmarksFile)
      ? JSON.parse(fs.readFileSync(bookmarksFile, "utf8"))
      : {};
    const delta = {
      id: "delta",
      label: "Delta handbook",
      url: `${origin}/delta`,
    };
    fs.writeFileSync(
      bookmarksFile,
      JSON.stringify({
        ...saved,
        pinnedByProfile: {
          ...saved.pinnedByProfile,
          [defaultProfileId]: { folders: [], bookmarks: [delta] },
        },
        libraryByProfile: {
          ...saved.libraryByProfile,
          [defaultProfileId]: {
            // Imports keep most pages in folders.
            folders: [{ id: "docs", label: "Docs" }],
            bookmarks: [{ ...delta, folderId: "docs" }],
          },
        },
      }),
    );
    const address = () =>
      run<string>(
        `return [...document.querySelectorAll('input[aria-label="Address and search bar"]')].find(el=>el.checkVisibility({visibilityProperty:true,opacityProperty:true}))?.value ?? ''`,
      );
    const visit = async (page: string, newTab: boolean) => {
      await open();
      await type(`${origin}/${page}`);
      await wait(`return rows()[0]?.dataset.itemId==='web'`);
      await run(
        `key('Enter',${newTab ? "{metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform)}" : "{}"})`,
      );
      await wait(`return !input()`);
      await expect.poll(address, { timeout: 15_000 }).toContain(`/${page}`);
      // History keeps the title the page had when it was left.
      const title = `${page[0]?.toUpperCase()}${page.slice(1)} handbook`;
      await wait(
        `return [...document.querySelectorAll('[data-point-key^="browser:"]')].some(tab=>tab.textContent.includes(${JSON.stringify(title)}))`,
        `${title} titled`,
      );
    };
    // Gamma stays in history only; Alpha and Beta are open, Beta in front.
    await visit("gamma", true);
    await visit("alpha", false);
    await visit("beta", true);
    await expect
      .poll(
        () =>
          app.eval<number>(
            `window.catamorphicDesktop.historyQuery({query:'handbook',limit:10}).then(result=>result.entries.length)`,
          ),
        { timeout: 15_000 },
      )
      .toBe(3);

    await open();
    await type("handbook");
    await wait(
      `const ids=rows().map(row=>row.dataset.itemId);
       return ids[0]?.startsWith('open-tab:browser:') && ids[1]==='bookmark:pinned:delta' &&
         ['Beta handbook','Gamma handbook'].every(name=>labels().some(label=>label.includes(name)))`,
      "open tab, then bookmark, then history",
    );
    const order = await run<string[]>("return labels()");
    expect(order[0]).toContain("Alpha handbook");
    // The pinned page and its library copy are one row.
    expect(
      order.filter((label) => label.includes("Delta handbook")),
    ).toHaveLength(1);
    // The tab in front is not offered; its page and Gamma follow as history.
    expect(
      order.filter((label) => label.includes("Alpha handbook")),
    ).toHaveLength(1);
    const beta = order.findIndex((label) => label.includes("Beta handbook"));
    const gamma = order.findIndex((label) => label.includes("Gamma handbook"));
    expect(beta).toBeGreaterThan(1);
    expect(gamma).toBeGreaterThan(1);
    await shot("palette-open-tabs.png");
    await run(`key('Enter')`);
    await wait(`return !input()`);
    await expect.poll(address, { timeout: 15_000 }).toContain("/alpha");

    // The Tabs mode lists open tabs in strip order and switches to one.
    await open();
    await type("tabs");
    await run(`key(' ')`);
    await wait(`return chip()==='Tabs'`);
    await wait(
      `return labels().some(label=>label.includes('Alpha handbook') && label.includes('current')) && labels().some(label=>label.includes('Beta handbook'))`,
      "open tabs listed",
    );
    await shot("palette-tabs-mode.png");
    await type("beta");
    await wait(`return labels()[0]?.includes('Beta handbook')`);
    await run(`key('Enter')`);
    await wait(`return !input()`);
    await expect.poll(address, { timeout: 15_000 }).toContain("/beta");
  } finally {
    server.close();
  }
});

it("leaves the list where it is when the pointer highlights a clipped row", async () => {
  await open();
  const list = `input().closest('[role="dialog"]').querySelector('[role="listbox"]')`;
  // The last row the list cuts off at its bottom edge, once its motion settled.
  const target = await wait<{ x: number; y: number; id: string }>(`
    const box = ${list}.getBoundingClientRect();
    if (${list}.getAnimations({ subtree: true }).some((a) => a.playState === 'running')) return false;
    const row = rows().find((row) => { const r = row.getBoundingClientRect(); return r.top < box.bottom && r.bottom > box.bottom; });
    if (!row || ${list}.scrollTop !== 0) return false;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: box.bottom - 6, id: row.dataset.itemId };
  `);
  await app.movePointerThrough([{ x: target.x, y: target.y - 40 }, target]);
  await wait(
    `return rows().find((row) => row.dataset.itemId === ${JSON.stringify(target.id)})?.getAttribute('aria-selected') === 'true'`,
    "the pointer highlights the clipped row",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await run(`return ${list}.scrollTop`)).toBe(0);
  // The keyboard still keeps the row it chooses in view.
  await run(`key('ArrowDown'); return true;`);
  await wait(`return ${list}.scrollTop > 0`, "arrow keys scroll");
  await close();
});

it("closes an untouched New Tab once another tab is shown, and keeps a typed one", async () => {
  const strip = `[...document.querySelectorAll('[data-tab-orientation] [data-point-key]:not([data-sidebar-item-id])')]`;
  const newTabs = () =>
    run<number>(
      `return ${strip}.filter((el) => el.dataset.pointKey.startsWith('palette:')).length`,
    );
  // A real click on a browser tab, aimed once the strip has settled (a New
  // Tab joining it moves the others) and only where that tab is hit, never
  // a neighbour or a close button.
  const showOtherTab = async () => {
    const point = await wait<{ x: number; y: number }>(`
      const tab = ${strip}.find((el) => el.dataset.pointKey.startsWith('browser:') && el.checkVisibility());
      if (!tab) return false;
      const row = tab.closest('[data-tab-orientation]');
      if (row.getAnimations({ subtree: true }).some((a) => a.playState === 'running')) return false;
      const r = tab.getBoundingClientRect();
      const point = { x: r.left + Math.min(24, r.width / 3), y: r.top + r.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return tab.contains(hit) && !hit.closest('[aria-label^="Close"]') && point;
    `);
    await app.movePointer(point);
    await app.clickPointer(point);
  };
  const tabInput = `document.activeElement?.closest('[data-palette="tab"]') && document.activeElement.tagName === 'TEXTAREA'`;
  expect(await newTabs()).toBe(0);
  await shortcut("t");
  await wait(`return ${tabInput}`, "New Tab focused");
  expect(await newTabs()).toBe(1);
  await showOtherTab();
  // The strip lets the closed tab play its exit before it leaves.
  await wait(
    `return !document.querySelector('[data-palette="tab"]') && ${strip}.every((el) => !el.dataset.pointKey.startsWith('palette:'))`,
    "untouched New Tab closed",
  );
  // Typed into, it is kept for later.
  await shortcut("t");
  await wait(`return ${tabInput}`, "second New Tab focused");
  await app.insertText("notes");
  await wait(
    `return document.activeElement?.closest('[data-palette="tab"]') && document.activeElement.value === 'notes'`,
    "typed into the New Tab",
  );
  await showOtherTab();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(await newTabs()).toBe(1);
});
