import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle;
let projectRoot: string;
let projectId: string;
const helpers = `
${setReactValueJs}
const input=()=>[...document.querySelectorAll('[data-workspace-visible="true"] [aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0);
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
const nativeHistory = async (redo = false) => {
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      key: "z",
      code: "KeyZ",
      windowsVirtualKeyCode: 90,
      modifiers: (process.platform === "darwin" ? 4 : 2) | (redo ? 8 : 0),
      ...(type === "keyDown" ? { commands: [redo ? "redo" : "undo"] } : {}),
    });
};
const pasteImage = async () => {
  await app.eval(
    `(async()=>{const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;canvas.getContext('2d').fillRect(0,0,8,8);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);})()`,
  );
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
      modifiers: process.platform === "darwin" ? 4 : 2,
      ...(type === "keyDown" ? { commands: ["paste"] } : {}),
    });
};
const stripTabs = `[...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]:not([data-sidebar-item-id], [aria-hidden])')]`;
const selectStripTab = async (key: string) => {
  await run(`
    ${stripTabs}.find(el => el.dataset.pointKey === ${JSON.stringify(key)})?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    return true;
  `);
  const point = await wait<{ x: number; y: number }>(`
    const tab = ${stripTabs}.find(el => el.dataset.pointKey === ${JSON.stringify(key)});
    if (!tab || tab.closest('[data-tab-orientation]').getAnimations({subtree:true}).some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return false;
    const r = tab.getBoundingClientRect();
    const point = {x:r.left+Math.min(24,r.width/3), y:r.top+r.height/2};
    return tab.contains(document.elementFromPoint(point.x,point.y)) && point;
  `);
  await app.clickPointer(point);
};
/** Where the chats are and what has focus, for a wait that timed out. */
const chatState = `JSON.stringify({
  floating: [...document.querySelectorAll('section[data-floating-chat]')].map((el) => el.dataset.chatLocalId),
  inTabs: [...document.querySelectorAll('section[data-chat-tab]')].map((el) => el.dataset.chatLocalId),
  strip: [...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]:not([data-sidebar-item-id])')].map((el) => el.dataset.pointKey),
  focused: (() => { const el = document.activeElement; return el && [el.tagName, el.getAttribute('aria-label'), el.closest('section')?.dataset.chatLocalId ?? null, el.closest('[data-palette]')?.dataset.palette ?? null]; })(),
  appDocumentHasFocus: document.hasFocus(),
})`;
/** A wait that, timed out, says where the chats are and what has focus. */
const waitTelling = async <T>(code: string, label: string): Promise<T> => {
  try {
    return await wait<T>(code, label);
  } catch (error) {
    const state = await app
      .eval<string>(chatState)
      .catch((cause: unknown) => `unreadable (${String(cause)})`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; state: ${state}`,
    );
  }
};

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  projectRoot = path.join(app.userDataDir, "palette-project");
  const project = await createProjectWorkspace({
    app,
    name: "Palette ranking",
    rootPath: projectRoot,
  });
  projectId = project.id;
  fs.mkdirSync(path.join(projectRoot, ".work"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "tickets.json"),
    JSON.stringify([
      { id: "t-101", title: "Checkout button misaligned", owner: "maya" },
      { id: "t-102", title: "Refund emails delayed", owner: "sam" },
      { id: "t-103", title: "Search results empty on mobile", owner: "maya" },
    ]),
  );
  // One module backs a sidebar section and a palette mode (ADR 0186); its
  // package.json declares the files it writes (ADR 0277).
  fs.mkdirSync(path.join(projectRoot, ".work/tickets"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".work/tickets/package.json"),
    JSON.stringify({
      name: "tickets",
      private: true,
      catamorphic: { access: { writes: ["queries.log", "claimed.log"] } },
    }),
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work/tickets/index.ts"),
    `import {readFile,appendFile} from 'node:fs/promises';
    export default {
      async load({query}){
        const all=JSON.parse(await readFile('tickets.json','utf8'));
        if(query!==undefined) await appendFile('queries.log',JSON.stringify(query)+'\\n');
        const shown=query?all.filter(t=>t.title.toLowerCase().includes(query.toLowerCase())):all;
        return {items:shown.map(t=>({id:t.id,label:t.title,description:t.id.toUpperCase(),keywords:[t.owner],
          actions:[{action:'claim',label:'Claim',icon:'Hand'}]}))};
      },
      async action({itemId,action}){ if(action==='claim'||action.startsWith('open')) await appendFile('claimed.log',itemId+'\\n'); }
    };`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work/workspace.js"),
    `module.exports={sidebars: {left:[{id:'work',title:'Work',icon:'Ticket',sections:[
        {id:'tickets',title:'Tickets',source:'.work/tickets/index.ts',height:160},
        {id:'files',source:'work:files'}]}],
      right:[] },
      palette:{modes:[
        {id:'ticket-mode',trigger:'tickets',aliases:['tix'],title:'Tickets',description:'Find a ticket and claim it',icon:'Ticket',section:'tickets'},
        {id:'ticket-search',trigger:'find-ticket',title:'Ticket search',source:'.work/tickets/index.ts',search:'source'},
        {id:'runbooks',trigger:'runbooks',title:'Runbooks',items:[{label:'Deploy runbook',url:'https://runbooks.test/deploy',keywords:['release']}]},
        {id:'project-files',trigger:'pf',title:'Project files',section:'files'}
      ]}
    };`,
  );
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Palette ranking')`);
  // Allowed once in its section, it runs for the palette mode too.
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-section="tickets"] [data-testid="module-access-allow"]')`,
    { label: "the tickets module asks" },
  );
  await app.eval(
    `document.querySelector('[data-sidebar-section="tickets"] [data-testid="module-access-allow"]').click()`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-source="tickets"] [data-sidebar-item-id]')`,
  );
  // Close the startup New Tab so every search uses the overlay.
  await shortcut("w");
  await app.eval(`window.catamorphicDesktop.devWindow('fitSize',1300,900)`);
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
  // A row without an address opens through its source: here, it claims.
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
       return ids[0]?.startsWith('open-tab:browser:') && ids[1]==='bookmark:delta' &&
         ['Beta handbook','Gamma handbook'].every(name=>labels().some(label=>label.includes(name)))`,
      "open tab, then bookmark, then history",
    ).catch(async (error: unknown) => {
      const ids = await run<string[]>(
        "return rows().map(row=>row.dataset.itemId)",
      );
      throw new Error(`${String(error)}; rows: ${JSON.stringify(ids)}`);
    });
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
  const still = `!input().closest('[role="dialog"]').parentElement.getAnimations({ subtree: true }).some(a =>
    a.effect?.getTiming().iterations !== Infinity && (a.pending || a.playState === 'running' || a.playState === 'paused'))`;
  await run(`
    const probe = window.__clippedPalettePointer = { events: [] };
    probe.listener = event => {
      if (!event.isTrusted) return;
      const dialog = input()?.closest('[role="dialog"]');
      probe.events.push({
        clientX: event.clientX, clientY: event.clientY,
        movementX: event.movementX, movementY: event.movementY,
        row: event.target instanceof Element ? event.target.closest('[role="option"]')?.dataset.itemId ?? null : null,
        selected: dialog?.querySelector('[role="option"][aria-selected="true"]')?.dataset.itemId ?? null,
      });
      if (probe.events.length > 50) probe.events.shift();
    };
    window.addEventListener('mousemove', probe.listener, true);
    return true;
  `);
  const pointFor = (kind: "precursor" | "clipped") =>
    wait<{
      x: number;
      y: number;
      id: string;
      top: number;
      bottom: number;
      edge: number;
    }>(
      `
      if (!(${still}) || ${list}.scrollTop !== 0) return false;
      const box = ${list}.getBoundingClientRect();
      const row = rows().find(row => {
        const r = row.getBoundingClientRect();
        return ${
          kind === "clipped"
            ? "r.top < box.bottom && r.bottom > box.bottom"
            : "r.top >= box.top && r.bottom <= box.bottom && !row.matches(':hover')"
        };
      });
      if (!row) return false;
      const r = row.getBoundingClientRect();
      // Native pointer helpers round coordinates. Pick an integer inside the
      // actual visible intersection and hit-test that exact integer.
      const left = Math.ceil(Math.max(r.left, box.left)), right = Math.ceil(Math.min(r.right, box.right)) - 1;
      const top = Math.ceil(Math.max(r.top, box.top)), bottom = Math.ceil(Math.min(r.bottom, box.bottom)) - 1;
      if (right < left || bottom < top) return false;
      const point = { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2), id: row.dataset.itemId,
        top: r.top, bottom: r.bottom, edge: box.bottom };
      if (!row.contains(document.elementFromPoint(point.x, point.y))) return false;
      window.__clippedPalettePointer.${kind} = point;
      return point;
    `,
      `${kind} row and outer palette wrapper settled`,
    );
  try {
    const precursor = await pointFor("precursor");
    await app.movePointer(precursor);
    await wait(
      `return window.__clippedPalettePointer.events.some(event =>
      event.clientX === ${precursor.x} && event.clientY === ${precursor.y} && event.row === ${JSON.stringify(precursor.id)});`,
      "a trusted native move reached the fully visible precursor row",
    );
    // The precursor must actually reach Chromium before moving again, so the
    // final move cannot coalesce with it into an ignored zero-movement event.
    const target = await pointFor("clipped");
    expect(target.top).toBeLessThan(target.edge);
    expect(target.bottom).toBeGreaterThan(target.edge);
    await app.movePointer(target);
    await wait(
      `return window.__clippedPalettePointer.events.some(event =>
      event.clientX === ${target.x} && event.clientY === ${target.y} && event.row === ${JSON.stringify(target.id)} &&
      (event.movementX !== 0 || event.movementY !== 0)) &&
      rows().find(row => row.dataset.itemId === ${JSON.stringify(target.id)})?.getAttribute('aria-selected') === 'true';`,
      "the trusted pointer move highlights the clipped row",
    );
    // Observe the queued scroll/focus work and the highlight's visual rest.
    await run(
      `return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`,
    );
    await wait(`return ${still};`, "the hovered palette at rest");
    expect(await run(`return ${list}.scrollTop`)).toBe(0);
    // The keyboard still keeps the row it chooses in view.
    await run(`key('ArrowDown'); return true;`);
    await wait(`return ${list}.scrollTop > 0`, "arrow keys scroll");
    await close();
  } catch (error) {
    const state = await run(`
      const dialog = input()?.closest('[role="dialog"]');
      const wrapper = dialog?.parentElement;
      const list = dialog?.querySelector('[role="listbox"]');
      const style = wrapper && getComputedStyle(wrapper);
      return {
        pointer: window.__clippedPalettePointer,
        wrapper: wrapper && { rect: wrapper.getBoundingClientRect().toJSON(), translate: style.translate, scale: style.scale, opacity: style.opacity,
          animations: wrapper.getAnimations({ subtree: true }).map(animation => ({ name: animation.animationName ?? animation.transitionProperty,
            state: animation.playState, pending: animation.pending, time: animation.currentTime, timing: animation.effect?.getTiming() })) },
        list: list && { rect: list.getBoundingClientRect().toJSON(), scrollTop: list.scrollTop },
        rows: [...(list?.querySelectorAll('[role="option"]') ?? [])].map(row => ({ id: row.dataset.itemId,
          selected: row.getAttribute('aria-selected'), rect: row.getBoundingClientRect().toJSON() })),
      };
    `).catch((cause: unknown) => `unreadable (${String(cause)})`);
    throw new Error(`Clipped palette pointer: ${JSON.stringify(state)}`, {
      cause: error,
    });
  } finally {
    await run(`
      const probe = window.__clippedPalettePointer;
      if (probe) window.removeEventListener('mousemove', probe.listener, true);
      delete window.__clippedPalettePointer;
      return true;
    `);
  }
});

it("moves the caret between the input's lines with the arrows, and the highlight past them", async () => {
  await open();
  // Real key presses: only the browser's own handling moves a caret. The
  // palette claims a key by preventing it; a listener after React's reads that.
  await run(`window.__arrows = [];
    window.__arrow = (event) => { if (event.key.startsWith('Arrow')) window.__arrows.push(event.defaultPrevented); };
    window.addEventListener('keydown', window.__arrow);
    return true;`);
  const caretAtEnd = () =>
    run(
      `const el = input(); el.setSelectionRange(el.value.length, el.value.length); return true;`,
    );
  const caret = () => run<number>(`return input().selectionStart`);
  const press = async (key: "ArrowUp" | "ArrowDown", modifiers = 0) => {
    await app.press(key, modifiers);
    return caret();
  };
  const SHIFT = 8;
  try {
    await type("first line\nsecond line");
    await caretAtEnd();
    const end = "first line\nsecond line".length;
    // Up from the second line reaches the first; from the first, the results.
    const onFirst = await press("ArrowUp");
    expect(onFirst).toBeLessThanOrEqual("first line".length);
    expect(await press("ArrowUp")).toBe(onFirst);
    // Down returns to the second line; from the last, the results again.
    expect(await press("ArrowDown")).toBe(end);
    expect(await press("ArrowDown")).toBe(end);
    expect(await run(`return window.__arrows`)).toEqual([
      false,
      true,
      false,
      true,
    ]);

    // A line too long for the input wraps, and its wrapped lines count.
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    await type(long);
    await wait(`return input().offsetHeight > 60`, "the long query wraps");
    await caretAtEnd();
    await run(`window.__arrows = []; return true;`);
    expect(await press("ArrowUp")).toBeLessThan(long.length);
    // From the start of the first line down to the start of the next, a
    // caret where the line wraps, and from there up again.
    await run(`input().setSelectionRange(0, 0); return true;`);
    const wrapped = await press("ArrowDown");
    expect(wrapped).toBeGreaterThan(0);
    expect(await press("ArrowUp")).toBe(0);
    expect(await run(`return window.__arrows`)).toEqual([false, false, false]);
    // Shift selects in the text, on its last line too.
    await caretAtEnd();
    await run(`window.__arrows = []; return true;`);
    await press("ArrowUp", SHIFT);
    await press("ArrowDown", SHIFT);
    await press("ArrowDown", SHIFT);
    expect(await run(`return window.__arrows`)).toEqual([false, false, false]);

    // One line: the arrows only ever move the highlight.
    await type("find");
    await wait(`return rows().length > 1`, "results for one line");
    await run(`window.__arrows = []; return true;`);
    const highlighted = () =>
      run<string>(
        `return rows().find((row) => row.getAttribute('aria-selected') === 'true')?.dataset.itemId`,
      );
    const first = await highlighted();
    expect(await press("ArrowDown")).toBe(4);
    expect(await highlighted()).not.toBe(first);
    expect(await press("ArrowUp")).toBe(4);
    expect(await highlighted()).toBe(first);
    expect(await run(`return window.__arrows`)).toEqual([true, true]);
  } finally {
    await run(
      `window.removeEventListener('keydown', window.__arrow); return true;`,
    );
    await close();
  }
  expect(app.getRendererErrors()).toEqual([]);
});

it("closes an untouched New Tab once another tab is shown, and keeps a typed one", async () => {
  const strip = stripTabs;
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
    `return !document.querySelector('[data-workspace-visible="true"] [data-palette="tab"]') && ${strip}.every((el) => !el.dataset.pointKey.startsWith('palette:'))`,
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

it("opens a chat asked for from a New Tab in that tab, in its place", async () => {
  const keys = () =>
    run<string[]>(
      `return [...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]:not([data-sidebar-item-id])')].map((el) => el.dataset.pointKey)`,
    );
  const select = async (key: string) => {
    const point = await wait<{ x: number; y: number }>(`
      const tab = document.querySelector('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key="${key}"]');
      if (!tab?.checkVisibility()) return false;
      if (tab.closest('[data-tab-orientation]').getAnimations({ subtree: true }).some((a) => a.playState === 'running')) return false;
      const r = tab.getBoundingClientRect();
      const point = { x: r.left + Math.min(24, r.width / 3), y: r.top + r.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return tab.contains(hit) && !hit.closest('[aria-label^="Close"]') && point;
    `);
    await app.movePointer(point);
    await app.clickPointer(point);
  };
  /** The chat in front: in a tab, its composer focused, nothing floating. */
  const chatInTab = `(() => {
    const chat = document.querySelector('section[data-chat-tab][data-chat-project="${projectId}"]');
    return !!chat && !document.querySelector('section[data-floating-chat]') &&
      chat.querySelector('[data-composer-input]') === document.activeElement &&
      chat.dataset.chatLocalId;
  })()`;
  /** The strip once the New Tab a chat replaced has played its exit. */
  const withoutNewTab = (label: string) =>
    wait<string[]>(
      `const keys = [...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]:not([data-sidebar-item-id])')].map((el) => el.dataset.pointKey);
       return !keys.some((key) => key.startsWith('palette:')) && keys;`,
      label,
    );
  const freshNewTab = async () => {
    await shortcut("t");
    await wait(
      `return !!document.activeElement?.closest('[data-palette="tab"]') && document.activeElement.tagName === 'TEXTAREA'`,
      "a fresh New Tab",
    );
  };
  // The typed New Tab the last test kept: Cmd+N there opens the chat in it,
  // in its place in the strip.
  const before = await keys();
  const newTab = before.find((key) => key.startsWith("palette:"));
  if (!newTab) throw new Error("No New Tab to start from");
  await select(newTab);
  await wait(
    `return !!document.activeElement?.closest('[data-palette="tab"]')`,
    "the New Tab in front",
  );
  await shortcut("n");
  const first = await wait<string>(
    `return ${chatInTab}`,
    "the chat opened in the New Tab",
  );
  const after = await withoutNewTab("the New Tab replaced");
  expect(after).toHaveLength(before.length);
  expect(after.indexOf(`chat:${first}`)).toBe(before.indexOf(newTab));

  // New chat from a New Tab's own palette does the same.
  await freshNewTab();
  await type("New chat");
  await wait(
    `const row = rows().find((row) => row.dataset.itemId === 'action:new-floating-chat');
     row?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
     return !!row;`,
    "New chat picked",
  );
  const second = await wait<string>(
    `return ${chatInTab} !== ${JSON.stringify(first)} && ${chatInTab}`,
    "the palette's chat opened in its New Tab",
  );
  expect(await withoutNewTab("the second New Tab replaced")).toContain(
    `chat:${second}`,
  );

  // So does a message sent to an agent from it.
  await freshNewTab();
  await type("hello from a new tab");
  await wait(
    `const row = rows().find((row) => row.dataset.itemId === 'send-to-agent');
     row?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
     return !!row;`,
    "Send to agent picked",
  );
  const third = await wait<string>(
    `const chat = document.querySelector('section[data-chat-tab][data-chat-project="${projectId}"]');
     return !document.querySelector('section[data-floating-chat]') &&
       chat?.querySelector('[role="log"]')?.textContent.includes('hello from a new tab') &&
       chat.dataset.chatLocalId;`,
    "the message's chat in the New Tab",
  );
  expect(await withoutNewTab("the third New Tab replaced")).toContain(
    `chat:${third}`,
  );

  // An empty chat floating over a New Tab moves into it.
  await freshNewTab();
  await wait(
    `const plus = document.querySelector('[data-dock-rail] button[aria-label="New chat"]');
     plus?.click();
     return !!plus;`,
    "the dock's +",
  );
  const floated = await wait<string>(
    `return document.querySelector('section[data-floating-chat]')?.dataset.chatLocalId;`,
    "a chat floating over the New Tab",
  );
  // The person clicks back into the New Tab before Cmd+N, as a key pressed
  // before the floating chat's autofocus frame does (on a slow machine):
  // the chat it moves in still takes focus.
  await run(`
    const field = document.querySelector('[data-workspace-visible="true"] [data-palette="tab"] textarea');
    field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    field.focus();
    return true;
  `);
  await wait(
    `return document.activeElement?.closest('[data-palette="tab"]') && !document.querySelector('section[data-floating-chat] [data-composer-input]:focus')`,
    "focus back in the New Tab",
  );
  await shortcut("n");
  expect(await waitTelling<string>(`return ${chatInTab}`, "it moved in")).toBe(
    floated,
  );
  expect(await withoutNewTab("the fourth New Tab replaced")).toContain(
    `chat:${floated}`,
  );

  // With a page in front, a new chat floats as before.
  const page = (await keys()).find((key) => key.startsWith("browser:"));
  if (!page) throw new Error("No page to put in front");
  await select(page);
  // In front before Cmd+N: asked while the fresh chat still is, Cmd+N
  // keeps to that chat, as it should.
  await wait(
    `return !!document.querySelector('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key="${page}"] [aria-current]')`,
    "the page in front",
  );
  await shortcut("n");
  await wait(
    `return !!document.querySelector('section[data-floating-chat] [data-composer-input]')`,
    "a floating chat over the page",
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("shows the new chat's harness, model name and effort in chat mode", async () => {
  const defaultId = await app.eval<string>(
    `window.catamorphicDesktop.agentsList().then(data => data.defaultAgentId)`,
  );
  await app.eval(`(async () => {
    const agent = await window.catamorphicDesktop.agentsCreate({name:'Review helper',harness:'codex',model:'fake-model-a',effort:'high'});
    await window.catamorphicDesktop.agentsSetDefault(agent.id);
  })()`);
  await open();
  await type("chat");
  await run(`key(' ')`);
  await wait(
    `return rows()[0]?.textContent.includes('Review helper · Fake Model A · high') && !!rows()[0]?.querySelector('[data-harness-icon="openai"]');`,
    "chat identity and default settings",
  );
  await type("please review this");
  expect(await run(`return rows()[0].textContent`)).toBe(
    "Ask agentReview helper · Fake Model A · high",
  );
  await shot("palette-chat-harness-model-effort.png");
  await app.eval(`window.catamorphicDesktop.devWindow('fitSize',700,600)`);
  await shot("palette-chat-harness-model-effort-narrow.png");
  await close();
  await app.eval(`window.catamorphicDesktop.devWindow('fitSize',1300,900)`);
  await app.eval(
    `window.catamorphicDesktop.agentsSetDefault(${JSON.stringify(defaultId)})`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("pastes a clipboard image into Ask agent and sends the same attachment", async () => {
  await open();
  await type("agent");
  await run(`key(' ')`);
  await wait(
    `return input()?.isContentEditable && document.activeElement===input()`,
    "Ask agent composer focused",
  );
  await app.eval(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=8; canvas.height=8;
    canvas.getContext('2d').fillRect(0,0,8,8);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  })()`);
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      modifiers: process.platform === "darwin" ? 4 : 2,
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
      ...(type === "keyDown" ? { commands: ["paste"] } : {}),
    });
  await wait(
    `return !!input().querySelector('[data-testid="composer-pill"][data-pill-kind="image"] img')`,
    "image pill from native paste",
  );
  // A pill-only message sends too; this used to be a textarea with no paste handler.
  await shot("palette-pasted-image.png");
  await run(`key('Enter')`);
  await app.waitFor(
    `document.body.innerText.includes('Received 1 attachment:')`,
    { label: "agent received pasted image" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("restores typing focus when Backspace leaves an empty Ask agent mode", async () => {
  await open();
  await type("agent");
  await run(`key(' ')`);
  await wait(`return input()?.isContentEditable`);
  await run(`key('Backspace')`);
  await wait(
    `return input() instanceof HTMLTextAreaElement && document.activeElement===input()`,
  );
  await app.insertText("focus restored");
  expect(await run(`return input().value`)).toBe("focus restored");
  await close();
});

it.each([false, true])(
  "keeps the caret and a partial selection while editing the palette (Ask agent: %s)",
  async (agent) => {
    await open();
    if (agent) {
      await type("agent");
      await run(`key(' ')`);
      await wait(
        `return input()?.isContentEditable && document.activeElement===input()`,
      );
    }
    const text = "Keep this draft while I edit words in the middle. ".repeat(8);
    await app.insertText(text);
    const select = () =>
      run(`
      const field=input();
      if(field instanceof HTMLTextAreaElement) field.setSelectionRange(5,9);
      else getSelection().setBaseAndExtent(field.firstChild,5,field.firstChild,9);
      return true;
    `);
    const selection = () =>
      run<[number, number]>(`
      const field=input(), selection=getSelection();
      return field instanceof HTMLTextAreaElement
        ? [field.selectionStart,field.selectionEnd]
        : [selection.anchorOffset,selection.focusOffset];
    `);
    try {
      await select();
      // Let results, height and profile updates commit while the person
      // has selected one word, then edit through Chromium's own path.
      await app.eval(
        `window.catamorphicDesktop.getPrefs().then(prefs=>window.catamorphicDesktop.setPrefs({voiceInChats:!prefs.voiceInChats}))`,
      );
      expect(await selection()).toEqual([5, 9]);
      await app.insertText("those");
      expect(await selection()).toEqual([10, 10]);
      for (let index = 0; index < 8; index++) {
        await app.press("ArrowRight");
        await app.insertText("x");
        const [start, end] = await selection();
        expect(start).toBe(end);
      }
      await shot(`palette-selection-${agent ? "agent" : "search"}.png`);
    } finally {
      await close();
    }
    expect(app.getRendererErrors()).toEqual([]);
  },
);

it.each(["overlay", "tab"])(
  "keeps existing text when a mode trigger is inserted at its beginning (%s)",
  async (variant) => {
    const text = "  Keep this query\nexactly as typed.  ";
    for (const { trigger, label } of [
      { trigger: "web", label: "Search web" },
      { trigger: "@hist", label: "History" },
      { trigger: "file", label: "Files" },
      { trigger: "tix", label: "Tickets" },
      { trigger: "agent", label: "Ask agent" },
    ]) {
      if (variant === "overlay") await open();
      else {
        await shortcut("t");
        await wait(`return document.activeElement === input()`);
      }
      await app.insertText(text);
      await run(`input().setSelectionRange(0, 0); return true;`);
      await app.insertText(trigger);
      await app.press("Space");
      await wait(`return chip() === ${JSON.stringify(label)}`);
      const value = () =>
        run<string>(
          `return input().isContentEditable ? input().textContent : input().value`,
        );
      expect(await value()).toBe(text);
      expect(await run(`return document.activeElement === input()`)).toBe(true);
      // The handoff into Ask agent must reach the actual editable, so
      // continued typing edits the retained draft rather than replacing it.
      await run(`
        const field = input();
        if (field instanceof HTMLTextAreaElement) field.setSelectionRange(field.value.length, field.value.length);
        return true;
      `);
      await app.insertText("more");
      expect(await value()).toBe(`${text}more`);
      if (trigger === "agent") await shot(`palette-prefix-${variant}.png`);
      if (variant === "overlay") await close();
      else {
        const closingKey = await run<string>(
          `return input().closest('[data-surface-key]').dataset.surfaceKey`,
        );
        await shortcut("w");
        await wait(
          `return ![...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]')].some(tab=>tab.dataset.pointKey===${JSON.stringify(closingKey)})`,
        );
      }
    }
    expect(app.getRendererErrors()).toEqual([]);
  },
);

