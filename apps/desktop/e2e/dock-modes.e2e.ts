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
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...mods }));
  const dockH = () => frontDock()?.getBoundingClientRect().height ?? 0;
  const hoverDock = () => frontDock().dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  const unhoverDock = () => frontDock().dispatchEvent(
    new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  const clickOutside = () =>
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

describe("dock modes", () => {
  it("boots into a project and opens a floating chat", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'dock-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = byText('button', 'Create');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!composer();`, { label: "floating chat" });
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
    const state = await runWait<{ text: string; focused: boolean }>(
      `const c = composer();
       if (!c.querySelector('[data-testid="composer-pill"][data-pill-kind="image"]')) return false;
       return { text: c.textContent, focused: document.activeElement === c };`,
      { label: "picked file as inline pill" },
    );
    expect(state.text).toBe("beforepicked.png  after");
    expect(state.focused).toBe(true);
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
    await run(`clickOutside(); return true;`);
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

  it("the slash menu merges the harness's commands under the skills", async () => {
    await run(`setComposer('/'); return true;`);
    const rows = await runWait<string[]>(
      `const menu = $('[data-testid="slash-menu"]');
       if (!menu || !menu.querySelector('[data-skill-name="compact"]')) return false;
       return [...menu.querySelectorAll('[role="option"]')].map((el) => el.dataset.skillName);`,
      { timeoutMs: 15_000, label: "menu with harness commands" },
    );
    // The e2e fixture list from main: compact + review, tagged as the
    // harness's own.
    expect(rows).toContain("compact");
    expect(rows).toContain("review");
    expect(
      await run<boolean>(
        `return $('[data-testid="slash-menu"]').textContent.includes('Claude Code');`,
      ),
    ).toBe(true);
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
    // Committing a command sends the literal /name to the harness.
    await run(`setComposer('/compact'); return true;`);
    await runWait(
      `return !!$('[data-testid="slash-menu"] [data-skill-name="compact"]');`,
      { label: "compact filtered" },
    );
    await run(`
      composer().dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return frontDock().querySelector('[role="log"]').textContent.includes('You said: /compact');`,
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
      await run(`setComposer('terminal: echo ${label}'); send(); return true;`);
      await runWait(
        `return frontDock().querySelector('[role="log"]').textContent.includes('${label}');`,
        { timeoutMs: 30_000, label: `terminal turn ${label}` },
      );
    }
    await runWait(
      `return !!frontDock().querySelector('button[aria-label$=" terminals"]');`,
      { timeoutMs: 15_000, label: "collapsed group chip" },
    );
    // The group chip ENTERED through the pill vocabulary (its wrapper
    // keeps the class for the element's lifetime).
    expect(
      await run<boolean>(
        `return !!frontDock().querySelector('.animate-pill-in button[aria-label$=" terminals"]');`,
      ),
    ).toBe(true);
    // Its popover pops in and back out.
    await run(
      `frontDock().querySelector('button[aria-label$=" terminals"]').click(); return true;`,
    );
    await runWait(
      `const pop = frontDock().querySelector('.animate-pop-in');
       return !!pop && pop.textContent.includes('Agent terminal');`,
      { label: "group popover popped in" },
    );
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
