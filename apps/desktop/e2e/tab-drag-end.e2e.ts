import { execFileSync } from "node:child_process";
import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  openProjectSwitcher,
  pointerOnPage,
  setReactValueJs,
  waitForProjectWorkspace,
  workspaceDomHelpersJs,
} from "./harness.js";

/**
 * A dragged tab whose row leaves mid-drag (closed, or gone from a list) hears
 * its dragend detached, where React never sees it. The drag still ends: the
 * side drop targets laid over the pages, and the strip's dragging state, go
 * the moment the pointer is back in the window.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  const name = new URL(request.url ?? "/", "http://fixture").searchParams.get(
    "name",
  );
  response.end(
    `<title>${name}</title><body style="margin:0;height:100vh"><h1>${name}</h1><script>window.events=[];document.addEventListener('click',()=>events.push('click'),true)</script></body>`,
  );
});

const mac = process.platform === "darwin";
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n ${workspaceDomHelpersJs} const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
const paletteInput = `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find((el) => !el.closest('[inert]') && el.checkVisibility())`;
const openPage = async (name: string) => {
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', bubbles: true, cancelable: true,
    ...(${mac} ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  await app.waitFor(`!!${paletteInput}`, { label: "New Tab" });
  await run(
    `const input = ${paletteInput}; input.focus(); setReactValue(input, ${JSON.stringify(`${origin}/?name=${name}`)})`,
  );
  await app.waitFor(
    `document.activeElement === ${paletteInput} && document.activeElement.closest('[role="dialog"]').querySelector('[data-item-id=web]')?.getAttribute('aria-selected') === 'true'`,
    { label: "address row selected" },
  );
  await app.press("Enter");
  return app.waitFor<string>(
    `[...document.querySelectorAll('[data-surface-key^="browser:"][data-workspace-slot]')].find((pane) => pane.querySelector('webview')?.getTitle?.() === ${JSON.stringify(name)})?.getAttribute('data-surface-key') ?? false`,
    { label: `${name} shown`, timeoutMs: 30_000 },
  );
};
/**
 * Starts dragging `source`'s tab, closes the tab while the drag runs, and
 * ends the drag as the browser does: at the row, now out of the page.
 */
const dragAndCloseMidway = async (source: string, close: string) => {
  await app.eval(
    `(()=>{window.__dragSource=document.querySelector(${JSON.stringify(source)});window.__dragSource.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}));return true})()`,
  );
  return async (dragging: string) => {
    await app.waitFor(dragging, { label: "the drag under way" });
    await run(`$(${JSON.stringify(close)}).click()`);
    await app.waitFor("!window.__dragSource.isConnected", {
      label: "the dragged row gone",
    });
    await app.eval(
      "(()=>{window.__dragSource.dispatchEvent(new DragEvent('dragend',{bubbles:true}));delete window.__dragSource;return true})()",
    );
  };
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await openProjectSwitcher(app);
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New project')",
  );
  await run("button('New project').click()");
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Tab drags')",
  );
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  await waitForProjectWorkspace({ app, name: "Tab drags" });
  await app.eval(
    "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar',headerPlacement:'sidebar'})",
  );
  await focusWindow(app);
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