it("retains independent New Tab drafts, appends new tabs, and reuses an empty tab", async () => {
  const strip = stripTabs;
  const keys = () =>
    run<string[]>(`return ${strip}.map(el => el.dataset.pointKey)`);
  const currentKey = () =>
    run<string>(
      `return input().closest('[data-surface-key]').dataset.surfaceKey`,
    );
  const select = async (key: string) => {
    await selectStripTab(key);
    await wait(
      `return input()?.closest('[data-surface-key]')?.dataset.surfaceKey === ${JSON.stringify(key)} && document.activeElement === input()`,
    );
  };
  const newTab = async () => {
    await shortcut("t");
    await wait(
      `return input() instanceof HTMLTextAreaElement && input().value === '' && document.activeElement === input() && !!input().closest('[data-palette="tab"]')`,
    );
    return currentKey();
  };
  const before = await keys();
  const first = await newTab();
  expect((await keys()).at(-1)).toBe(first);
  await app.insertText("first draft");
  await run(`input().setSelectionRange(0, 5); return true;`);
  const second = await newTab();
  expect(second).not.toBe(first);
  expect((await keys()).at(-1)).toBe(second);
  await app.insertText("agent");
  await app.press("Space");
  await wait(
    `return input()?.isContentEditable && document.activeElement === input()`,
  );
  await app.insertText("second draft\nwith another line");
  await select(first);
  expect(
    await run(
      `return [input().value,input().selectionStart,input().selectionEnd]`,
    ),
  ).toEqual(["first draft", 0, 5]);
  await select(second);
  expect(await run(`return [chip(),input().innerText]`)).toEqual([
    "Ask agent",
    "second draft\nwith another line",
  ]);
  const empty = await newTab();
  expect((await keys()).at(-1)).toBe(empty);
  expect(await newTab()).toBe(empty);
  // The + button shares Cmd+T's reuse and focus handoff.
  await run(
    `document.querySelector('[data-workspace-visible="true"] button[aria-label="New tab"]').click(); return true;`,
  );
  await wait(`return document.activeElement === input()`);
  expect(await currentKey()).toBe(empty);
  expect(await keys()).toEqual([
    ...before.filter((key) => key !== first),
    first,
    second,
    empty,
  ]);
  await select(first);
  expect(await run(`return input().value`)).toBe("first draft");
  // Leaving an empty tab still closes it; both drafts survive that cleanup.
  await wait(
    `return !${strip}.some(el => el.dataset.pointKey === ${JSON.stringify(empty)})`,
  );
  for (const key of [first, second]) {
    await select(key);
    await shortcut("w");
    await wait(
      `return ![...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]')].some(tab=>tab.dataset.pointKey===${JSON.stringify(key)})`,
    );
  }
  expect(await keys()).toEqual(before.filter((key) => key !== first));
  expect(app.getRendererErrors()).toEqual([]);
});

