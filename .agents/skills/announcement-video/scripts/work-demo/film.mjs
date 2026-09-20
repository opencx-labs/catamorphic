// Drives the film's scenes in the real desktop through CDP. Each scene is a
// separate command so a take can be rehearsed piece by piece:
//   node film.mjs viewport | browser | chat1 | chat2 | app | reset
// Typing is human-paced through Input.insertText; keys are real Input events.
import fs from 'node:fs';
import { send, evaluate, pause, ws } from './cdp.mjs';

const here = new URL('.', import.meta.url).pathname;
function mark(event) {
  try {
    const start = JSON.parse(fs.readFileSync(`${here}start.json`)).start;
    const t = (Date.now() - start) / 1000;
    fs.appendFileSync(`${here}markers.jsonl`, JSON.stringify({ t, event }) + '\n');
    console.log(t.toFixed(2), event);
  } catch {
    console.log('(no capture running)', event);
  }
}
const jitter = (base, spread) => base + Math.random() * spread;
async function type(text) {
  for (const char of text) {
    await send('Input.insertText', { text: char });
    await pause(char === ' ' ? jitter(90, 90) : jitter(55, 70));
    if (/[,.!?]/.test(char)) await pause(jitter(160, 120));
  }
}
async function key(key, { code = key, modifiers = 0, text } = {}) {
  const base = { key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const ENTER = { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
async function enter() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', ...ENTER });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function until(expression, label, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return;
    await pause(400);
  }
  throw new Error(`timeout: ${label}`);
}
async function clickAt(selector) {
  return clickEl(`document.querySelector(${JSON.stringify(selector)})`, selector);
}
// Clicks the element an expression resolves to, with a real pointer.
async function clickEl(expression, label = expression) {
  const box = await evaluate(`(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`missing ${label}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
  await pause(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
}
const appRow = `[...document.querySelectorAll('[data-sidebar-section]')].filter(s => s.getClientRects().length && /^Apps/.test(s.textContent)).map(s => s.querySelector('[role=treeitem]')).find(Boolean)`;
const composer = `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`;
// Several status triggers can be mounted (bubbles, rows, the floating chat);
// read them all, never just the first visible one.
const visibleStatuses = `[...document.querySelectorAll('[data-testid=session-inspector-trigger]')].filter(e => e.getClientRects().length).map(e => e.getAttribute('aria-label') || '')`;
const chatWorking = `(${visibleStatuses}).some(s => /Working|Starting|Running/.test(s))`;
const chatIdle = `(() => { const s = ${visibleStatuses}; return s.some(x => /Ready|Idle/.test(x)) && !s.some(x => /Working|Starting|Running/.test(x)); })()`;

// A trackpad flick: many small wheel ticks, fast first and settling, the way
// a finger's momentum reads. One big wheel delta lands as a jump instead.
async function flick(box, total, ms) {
  const step = 16;
  const ticks = Math.max(1, Math.round(ms / step));
  let sent = 0;
  for (let i = 1; i <= ticks; i += 1) {
    const eased = 1 - (1 - i / ticks) ** 3;
    const delta = Math.round(total * eased) - sent;
    sent += delta;
    if (delta > 0) await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...box, deltaX: 0, deltaY: delta });
    await pause(step);
  }
}

const scenes = {
  async viewport() {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    console.log('viewport 1280x800');
  },
  async browser() {
    // A project bookmark opens the reference page in Work's browser.
    await clickEl(`(() => { const row = [...document.querySelectorAll('[data-workspace-visible="true"] [role=treeitem]')].find(r => /Desk lamps/.test(r.textContent)); return row?.querySelector('[data-tree-primary]') ?? row; })()`, 'Desk lamps bookmark');
    mark('bookmark clicked');
    // Park the pointer over the page: a pointer left on a row keeps its
    // tooltip open for as long as it sits there.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    await until(`!!document.querySelector('webview')`, 'webview mounted', 30000);
    // The main take ran with overlay scrollbars (trackpad); a classic 15px
    // bar narrows the page and its lines wrap differently at the splice.
    // Hide the guest's bar as soon as its document exists.
    await evaluate(`(() => { const w = document.querySelector('webview'); const css = 'html::-webkit-scrollbar{display:none}'; const apply = () => w.insertCSS(css).catch(() => {}); w.addEventListener('dom-ready', apply); apply(); return true; })()`);
    await pause(2600);
    mark('page loaded');
    // Reading: put the sidebar away so the page has the window.
    await clickAt('button[aria-label="Collapse sidebar"]');
    // The tab strip slides under where the collapse button was; leave
    // through host chrome (the address bar) before parking over the page,
    // or the tab that lands under the last host pointer opens its card.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 60 });
    await pause(250);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('sidebar collapsed');
    await pause(1400);
    if (await evaluate(`!!document.querySelector('[data-testid=tab-hover-card]')`)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 19 });
      await pause(200);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 60 });
      await pause(300);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
      await pause(600);
    }
    const box = await evaluate(`(() => { const w = document.querySelector('webview'); const r = w.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    // Two trackpad flicks, 480px in all: the same offset as the main take
    // ends on, so the cut into it is seamless.
    await flick(box, 200, 650);
    await pause(900);
    await flick(box, 280, 750);
    await pause(300);
    mark('scrolled');
  },
  async chat1() {
    // The page has focus after browsing; with the sidebar away, the dock's
    // New chat button is how a person starts a chat beside it.
    // Two New chat buttons exist (sidebar strip and dock); the dock's sits
    // furthest right and is the visible one while the sidebar is away.
    await clickEl(`[...document.querySelectorAll('button[aria-label="New chat"]')].sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0]`, 'New chat');
    await until(`!!${composer}`, 'floating chat open', 15000);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    await pause(700);
    mark('chat opened');
    await type('Add a Launch section at the top of my sidebar with the four docs, each with a fitting icon.');
    await pause(500);
    await enter();
    mark('prompt 1 sent');
    await until(chatWorking, 'agent working', 30000);
    // Bring the sidebar back to watch the change land.
    await pause(1500);
    await clickEl(`[...document.querySelectorAll('button[aria-label]')].find(b => /^(Expand|Show|Open) sidebar/.test(b.getAttribute('aria-label')) && b.getClientRects().length)`, 'Expand sidebar');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('sidebar expanded');
    // Match the section title, not any row text: the chat row already reads "Add a Launch section…".
    await until(`[...document.querySelectorAll('[data-sidebar-section]')].some(s => /^Launch/.test(s.textContent))`, 'launch section', 240000);
    mark('sidebar section added');
    await until(chatIdle, 'prompt 1 done', 240000);
    mark('prompt 1 done');
  },
  async theme() {
    // Second ask in the same floating chat: the look of the project. Then
    // the chat goes to its bubble and the dock to the corner, so the change
    // lands on a clean window; the bubble carries the finished signal.
    await pause(1200);
    await type('Switch this project to light mode, with a calmer accent than orange and a softer font.');
    await pause(500);
    await enter();
    mark('prompt 2 sent');
    await until(chatWorking, 'agent working', 30000);
    await pause(1800);
    await clickAt('[data-floating-chat]:not([inert]) button[aria-label="Minimize chat to bubble"]');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('chat minimized');
    await pause(1600);
    await clickAt('button[aria-label="Collapse chat bubbles"]');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('dock collapsed');
    // Project themes wrap the workspace in ProjectTheme (not the document root).
    await until(`!!document.querySelector('[data-theme=light].size-full')`, 'theme switched', 240000);
    mark('theme switched');
    // The chat is minimized, so read busyness from any mounted inspector
    // trigger and from spinners on the bubble and the chat row.
    await pause(3000);
    await until(`(() => { const triggers = [...document.querySelectorAll('[data-testid=session-inspector-trigger]')]; const busy = triggers.some(t => /Working|Starting/.test(t.getAttribute('aria-label') || '')); const spinning = !!document.querySelector('[data-chat-bubble] .animate-spin, [data-sidebar-section] [role=treeitem] .animate-spin'); return !busy && !spinning; })()`, 'prompt 2 done', 240000);
    mark('prompt 2 done');
    await pause(2200);
    await clickAt('button[aria-label="Expand chat bubbles"]');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('dock expanded');
    await pause(1400);
    // ⌘⇧-click the bubble: the chat opens as a tab beside the page.
    const bubble = await evaluate(`(() => { const b = document.querySelector('[data-chat-bubble] button[aria-label^="Open"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!bubble) throw new Error('missing bubble');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...bubble });
    await pause(400);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...bubble, button: 'left', clickCount: 1, modifiers: 12 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bubble, button: 'left', clickCount: 1, modifiers: 12 });
    mark('chat opened to the side');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 420 });
    await pause(2000);
  },
  async chat2() {
    // Third ask, typed in the side tab.
    await clickAt('[data-composer-input]');
    await pause(600);
    await type("Now build me a small app that shows what I've been working on here: chats by day, which are still open, and what each one was about. Make it feel like part of Work.");
    await pause(500);
    await enter();
    mark('build requested');
    await until(chatWorking, 'agent working', 30000);
    await until(`!!(${appRow})`, 'app appears in sidebar', 900000);
    mark('app listed');
    await until(chatIdle, 'build done', 900000);
    mark('build done');
  },
  async app() {
    mark('opening app');
    // Make the page's pane the active one so the app opens beside the chat.
    await clickEl(`(() => { const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /Wikipedia$/.test(e.textContent.trim()) && e.getClientRects().length); return el?.closest('[role=tab]') ?? el; })()`, 'page tab');
    await pause(600);
    await clickEl(`(() => { const row = ${appRow}; return row?.querySelector('[data-tree-primary]') ?? row; })()`, 'app row');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 420 });
    await until(`!!document.querySelector('[data-testid=app-access-consent]')`, 'consent card', 20000);
    await pause(2200);
    mark('consent shown');
    await clickAt('[data-testid=app-access-allow]');
    mark('allowed');
    await pause(6000);
    mark('app visible');
  },
  async pickup() {
    // Continuation from the main take's end: the assistant opened the app's
    // tab and the chat floats over it. Put the chat away, meet the consent
    // card, allow, let the app load, then bring the chat back beside it.
    mark('pickup start');
    await pause(1500);
    await clickAt('[data-floating-chat]:not([inert]) button[aria-label="Minimize chat to bubble"]');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('chat minimized');
    await until(`!!document.querySelector('[data-testid=app-access-consent]')`, 'consent card', 20000);
    await pause(2200);
    mark('consent shown');
    await clickAt('[data-testid=app-access-allow]');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    mark('allowed');
    await pause(4000);
    mark('app visible');
    const bubble = await evaluate(`(() => { const b = document.querySelector('[data-chat-bubble] button[aria-label^="Open"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!bubble) throw new Error('missing bubble');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...bubble });
    await pause(500);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...bubble, button: 'left', clickCount: 1, modifiers: 12 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bubble, button: 'left', clickCount: 1, modifiers: 12 });
    mark('chat beside app');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 420 });
    await pause(5500);
    mark('pickup end');
  },
  // The window as the main take began: dock in the window, no answers
  // remembered, only Launch plan.md open, sidebar out, pointer parked.
  async prep() {
    await evaluate(`catamorphicDesktop.dockDetach(false)`);
    await evaluate(`catamorphicDesktop.setPrefs({ appAccessApprovals: [] })`);
    // Every open tab has a labelled close control ("Close <title>").
    const closeTab = `document.querySelector('[data-tab-orientation] button[aria-label^="Close "]')`;
    for (let i = 0; i < 12; i += 1) {
      const box = await evaluate(`(() => { const e = ${closeTab}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!box) break;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
      await pause(150);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
      await pause(500);
    }
    if (await evaluate(`!!document.querySelector('button[aria-label="Expand sidebar"]')`)) {
      await clickAt('button[aria-label="Expand sidebar"]');
      await pause(500);
    }
    if (await evaluate(`!!document.querySelector('[role=dialog]')`)) {
      await key('Escape', { code: 'Escape' });
      await pause(400);
    }
    const filesSection = `[...document.querySelectorAll('[data-sidebar-section]')].find(s => s.getClientRects().length && /^Files/.test(s.textContent.trim()))`;
    // Folded rows keep their boxes; a row counts as shown when a click at
    // its centre would land on it.
    const planRow = `[...${filesSection}.querySelectorAll('[role=treeitem]')].find(r => /Launch plan\\.md/.test(r.textContent))`;
    const rowShown = `(() => { const r = ${planRow}; if (!r) return false; const b = r.getBoundingClientRect(); return r.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })()`;
    if (!(await evaluate(rowShown))) {
      await clickEl(`${filesSection}.querySelector('button')`, 'Files header');
      await pause(500);
    }
    await until(rowShown, 'Files rows shown', 4000);
    await clickEl(planRow, 'Launch plan.md row');
    await until(`[...document.querySelectorAll('[data-tab-orientation] button')].some(b => /Launch plan\\.md/.test(b.textContent))`, 'plan tab open', 8000);
    await pause(800);
    // The main take began with the Files section folded.
    await clickEl(`${filesSection}.querySelector('button')`, 'Files header');
    // A stray New Tab from a restored workspace goes; the document takes
    // focus at its heading, as a fresh open leaves it; the pointer parks.
    const newTab = await evaluate(`(() => { const e = [...document.querySelectorAll('[data-tab-orientation] button')].find(b => /New Tab/.test(b.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (newTab) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...newTab });
      await pause(300);
      if (await evaluate(`!!document.querySelector('[data-tab-orientation] button[aria-label="Close New Tab"]')`)) {
        await clickAt('[data-tab-orientation] button[aria-label="Close New Tab"]');
        await pause(500);
      }
    }
    await evaluate(`(() => { const pm = document.querySelector('.ProseMirror'); if (!pm) return false; pm.focus(); const first = pm.querySelector('h1') || pm.firstChild; window.getSelection().collapse(first.firstChild || first, 0); return true; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420 });
    await pause(600);
    console.log(JSON.stringify(await evaluate(`({ tabs: [...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim()), theme: document.querySelector('.size-full[data-theme]')?.dataset.theme, sections: [...document.querySelectorAll('[data-sidebar-section]')].filter(s => s.getClientRects().length).map(s => s.textContent.trim().slice(0, 12)) })`)));
  },
  async reset() {
    await send('Emulation.clearDeviceMetricsOverride');
    console.log('viewport reset');
  },
};
const scene = process.argv[2];
if (!scenes[scene]) { console.error('scenes:', Object.keys(scenes).join(' ')); process.exit(1); }
await scenes[scene]();
ws.close();
// A scene is done when its waits are done; never let a lingering socket keep the take waiting.
setTimeout(() => process.exit(0), 200);
