import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
let server: http.Server;
const dock =
  "[...document.querySelectorAll('section[aria-label]')].find(el=>!el.closest('[inert]')&&el.querySelector('[data-composer-input]'))";
const composer = `${dock}.querySelector('[data-composer-input]')`;
const box = () =>
  app.eval<{ left: number; right: number; top: number; bottom: number }>(
    `${dock}.getBoundingClientRect().toJSON()`,
  );
const compact = () =>
  app.waitFor(
    `${dock}?.hasAttribute('data-lurking')&&${dock}.getBoundingClientRect().height<220&&${dock}.getAnimations({subtree:true}).every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity)`,
  );
const expanded = () =>
  app.waitFor(
    `!${dock}?.hasAttribute('data-lurking')&&${dock}.getBoundingClientRect().height>400`,
  );
const moveOutside = async () => {
  // Settle hover in the shell before crossing into a native webview. The
  // initial pointer can be parked under a card that moved during opening.
  const shell = await app.eval<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector('[data-sidebar="left"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  await app.movePointer(shell);
  const page = await app.waitFor<{ x: number; y: number }>(
    `(()=>{const view=document.querySelector('webview'),r=view.getBoundingClientRect(),card=${dock}.getBoundingClientRect();const x=(r.left+card.left)/2,y=r.top+r.height/2;return x>r.left&&x<card.left&&document.elementFromPoint(x,y)===view?{x,y}:false})()`,
    { label: "visible page gutter outside the floating chat" },
  );
  await app.movePointer(page);
  return page;
};
const send = async (text: string) => {
  await app.eval(`${composer}.focus()`);
  await app.insertText(text);
  await app.press("Enter");
};
beforeAll(async () => {
  server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<title>Hover backdrop</title><body style='height:2000px'>Local hover fixture</body>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Floating hover',rootPath:${JSON.stringify("/tmp/floating-hover")}})`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-dock-rail] button[aria-label="New chat"]')`,
  );
  const plus = await app.eval<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector('[data-dock-rail] button[aria-label="New chat"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  await app.clickPointer(plus);
  await app.waitFor(`!!${composer}`);
  await focusWindow(app);
  await send(`show: http://127.0.0.1:${address.port}/`);
  await app.waitFor(
    `!!document.querySelector('webview')&&!${dock}.querySelector('[aria-label="Stop the agent"]')`,
  );
  await send("terminal: sleep 90 && echo hover-done");
  await app.waitFor(`!!${dock}.querySelector('[aria-label="Stop the agent"]')`);
  await expanded();
});
afterAll(async () => {
  try {
    expect(app?.getRendererErrors() ?? []).toEqual([]);
  } finally {
    await app?.stop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

it("recovers a missed enter while approaching slowly from above", async () => {
  await app.clickPointer(await moveOutside());
  await compact();
  const bounds = await box();
  await app.movePointer({
    x: (bounds.left + bounds.right) / 2,
    y: bounds.top - 24,
  });
  await app.eval(
    `window.__missedDockEnter=false;window.__dropDockEnter=event=>{const dock=${dock};if(dock?.contains(event.target)){window.__missedDockEnter=true;event.stopImmediatePropagation();window.removeEventListener('mouseover',window.__dropDockEnter,true)}};window.addEventListener('mouseover',window.__dropDockEnter,true)`,
  );
  try {
    for (let y = bounds.top - 12; y <= bounds.top + 16; y += 2) {
      await app.movePointer({ x: (bounds.left + bounds.right) / 2, y });
      await app.eval("new Promise(r=>requestAnimationFrame(()=>r(true)))");
    }
    expect(await app.eval("window.__missedDockEnter")).toBe(true);
    await expanded();
    if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
          "lurk-top-recovered.png",
        ),
      );
  } finally {
    await app.eval(
      "window.removeEventListener('mouseover',window.__dropDockEnter,true)",
    );
  }
});

it("expands on repeated slow top entries across its header and edges", async () => {
  await app.eval("window.catamorphicDesktop.devWindow('setSize',1024,700)");
  for (const fraction of [0.1, 0.5, 0.9, 0.02, 0.98]) {
    await moveOutside();
    await compact();
    const bounds = await box();
    const x = bounds.left + (bounds.right - bounds.left) * fraction;
    await app.movePointer({ x, y: bounds.top - 20 });
    for (let y = bounds.top - 10; y <= bounds.top + 18; y += 2) {
      await app.movePointer({ x, y });
      await app.eval("new Promise(r=>requestAnimationFrame(()=>r(true)))");
    }
    try {
      await expanded();
    } catch (error) {
      throw new Error(
        JSON.stringify(
          await app.eval(
            `(()=>{const r=${dock}.getBoundingClientRect();return {fraction:${fraction},before:${JSON.stringify(bounds)},now:r.toJSON(),hit:document.elementFromPoint(${x},${bounds.top + 18})?.outerHTML.slice(0,500),lurking:${dock}.hasAttribute('data-lurking')}})()`,
          ),
        ),
        { cause: error },
      );
    }
    expect(
      await app.eval(
        `!!${dock}.querySelector('[aria-label="Stop the agent"]')`,
      ),
    ).toBe(true);
  }
  await app.eval(
    `${dock}.querySelector('[aria-label="Stop the agent"]').click()`,
  );
});