it("gives the shown page back its presses when the dragged tab's row leaves mid-drag", async () => {
  const gone = await openPage("Gone");
  const shown = await openPage("Shown");
  const row = `aside [data-point-key="${gone}"]`;
  const finish = await dragAndCloseMidway(
    row,
    `${row} button[aria-label^="Close"]`,
  );
  await finish("!!document.querySelector('[data-tab-drop-sides]')");
  // The drag's end never reached the app: its side targets still cover the
  // page in sight, transparent, and took every press and wheel meant for it.
  expect(
    await app.eval("!!document.querySelector('[data-tab-drop-sides]')"),
  ).toBe(true);
  const page = await app.connectToFrame("?name=Shown");
  try {
    const point = await app.eval<{ x: number; y: number }>(`(() => {
      const box = document.querySelector(${JSON.stringify(`[data-surface-key="${shown}"] webview`)}).getBoundingClientRect();
      return { x: box.left + box.width * 0.5, y: box.top + box.height * 0.3 };
    })()`);
    await pointerOnPage(app, {
      view: `document.querySelector(${JSON.stringify(`[data-surface-key="${shown}"] webview`)})`,
      selector: "body",
      point,
    });
    expect(
      await app.eval("!!document.querySelector('[data-tab-drop-sides]')"),
    ).toBe(false);
    for (const type of ["mousePressed", "mouseReleased"])
      await app.cdp("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
    await page.waitFor("events.includes('click')", {
      label: "the shown page took the press",
    });
  } finally {
    page.close();
  }
  expect(app.getRendererErrors()).toEqual([]);
});

it("ends a strip tab's drag when the tab closes before the drop", async () => {
  await app.eval("window.catamorphicDesktop.setPrefs({tabPlacement:'top'})");
  const strip =
    '[data-workspace-visible=true] [data-tab-orientation="horizontal"]';
  const tab = await openPage("Strip");
  const source = `${strip} [data-point-key="${tab}"]`;
  await app.waitFor(`!!document.querySelector(${JSON.stringify(source)})`);
  const finish = await dragAndCloseMidway(
    source,
    `${source} button[aria-label^="Close"]`,
  );
  await finish(
    `document.querySelector(${JSON.stringify(strip)}).hasAttribute('data-tab-dragging')`,
  );
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 400,
    y: 300,
  });
  // Close buttons show again, and the strip's ends move the window.
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(strip)}).hasAttribute('data-tab-dragging') && !document.querySelector('[data-tab-drop-sides]')`,
    { label: "the drag over" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});

// xdotool holds the button through a real drag only on the Linux test
// desktop. A real drag sends the window no pointer events until its drop
// (one pointercancel as it starts), so nothing above ends it early.
it.skipIf(process.platform !== "linux")(
  "keeps the side targets through a real drag, and tiles the tab where it lands",
  async () => {
    await app.eval(
      "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar'})",
    );
    const tiled = await openPage("Tiled");
    const anchor = await openPage("Anchor");
    const row = `aside [data-point-key="${tiled}"]`;
    await app.waitFor(`!!document.querySelector(${JSON.stringify(row)})`);
    const from = await app.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(row)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    const page = await app.eval<{ x: number; y: number; w: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(`[data-surface-key="${anchor}"] webview`)}).getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`,
    );
    const sides = () =>
      app.eval<boolean>("!!document.querySelector('[data-tab-drop-sides]')");
    // OS pointer movement completing does not mean Chromium has delivered
    // its dragover yet. Observe that real event before releasing the button.
    await app.eval(`(() => {
      window.__tabDropHover = null;
      window.__watchTabDropHover = (event) => {
        if (event.isTrusted && event.target.closest?.('[data-tab-drop-sides]'))
          window.__tabDropHover = { x: event.clientX, y: event.clientY, accepted: event.defaultPrevented };
      };
      window.addEventListener('dragover', window.__watchTabDropHover);
      return true;
    })()`);
    await app.movePointer(from);
    execFileSync("xdotool", ["mousedown", "1"]);
    try {
      await app.movePointerThrough(
        Array.from({ length: 12 }, (_, i) => ({
          x: from.x + (i + 1) * 6,
          y: from.y + i + 1,
        })),
      );
      await app.waitFor("!!document.querySelector('[data-tab-drop-sides]')", {
        label: "the drag under way",
      });
      for (const across of [0.2, 0.5, 0.8]) {
        const x = page.x + page.w * across;
        await app.movePointerThrough([
          { x, y: page.y },
          { x: x + 3, y: page.y + 2 },
        ]);
        await app.waitFor(
          `window.__tabDropHover?.accepted && Math.abs(window.__tabDropHover.x - ${x + 3}) <= 1 && Math.abs(window.__tabDropHover.y - ${page.y + 2}) <= 1`,
          { label: `the native drag accepted at ${across}` },
        );
        expect(await sides()).toBe(true);
      }
    } finally {
      execFileSync("xdotool", ["mouseup", "1"]);
      await app.eval(`(() => {
        window.removeEventListener('dragover', window.__watchTabDropHover);
        delete window.__watchTabDropHover;
        delete window.__tabDropHover;
        return true;
      })()`);
    }
    await app.waitFor(
      `!!document.querySelector(${JSON.stringify(`[data-workspace-slot="right"][data-surface-key="${tiled}"]`)}) && !document.querySelector('[data-tab-drop-sides]')`,
      { label: "the tab tiled on the right" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  },
);
