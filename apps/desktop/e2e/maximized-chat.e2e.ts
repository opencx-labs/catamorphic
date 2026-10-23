import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Maximized chat',rootPath:${JSON.stringify(`${app.userDataDir}/maximized-chat`)}})`,
  );
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
});
afterAll(async () => {
  await app?.stop();
});
async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:false})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}
it("keeps a maximized chat in its normal tab when the dock collapses", async () => {
  await click('[data-dock-rail] button[aria-label="New chat"]');
  await app.waitFor(
    "!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')",
  );
  await app.waitFor(
    "!document.querySelector('[data-floating-chat]:not([inert])').getAnimations().some(a => a.playState === 'running')",
    { label: "the floating chat's entrance to finish" },
  );
  await click("[data-floating-chat]:not([inert]) [data-composer-input]");
  await app.insertText("A draft that stays in the tab");
  await click(
    '[data-floating-chat]:not([inert]) button[aria-label="Open as tab"]',
  );
  const id = await app.waitFor<string>(
    "document.querySelector('[data-chat-tab]:not([inert])')?.dataset.chatLocalId",
  );
  await app.waitFor(`!document.querySelector('[data-chat-bubble="${id}"]')`);
  for (let i = 0; i < 2; i++) {
    await click('button[aria-label="Expand chat bubbles"]');
    await click('button[aria-label="Collapse chat bubbles"]');
    await app.waitFor(
      "!!document.querySelector('button[aria-label=\"Expand chat bubbles\"]')",
    );
    expect(
      await app.eval(
        `(() => {const tab=document.querySelector('[data-chat-local-id="${id}"]');return {tab:tab.hasAttribute('data-chat-tab'),inert:tab.inert,draft:tab.querySelector('[data-composer-input]').textContent}})()`,
      ),
    ).toEqual({
      tab: true,
      inert: false,
      draft: "A draft that stays in the tab",
    });
  }
  expect(app.getRendererErrors()).toEqual([]);
});
