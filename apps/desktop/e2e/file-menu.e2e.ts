import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * A file's right-click menu: the ways to open it, then copy its path, show
 * it in Finder and copy the file itself; the same on its tab, anywhere on
 * the tab, and on a link to it in a chat's reply.
 */

let app: AppHandle;
let root = "";
const MENU = [
  "Open here",
  "Open in new tab",
  "Open to the side",
  "Open floating",
  "Copy path",
  "Show in Finder",
  "Copy file",
];

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor("!!document.querySelector('[data-sidebar=left]')");
  root = `${app.userDataDir}/file-menu`;
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'File menu',rootPath:${JSON.stringify(root)}})`,
  );
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  const status = await app.eval<number>(`(async () => {
    const { url } = await window.catamorphicDesktop.getServerState();
    const projects = await fetch(url + '/api/projects').then((r) => r.json());
    const project = projects.items.find((p) => p.name === 'File menu');
    return fetch(url + '/api/projects/' + project.id + '/files/' + encodeURIComponent('notes/plan.md'), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Plan' }),
    }).then((r) => r.status);
  })()`);
  expect(status).toBe(200);
}, 180_000);

afterAll(async () => {
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
});

/**
 * A real right-click at a point of `selector`'s box (a fraction across),
 * once nothing covers it there (the Files palette closing over the tabs),
 * again if the first lands while something still did.
 */
async function rightClick(selector: string, across = 0.5) {
  const at = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); const x = r.x + r.width * ${across}; const y = r.y + r.height / 2; return el.contains(document.elementFromPoint(x, y)) || el.closest('[data-point-key]')?.contains(document.elementFromPoint(x, y)) ? { x, y } : false; })()`;
  for (let attempt = 0; ; attempt += 1) {
    const point = await app.waitFor<{ x: number; y: number }>(at, {
      label: `${selector} under the pointer`,
    });
    for (const type of ["mousePressed", "mouseReleased"])
      await app.cdp("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "right",
        clickCount: 1,
      });
    try {
      await app.waitFor(
        `document.querySelectorAll('[role="menuitem"]').length === ${MENU.length}`,
        {
          label: `menu on ${selector}`,
          timeoutMs: attempt < 2 ? 3_000 : 15_000,
        },
      );
      break;
    } catch (cause) {
      if (attempt >= 2) throw cause;
    }
  }
  return app.eval<string[]>(
    `[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`,
  );
}

const choose = (label: string) =>
  app.eval(
    `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === ${JSON.stringify(label)}).click(); true`,
  );

/** Pastes into a field for real: what the clipboard holds as text. */
async function paste(): Promise<string> {
  await app.eval(
    `(() => { const field = document.createElement('textarea'); field.id = 'paste-check'; field.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'; document.body.append(field); field.focus(); return true; })()`,
  );
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      modifiers: process.platform === "darwin" ? 4 : 2,
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
      ...(type === "keyDown" ? { commands: ["paste"] } : {}),
    });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const value = await app.eval<string>(
    `(() => { const field = document.getElementById('paste-check'); const value = field.value; field.remove(); return value; })()`,
  );
  return value;
}

/**
 * Picks a copy from the open menu and returns what it put on the clipboard.
 * The copy lands once the file's path is known, a moment after the pick:
 * the clipboard first holds a marker, and what replaces it is the copy.
 */
async function copied(label: string): Promise<string> {
  const marker = `before ${label}`;
  await app.eval(`navigator.clipboard.writeText(${JSON.stringify(marker)})`);
  await choose(label);
  for (let tries = 0; tries < 40; tries += 1) {
    const value = await paste();
    if (value && value !== marker) return value;
  }
  throw new Error(`${label} put nothing on the clipboard`);
}

it("lists a file tab's actions after its ways to open, from anywhere on the tab", async () => {
  await app.eval(
    `document.querySelector('[data-sidebar-search="search-files"]').click(); true`,
  );
  await app.waitFor(
    `!!document.querySelector('textarea[placeholder="Search filenames…"]')`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; setReactValue(document.querySelector('textarea[placeholder="Search filenames…"]'), 'plan'); return true; })()`,
  );
  await app.waitFor(
    `(() => { const row = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes('plan.md')); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return true; })()`,
    { timeoutMs: 30_000, label: "plan.md in the Files palette" },
  );
  const tab = '[data-point-key^="editor:"]';
  await app.waitFor(`!!document.querySelector('${tab}')`, {
    timeoutMs: 30_000,
  });
  // Its label, and its far end where the close button rides.
  expect(await rightClick(`${tab} .workspace-tab-label`, 0.3)).toEqual(MENU);
  expect(await copied("Copy path")).toBe(`${root}/notes/plan.md`);
  expect(await rightClick(tab, 0.92)).toEqual(MENU);
  await choose("Copy file");
  await app.waitFor(`!document.querySelector('[role="menuitem"]')`, {
    label: "menu gone",
  });
});

it("lists the same on a file link in a chat's reply", async () => {
  await app.eval(
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))",
  );
  await app.waitFor(
    "!!document.querySelector('[data-floating-chat] [data-composer-input]')",
  );
  await app.eval(
    `(() => { ${setReactValueJs}; const input = document.querySelector('[data-floating-chat] [data-composer-input]'); setReactValue(input, '[the plan](notes/plan.md)'); input.closest('form').requestSubmit(); return true; })()`,
  );
  const link = 'a[data-response-link="file"]';
  await app.waitFor(`!!document.querySelector('${link}')`, {
    timeoutMs: 30_000,
    label: "file link in the reply",
  });
  expect(await rightClick(link)).toEqual(MENU);
  expect(await copied("Copy path")).toBe(`${root}/notes/plan.md`);
});
