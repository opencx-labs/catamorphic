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

/** Where the open menu rests, once it has popped in; false before. */
const MENU_AT_REST = `(() => { const menu = document.querySelector('[role="menuitem"]')?.closest('[role="menu"]'); return !!menu && menu.getAnimations().every((a) => a.playState !== 'running') && JSON.stringify(menu.getBoundingClientRect()); })()`;

/**
 * A real right-click at a point of `selector`'s box (a fraction across),
 * once nothing covers it there (the Files palette closing over the tabs),
 * until its menu opens and comes to rest: again if the first lands while
 * something still covered it, or the menu closed as it opened (macOS CI
 * can take key status from the window then). Exactly on it, or anywhere
 * on its tab.
 */
async function rightClick(
  selector: string,
  across = 0.5,
  exactly = false,
  listed = MENU,
) {
  const at = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const x = r.x + r.width * ${across}; const y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return el.contains(hit) || (!${exactly} && el.closest('[data-point-key]')?.contains(hit)) ? { x, y } : false; })()`;
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
        `document.querySelectorAll('[role="menuitem"]').length === ${listed.length}`,
        {
          label: `menu on ${selector}`,
          timeoutMs: attempt < 2 ? 3_000 : 15_000,
        },
      );
      await app.waitFor(MENU_AT_REST, {
        label: `menu on ${selector} at rest`,
        timeoutMs: attempt < 2 ? 3_000 : 15_000,
      });
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
    `document.querySelector('[data-header-action="command:search-files"]').click(); true`,
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
  // Its label.
  expect(await rightClick(`${tab} .workspace-tab-label`, 0.3)).toEqual(MENU);
  expect(await copied("Copy path")).toBe(`${root}/notes/plan.md`);
  // Its close button, over the label's end once the pointer is on the tab.
  await app.waitFor(`!document.querySelector('[role="menuitem"]')`, {
    label: "menu gone",
  });
  const middle = await app.eval<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('${tab}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...middle });
  expect(await rightClick(`${tab} .workspace-tab-close`, 0.5, true)).toEqual(
    MENU,
  );
  // A right-click in the open menu does not open it again where it was.
  const before = await app.waitFor<string>(MENU_AT_REST, {
    label: "menu at rest",
  });
  const item = await app.eval<{ x: number; y: number }>(
    `(() => { const r = [...document.querySelectorAll('[role="menuitem"]')].at(-1).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...item,
      button: "right",
      clickCount: 1,
    });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    await app.waitFor<string>(MENU_AT_REST, { label: "menu at rest" }),
  ).toBe(before);
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

it("copies the address of a URL in chat and an ordinary link elsewhere", async () => {
  const url = "https://docs.example.test/guide?view=full#paste";
  await app.eval(`(() => { ${setReactValueJs};
    const input = document.querySelector('[data-floating-chat] [data-composer-input]');
    setReactValue(input, ${JSON.stringify(`[Read the guide](${url})`)});
    input.closest('form').requestSubmit(); return true;
  })()`);
  const link = `a[data-response-link="web"][href="${url}"]`;
  await app.waitFor(`!!document.querySelector(${JSON.stringify(link)})`, {
    label: "web link in the reply",
  });
  const actions = [...MENU.slice(0, 4), "Copy link"];
  expect(await rightClick(link, 0.5, true, actions)).toEqual(actions);
  expect(await copied("Copy link")).toBe(url);
  await app.waitFor(`!document.querySelector('[role="menuitem"]')`);

  // Inline URL and browser-tab pills expose the same address as links.
  await app.eval(`(() => {
    const input = document.querySelector('[data-floating-chat] [data-composer-input]');
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(url)});
    input.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data}));
  })()`);
  const pill = "[data-composer-input] [data-link-url]";
  await app.waitFor(`!!document.querySelector(${JSON.stringify(pill)})`);
  expect(await rightClick(pill, 0.5, true, ["Copy link"])).toEqual([
    "Copy link",
  ]);
  expect(await copied("Copy link")).toBe(url);
  await app.waitFor(`!document.querySelector('[role="menuitem"]')`);

  // Ordinary host links need the same copy action even outside a chat.
  await app.eval(`(() => {
    const anchor = document.createElement('a');
    anchor.id = 'ordinary-url'; anchor.href = ${JSON.stringify(url)};
    anchor.textContent = 'Read the guide';
    anchor.style.cssText = 'position:fixed;left:300px;top:60px;z-index:100';
    document.querySelector('[data-workspace-ready]').append(anchor);
  })()`);
  expect(await rightClick("#ordinary-url", 0.5, true, ["Copy link"])).toEqual([
    "Copy link",
  ]);
  expect(await copied("Copy link")).toBe(url);
  await app.eval(`document.querySelector('#ordinary-url').remove()`);
  await app.waitFor(`!document.querySelector('[role="menuitem"]')`);
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key:'p',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,
  }))`);
  const palette = '[data-palette="overlay"] textarea';
  await app.waitFor(
    `document.activeElement === document.querySelector('${palette}')`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; setReactValue(document.querySelector('${palette}'),${JSON.stringify(url)}); })()`,
  );
  await app.waitFor(`!!document.querySelector('[data-item-id="web"]')`);
  expect(await rightClick('[data-item-id="web"]', 0.5, true, actions)).toEqual(
    actions,
  );
  expect(await copied("Copy link")).toBe(url);
});