it("retains a selected skill and only accents targets while its palette is active", async () => {
  if (
    await app.eval<boolean>(
      `!!document.querySelector('section[data-floating-chat] [data-composer-input]')`,
    )
  ) {
    await shortcut("m");
    await wait(
      `return !document.querySelector('section[data-floating-chat] [data-composer-input]')`,
      "floating chats minimized before tab targeting",
    );
  }
  const strip = `[...document.querySelectorAll('[data-workspace-visible="true"] [data-tab-orientation] [data-point-key]:not([data-sidebar-item-id])')]`;
  const browser = await run<string>(
    `return ${strip}.find(el => el.dataset.pointKey.startsWith('browser:')).dataset.pointKey`,
  );
  await shortcut("t");
  await wait(
    `return document.activeElement === input() && !!input().closest('[data-palette="tab"]')`,
  );
  const palette = await run<string>(
    `return input().closest('[data-surface-key]').dataset.surfaceKey`,
  );
  await app.insertText(">close tab");
  await wait(
    `return rows().find(row=>row.getAttribute('aria-selected')==='true')?.dataset.itemId==='action:close-tab'`,
    "close-tab command selected",
  );
  await wait(
    `return ${strip}.some(el => el.dataset.pointKey === ${JSON.stringify(palette)} && el.dataset.paletteTarget)`,
  );
  await selectStripTab(browser);
  await wait(`return !${strip}.some(el => el.dataset.paletteTarget)`);
  await selectStripTab(palette);
  await wait(
    `return ${strip}.some(el => el.dataset.pointKey === ${JSON.stringify(palette)} && el.dataset.paletteTarget)`,
  );
  await wait(
    `return document.activeElement===input()`,
    "retained palette input focused",
  );
  await type("skills");
  await app.press("Space");
  await wait(`return chip() === 'Skills' && rows().length > 1`);
  await app.press("ArrowDown");
  const selected = await run<string>(
    `return rows().find(el => el.getAttribute('aria-selected') === 'true').dataset.itemId`,
  );
  await selectStripTab(browser);
  await selectStripTab(palette);
  await wait(
    `return document.activeElement === input() && chip() === 'Skills'`,
  );
  expect(
    await run(
      `return rows().find(el => el.getAttribute('aria-selected') === 'true').dataset.itemId`,
    ),
  ).toBe(selected);
  await shortcut("w");
  expect(app.getRendererErrors()).toEqual([]);
});

