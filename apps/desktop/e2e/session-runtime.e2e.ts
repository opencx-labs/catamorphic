import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp({
    env: process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT
      ? { CATAMORPHIC_E2E_WINDOW_MODE: "visible" }
      : {},
  });
});
afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const dock = () => $$('section[aria-label]').find(el => !el.inert && el.querySelector('[data-composer-input]'));
  ${setReactValueJs}
`;
const run = (body: string) =>
  app.eval(`(async () => { ${helpers} ${body} })()`);
const wait = (body: string) =>
  app.waitFor(`(async () => { ${helpers} ${body} })()`);
const inspector = async () => {
  await wait(`return !$('[data-testid="resource-inspector"]');`);
  await run(`dock().querySelector('[aria-label^="Session status:"]').click();`);
  await wait(`return !!$('[data-testid="session-inspector-content"]');`);
};
const pick = async (name: string) => {
  await wait(`const row = $$('[role="option"]').find(el => !el.closest('[inert]') && el.textContent.includes(${JSON.stringify(name)}));
    if (!row) return false;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true;`);
};

describe("session runtime controls", () => {
  it("edits only the current conversation and preserves the setting on reload", async () => {
    await wait(
      `const button = $$('button').find(el => el.textContent.includes('New project')); if (!button) return false; button.click(); return true;`,
    );
    await wait(`return !!$('[data-testid="project-name-input"]');`);
    await run(
      `setReactValue($('[data-testid="project-name-input"]'), 'runtime-controls');`,
    );
    await wait(
      `const button = $('[data-testid="project-submit"]'); if (!button || button.disabled) return false; button.click(); return true;`,
    );
    await wait(
      `return $$('[role="tab"], button').some(el => el.textContent.includes('New Tab'));`,
    );
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }));`,
    );
    await wait(`return !!dock()?.querySelector('[data-composer-input]');`);
    await run(
      `const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'hello agent'); input.closest('form').requestSubmit();`,
    );
    await wait(`return dock()?.textContent.includes('You said: hello agent');`);
    await run(`const { url } = await window.catamorphicDesktop.getServerState();
      const { items } = await fetch(url + '/api/projects').then(r => r.json());
      const project = items.find(p => p.name === 'runtime-controls');
      const base = url + '/api/projects/' + project.id + '/agent/sessions';
      const sessions = await fetch(base).then(r => r.json());
      window.__runtimeTest = { base, id: sessions.items[0].id, agents: await window.catamorphicDesktop.agentsList() };`);
    await inspector();
    await run(`$('[aria-label="Change model"]').click();`);
    await pick("Fake Model B");
    await wait(
      `const {base, id} = window.__runtimeTest; const session = await fetch(base + '/' + id).then(r => r.json()); return session.model === 'fake-model-b';`,
    );
    await inspector();
    await wait(
      `return $('[data-testid="session-inspector-content"]').textContent.includes('fake-model-b');`,
    );
    await run(`$('[aria-label="Change reasoning"]').click();`);
    await pick("High effort");
    await wait(
      `const {base, id} = window.__runtimeTest; const session = await fetch(base + '/' + id).then(r => r.json()); return session.modelEffort === 'high';`,
    );
    expect(
      await run(
        `return JSON.stringify(await window.catamorphicDesktop.agentsList()) === JSON.stringify(window.__runtimeTest.agents);`,
      ),
    ).toBe(true);
    await run(`window.location.reload();`);
    await wait(
      `const chat = $$('button').find(el => el.textContent.trim() === 'Quick chat'); if (!chat) return false; chat.click(); return true;`,
    );
    await wait(
      `return !!dock()?.querySelector('[aria-label^="Session status:"]');`,
    );
    await inspector();
    await wait(
      `const text = $('[data-testid="session-inspector-content"]').textContent; return text.includes('fake-model-b') && text.includes('High');`,
    );
    if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT) {
      await wait(
        `const panel = $('[data-testid="resource-inspector"]'); return !!panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(dock()).opacity === '1';`,
      );
      await app.screenshot(process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT);
    }
    await run(`$('[aria-label="Change model"]').click();`);
    await pick("Agent default");
    await inspector();
    await wait(
      `const content = $('[data-testid="session-inspector-content"]'); return !!content && !content.textContent.includes('fake-model-b');`,
    );
  });
});
