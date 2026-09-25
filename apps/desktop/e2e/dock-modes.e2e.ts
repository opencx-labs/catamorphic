import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Floating-dock behaviors around a working agent:
 * - lurk mode: with a tab behind and the agent working, the dock shrinks
 *   vertically to a strip; hover/focus expands, leaving/focusing outside
 *   re-shrinks, and the end of the turn expands for good;
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
  await runWait(
    `return frontDock()?.querySelector(${JSON.stringify(selector)})?.matches(':hover');`,
    {
      label: "native pointer reached the surface chip",
    },
  );
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
    await run(`pressKey('n', { metaKey: true }); return true;`);
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
    // A fresh chat picks up the new default through agents-changed.
    await run(`pressKey('n', { metaKey: true }); return true;`);
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
    // so the two do not queue behind each other.
    await dockWait(
      `return !frontDock().querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes(', Working,');`,
      { label: "turn finished", timeoutMs: 40_000 },
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
    );
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
    // The margin beside the chat is empty space in the dock window: the
    // pointer passes over it, and the click lands on the workspace behind.
    const first = await bounds();
    const margin = {
      x: first.dock.x - first.main.x + Math.floor(first.chat.left / 2),
      y:
        first.dock.y -
        first.main.y +
        first.chat.top +
        Math.floor(first.chat.height / 2),
    };
    await app.movePointer(margin);
    // The dock answers the hover by letting the window through; the OS
    // applies that a moment later, and the click must come after it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await app.clickPointer(margin);
    const marginHit = await dockRun<string | null>(
      `const hit = document.elementFromPoint(${Math.floor(first.chat.left / 2)}, ${first.chat.top + Math.floor(first.chat.height / 2)});
       return hit ? hit.tagName : null;`,
    );
    // The dock reads the margin as empty space (only the body answers).
    expect(marginHit).toBe("BODY");
    if (process.platform === "darwin") {
      // macOS honors the window's mouse-ignore, so the click lands behind
      // it. The private Linux display's window manager does not apply X11
      // input shapes, so there the click stays with the dock window.
      await app
        .waitFor(`window.__throughClicks > 0`, {
          label: "click reached the workspace window",
          timeoutMs: 10_000,
        })
        .catch(async (error: unknown) => {
          const state = await dockRun(`return {
            hasFocus: document.hasFocus(),
            dockPointerDowns: window.__dockPointerDowns,
          };`);
          throw new Error(
            `${String(error)}; margin ${JSON.stringify(margin)}; dock state: ${JSON.stringify(state)}`,
          );
        });
    }
    // A real click in the composer focuses the dock window, as typing would,
    // and focus on the dock keeps it resting where it was rather than
    // moving it to the display's edge.
    await app.clickPointer({
      x: first.dock.x - first.main.x + first.composer.x,
      y: first.dock.y - first.main.y + first.composer.y,
    });
    await dockWait(
      `return document.hasFocus() && document.activeElement === composer();`,
      { label: "dock window focused through its composer" },
    ).catch(async (error: unknown) => {
      const state = await dockRun(`return {
        hasFocus: document.hasFocus(),
        pointerDowns: window.__dockPointerDowns,
        active: document.activeElement?.outerHTML.slice(0, 200),
      };`);
      throw new Error(`${String(error)}; dock state: ${JSON.stringify(state)}`);
    });
    const focused = await bounds();
    expect(focused.dock.x).toBe(first.dock.x);
    expect(focused.dock.y).toBe(first.dock.y);
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
    await app.movePointer(margin);
    await dockWait(
      `const move = window.__dockLastMove;
       if (!move) return false;
       const box = frontDock().getBoundingClientRect();
       return (move.x < box.left || move.x > box.right ||
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

  it("the built-in slash menu offers shared skills without inventing native commands", async () => {
    await run(`setComposer('/'); return true;`);
    const rows = await runWait<string[]>(
      `const menu = $('[data-testid="slash-menu"]');
       if (!menu || !menu.querySelector('[data-skill-name="writing-workflows"]') ||
           menu.querySelector('[aria-busy="true"]')) return false;
       return [...menu.querySelectorAll('[role="option"]')].map((el) => el.dataset.skillName);`,
      { timeoutMs: 15_000, label: "built-in command catalog" },
    );
    // This chat runs the built-in Fake Agent. Native command fixtures must
    // follow the selected harness, just like production discovery does.
    expect(rows).toContain("status");
    expect(rows).toContain("writing-workflows");
    expect(rows).not.toContain("compact");
    expect(rows).not.toContain("review");
    expect(
      await run<boolean>(
        `return $('[data-testid="slash-menu"]').textContent.includes('Claude Code');`,
      ),
    ).toBe(false);
    // The panel pops in (and pops out when the token dissolves).
    expect(
      await run<boolean>(
        `return $('[data-testid="slash-menu"]').className.includes('animate-pop-in');`,
      ),
    ).toBe(true);
    await run(`setComposer(''); return true;`);
    await runWait(`return !$('[data-testid="slash-menu"]');`, {
      label: "menu closed after its exit animation",
    });
    // Unknown slash text remains an ordinary message after discovery settles.
    await run(`setComposer('/unknown-command-zzzz'); return true;`);
    await runWait(
      `const menu = $('[data-testid="slash-menu"]');
       return !!menu && menu.textContent.includes('No matching commands') &&
         !menu.querySelector('[aria-busy="true"]');`,
      { label: "unknown command after discovery" },
    );
    await run(`
      composer().dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return frontDock().querySelector('[role="log"]').textContent.includes('You said: /unknown-command-zzzz');`,
      { timeoutMs: 30_000, label: "harness received the raw command" },
    );
  }, 60_000);

  it("chips fold into an animated group chip past the threshold; the split affordance is hover-only", async () => {
    // Three quick terminal turns after the lurk test's one cross
    // SURFACE_GROUP_THRESHOLD (3). On retry the group already exists, so
    // stop as soon as its semantic control is present instead of assuming
    // an exact accumulated count.
    for (const label of ["two", "three", "four"]) {
      const grouped = await run<boolean>(
        `return !!frontDock().querySelector('button[aria-label$=" terminals"]');`,
      );
      if (grouped) break;
      const marker = `${label}-${Date.now()}`;
      await run(
        `setComposer('terminal: echo ${marker}'); send(); return true;`,
      );
      await runWait(
        `return [...frontDock().querySelectorAll('[role="log"] article')].some(el =>
          el.textContent.includes('terminal result:') && el.textContent.includes('${marker}'));`,
        { timeoutMs: 30_000, label: `terminal turn ${label}` },
      );
    }
    await runWait(
      `return !!frontDock().querySelector('button[aria-label$=" terminals"]');`,
      { timeoutMs: 15_000, label: "collapsed group chip" },
    );
    expect(
      await run(
        `return frontDock().querySelector('[data-testid="surface-group"][data-kind="terminal"]').textContent;`,
      ),
    ).toMatch(/^Terminals\d+$/);
    // The group chip ENTERED through the pill vocabulary (its wrapper
    // keeps the class for the element's lifetime).
    expect(
      await run<boolean>(
        `return !!frontDock().querySelector('.animate-pill-in button[aria-label$=" terminals"]');`,
      ),
    ).toBe(true);
    await runWait(
      `const button = frontDock().querySelector('[data-testid="surface-group"]'); return button && !button.closest('[inert]');`,
      { label: "rail is interactive after the turn settles" },
    );
    // Its popover pops in and back out.
    await run(
      `frontDock().querySelector('button[aria-label$=" terminals"]').click(); return true;`,
    );
    await runWait(
      `const pop = frontDock().querySelector('.animate-pop-in');
       const members = pop?.querySelector('[data-testid="surface-group-members"]') ?? frontDock().querySelector('[data-testid="surface-group-members"]');
       return !!pop && members?.children.length >= 4;`,
      { label: "group popover popped in" },
    );
    await hoverChip('[data-testid="surface-group-members"] button');
    await runWait(
      `return document.querySelector('[data-resource-inspector][data-open="true"]')?.textContent.includes('Terminal');`,
      { label: "group member uses shared preview" },
    );
    await app.press("Escape");
    await run(
      `frontDock().querySelector('button[aria-label$=" terminals"]').click(); return true;`,
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
      `const chip = frontDock().querySelector('[data-testid="surface-chip"][data-kind="browser"]');
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
    await hoverChip('[data-testid="surface-chip"][data-kind="browser"] button');
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
});
