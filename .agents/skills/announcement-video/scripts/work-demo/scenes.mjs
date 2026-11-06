// The v6 film ("Lisbon offsite"), driven through CDP. One command per scene
// so each can be rehearsed alone: node scenes.mjs <scene>
import fs from "node:fs";
import { ws } from "./cdp.mjs";
import {
  boxOf,
  chatIdle,
  chatWorking,
  clickAt,
  clickEl,
  enter,
  evaluate,
  flick,
  mark,
  park,
  pause,
  pressAt,
  send,
  type,
  until,
  visible,
  visibleStatuses,
} from "./lib.mjs";

const ASKS = {
  belem:
    "Open Belém in this guide and fill Friday afternoon with three things we can walk between.",
  light: "Switch Work to light mode.",
  workflow:
    "Add a workflow to this project that checks Friday's forecast every morning and posts it here.",
  app: "Make the team an app with the plan and Friday's forecast, where people can join activities.",
};
const SEEDS = [
  "Draft a packing list for three days away in October.",
  "Write a short welcome note I can read at Wednesday's kickoff.",
  "What should we ask the hotel before we arrive?",
];
const here = new URL(".", import.meta.url).pathname;
const dockNewChat = `[...document.querySelectorAll('button[aria-label="New chat"]')].filter(b => b.getClientRects().length).sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0]`;
const anyComposer = `[...document.querySelectorAll('[data-composer-input]')].find(e => e.getClientRects().length && !e.closest('[inert]'))`;
const floatingComposer = `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`;
const minimize = `document.querySelector('[data-floating-chat]:not([inert]) button[aria-label="Minimize chat to bubble"]')`;
const bubble = `document.querySelector('[data-chat-bubble] button[aria-label^="Open"]')`;
const section = (title) =>
  `[...document.querySelectorAll('${visible} [data-sidebar-section]')].find(s => s.getClientRects().length && new RegExp('^' + ${JSON.stringify(title)}).test(s.textContent.trim()))`;
const rowsOf = (title) =>
  `[...((${section(title)})?.querySelectorAll('[role=treeitem]') ?? [])]`;
const tabs = `[...document.querySelectorAll('${visible} [data-tab-orientation] > [data-point-key]')]`;
const tabMatching = (re) =>
  `${tabs}.find(t => t.getClientRects().length && ${re}.test(t.textContent.trim()))`;
const planText = `([...document.querySelectorAll('${visible} .ProseMirror')].map(p => p.innerText).join('\\n'))`;
const guideUrl = `(document.querySelector('${visible} webview')?.getURL?.() ?? '')`;
const themeNow = `(document.querySelector('.size-full[data-theme]')?.dataset.theme ?? document.documentElement.dataset.theme ?? '')`;

function sparse(on) {
  const flag = `${here}sparse.flag`;
  if (on) fs.writeFileSync(flag, "");
  else fs.rmSync(flag, { force: true });
}
async function key(keyName, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
  });
}
const META = 4;
const SHIFT = 8;
// The palette: Cmd+P, a query typed at human pace, then the row a person
// would pick (arrow keys down to it) opened beside the current view.
async function paletteBeside(query, pick) {
  await key("p", "KeyP", 80, META);
  mark("palette open");
  await pause(700);
  await type(query);
  await pause(800);
  const rows = `[...document.querySelectorAll('[role=option]')].filter(o => o.getClientRects().length && !/^(Lisbon offsite|Product Night|Default Project)$/.test(o.textContent.trim()))`;
  const index = await evaluate(
    `(${rows}).findIndex(o => ${pick}.test(o.textContent))`,
  );
  if (index < 0)
    throw new Error(
      `palette has no row for ${pick}: ${JSON.stringify(await evaluate(`(${rows}).map(o => o.textContent.trim().slice(0, 60))`))}`,
    );
  for (let i = 0; i < index; i += 1) {
    await pause(260);
    await key("ArrowDown", "ArrowDown", 40);
  }
  await pause(500);
  mark("palette pick");
  await key("Enter", "Enter", 13, META | SHIFT);
  mark("palette beside");
}
// One ask in the chat: open it (the dock's New chat the first time, the
// bubble after), type, send, let the first steps show, put it away.
async function ask(name, { first = false, holdReply = 0 } = {}) {
  if (first) await clickEl(dockNewChat, "dock New chat");
  else await clickEl(bubble, "chat bubble");
  await until(`!!${floatingComposer}`, "floating chat open", 15000);
  mark(`${name} chat open`);
  // Rest over the chat, never over a page the agent may be navigating:
  // input over a page mid-navigation is never acknowledged.
  await park(640, 330);
  await pause(holdReply || 900);
  if (!first) await clickEl(floatingComposer, "composer");
  await type(ASKS[name]);
  await pause(600);
  await enter();
  mark(`${name} sent`);
  await until(chatWorking, "agent working", 30000);
  await until(
    `document.querySelectorAll('[data-floating-chat]:not([inert]) [data-step-kind]').length >= 1`,
    "steps",
    25000,
  ).catch(() => {});
  await pause(1200);
  await clickEl(minimize, "minimize");
  mark(`${name} minimized`);
  await park(630, 690);
}
async function waitIdle(name, extra = {}) {
  const start = Date.now();
  const seen = new Set();
  while (Date.now() - start < 30 * 60 * 1000) {
    for (const [label, expr] of Object.entries(extra)) {
      if (!seen.has(label) && (await evaluate(expr))) {
        seen.add(label);
        mark(`${name}: ${label}`);
      }
    }
    const statuses = await evaluate(visibleStatuses);
    if (
      !seen.has("question") &&
      statuses.some((s) => /Waiting|Needs/.test(s))
    ) {
      seen.add("question");
      mark(`${name}: attention`);
    }
    if (await evaluate(chatIdle)) {
      mark(`${name} idle`);
      return;
    }
    await pause(200);
  }
  throw new Error(`${name} never settled`);
}

