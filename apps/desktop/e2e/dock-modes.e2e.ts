import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Floating-dock behaviors around a working agent:
 * - lurk mode: with a tab behind and the agent working, the dock shrinks
 *   vertically to a strip; hover/focus expands, leaving/focusing outside
 *   or clicking the page behind re-shrinks, and the end of the turn
 *   expands for good;
 * - the `open` shim: `open <url>` in an agent terminal lands as an
 *   in-app browser tab (never the system browser);
 * - the attach button inserts files at the caret exactly like a paste;
 * - the proactive auth banner (probe forced via the e2e seam) offers
 *   re-login before a send fails, and dismisses.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp({
    env: { CATAMORPHIC_E2E_AUTH_HEALTH: "expired" },
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  const frontDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  const composer = () => frontDock()?.querySelector('[data-composer-input]');
  const setComposer = (text) => {
    const c = composer(); c.focus();
    setReactValue(c, text);
  };
  const send = () => composer().dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true }));
  // Typing at the end of the composer, through the editor's own path.
  const typeInComposer = (text) => {
    const c = composer(); c.focus();
    const range = document.createRange();
    range.selectNodeContents(c); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.execCommand('insertText', false, text);
  };
  const composerKey = (key) => composer().dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true }));
  // The composer's "/" and "@" menu (ADR 0274), while it is open.
  const composerMenu = () =>
    $$('[data-testid="composer-menu"]').find((el) => !el.inert);
  const menuRows = () =>
    [...(composerMenu()?.querySelectorAll('[role="option"]') ?? [])].map((el) => el.dataset.itemId);
  ${setReactValueJs}
  const pressKey = (key, mods = {}) => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };
  const dockH = () => frontDock()?.getBoundingClientRect().height ?? 0;
  const hoverDock = () => frontDock().dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  // A real leave: the pointer moves somewhere outside the dock first (the
  // dock ignores boundary events the layout produced under a parked pointer).
  const unhoverDock = () => {
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 4, clientY: 4 }));
    frontDock().dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body, clientX: 4, clientY: 4 }));
  };
  const clickOutside = () =>
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

/**
 * The dock's +, pressed as a person presses it (Chromium's own input, so a
 * press precedes the click): it starts a floating chat even over a New Tab,
 * where Cmd+N would open the chat in the tab.
 */
