import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
  await createProjectWorkspace({
    app,
    name: "Maximized chat",
    rootPath: `${app.userDataDir}/maximized-chat`,
  });
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
});
afterAll(async () => {
  await app?.stop();
});
async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => {
      const e=document.querySelector(${JSON.stringify(selector)});
      if(!e || e.closest('[inert]') || e.disabled) return false;
      if(document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity)) return false;
      const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(x,y))?{x,y}:false;
    })()`,
    { label: `settled, reachable control: ${selector}` },
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

it("maximizes the floating chat when the chat tab behind it has focus", async () => {
  const backgroundId = await app.waitFor<string>(
    "document.querySelector('[data-chat-tab]:not([inert])')?.dataset.chatLocalId",
  );
  const primary = await app.eval<number>(
    "/Mac/.test(navigator.platform) ? 4 : 2",
  );
  // The previous case leaves the rail collapsed; the shortcut opens a
  // floating chat independently of the rail's presentation.
  await app.press("n", primary);
  const floatingId = await app.waitFor<string>(
    "document.querySelector('[data-floating-chat]:not([inert])')?.dataset.chatLocalId",
  );
  await click("[data-floating-chat]:not([inert]) [data-composer-input]");
  await app.insertText("A floating draft survives background focus");
  await click(
    `[data-tab-orientation] [data-point-key="chat:${backgroundId}"] .workspace-tab-label`,
  );
  await app.waitFor(
    `document.querySelectorAll('[data-floating-chat]:not([inert])').length === 1 &&
      document.querySelector('[data-chat-local-id="${backgroundId}"]')?.hasAttribute('data-chat-tab') &&
      !document.activeElement?.closest('[data-floating-chat]')`,
    { label: "one floating chat with the background tab focused" },
  );
  await app.press("m", primary | 8);
  await app.waitFor(
    `document.querySelector('[data-chat-local-id="${floatingId}"]')?.hasAttribute('data-chat-tab') &&
      !document.querySelector('[data-floating-chat]:not([inert])') &&
      !document.querySelector('[data-chat-bubble="${floatingId}"]')`,
    { label: "the floating chat expanded into its own tab" },
  );
  expect(
    await app.eval(
      `document.querySelector('[data-chat-local-id="${floatingId}"] [data-composer-input]')?.textContent`,
    ),
  ).toBe("A floating draft survives background focus");
  // Tab chats are outside Cmd+M's floating-chat cycle.
  await app.press("m", primary);
  await app.eval(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
  );
  expect(
    await app.eval(
      `document.querySelector('[data-chat-local-id="${floatingId}"]')?.hasAttribute('data-chat-tab') && !document.querySelector('[data-chat-bubble="${floatingId}"]')`,
    ),
  ).toBe(true);
  await app.press("m", primary | 8);
  await app.waitFor(
    `!!document.querySelector('[data-chat-local-id="${floatingId}"][data-floating-chat]:not([inert])') &&
      !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)`,
    { label: "the tab explicitly returned to a floating chat" },
  );
  await app.press("m", primary);
  // Inert starts with the exit tween, before the entry commits to min.
  // Its bubble only returns after that commit; let the motions settle too.
  await app.waitFor(
    `document.querySelector('[data-chat-local-id="${floatingId}"]')?.inert &&
      !!document.querySelector('[data-chat-bubble="${floatingId}"]') &&
      !document.getAnimations().some(animation =>
        animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)`,
    { label: "the maximized chat committed to minimized and motions settled" },
  );
  await app.press("m", primary);
  await app.waitFor(
    `document.querySelector('[data-chat-local-id="${floatingId}"]')?.hasAttribute('data-floating-chat') &&
      !document.querySelector('[data-chat-local-id="${floatingId}"]')?.inert`,
    { label: "the same chat restored as floating" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
