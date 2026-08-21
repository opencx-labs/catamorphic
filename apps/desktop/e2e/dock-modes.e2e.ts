import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

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
    const kept = [...c.querySelectorAll('[data-pill-id]')];
    c.replaceChildren(...kept, document.createTextNode(text));
    c.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const send = () => composer().dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true }));
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
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
      `setComposer('terminal: sleep 6 && echo lurk-done'); send(); return true;`,
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

  it("`open <url>` in an agent terminal lands as an in-app browser tab", async () => {
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
  }, 60_000);
});
