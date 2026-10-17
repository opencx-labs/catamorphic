import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, type FrameHandle, launchApp } from "./harness.js";

// The pill in its own window, docked at any edge of the screen (ADR 0242).
let app: AppHandle;
let dock: FrameHandle | undefined;
let overlay: FrameHandle | undefined;
beforeAll(async () => {
  app = await launchApp();
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Pill", rootPath: path.join(app.userDataDir, "pill") })})`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(project.id)}})`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-chat-region]')`,
  );
});
afterAll(async () => {
  overlay?.close();
  dock?.close();
  await app?.stop();
});

type Edge = "bottom" | "left" | "right" | "top";
const pill = () => {
  if (!dock) throw new Error("the pill is not in its own window");
  return dock;
};
/** True when the pill's window rests where `edge` puts it on its screen. */
const restsAt = (edge: Edge) => {
  const where = {
    bottom:
      "Math.abs(screenY + outerHeight + 12 - (screen.availTop + screen.availHeight)) < 3",
    left: "Math.abs(screenX - screen.availLeft) < 2 && Math.abs(screenY + outerHeight / 2 - (screen.availTop + screen.availHeight / 2)) < 2",
    right:
      "Math.abs(screenX + outerWidth - (screen.availLeft + screen.availWidth)) < 2 && Math.abs(screenY + outerHeight / 2 - (screen.availTop + screen.availHeight / 2)) < 2",
    top: "Math.abs(screenY - screen.availTop) < 2 && Math.abs(screenX + outerWidth / 2 - (screen.availLeft + screen.availWidth / 2)) < 2",
  }[edge];
  return `document.querySelector('[data-dock-host]')?.dataset.dockEdge === '${edge}' && ${where}`;
};
const prefs = () =>
  app.eval<{ dockDetached: boolean; dockEdge: Edge }>(
    "window.catamorphicDesktop.getPrefs()",
  );
/** A drag on the pill as its own renderer sends it, in screen points. */
const drag = (steps: string) =>
  pill().eval(`(async () => {
    const api = window.catamorphicDesktop;
    const at = (x, y) => ({ screenX: x, screenY: y, reducedMotion: true });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const area = { x: screen.availLeft, y: screen.availTop, w: screen.availWidth, h: screen.availHeight };
    const from = { x: screenX + outerWidth / 2, y: screenY + outerHeight / 2 };
    ${steps}
  })()`);

it("docks at every edge of the screen, a column on either side", async () => {
  await app.eval(
    "window.catamorphicDesktop.setPrefs({dockDetached:true,dockFollowsWindow:false,dockEdge:'bottom'})",
  );
  dock = await app.connectToFrame("surface=dock");
  for (const edge of ["bottom", "left", "right", "top", "bottom"] as const) {
    await app.eval(
      `window.catamorphicDesktop.setPrefs({dockEdge:${JSON.stringify(edge)}})`,
    );
    await pill().waitFor(restsAt(edge), { label: `pill at the ${edge}` });
    const rail = await pill().eval<{
      column: boolean;
      inside: boolean;
    }>(
      `(() => { const rail = document.querySelector('[data-dock-rail]'); const r = rail.getBoundingClientRect(); return { column: getComputedStyle(rail).flexDirection === 'column', inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`,
    );
    expect(rail).toEqual({
      column: edge === "left" || edge === "right",
      inside: true,
    });
  }
});