it.each(["web", "agent", "tix"])(
  "undoes and redoes entering and leaving %s mode",
  async (trigger) => {
    const selectAll = async () => {
      for (const type of ["keyDown", "keyUp"])
        await app.cdp("Input.dispatchKeyEvent", {
          type,
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: process.platform === "darwin" ? 4 : 2,
          ...(type === "keyDown" ? { commands: ["selectAll"] } : {}),
        });
    };
    const history = async (redo = false) => {
      for (const type of ["keyDown", "keyUp"])
        await app.cdp("Input.dispatchKeyEvent", {
          type,
          key: "z",
          code: "KeyZ",
          windowsVirtualKeyCode: 90,
          modifiers: (process.platform === "darwin" ? 4 : 2) | (redo ? 8 : 0),
          ...(type === "keyDown" ? { commands: [redo ? "redo" : "undo"] } : {}),
        });
    };
    await open();
    const text = "retained draft";
    await app.insertText(text);
    await run(`input().setSelectionRange(0,0); return true;`);
    await app.insertText(trigger);
    await app.press("Space");
    await wait(`return !!chip()`);
    const label = await run<string>(`return chip()`);
    const value = () =>
      run<string>(
        `return input().isContentEditable ? input().textContent : input().value`,
      );
    await history();
    await wait(
      `return chip() === null && input().value === ${JSON.stringify(trigger + text)}`,
    );
    expect(
      await run(`return [input().selectionStart,input().selectionEnd]`),
    ).toEqual([trigger.length, trigger.length]);
    await history(true);
    await wait(`return chip() === ${JSON.stringify(label)}`);
    expect(await value()).toBe(text);
    await run(
      `if(input() instanceof HTMLTextAreaElement) input().setSelectionRange(input().value.length,input().value.length); return true;`,
    );
    await app.insertText(" extra");
    expect(await value()).toBe(`${text} extra`);
    await history();
    expect(await value()).toBe(text);
    expect(await run(`return chip()`)).toBe(label);
    // Empty the draft through native editing, then Backspace pops the chip.
    await selectAll();
    await app.press("Backspace");
    await wait(`return (input().value ?? input().textContent) === ''`);
    await app.press("Backspace");
    await wait(`return chip() === null`);
    await history();
    await wait(
      `return chip() === ${JSON.stringify(label)} && document.activeElement === input()`,
    );
    expect(await value()).toBe("");
    await history(true);
    await wait(`return chip() === null`);
    await history();
    await wait(`return chip() === ${JSON.stringify(label)}`);
    // Deleting back to a boundary is a native edit, not a mode undo.
    await app.insertText("hello");
    await selectAll();
    await app.press("Backspace");
    await history();
    expect(await value()).toBe("hello");
    expect(await run(`return chip()`)).toBe(label);
    await close();

    await open();
    await app.insertText(trigger);
    await app.press("Space");
    await wait(`return !!chip()`);
    await history();
    await wait(
      `return chip() === null && input().value === ${JSON.stringify(trigger)}`,
    );
    // A new edit after mode undo starts a new redo branch.
    await app.insertText("x");
    await history();
    expect(await value()).toBe(trigger);
    await history(true);
    expect(await value()).toBe(`${trigger}x`);
    expect(await run(`return chip()`)).toBe(null);
    await close();
    await open();
    await app.insertText(trigger);
    await app.press("Space");
    await wait(`return !!chip()`);
    await app.insertText("hello");
    await selectAll();
    await app.press("Backspace");
    await history();
    expect(await value()).toBe("hello");
    await history(true);
    expect(await value()).toBe("");
    await history();
    expect(await value()).toBe("hello");
    expect(await run(`return chip()`)).toBe(label);
    await history();
    expect(await value()).toBe("");
    await history();
    await wait(
      `return chip() === null && input().value === ${JSON.stringify(trigger)}`,
    );
    await close();
    expect(app.getRendererErrors()).toEqual([]);
  },
);