const scenes = {
  async seed() {
    for (const prompt of SEEDS) {
      if (!(await evaluate(`!!${anyComposer}`))) {
        await clickEl(dockNewChat, "dock New chat");
        await until(`!!${anyComposer}`, "chat open", 15000);
      }
      await pause(500);
      await clickEl(anyComposer, "composer");
      await send("Input.insertText", { text: prompt });
      await pause(300);
      await enter();
      await until(chatWorking, "agent working", 30000);
      await until(chatIdle, "seed done", 300000);
      console.log("seeded:", prompt);
      await pause(800);
      if (await evaluate(`!!${minimize}`)) await clickEl(minimize, "minimize");
      const closeChatTab = `[...document.querySelectorAll('${visible} button[aria-label^="Close "]')].find(b => b.getClientRects().length && /Close (New chat|Draft|Write|What)/.test(b.getAttribute('aria-label')))`;
      if (await evaluate(`!!(${closeChatTab})`))
        await clickEl(closeChatTab, "close chat tab");
      await pause(800);
    }
  },
  // The opening: only Plan.md open, at its top, dark, pointer parked.
  async prep() {
    // Frame for the screen the window is on: a 1280x800 layout, captured at
    // 2560x1600 on a Retina display or 1680x1050 (zoom 1.3125) on a 1x one.
    await evaluate(`window.catamorphicDesktop.devWindow("zoom", 1)`);
    await pause(400);
    const retina = (await evaluate("devicePixelRatio")) >= 2;
    await evaluate(
      retina
        ? `window.catamorphicDesktop.devWindow("setSize", 1280, 800)`
        : `window.catamorphicDesktop.devWindow("setSize", 1680, 1050)`,
    );
    if (!retina)
      await evaluate(`window.catamorphicDesktop.devWindow("zoom", 1.3125)`);
    await pause(800);
    if (
      await evaluate(
        `!!document.querySelector('[data-floating-chat]:not([inert]) button[aria-label="Close chat"]')`,
      )
    )
      await clickAt(
        '[data-floating-chat]:not([inert]) button[aria-label="Close chat"]',
      );
    if (await evaluate(`!!${minimize}`)) await clickEl(minimize, "minimize");
    for (let i = 0; i < 10; i += 1) {
      const close = `[...document.querySelectorAll('${visible} [data-tab-orientation] button[aria-label^="Close "]')].find(b => b.getClientRects().length)`;
      if (!(await evaluate(`!!(${close})`))) break;
      await clickEl(close, "close tab");
      await pause(500);
    }
    const files = section("Files");
    const planRow = `[...(${files}).querySelectorAll('[role=treeitem]')].find(r => r.textContent.trim() === 'Plan.md')`;
    const rowShown = `(() => { const r = ${planRow}; if (!r) return false; const b = r.getBoundingClientRect(); return r.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })()`;
    if (!(await evaluate(rowShown))) {
      await clickEl(`(${files}).querySelector('button')`, "Files header");
      await pause(700);
    }
    await until(rowShown, "plan row shown", 4000);
    await clickEl(
      `(${planRow}).querySelector('[data-tree-primary]') ?? (${planRow})`,
      "Plan row",
    );
    await until(
      `!!document.querySelector('${visible} .ProseMirror')`,
      "plan open",
      8000,
    );
    await pause(800);
    await evaluate(
      `(() => { document.activeElement?.blur?.(); window.getSelection().removeAllRanges(); return true; })()`,
    );
    await park(1235, 470);
    await pause(500);
    console.log(
      JSON.stringify(
        await evaluate(
          `({ tabs: ${tabs}.map(t => t.textContent.trim()), theme: ${themeNow}, statuses: ${visibleStatuses}, w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`,
        ),
      ),
    );
  },
  // 1. The plan; the palette opens the guide beside it; a look at the guide.
  async open() {
    await pause(3000);
    mark("open hold end");
    await paletteBeside("lisbon", "/Lisbon guide/");
    await until(
      `!!document.querySelector('${visible} webview')`,
      "guide tile",
      15000,
    );
    // Input over a page that is still attaching is never acknowledged: wait
    // for the guide to finish loading before the pointer goes near it.
    await until(
      `(() => { try { const w = document.querySelector('${visible} webview'); return !!w.getURL() && !w.isLoading(); } catch { return false; } })()`,
      "guide loaded",
      20000,
    );
    await pause(700);
    await park(1060, 470);
    await pause(1800);
    mark("guide shown");
    await flick(1060, 470, 340, 800);
    await pause(900);
    mark("guide scrolled");
  },
  // 2. Ask for Friday afternoon; the agent drives the guide and edits the plan.
  async belem() {
    await ask("belem", { first: true });
    await waitIdle("belem", {
      "guide on Belém": `/Bel%C3%A9m|Belém/.test(${guideUrl})`,
      "plan filled": `/Jer[oó]nimos|Bel[eé]m Tower|Past[eé]is/i.test(${planText})`,
    });
    await pause(2800);
    mark("belem landed");
  },
  // 3. Light mode, by asking.
  async light() {
    await ask("light", { holdReply: 1700 });
    await waitIdle("light", { "theme light": `${themeNow} === 'light'` });
    await pause(2400);
    mark("light landed");
  },
  // 4. A workflow; its graph.
  async workflow() {
    await ask("workflow", { holdReply: 1500 });
    sparse(true);
    await waitIdle("workflow", {
      "workflow listed": `(${rowsOf("Workflows")}).length > 0`,
      "workflow tab": `!!(${tabMatching("/forecast|weather/i")})`,
    });
    sparse(false);
    await pause(1500);
    mark("workflow settled");
    const tab = (await evaluate(`!!(${tabMatching("/forecast|weather/i")})`))
      ? tabMatching("/forecast|weather/i")
      : `(${rowsOf("Workflows")})[0]?.querySelector('[data-tree-primary]')`;
    await clickEl(tab, "workflow");
    mark("workflow opened");
    await until(
      `!!document.querySelector('${visible} .react-flow')`,
      "graph",
      15000,
    ).catch(() => {});
    await park(1235, 470);
    await pause(3200);
    mark("graph held");
  },
  // 5. An app; the palette opens it beside the graph; Sam uses it.
  async app() {
    await ask("app", { holdReply: 1500 });
    sparse(true);
    await waitIdle("app", {
      "app listed": `(${rowsOf("Apps")}).length > 0`,
    });
    sparse(false);
    await pause(1500);
    mark("app settled");
    const appName = await evaluate(
      `(${rowsOf("Apps")})[0]?.textContent.trim()`,
    );
    const query = appName.split(/\s+/)[0].toLowerCase().slice(0, 7);
    await paletteBeside(
      query,
      `new RegExp(${JSON.stringify(appName)} + '.*(Open tab|App)')`,
    );
    await park(1235, 470);
    mark("app beside");
  },
  async use() {
    const frame = await appFrame();
    let ready = false;
    for (let i = 0; i < 400 && !ready; i += 1) {
      const text = (await frame.ev(`document.body.innerText`)) ?? "";
      if (/Couldn.t load|Not authorized|went wrong/i.test(text))
        throw new Error("app failed to load");
      ready = /Friday/.test(text) && text.length > 200;
      if (!ready) await pause(500);
    }
    if (!ready) throw new Error("app never loaded");
    mark("app ready");
    await pause(1800);
    // Pick Sam, open Friday, join two stops.
    const picker = await inApp(
      frame,
      `[...document.querySelectorAll('select, button, [role=combobox]')].find(e => /choose your name|who are you|i'm/i.test(e.textContent + ' ' + (e.getAttribute('aria-label') || '')))`,
    );
    if (picker) {
      const isSelect = await frame.ev(`!!document.querySelector('select')`);
      if (isSelect) {
        await pressAt(picker);
        await pause(500);
        await frame.ev(
          `(() => { const s = document.querySelector('select'); const o = [...s.options].find(o => /Sam/.test(o.textContent)); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        );
        await key("Escape", "Escape", 27);
      } else {
        await pressAt(picker);
        await pause(700);
        const sam = await inApp(
          frame,
          `[...document.querySelectorAll('[role=option], [role=menuitem], button, li')].find(e => e.textContent.trim() === 'Sam Okafor')`,
        );
        if (sam) await pressAt(sam);
      }
      mark("picked Sam");
      await pause(1100);
    }
    const friday = await inApp(
      frame,
      `[...document.querySelectorAll('[role=tab], button')].find(e => e.textContent.trim() === 'Friday')`,
    );
    if (friday) {
      await pressAt(friday);
      mark("friday");
      await park(1235, 470);
      await pause(2600);
    }
    for (const stop of ["Jer", "Past"]) {
      const toggle = await inApp(
        frame,
        `(() => { const rows = [...document.querySelectorAll('li, [role=listitem], div')].filter(e => e.textContent.includes(${JSON.stringify(stop)}) && e.querySelector('button, [role=switch], input[type=checkbox]')).sort((a, b) => a.textContent.length - b.textContent.length); const row = rows[0]; return row && (row.querySelector('[role=switch]') ?? row.querySelector('input[type=checkbox]') ?? [...row.querySelectorAll('button')].at(-1)); })()`,
        "center",
      );
      if (!toggle) {
        mark(`no toggle for ${stop}`);
        continue;
      }
      await pressAt(toggle);
      mark(`joined ${stop}`);
      await pause(1500);
    }
    await park(560, 640);
    await pause(3500);
    mark("end");
    frame.close();
  },
};

// The app runs in its own frame target; read it through a second socket.
async function appFrame() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: film scripts run outside turbo
  const port = process.env.CDP_PORT;
  for (let i = 0; i < 120; i += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
      r.json(),
    );
    const t = targets.find(
      (x) => x.type === "iframe" && /\/apps\//.test(x.url),
    );
    if (t) {
      const socket = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((y, n) => {
        socket.onopen = y;
        socket.onerror = n;
      });
      let id = 0;
      const pending = new Map();
      socket.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m.result);
          pending.delete(m.id);
        }
      };
      const ev = (expression) =>
        new Promise((r) => {
          pending.set(++id, (res) => r(res?.result?.value));
          socket.send(
            JSON.stringify({
              id,
              method: "Runtime.evaluate",
              params: { expression, returnByValue: true, awaitPromise: true },
            }),
          );
        });
      return { ev, close: () => socket.close() };
    }
    await pause(500);
  }
  throw new Error("no app frame");
}
async function inApp(frame, expression, block = "nearest") {
  const inner = await frame.ev(
    `(() => { const e = ${expression}; if (!e) return null; e.scrollIntoView({ block: '${block}', behavior: '${block === "nearest" ? "instant" : "smooth"}' }); return true; })()`,
  );
  if (!inner) return null;
  await pause(block === "nearest" ? 50 : 650);
  return inAppNow(frame, expression);
}
async function inAppNow(frame, expression) {
  const inner = await frame.ev(
    `(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!inner) return null;
  const outer = await boxOf(
    `[...document.querySelectorAll('${visible} iframe[src*="/apps/"]')].find(f => f.getClientRects().length)`,
  );
  if (!outer) return null;
  return { x: outer.left + inner.x, y: outer.top + inner.y };
}

const scene = process.argv[2];
if (!scenes[scene]) {
  console.error("scenes:", Object.keys(scenes).join(" "));
  process.exit(1);
}
await scenes[scene]();
ws.close();
setTimeout(() => process.exit(0), 200);