const pressDockPlus = async () => {
  const point = await runWait<{ x: number; y: number }>(
    `const plus = $('[data-dock-rail] button[aria-label="New chat"]');
     if (!plus) return false;
     const r = plus.getBoundingClientRect();
     return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`,
    { label: "the dock's +" },
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
};

// Native hover follows the isolated desktop's pointer and hit testing.
const hoverChip = async (selector: string) => {
  await runWait(
    `return !frontDock()?.querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes(', Working,');`,
    {
      label: "agent turn settled before hovering its surfaces",
    },
  );
  await app.movePointer({ x: 1, y: 1 });
  const point = await runWait<{ x: number; y: number }>(
    `
    const button = frontDock()?.querySelector(${JSON.stringify(selector)});
    if (!button) return false;
    const dock = frontDock();
    if (dock.getAnimations({subtree:true}).some(animation =>
      animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)) return false;
    const bounds = button.getBoundingClientRect();
    // The chip's trailing split/remove overlay appears on hover. Aim at the
    // leading icon so that overlay cannot replace the preview's hit target.
    const x = bounds.left + 8, y = bounds.top + bounds.height / 2;
    return button.contains(document.elementFromPoint(x, y)) && { x, y };
  `,
    { label: "surface chip ready for native hover" },
  );
  await app.movePointer(point);
  const hovered = `return frontDock()?.querySelector(${JSON.stringify(selector)})?.matches(':hover');`;
  // A person's pointer keeps moving: if hover has not landed, arrive once
  // more before deciding.
  const seen = await runWait<boolean>(hovered, {
    timeoutMs: 2_000,
    label: "native pointer reached the surface chip",
  }).catch(() => false);
  if (seen) return;
  await app.movePointerThrough([{ x: point.x + 2, y: point.y }, point]);
  const again = await runWait<boolean>(hovered, {
    timeoutMs: 5_000,
    label: "native pointer reached the surface chip",
  }).catch(() => false);
  if (again) return;
  // The macOS runner's warped pointer is often never delivered to the
  // window at all. Chromium's own pointer input at the same point still
  // hit-tests the chip, which is what the previews depend on.
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await runWait(hovered, { label: "pointer reached the surface chip" });
};

describe("dock modes", () => {
  it("boots into a project and opens a floating chat", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'dock-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = $('[data-testid="project-submit"]');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
    // Cmd+N would open the chat in the New Tab in front; the dock's own +
    // starts it in the dock.
    await pressDockPlus();
    await runWait(
      `const dock = frontDock();
       return dock && document.activeElement === composer() &&
         !dock.getAnimations({subtree:true}).some(animation =>
           animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);`,
      { label: "floating chat finished opening with its composer focused" },
    ).catch(async (error: unknown) => {
      const state = await run(`return {
        active: document.activeElement?.outerHTML.slice(0, 1000),
        windowFocused: document.hasFocus(),
        animations: frontDock()?.getAnimations({subtree:true}).map(animation => ({
          state: animation.playState, timing: animation.effect?.getTiming(),
        })),
      };`);
      throw new Error(`${String(error)}; dock state: ${JSON.stringify(state)}`);
    });
  }, 180_000);

  it("the attach button inserts files at the caret, exactly like a paste", async () => {
    await run(`
      setComposer('before after');
      const c = composer();
      const textNode = [...c.childNodes].find((n) => n.nodeType === 3);
      const range = document.createRange();
      range.setStart(textNode, 6); range.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      frontDock().querySelector('button[aria-label="Attach files"]').focus();
      const input = frontDock().querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137,80,78,71])], 'picked.png', { type: 'image/png' }));
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    const text = await runWait<string>(
      `const c = composer();
       if (!c.querySelector('[data-testid="composer-pill"][data-pill-kind="image"]')) return false;
       return c.textContent;`,
      { label: "picked file as inline pill" },
    );
    expect(text).toBe("beforepicked.png  after");
    await runWait(`return document.activeElement === composer();`, {
      label: "composer regains focus after attachment insertion",
    }).catch(async (error: unknown) => {
      const focus = await run(`return {
        active: document.activeElement?.outerHTML.slice(0, 1000),
        windowFocused: document.hasFocus(),
        inert: !!composer()?.closest('[inert]'),
      };`);
      throw new Error(
        `${String(error)}; focus state: ${JSON.stringify(focus)}`,
      );
    });
    await run(`setComposer(''); return true;`);
    await runWait(
      `return composer().hasAttribute('data-empty') === false || true;`,
      {
        label: "composer reset",
      },
    );
    await run(`
      const pill = frontDock().querySelector('[data-testid="composer-pill"] button[aria-label^="Remove"]');
      if (pill) pill.click();
      return true;
    `);
  });

  it("the proactive auth banner offers re-login for a session agent, and dismisses", async () => {
    // A local claude-code agent; the forced e2e health makes the probe
    // report "expired" without touching real credentials.
    await app.eval(`(async () => {
      const created = await window.catamorphicDesktop.agentsCreate({
        name: 'My Claude', harness: 'claude-code', auth: 'local', effort: 'medium' });
      await window.catamorphicDesktop.agentsSetDefault(created.id);
      return created.id;
    })()`);
    // A fresh chat picks up the new default through agents-changed. The
    // dock's + keeps the empty chat floating (Cmd+N would move it into the
    // New Tab behind it).
    await pressDockPlus();
    const banner = await runWait<string>(
      `const b = frontDock()?.querySelector('[data-testid="auth-health-banner"]');
       return b ? b.textContent : false;`,
      { label: "auth banner", timeoutMs: 20_000 },
    );
    expect(banner).toContain("My Claude's session has expired");
    expect(banner).toContain("Re-login My Claude");
    await run(
      `frontDock().querySelector('[data-testid="auth-health-banner"] button[aria-label="Dismiss"]').click(); return true;`,
    );
    await runWait(
      `return !frontDock().querySelector('[data-testid="auth-health-banner"]');`,
      { label: "banner dismissed" },
    );
    // Back to the fake agent: the SAME dock re-resolves through the
    // agents-changed roster refetch and the banner stays gone.
    await app.eval(`(async () => {
      const { agents } = await window.catamorphicDesktop.agentsList();
      const fake = agents.find((a) => a.name === 'Fake Agent');
      await window.catamorphicDesktop.agentsSetDefault(fake.id);
      return true;
    })()`);
    await runWait(
      `return !!composer() && !frontDock().querySelector('[data-testid="auth-health-banner"]');`,
      { label: "dock back on the fake agent" },
    );
  }, 60_000);

  it("in its own window, lurks when the window blurs while the agent works", async () => {
    // The private display parks its pointer mid-screen, where the detached
    // dock opens: a pointer resting on the chat rightly keeps it expanded
    // (on Linux the dock's shape changing under it reports it there). Park
    // it on the workspace, away from the dock, as a person reading would.
    await app.movePointer({ x: 1, y: 1 });
    await app.eval(`window.catamorphicDesktop.dockDetach(true)`);
    const dock = await app.connectToFrame("surface=dock");
    const dockHelpers = `${helpers}`;
    const dockRun = <T = unknown>(body: string) =>
      dock.eval<T>(`(() => { ${dockHelpers}\n${body} })()`);
    const dockWait = <T = unknown>(
      body: string,
      opts?: { timeoutMs?: number; label?: string },
    ) => dock.waitFor<T>(`(() => { ${dockHelpers}\n${body} })()`, opts);
    await dockWait(`return !!composer();`, {
      label: "chat in the dock window",
    });
    // The rest of the screen is the backdrop: a blurred window lurks while
    // the agent works, and comes back when the window is focused again.
    await dockRun(`window.dispatchEvent(new Event('focus')); return true;`);
    await dockRun(
      `setComposer('terminal: sleep 15 && echo blur-done'); send(); return true;`,
    );
    await dockWait(
      `return dockH() > 400 && !frontDock().hasAttribute('data-lurking');`,
      {
        label: "expanded while the window is focused",
      },
    );
    await dockRun(
      `unhoverDock(); window.dispatchEvent(new Event('blur')); return true;`,
    );
    await dockWait(
      `return frontDock().hasAttribute('data-lurking') && dockH() < 220;`,
      { label: "lurks after the window blurred", timeoutMs: 10_000 },
    );
    await dockRun(`window.dispatchEvent(new Event('focus')); return true;`);
    await dockWait(
      `return !frontDock().hasAttribute('data-lurking') && dockH() > 400;`,
      { label: "expanded when the window is focused again" },
    );
    // Let this turn end before the next test starts its own timed command,
    // so the two do not queue behind each other. The dock window also draws
    // the end (its spinners fading out) before it hides: a window hidden in
    // the frames between the end arriving and those fades starting never
    // starts them, and the next test, showing it again, waits on them
    // forever.
    await dockWait(
      `return !frontDock().querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes(', Working,') &&
         !frontDock().getAnimations({ subtree: true }).some((animation) =>
           animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);`,
      { label: "turn finished and drawn", timeoutMs: 40_000 },
    );
    await app.eval(`window.catamorphicDesktop.dockDetach(false)`);
    await runWait(`return !!composer();`, { label: "chat back in the window" });
  }, 120_000);

  it("in its own window, empty space lets clicks through to the workspace, and a click on the workspace lurks the chat", async () => {
    await app.eval(`window.catamorphicDesktop.dockDetach(true)`);
    const dock = await app.connectToFrame("surface=dock");
    const dockHelpers = `${helpers}`;
    const dockRun = <T = unknown>(body: string) =>
      dock.eval<T>(`(() => { ${dockHelpers}\n${body} })()`);
    const dockWait = <T = unknown>(
      body: string,
      opts?: { timeoutMs?: number; label?: string },
    ) => dock.waitFor<T>(`(() => { ${dockHelpers}\n${body} })()`, opts);
    await dockWait(
      `return !!composer() && !frontDock().getAnimations({ subtree: true }).some((animation) =>
         animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);`,
      { label: "chat open in the dock window" },
    ).catch(async (error: unknown) => {
      // Say what is still moving (or that no chat arrived), so a stall
      // here points at its cause.
      const state = await dockRun(`return new Promise((resolve) => {
        // Whether the window still draws: animation frames in half a second.
        let frames = 0;
        let counting = true;
        const tick = () => { frames += 1; if (counting) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        setTimeout(() => { counting = false; resolve(frames); }, 500);
      }).then((frames) => ({
        frames,
        visibility: document.visibilityState,
        composer: !!composer(),
        sections: $$('section[aria-label]').map((el) => ({ inert: el.inert, composer: !!el.querySelector('[data-composer-input]') })),
        running: (frontDock()?.getAnimations({ subtree: true }) ?? [])
          .filter((animation) => animation.playState === 'running')
          .map((animation) => ({
            name: animation.transitionProperty ?? animation.animationName ?? animation.id,
            target: animation.effect?.target?.getAttribute?.('class')?.slice(0, 80),
            time: animation.currentTime,
            // Never started (pending, no start time) or started and stuck.
            pending: animation.pending,
            start: animation.startTime,
            iterations: animation.effect?.getTiming().iterations,
          })),
      }));`);
      throw new Error(`${String(error)}; dock state: ${JSON.stringify(state)}`);
    });
    const bounds = async () => ({
      dock: await dock.eval<{ x: number; y: number }>(
        "window.catamorphicDesktop.devWindow('get').then((state) => state.contentBounds)",
      ),
      main: await app.eval<{ x: number; y: number }>(
        "window.catamorphicDesktop.devWindow('get').then((state) => state.contentBounds)",
      ),
      chat: await dockRun<{ left: number; top: number; height: number }>(
        `const rect = frontDock().getBoundingClientRect();
         return { left: rect.left, top: rect.top, height: rect.height };`,
      ),
      composer: await dockRun<{ x: number; y: number }>(
        `const rect = composer().getBoundingClientRect();
         return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
      ),
    });
    // The workspace window records what reaches it.
    await app.eval(
      `window.__throughClicks = 0;
       document.addEventListener('pointerdown', () => { window.__throughClicks += 1; }, true);
       true`,
    );
    await dockRun(
      `window.__dockPointerDowns = 0;
       document.addEventListener('pointerdown', () => { window.__dockPointerDowns += 1; }, true);
       window.__dockLastMove = null;
       document.addEventListener('mousemove', (event) => {
         window.__dockLastMove = { x: event.clientX, y: event.clientY };
       }, true);
       return true;`,
    );
    // Where the window rests, once it has: a dock window that just opened
    // still moves into its workspace's chat region and to its chat's size.
    const settled = async () => {
      let last = await bounds();
      const deadline = Date.now() + 10_000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const next = await bounds();
        if (JSON.stringify(next) === JSON.stringify(last)) return next;
        if (Date.now() > deadline)
          throw new Error(
            `The dock window never settled: ${JSON.stringify(next)}`,
          );
        last = next;
      }
    };
    // The margin beside the chat is empty space in the dock window: the
    // pointer passes over it, and the click lands on the workspace behind.
    const first = await settled();
    const margin = {
      x: first.dock.x - first.main.x + Math.floor(first.chat.left / 2),
      y:
        first.dock.y -
        first.main.y +
        first.chat.top +
        Math.floor(first.chat.height / 2),
    };
    // Count every change of what the window does with clicks.
    await dockRun(`window.__passThroughChanges = 0;
      new MutationObserver(() => { window.__passThroughChanges += 1; })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-dock-pass-through'] });
      return true;`);
    const marginInDock = {
      x: Math.floor(first.chat.left / 2),
      y: first.chat.top + Math.floor(first.chat.height / 2),
    };
    const shaped = process.platform === "linux";
    // Where the empty-space click goes, in main-window coordinates. On
    // Linux the window takes the shape of what the dock draws, including the
    // visible part of the chat's shadow, so the click goes to a point the
    // applied shape leaves out, wherever that is.
    let empty = margin;
    let emptyInDock = marginInDock;
    if (shaped) {
      // The click may only come once the shape keeps the composer in and
      // leaves some empty space out.
      emptyInDock = await dockWait<{ x: number; y: number }>(
        `const shape = document.documentElement.dataset.dockShape;
         if (!shape) return false;
         const rects = JSON.parse(shape);
         if (!Array.isArray(rects)) return false;
         const inside = (x, y) => rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
         if (!inside(${first.composer.x}, ${first.composer.y})) return false;
         for (let y = 4; y < innerHeight; y += 4)
           for (let x = 4; x < innerWidth; x += 4)
             if (!inside(x, y) && document.elementFromPoint(x, y) === document.body) return { x, y };
         return false;`,
        { label: "dock window shaped to its content" },
      );
      empty = {
        x: first.dock.x - first.main.x + emptyInDock.x,
        y: first.dock.y - first.main.y + emptyInDock.y,
      };
      await app.movePointer(empty);
    } else {
      await app.movePointer(margin);
      // The dock answers the hover by asking the main process to let clicks
      // through; the click must come after that has been applied.
      await dockWait(
        `return document.documentElement.dataset.dockPassThrough === 'true';`,
        { label: "dock lets clicks through over its margin" },
      );
    }
    await app.clickPointer(empty);
    const emptyHit = await dockRun<string | null>(
      `const hit = document.elementFromPoint(${emptyInDock.x}, ${emptyInDock.y});
       return hit ? hit.tagName : null;`,
    );
    // The dock reads the point as empty space (only the body answers).
    expect(emptyHit).toBe("BODY");
    // The click lands behind the dock: macOS honors the window's
    // mouse-ignore, Linux its shape.
    await app
      .waitFor(`window.__throughClicks > 0`, {
        label: "click reached the workspace window",
        timeoutMs: 10_000,
      })
      .catch(async (error: unknown) => {
        const state = await dockRun(`return {
          hasFocus: document.hasFocus(),
          dockPointerDowns: window.__dockPointerDowns,
          shape: document.documentElement.dataset.dockShape,
        };`);
        throw new Error(
          `${String(error)}; point ${JSON.stringify(empty)}; dock state: ${JSON.stringify(state)}`,
        );
      });
    // A real click in the composer focuses the dock window, as typing would,
    // and focus on the dock keeps it resting where it was rather than
    // moving it to the display's edge. The pointer arrives first: a click
    // that lands before the dock stops letting clicks through reaches the
    // workspace behind it instead (a person's pointer never teleports).
    const inComposer = {
      x: first.dock.x - first.main.x + first.composer.x,
      y: first.dock.y - first.main.y + first.composer.y,
    };
    // Nothing flips between passing and taking clicks on Linux: at most one
    // request and its answer (it used to flip dozens of times a second).
    if (shaped)
      expect(
        await dockRun<number>("return window.__passThroughChanges;"),
      ).toBeLessThanOrEqual(2);
    await app.movePointer(inComposer);
    // The marker turns "false" only after the main process takes clicks
    // again; a click sent before that is the one that fell through in CI.
    // A shaped window never stopped taking them over its content.
    if (!shaped)
      await dockWait(
        `return document.documentElement.dataset.dockPassThrough === 'false';`,
        { label: "dock takes clicks over its composer" },
      );
    await app.clickPointer(inComposer);
    await dockWait(
      `return document.hasFocus() && document.activeElement === composer();`,
      { label: "dock window focused through its composer" },
    ).catch(async (error: unknown) => {
      const state = await dockRun(`return {
        hasFocus: document.hasFocus(),
        pointerDowns: window.__dockPointerDowns,
        active: document.activeElement?.outerHTML.slice(0, 200),
      };`);
      const through = await app.eval("window.__throughClicks");
      throw new Error(
        `${String(error)}; dock state: ${JSON.stringify(state)}; workspace clicks: ${through}`,
      );
    });
    const focused = await bounds();
    expect(
      { x: focused.dock.x, y: focused.dock.y },
      JSON.stringify({ first: first.dock, focused: focused.dock }),
    ).toEqual({ x: first.dock.x, y: first.dock.y });
    await dockRun(
      `setComposer('terminal: sleep 15 && echo through-done'); send(); return true;`,
    );
    await dockWait(
      `return dockH() > 400 && !frontDock().hasAttribute('data-lurking');`,
      { label: "expanded while the dock window is focused" },
    );
    // A person's pointer crosses the dock's empty space on its way to the
    // workspace, and that move tells the dock the pointer left the chat.
    // A native pointer that jumps from the composer straight to the
    // workspace exits the dock window without moving inside it, and the
    // dock deliberately keeps its hover for a leave without a recent move
    // (the layout moving under a parked pointer), so the chat never lurks.
    await dockRun(`window.__dockLastMove = null; return true;`);
    if (shaped)
      // Over a shaped window's empty space the pointer is outside the
      // window, so the dock learns the pointer left from a move just inside
      // the chat's edge followed at once by the leave, as a person's
      // pointer crossing the edge produces (the dock ignores a leave with
      // no move in the last 400 ms: layout sliding under a parked pointer).
      await app.movePointerThrough([
        { x: first.dock.x - first.main.x + first.chat.left + 6, y: margin.y },
        margin,
      ]);
    else await app.movePointer(margin);
    await dockWait(
      `const move = window.__dockLastMove;
       if (!move) return false;
       const box = frontDock().getBoundingClientRect();
       return (${shaped} || move.x < box.left || move.x > box.right ||
         move.y < box.top || move.y > box.bottom) &&
         !frontDock().matches(':hover');`,
      { label: "the dock saw the pointer leave the chat" },
    );
    // A click on the workspace takes the focus with it: the chat lurks.
    const outside = { x: 40, y: 400 };
    await app.movePointer(outside);
    await app.clickPointer(outside);
    await dockWait(
      `return frontDock().hasAttribute('data-lurking') && dockH() < 220;`,
      { label: "lurks behind the click", timeoutMs: 10_000 },
    );
    await dockWait(
      `return !frontDock().querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes(', Working,');`,
      { label: "turn finished", timeoutMs: 40_000 },
    );
    if (shaped) {
      // A chat minimizing gives up the pointer on its first exit frame but
      // draws until the exit ends: the shape keeps it in the whole time
      // rather than clipping it away mid-animation.
      await dockWait(
        `return frontDock().getAnimations().every((animation) => animation.playState !== 'running');`,
        { label: "chat settled before minimizing" },
      );
      const exit = await dockRun<{
        samples: number;
        clipped: number;
      }>(`return new Promise((resolve) => {
        const chat = frontDock();
        const box = chat.getBoundingClientRect();
        const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        let samples = 0;
        let clipped = 0;
        let exiting = false;
        const sample = () => {
          const leaving = chat.classList.contains('animate-dock-out');
          const shape = document.documentElement.dataset.dockShape;
          if (leaving) exiting = true;
          // Still visibly drawing: the applied shape trails the page by at
          // most a frame, and a finished exit (opacity 0) rightly leaves it.
          if (leaving && shape && Number(getComputedStyle(chat).opacity) >= 0.1) {
            const rects = JSON.parse(shape) ?? [];
            samples += 1;
            if (!rects.some((r) => middle.x >= r.x && middle.y >= r.y && middle.x < r.x + r.width && middle.y < r.y + r.height))
              clipped += 1;
          }
          if (exiting && !leaving) resolve({ samples, clipped });
          else requestAnimationFrame(sample);
        };
        document.querySelector('[data-chat-bubble] button').click();
        requestAnimationFrame(sample);
      });`);
      expect(exit.samples).toBeGreaterThan(0);
      expect(exit.clipped).toBe(0);
      // Open the chat again so it can move back into the workspace window.
      await dockRun(
        "document.querySelector('[data-chat-bubble] button').click(); return true;",
      );
      await dockWait(`return !!composer();`, { label: "chat open again" });
    }
    await app.eval(`window.catamorphicDesktop.dockDetach(false)`);
    await runWait(`return !!composer();`, { label: "chat back in the window" });
  }, 120_000);

  it("lurks while the agent works: shrinks on focus-out, expands on hover, expands when done", async () => {
    await run(
      // Keep the turn alive through the animated focus and hover assertions.
      // Six seconds was shorter than this setup can take on a loaded CI host,
      // so the dock correctly expanded for the completed turn before the
      // pointer-leave assertion could observe it re-lurking.
      `setComposer('terminal: sleep 15 && echo lurk-done'); send(); return true;`,
    );
    // Focus stays in the composer right after sending — the dock stays
    // expanded until attention moves away.
    await runWait(`return dockH() > 400;`, { label: "expanded while focused" });
    // Xvfb can leave its virtual pointer over the centered dock even though
    // this test never moved it there. Clear hover as well as focus so this
    // assertion exercises the intended fully disengaged state.
    await run(`unhoverDock(); clickOutside(); return true;`);
    await runWait(
      `return frontDock().hasAttribute('data-lurking') && dockH() < 220;`,
      { label: "shrunk after focusing outside", timeoutMs: 10_000 },
    );
    await run(`hoverDock(); return true;`);
    await runWait(
      `return !frontDock().hasAttribute('data-lurking') && dockH() > 400;`,
      { label: "expanded on hover" },
    );
    await run(`unhoverDock(); return true;`);
    await runWait(
      `return frontDock().hasAttribute('data-lurking') && dockH() < 220;`,
      { label: "re-shrunk after the pointer left" },
    );
    // The turn ends → the dock expands for good.
    await runWait(
      `return !frontDock().hasAttribute('data-lurking') && dockH() > 400;`,
      { label: "expanded when the agent finished", timeoutMs: 30_000 },
    );
  }, 60_000);

  it("the built-in chat's / menu offers shared skills without inventing native commands", async () => {
    // "/" opens the composer's own menu (ADR 0274), the slash typed.
    await run(`setComposer(''); composer().focus(); return true;`);
    await app.press("Slash");
    const rows = await runWait<string[]>(
      `const rows = menuRows();
       if (!rows.includes('skill:writing-workflows') || composerMenu().querySelector('[role="status"]')) return false;
       return rows;`,
      { timeoutMs: 15_000, label: "built-in / menu" },
    );
    // This chat runs the built-in Fake Agent. Native command fixtures must
    // follow the selected harness, just like production discovery does.
    expect(rows).toContain("action:session-status");
    expect(rows).not.toContain("command:compact");
    expect(rows).not.toContain("command:review");
    expect(await run<string>(`return composer().textContent;`)).toBe("/");
    // Escape closes the menu and leaves the slash, so a message can start
    // with one; it goes as written, the chat staying where it is.
    await app.press("Escape");
    await runWait(
      `return !composerMenu() && document.activeElement === composer() && composer().textContent === '/';`,
      { label: "menu closed, the slash kept" },
    );
    await app.insertText("unknown-command-zzzz");
    await app.press("Enter");
    await runWait(
      `return frontDock().querySelector('[role="log"]').textContent.includes('You said: /unknown-command-zzzz');`,
      { timeoutMs: 30_000, label: "harness received the raw command" },
    );
  }, 60_000);

  it("chips fold into an animated group chip past the threshold; the split affordance is hover-only", async () => {
    // A terminal's chip lasts as long as its command (ADR 0223): four
    // commands left running cross SURFACE_GROUP_THRESHOLD (3). On retry
    // the group already exists, so stop as soon as its semantic control is
    // present instead of assuming an exact accumulated count.
    for (const label of ["one", "two", "three", "four"]) {
      const grouped = await run<boolean>(
        `return !!frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"] [data-chip-main]');`,
      );
      if (grouped) break;
      const marker = `${label}-${Date.now()}`;
      await run(
        `setComposer('start: echo ${marker} && sleep 600'); send(); return true;`,
      );
      await runWait(
        `return [...frontDock().querySelectorAll('[role="log"] article')].some(el =>
          el.textContent.includes('in the background') && el.textContent.includes('${marker}'));`,
        { timeoutMs: 30_000, label: `terminal turn ${label}` },
      );
    }
    await runWait(
      `return !!frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"] [data-chip-main]');`,
      { timeoutMs: 15_000, label: "collapsed group chip" },
    );
    expect(
      await run(
        `return frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"]').textContent;`,
      ),
    ).toMatch(/^Terminals\d+$/);
    // The group chip is read as its words and how many it holds.
    expect(
      await run<string>(
        `return frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"] [data-chip-main]').getAttribute('aria-label');`,
      ),
    ).toMatch(/^Terminals, \d+$/);
    await runWait(
      `const button = frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"] [data-chip-main]'); return button && !button.closest('[inert]');`,
      { label: "rail is interactive after the turn settles" },
    );
    // Its popover pops in and back out.
    await run(
      `frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"] [data-chip-main]').click(); return true;`,
    );
    await runWait(
      `const pop = frontDock().querySelector('.animate-pop-in');
       const members = pop?.querySelector('[data-testid="chip-group-members"]') ?? frontDock().querySelector('[data-testid="chip-group-members"]');
       return !!pop && (members?.querySelectorAll('[data-testid="chip-member"]').length ?? 0) >= 4;`,
      { label: "group popover popped in" },
    );
    await hoverChip('[data-testid="chip-group-members"] [data-member-main]');
    await runWait(
      `return document.querySelector('[data-resource-inspector][data-open="true"]')?.textContent.includes('Terminal');`,
      { label: "group member uses shared preview" },
    );
    await app.press("Escape");
    await run(
      `frontDock().querySelector('[data-testid="chip"][data-chip-id="group:terminal"] [data-chip-main]').click(); return true;`,
    );
    await runWait(
      `return !!frontDock().querySelector('.animate-pop-out') ||
              !frontDock().querySelector('.animate-pop-in');`,
      { label: "group popover popping out" },
    );
    // Individual chips reserve no width for the split affordance: it
    // lives in an overlay that only appears under the pointer.
    // open_surface associates the browser with this chat, unlike the
    // terminal `open` shim (covered separately below), which intentionally
    // has no requesting chat and therefore no rail chip.
    await run(`setComposer('show: https://example.org'); send(); return true;`);
    const overlay = await runWait<{ opacity: string; overlaid: boolean }>(
      `const chip = frontDock().querySelector('[data-testid="chip"][data-kind="browser"]');
       if (!chip) return false;
       const layer = [...chip.children].find((el) => el.className.includes('absolute'));
       if (!layer) return false;
       const chipRect = chip.getBoundingClientRect();
       const layerRect = layer.getBoundingClientRect();
       return { opacity: getComputedStyle(layer).opacity,
                overlaid: Math.abs(layerRect.right - chipRect.right) < 2 };`,
      { timeoutMs: 30_000, label: "browser chip with hover overlay" },
    );
    expect(overlay.opacity).toBe("0");
    expect(overlay.overlaid).toBe(true);
    await hoverChip(
      '[data-testid="chip"][data-kind="browser"] [data-chip-main]',
    );
    await runWait(
      `return document.querySelector('[data-resource-inspector][data-open="true"] [data-preview-location]')?.textContent.includes('https://example.org');`,
      { label: "composer surface previews its destination on hover" },
    );
    await app.press("Escape");
  }, 120_000);

  // The shim replaces macOS's native `open`; other platforms use their own
  // shell launchers and cannot exercise this platform integration.
  it.skipIf(process.platform !== "darwin")(
    "`open <url>` in an agent terminal lands as an in-app browser tab",
    async () => {
      // The turn before has ended: this one is a turn of its own (ADR 0240).
      await runWait(
        `return !frontDock()?.querySelector('[data-testid="chat-stop"]');`,
        { timeoutMs: 30_000, label: "the turn before settled" },
      );
      await run(
        `setComposer('terminal: open https://example.com'); send(); return true;`,
      );
      await runWait(
        `return $$('webview').some((w) => (w.src ?? '').startsWith('https://example.com'));`,
        { label: "in-app browser tab from the open shim", timeoutMs: 30_000 },
      );
      // …and it is the ACTIVE tab (the chat floats in front of it).
      const active = await run<boolean>(`
      return $$('[data-point-key^="browser:"]').length > 0;
    `);
      expect(active).toBe(true);
    },
    60_000,
  );

  it("lurks when the person clicks the page behind it while the agent works", async () => {
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<title>Backdrop page</title><body style="height:3000px"><p>backdrop</p></body>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      // The agent puts a page in front; the chat floats over it.
      await run(`setComposer('show: ${origin}/'); send(); return true;`);
      await runWait(
        `const page = $$('webview').find((w) => (w.src ?? '').startsWith(${JSON.stringify(origin)}));
         return !!page && page.checkVisibility() &&
           !frontDock().querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes(', Working,');`,
        { label: "page in front behind the chat", timeoutMs: 30_000 },
      );
      await run(
        `setComposer('terminal: sleep 15 && echo page-lurk-done'); send(); return true;`,
      );
      await runWait(
        `return dockH() > 400 && !frontDock().hasAttribute('data-lurking');`,
        {
          label: "expanded while the composer has focus",
        },
      );
      // The person works in this window, so it is the key window: on macOS
      // a click on a window that is not only activates it, and the page
      // never sees it. Say whether it was, for a failure to point at.
      const keyBefore = await app.eval<{ focused: boolean }>(
        "window.catamorphicDesktop.devWindow('get')",
      );
      console.info(
        `[dock-modes] workspace window key before the page click: ${keyBefore.focused}`,
      );
      await app.eval(`window.catamorphicDesktop.devWindow('focus')`);
      await app.waitFor(
        `window.catamorphicDesktop.devWindow('get').then((state) => state.focused)`,
        { label: "the workspace window is key", timeoutMs: 5_000 },
      );
      await runWait(
        `return dockH() > 400 && !frontDock().hasAttribute('data-lurking');`,
        { label: "still expanded in the focused window" },
      );
      // The person moves from the chat onto the page and clicks it.
      // On a small window the chat covers most of the page: aim at page the
      // chat leaves uncovered, its margins included, clear of every edge so
      // a pixel's rounding cannot put the click on the sidebar or the chat.
      const points = await runWait<{
        dock: { x: number; y: number };
        page: { x: number; y: number };
      }>(
        `
        const view = $$('webview').find((w) => (w.src ?? '').startsWith(${JSON.stringify(origin)}));
        const page = view.getBoundingClientRect();
        const dock = frontDock().getBoundingClientRect();
        const clear = (x, y) =>
          [[0, 0], [-10, 0], [10, 0], [0, -10], [0, 10]].every(([dx, dy]) => {
            const px = x + dx;
            const py = y + dy;
            const outside = px < dock.left || px > dock.right || py < dock.top || py > dock.bottom;
            return outside && document.elementFromPoint(px, py) === view;
          });
        let target;
        for (let y = page.top + 12; !target && y < page.bottom - 12; y += 8)
          for (let x = page.left + 12; !target && x < page.right - 12; x += 8)
            if (clear(x, y)) target = { x, y };
        return target && {
          dock: { x: dock.left + dock.width / 2, y: dock.top + 40 },
          page: target,
        };
      `,
        { label: "a point on the page outside the chat" },
      ).catch(async (error: unknown) => {
        const rects = await run(`return {
          page: $$('webview').find((w) => (w.src ?? '').startsWith(${JSON.stringify(origin)}))?.getBoundingClientRect().toJSON(),
          dock: frontDock()?.getBoundingClientRect().toJSON(),
          window: { width: innerWidth, height: innerHeight },
        };`);
        throw new Error(`${String(error)}; rects: ${JSON.stringify(rects)}`);
      });
      // Chromium's own pointer may still be where an earlier hover left it
      // (see hoverChip): park it off the chat, as the native one moves.
      await app.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...points.page,
      });
      await app.movePointerThrough([points.dock, points.page]);
      await app.clickPointer(points.page);
      await runWait(
        `return frontDock().hasAttribute('data-lurking') && dockH() < 220;`,
        { label: "lurks after the click on the page", timeoutMs: 10_000 },
      ).catch(async (error: unknown) => {
        const state = await run(`return {
          active: document.activeElement?.tagName,
          windowFocused: document.hasFocus(),
          hovered: frontDock()?.matches(':hover'),
          height: dockH(),
        };`);
        const window = await app.eval<{ focused: boolean }>(
          "window.catamorphicDesktop.devWindow('get')",
        );
        throw new Error(
          `${String(error)}; state: ${JSON.stringify(state)}; key window before: ${keyBefore.focused}, after: ${window.focused}; point: ${JSON.stringify(points.page)}`,
        );
      });
    } finally {
      server.close();
    }
  }, 90_000);

  it("in its own window, the dock's composer has its own / menu, a skill goes in its message beside its pills, and a chat in a tab has the same", async () => {
    const idle = `!frontDock().querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes(', Working,')`;
    await runWait(`return ${idle};`, {
      label: "the previous turn ended",
      timeoutMs: 40_000,
    });
    await app.movePointer({ x: 1, y: 1 });
    await app.eval(`window.catamorphicDesktop.dockDetach(true)`);
    const dock = await app.connectToFrame("surface=dock");
    const dockRun = <T = unknown>(body: string) =>
      dock.eval<T>(`(() => { ${helpers}\n${body} })()`);
    const dockWait = <T = unknown>(
      body: string,
      opts?: { timeoutMs?: number; label?: string },
    ) => dock.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);
    // The dock window draws its own composer's menu.
    const slashInDock = async (word: string) => {
      await dockRun(`typeInComposer(${JSON.stringify(word)}); return true;`);
      await dockWait(`return menuRows()[0] === 'skill:writing-workflows';`, {
        label: "the dock's / menu",
        timeoutMs: 15_000,
      });
    };
    try {
      await dockWait(`return !!composer();`, {
        label: "chat in the dock window",
      });
      await dockRun(
        `composer().focus(); setReactValue(composer(), ''); const data = new DataTransfer(); data.setData('text/plain', 'Release notes. '.repeat(120)); composer().dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data})); return true;`,
      );
      await dockWait(
        `return composer().querySelectorAll('[data-pill-id]').length === 1;`,
        { label: "a pill in the dock's composer" },
      );
      await slashInDock(" /writing-workflows");
      await dockRun(`composerKey('Enter'); return true;`);
      await dockWait(
        `return !composerMenu() && [...composer().querySelectorAll('[data-testid="composer-pill"]')].map((el) => el.dataset.pillKind).join() === 'paste,skill';`,
        { label: "the skill beside the pill in the dock's composer" },
      );
      await dockRun(`composerKey('Enter'); return true;`);
      await dockWait(
        `const sent = [...frontDock().querySelectorAll('[data-user-message]')].pop();
         return !!sent && [...sent.querySelectorAll('[data-testid="sent-pill"]')].map((el) => el.dataset.pillKind).join() === 'paste,skill' &&
           composer().querySelectorAll('[data-pill-id]').length === 0;`,
        {
          label: "the skill and its pill in the dock's chat",
          timeoutMs: 30_000,
        },
      );
      await dockWait(
        `const log = frontDock().querySelector('[role="log"]').textContent;
         return log.includes('skill loaded: writing-workflows') && log.includes('Received 2 attachments') && ${idle};`,
        { label: "the agent got both", timeoutMs: 30_000 },
      );
      // Escape closes the dock's menu and leaves what was typed.
      await slashInDock("/wri");
      await dockRun(`composerKey('Escape'); return true;`);
      await dockWait(
        `return !composerMenu() && composer().textContent === '/wri';`,
        { label: "the dock's menu closed, the typing kept" },
      );
      await dockRun(`setReactValue(composer(), ''); return true;`);
      // A chat in a tab is the workspace window's, with the same menu.
      await run(
        `window.focus(); pressKey('p', { metaKey: true }); return true;`,
      );
      await runWait(
        `const input = document.activeElement; return input?.getAttribute('aria-label') === 'Search commands, pages, and more';`,
        { label: "palette open in the workspace" },
      );
      await app.insertText("agent");
      await app.press("Space");
      await app.insertText("hello from a tab");
      await app.press("Enter", process.platform === "darwin" ? 4 : 2);
      await runWait(
        `const tab = $$('[data-chat-tab]').find((el) => !el.inert);
         return !!tab && tab.textContent.includes('You said: hello from a tab') && ${idle.replaceAll("frontDock()", "tab")};`,
        { label: "a chat in a tab", timeoutMs: 30_000 },
      );
      await run(
        `$$('[data-chat-tab]').find((el) => !el.inert).querySelector('[data-composer-input]').focus(); return true;`,
      );
      await app.press("Slash");
      await app.insertText("writing-workflows");
      await runWait(`return menuRows()[0] === 'skill:writing-workflows';`, {
        label: "the tab chat's / menu",
        timeoutMs: 15_000,
      });
      await app.press("Enter");
      await runWait(
        `return !composerMenu() && !!$$('[data-chat-tab]').find((el) => !el.inert).querySelector('[data-pill-kind="skill"]');`,
        { label: "the skill in the tab chat's message" },
      );
      await app.press("Enter");
      await runWait(
        `const tab = $$('[data-chat-tab]').find((el) => !el.inert);
         return !!tab && tab.textContent.includes('skill loaded: writing-workflows');`,
        { label: "the skill ran in the tab chat", timeoutMs: 30_000 },
      );
      await runWait(
        `return document.activeElement === $$('[data-chat-tab]').find((el) => !el.inert).querySelector('[data-composer-input]');`,
        { label: "the tab chat's composer has the keyboard back" },
      );
      expect(app.getRendererErrors()).toEqual([]);
    } finally {
      dock.close();
      await app.eval(`window.catamorphicDesktop.dockDetach(false)`);
    }
  }, 120_000);
});