it("only consumes a mode trigger before a collapsed caret, outside composition", async () => {
  await open();
  for (const [text, start, end] of [
    ["unknownquery", 7, 7],
    ["@squery", 2, 2],
    ["find webquery", 8, 8],
    ["webquery", 0, 3],
  ] as const) {
    await type(text);
    await run(`input().setSelectionRange(${start}, ${end}); return true;`);
    await app.press("Space");
    expect(await run(`return chip()`)).toBe(null);
    expect(await run(`return input().value`)).toBe(
      `${text.slice(0, start)} ${text.slice(end)}`,
    );
  }
  await type("webquery");
  await run(
    `input().setSelectionRange(3, 3); key(' ', {isComposing:true}); return true;`,
  );
  expect(await run(`return chip()`)).toBe(null);
  expect(await run(`return input().value`)).toBe("webquery");
  // Tab supports the same prefix handoff as Space.
  await app.press("Tab");
  await wait(`return chip() === 'Search web'`);
  expect(await run(`return input().value`)).toBe("query");
  await close();
});

it("undoes one logical attachment removal after its cleanup runs unfocused", async () => {
  await open();
  await app.insertText("agent");
  await app.press("Space");
  await wait(
    `return input()?.isContentEditable && document.activeElement === input()`,
  );
  await pasteImage();
  await wait(
    `return !!input().querySelector('[data-testid="composer-pill"] img')`,
  );
  await run(`window.__paletteOwner=input();return true;`);
  await app.insertText("tail");
  await run(
    `input().querySelector('button[aria-label^="Remove "]').click();input().blur();return true;`,
  );
  await wait(`return !input().querySelector('[data-pill-id]')`);
  await run(`input().focus();return true;`);
  await nativeHistory();
  await wait(
    `return !!input().querySelector('[data-testid="composer-pill"] img')`,
  );
  expect(await run(`return input() === window.__paletteOwner`)).toBe(true);
  await nativeHistory();
  expect(
    await run(
      `return !!input().querySelector('[data-testid="composer-pill"] img')`,
    ),
  ).toBe(true);
  expect(
    await run(
      `return [...input().childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.nodeValue).join('').includes('tail')`,
    ),
  ).toBe(false);
  await nativeHistory();
  await wait(`return !input().querySelector('[data-pill-id]')`);
  expect(await run(`return chip()`)).toBe("Ask agent");
  await close();
  expect(app.getRendererErrors()).toEqual([]);
});

it("records a committed composition as one palette undo transaction", async () => {
  await open();
  await app.insertText("agent");
  await app.press("Space");
  await wait(
    `return input()?.isContentEditable && document.activeElement === input()`,
  );
  await app.cdp("Input.imeSetComposition", {
    text: "に",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await app.cdp("Input.imeSetComposition", {
    text: "日本語",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await app.insertText("日本語");
  await wait(`return input().textContent === '日本語'`);
  await nativeHistory();
  await wait(`return input().textContent === '' && chip() === 'Ask agent'`);
  await nativeHistory(true);
  await wait(`return input().textContent === '日本語'`);
  await close();
  expect(app.getRendererErrors()).toEqual([]);
});