it("opens a chat away from the edge it rests on", async () => {
  await pill().eval(
    `document.querySelector('[data-dock-rail] [aria-label="New chat"]').click()`,
  );
  await pill().waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert])')`,
    { label: "chat open from the pill" },
  );
  // The card sits beside the pill, past its middle on the side away from
  // the screen edge (at the bottom it tucks over the pill's top edge).
  const away = {
    bottom: "chat.bottom < (rail.top + rail.bottom) / 2",
    left: "chat.left > (rail.left + rail.right) / 2",
    right: "chat.right < (rail.left + rail.right) / 2",
    top: "chat.top > (rail.top + rail.bottom) / 2",
  };
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    await app.eval(
      `window.catamorphicDesktop.setPrefs({dockEdge:${JSON.stringify(edge)}})`,
    );
    await pill().waitFor(
      `(() => { if (document.querySelector('[data-dock-host]')?.dataset.dockEdge !== '${edge}') return false; const card = document.querySelector('[data-floating-chat]:not([inert])'); if (!card || card.getAnimations({ subtree: true }).some((a) => a.playState === 'running')) return false; const chat = card.getBoundingClientRect(); const rail = document.querySelector('[data-dock-rail]').getBoundingClientRect(); return ${away[edge]} && chat.left >= 0 && chat.top >= 0 && chat.right <= innerWidth && chat.bottom <= innerHeight; })()`,
      { label: `chat away from the ${edge}` },
    );
  }
  await pill().eval(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true }))`,
  );
  await pill().waitFor(
    `!document.querySelector('[data-floating-chat]:not([inert])') && innerHeight < 300`,
    { label: "chat minimized to the pill" },
  );
});

it("shows where it can land while held, and lands on the nearest edge", async () => {
  // A press without a move is a click: the spots never stay on screen,
  // even on the first press, while the overlay's page is still loading.
  await drag(`
    await api.dockDrag({ phase: "start", ...at(from.x, from.y) });
    await api.dockDrag({ phase: "cancel", ...at(from.x, from.y) });
  `);
  overlay = await app.connectToFrame("data:text/html");
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(
    await overlay.eval<boolean>(`!document.querySelector('#targets.shown')`),
  ).toBe(true);
  await drag(`
    await api.dockDrag({ phase: "start", ...at(from.x, from.y) });
    await api.dockDrag({ phase: "move", ...at(area.x + 40, area.y + area.h / 2) });
  `);
  await overlay.waitFor(
    `document.visibilityState === 'visible' && !!document.querySelector('#targets.shown') && document.querySelectorAll('.target').length === 6 && document.querySelector('.target.lit')?.dataset.key === 'left'`,
    { label: "landing spots shown, the left one lit" },
  );
  await drag(`
    await wait(200);
    await api.dockDrag({ phase: "end", ...at(area.x + 40, area.y + area.h / 2) });
  `);
  await pill().waitFor(restsAt("left"), { label: "dropped on the left" });
  await overlay.waitFor(`!document.querySelector('#targets.shown')`, {
    label: "spots gone after the drop",
  });
  expect((await prefs()).dockEdge).toBe("left");
});

it("carries a throw toward where it was going", async () => {
  // Let go at rest 40% down the screen: the top is nearest.
  await drag(`
    const x = area.x + area.w / 2, y = area.y + area.h * 0.4;
    await api.dockDrag({ phase: "start", ...at(from.x, from.y) });
    await api.dockDrag({ phase: "move", ...at(x, y) });
    await wait(200);
    await api.dockDrag({ phase: "move", ...at(x, y + 60) });
    await wait(200);
    await api.dockDrag({ phase: "end", ...at(x, y + 60) });
  `);
  await pill().waitFor(restsAt("top"), { label: "set down: the top" });
  // The same spot, flicked downward: it carries on to the bottom.
  await drag(`
    const x = area.x + area.w / 2, y = area.y + area.h * 0.4;
    await api.dockDrag({ phase: "start", ...at(from.x, from.y) });
    await api.dockDrag({ phase: "move", ...at(x, y) });
    await wait(200);
    await api.dockDrag({ phase: "move", ...at(x, y) });
    await wait(30);
    await api.dockDrag({ phase: "move", ...at(x, y + 60) });
    await api.dockDrag({ phase: "end", ...at(x, y + 60) });
  `);
  await pill().waitFor(restsAt("bottom"), { label: "thrown: the bottom" });
});

it("moves to the spot an arrow key points at", async () => {
  await app.eval("window.catamorphicDesktop.setPrefs({dockEdge:'left'})");
  await pill().waitFor(restsAt("left"));
  const move = (direction: string) =>
    pill().eval<boolean>(
      `window.catamorphicDesktop.dockMove(${JSON.stringify(direction)})`,
    );
  expect(await move("left")).toBe(false);
  expect(await move("right")).toBe(true);
  await pill().waitFor(restsAt("right"), { label: "arrow right" });
  expect(await move("up")).toBe(true);
  await pill().waitFor(restsAt("top"), { label: "arrow up" });
  // From the keyboard, on the folded pill's bubble. Open, the pill has no
  // arrows and no handle of its own: its body is what moves it.
  expect(
    await pill().eval<number>(
      "document.querySelectorAll('[data-dock-arrows]').length",
    ),
  ).toBe(0);
  await app.eval("window.catamorphicDesktop.setPrefs({dockCollapsed:true})");
  await pill().waitFor(
    `document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
  );
  await pill().eval(
    `document.querySelector('[aria-label="Expand chat bubbles"]').focus()`,
  );
  await pill().eval(
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`,
  );
  await pill().waitFor(restsAt("bottom"), { label: "ArrowDown key" });
});

it("stays on the desktop while Work is minimized", async () => {
  // A Work window shorter than the screen, in front: the pill rests in
  // its chat region, well above the bottom of the screen.
  await app.eval("window.catamorphicDesktop.devWindow('setSize', 900, 560)");
  await app.eval("window.catamorphicDesktop.devWindow('focus')");
  await app.eval(
    "window.catamorphicDesktop.setPrefs({dockEdge:'bottom',dockFollowsWindow:true})",
  );
  const region = await app.eval<{ bottom: number }>(
    `(() => { const r = document.querySelector('[data-workspace-visible="true"] [data-workspace-chat-region]').getBoundingClientRect(); return { bottom: screenY + (outerHeight - innerHeight) + r.bottom }; })()`,
  );
  await pill().waitFor(
    `Math.abs(screenY + outerHeight + 12 - ${region.bottom}) < 3 && screenY + outerHeight + 12 < screen.availTop + screen.availHeight - 100`,
    { label: "pill in Work's chat region" },
  );
  await app.eval("window.catamorphicDesktop.devWindow('minimize')");
  await pill().waitFor(
    `window.catamorphicDesktop.devWindow('get').then((state) => state.visible && ${restsAt("bottom")})`,
    { label: "pill at the screen's bottom with Work minimized" },
  );
  expect(
    await pill().eval<boolean>(
      "window.catamorphicDesktop.devWindow('get').then((state) => state.visible)",
    ),
  ).toBe(true);
  await app.eval("window.catamorphicDesktop.devWindow('restore')");
  await app.eval("window.catamorphicDesktop.devWindow('focus')");
});

it("is placed from Settings on a miniature screen", async () => {
  await app.eval(`document.querySelector('[aria-label="Settings"]').click()`);
  await app.waitFor(
    `document.querySelectorAll('[data-pill-spot]').length === 5`,
    {
      label: "Pill settings",
    },
  );
  const pick = async (spot: string) => {
    await app.eval(
      `document.querySelector('[data-pill-spot="${spot}"] input').click()`,
    );
    // The hidden radio keeps focus inside the settings scroller.
    expect(
      await app.eval<number>(
        "document.querySelector('main.workspace-surface')?.scrollTop ?? 0",
      ),
    ).toBe(0);
  };
  await pick("left");
  await app.waitFor(
    `window.catamorphicDesktop.getPrefs().then((prefs) => prefs.dockDetached && prefs.dockEdge === 'left')`,
  );
  await pill().waitFor(restsAt("left"), { label: "picked: left" });
  await pick("window");
  await app.waitFor(
    `window.catamorphicDesktop.getPrefs().then((prefs) => !prefs.dockDetached && !!document.querySelector('[data-dock-host]:not([data-dock-native])'))`,
    { label: "picked: back in Work" },
  );
  await pick("right");
  dock?.close();
  dock = await app.connectToFrame("surface=dock");
  await pill().waitFor(restsAt("right"), { label: "picked: right" });
});
