import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Switching a chat's agent from its status popup: before the chat starts,
 * any agent; once it has, only agents on the harness it runs on, the others
 * listed with why (lib/agent-switch). Two seeded agents share the built-in
 * harness; a third runs on Codex.
 */
let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
}, 180_000);
afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const dock = () => {
    const candidates = $$('section[data-chat-local-id]').filter(el => !el.closest('[inert]') && el.getBoundingClientRect().width > 0 && el.querySelector('[data-composer-input]'));
    return candidates.find(el => el.dataset.floatingChat === 'true') ?? candidates[0];
  };
  ${setReactValueJs}
`;
const run = <T = unknown>(body: string) =>
  app.eval<T>(`(async () => { ${helpers} ${body} })()`);
const wait = <T = unknown>(body: string, label?: string) =>
  app.waitFor<T>(
    `(async () => { ${helpers} ${body} })()`,
    label ? { label } : undefined,
  );

/** Opens the chat's status popup the way a person does: a press on it. */
const inspector = async () => {
  await wait(
    `return !document.getAnimations().some(animation => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);`,
  );
  if (
    await run(
      `return !!$('[data-resource-inspector][data-open="true"] [data-testid="session-inspector-content"]');`,
    )
  )
    return;
  const point = await app.waitFor<{ x: number; y: number }>(`(() => { ${helpers}
    const button = dock()?.querySelector('[aria-label^="Session status:"]');
    if (!button || button.closest('[inert]')) return false;
    const rect = button.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
  await wait(
    `return !!$('[data-testid="session-inspector-content"]');`,
    "status popup",
  );
};
/** The agent picker's rows: name, and why it is disabled when it is. */
const agentRows = () =>
  wait<{ name: string; disabled: string | null }[]>(
    `const rows = $$('[role="option"]').filter(el => !el.closest('[inert]') && el.querySelector('*'));
     if (!rows.some(row => row.textContent.includes('Codex Fake'))) return false;
     return rows.map(row => ({
       name: ['Fake Agent', 'Other Fake', 'Codex Fake'].find(name => row.textContent.includes(name)) ?? row.textContent.trim().slice(0, 40),
       disabled: row.getAttribute('aria-disabled') === 'true' ? row.dataset.disabledReason ?? '' : null,
     })).filter(row => ['Fake Agent', 'Other Fake', 'Codex Fake'].includes(row.name));`,
    "agent picker rows",
  );
const pick = (name: string) =>
  wait(
    `const row = $$('[role="option"]').find(el => !el.closest('[inert]') && el.textContent.includes(${JSON.stringify(name)}));
     if (!row) return false;
     row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
     row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true;`,
    `pick ${name}`,
  );
const shownAgent = (name: string) =>
  wait(
    `const agent = $('[aria-label="Change agent"]'); return !!agent && agent.textContent.trim() === ${JSON.stringify(name)};`,
    `status shows ${name}`,
  );

describe("switching a chat's agent", () => {
  it("picks any agent before the chat starts, and stays on its harness after", async () => {
    await wait(
      `const button = $$('button').find(el => el.textContent.includes('Create or import project')); if (!button) return false; button.click(); return true;`,
    );
    await wait(`return !!$('[data-testid="project-name-input"]');`);
    await run(
      `setReactValue($('[data-testid="project-name-input"]'), 'agent-switch');`,
    );
    await wait(
      `const button = $('[data-testid="project-submit"]'); if (!button || button.disabled) return false; button.click(); return true;`,
    );
    await wait(
      `return $$('[role="tab"], button').some(el => el.textContent.includes('New Tab'));`,
    );
    await run(
      `await window.catamorphicDesktop.agentsCreate({ name: 'Codex Fake', harness: 'codex' });`,
    );
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform), bubbles: true }));`,
    );
    await wait(`return !!dock()?.querySelector('[data-composer-input]');`);

    // Before the first message: every agent, the Codex one included.
    await inspector();
    await shownAgent("Fake Agent");
    await run(`$('[aria-label="Change agent"]').click();`);
    expect(await agentRows()).toEqual([
      { name: "Fake Agent", disabled: null },
      { name: "Other Fake", disabled: null },
      { name: "Codex Fake", disabled: null },
    ]);
    await pick("Codex Fake");
    await inspector();
    await shownAgent("Codex Fake");
    await run(`$('[aria-label="Change agent"]').click();`);
    await pick("Fake Agent");
    await inspector();
    await shownAgent("Fake Agent");
    await run(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
    );

    // The conversation starts on the built-in harness.
    await run(
      `const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'hello agent'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return dock()?.textContent.includes('You said: hello agent');`,
      "first reply",
    );
    await run(`const { url } = await window.catamorphicDesktop.getServerState();
      const { items } = await fetch(url + '/api/projects').then(r => r.json());
      const project = items.find(p => p.name === 'agent-switch');
      const base = url + '/api/projects/' + project.id + '/agent/sessions';
      const sessions = await fetch(base).then(r => r.json());
      const { agents } = await window.catamorphicDesktop.agentsList();
      window.__switch = { base, id: sessions.items[0].id, agents };`);

    // Started: the other built-in agent continues it; Codex needs a new chat.
    await inspector();
    await run(`$('[aria-label="Change agent"]').click();`);
    const rows = await agentRows();
    expect(rows.map((row) => row.name)).toEqual([
      "Fake Agent",
      "Other Fake",
      "Codex Fake",
    ]);
    expect(rows[1]?.disabled).toBeNull();
    expect(rows[2]?.disabled).toBe("Codex · needs a new chat");
    // A disabled row does nothing when picked.
    await pick("Codex Fake");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await run(
        `const {base, id, agents} = window.__switch; const session = await fetch(base + '/' + id).then(r => r.json()); return agents.find(agent => agent.id === session.agentId)?.name;`,
      ),
    ).toBe("Fake Agent");
    await pick("Other Fake");
    await wait(
      `const {base, id, agents} = window.__switch; const session = await fetch(base + '/' + id).then(r => r.json()); return agents.find(agent => agent.id === session.agentId)?.name === 'Other Fake';`,
      "session on Other Fake",
    );
    await inspector();
    await shownAgent("Other Fake");
    // The conversation continues on the switched agent.
    await run(
      `const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'still here'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return dock()?.textContent.includes('You said: still here');`,
      "reply after the switch",
    );
  });
});
