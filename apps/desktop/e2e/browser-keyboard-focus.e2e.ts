import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  setReactValueJs,
} from "./harness.js";
import { pressNativePrimaryKey as nativeKey } from "./native-pointer.js";

let app: AppHandle;
let origin = "";
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/favicon.svg")) {
    response.setHeader("Content-Type", "image/svg+xml");
    response.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${request.url.includes("second") ? "blue" : "red"}"/></svg>`,
    );
    return;
  }
  const second = request.url === "/second";
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>${second ? "Second website" : "Keyboard fixture"}</title><link rel="icon" href="/favicon.svg?${second ? "second" : "first"}"><p>Use the keyboard without clicking here.</p><script>
    window.pageKeys = 0; window.reservedKeys = 0;
    document.addEventListener('keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); window.pageKeys++; }
      if (event.key.toLowerCase() === 'p') window.reservedKeys++;
    });
  </script>`);
});
const guest = `document.querySelector('[data-workspace-visible="true"] webview')`;
const inPage = <T>(code: string) =>
  app.eval<T>(`${guest}.executeJavaScript(${JSON.stringify(code)})`);
const focusedPage = () =>
  app.waitFor(
    `(async () => { const view = ${guest}; try { return view && !view.isLoading() && await view.executeJavaScript('document.hasFocus()'); } catch { return false; } })()`,
    { label: "page has native keyboard focus without a click" },
  );
const paletteInput =
  '[data-workspace-visible="true"] [data-palette="overlay"] textarea';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await focusWindow(app);
}, 180_000);
afterAll(async () => {
  await app?.stop();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it("focuses a page opened from the palette and keeps Work shortcuts first", async () => {
  await nativeKey("p");
  await app.waitFor(
    `document.activeElement === document.querySelector('${paletteInput}')`,
  );
  await app.insertText(origin);
  await app.press("Enter");
  await focusedPage();
  await nativeKey("k");
  await app.waitFor(`${guest}.executeJavaScript('window.pageKeys === 1')`, {
    label: "page shortcut handled immediately",
  });
  await nativeKey("p");
  await app.waitFor(
    `document.activeElement === document.querySelector('${paletteInput}')`,
    { label: "Work reserved shortcut opens the palette" },
  );
  expect(await inPage<number>("window.reservedKeys")).toBe(0);
  // Re-select the already-current page. Its active flag never changes.
  await app.eval(
    `(() => { ${setReactValueJs}; setReactValue(document.querySelector('${paletteInput}'), 'tabs'); })()`,
  );
  await app.press("Space");
  await app.waitFor(
    `document.querySelector('${paletteInput}')?.placeholder === 'Search open tabs…'`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; setReactValue(document.querySelector('${paletteInput}'), 'Keyboard fixture'); })()`,
  );
  await app.waitFor(
    `(() => { const row = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent.includes('Keyboard fixture')); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return true; })()`,
    { label: "current page picked from palette" },
  );
  await focusedPage();
  await nativeKey("k");
  await app.waitFor(`${guest}.executeJavaScript('window.pageKeys === 2')`);
});

it("hands focus back when the person returns using the tab bar", async () => {
  await nativeKey("t");
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] [data-palette="tab"] textarea')`,
  );
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => { const tab = document.querySelector('[data-workspace-visible="true"] [data-point-key^="browser:"] .workspace-tab-label'); const r = tab?.getBoundingClientRect(); if (!r) return false; const x = r.left+r.width/2, y=r.top+r.height/2; const last = window.__browserTabPoint; window.__browserTabPoint = {x,y}; return last?.x === x && last?.y === y && tab.contains(document.elementFromPoint(x,y)) && {x,y}; })()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
  await focusedPage();
  await nativeKey("k");
  await app.waitFor(`${guest}.executeJavaScript('window.pageKeys === 3')`);
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps a renamed browser tab while navigation updates its title and favicon", async () => {
  const tab = '[data-workspace-visible="true"] [data-point-key^="browser:"]';
  const point = await app.eval<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('${tab} .workspace-tab-label').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      clickCount: 1,
    });
  await app.waitFor(
    `!![...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Rename tab…')`,
  );
  await app.eval(
    `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Rename tab…').click()`,
  );
  await app.waitFor(
    `document.querySelector('input[name="name"]')?.value === 'Keyboard fixture'`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; const input = document.querySelector('input[name="name"]'); setReactValue(input, 'Team inbox'); input.form.requestSubmit(); })()`,
  );
  await app.waitFor(
    `document.querySelector('${tab} .workspace-tab-title')?.textContent === 'Team inbox' && !document.querySelector('input[name="name"]')`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; const input = document.querySelector('[data-workspace-visible="true"] [data-address-field] input'); input.focus(); setReactValue(input, ${JSON.stringify(origin)} + '/second'); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`,
  );
  await app.waitFor(
    `(async () => {
    const root = document.querySelector('[data-workspace-visible="true"]');
    const ws = await window.catamorphicDesktop.workspaceStateGet(root.dataset.projectRuntime);
    const browser = ws?.browsers[0];
    return browser?.label === 'Team inbox' && browser.title === 'Second website' && browser.faviconUrl?.includes('favicon.svg?second');
  })()`,
    { label: "custom name persisted while site metadata changed" },
  );
  expect(
    await app.eval(
      `document.querySelector('${tab} .workspace-tab-title').textContent`,
    ),
  ).toBe("Team inbox");
  await app.reload();
  await app.waitFor(
    `document.querySelector('${tab} .workspace-tab-title')?.textContent === 'Team inbox'`,
    { label: "custom tab name restored" },
  );
  await app.screenshot(
    `${process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp"}/browser-tab-name.png`,
  );
});
