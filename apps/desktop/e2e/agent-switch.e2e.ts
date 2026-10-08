import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Switching a chat's agent from its status popup, before the chat starts and
 * after. After, an agent on another harness carries on from a summary of the
 * conversation, and its row says so (lib/agent-switch). Two seeded agents
 * share the built-in harness; a third runs on Codex.
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
/** The agent picker's rows: name, whether it can be picked, and its detail. */
const agentRows = () =>
  wait<{ name: string; enabled: boolean; detail: string }[]>(
    `const names = ['Fake Agent', 'Other Fake', 'Codex Fake'];
     const rows = $$('[role="option"]').filter(el => !el.closest('[inert]'));
     if (!rows.some(row => row.textContent.includes('Codex Fake'))) return false;
     return rows.flatMap(row => {
       const name = names.find(candidate => row.textContent.includes(candidate));
       return name ? [{
         name,
         enabled: row.getAttribute('aria-disabled') !== 'true',
         detail: row.textContent.replace(name, '').replace('current', '').trim(),
       }] : [];
     });`,
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
/** The Agent row, once it can be used (a turn finishing makes it so). */
const changeAgent = async () => {
  await inspector();
  await wait(
    `const agent = $('[aria-label="Change agent"]'); if (!agent || agent.disabled) return false; agent.click(); return true;`,
    "Agent row ready",
  );
};
const shownAgent = (name: string) =>
  wait(
    `const agent = $('[aria-label="Change agent"]'); return !!agent && agent.textContent.trim() === ${JSON.stringify(name)};`,
    `status shows ${name}`,
  );

describe("switching a chat's agent", () => {
  it("picks any agent from the status popup, before the chat starts and after", async () => {
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

    // Before the first message: every agent, and each simply begins it.
    await inspector();
    await shownAgent("Fake Agent");
    await changeAgent();
    const before = await agentRows();
    expect(before.map((row) => [row.name, row.enabled])).toEqual([
      ["Fake Agent", true],
      ["Other Fake", true],
      ["Codex Fake", true],
    ]);
    expect(before.some((row) => row.detail.includes("summary"))).toBe(false);
    await pick("Codex Fake");
    await inspector();
    await shownAgent("Codex Fake");
    await changeAgent();
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
    const sessionAgent = (name: string) =>
      wait(
        `const {base, id, agents} = window.__switch; const session = await fetch(base + '/' + id).then(r => r.json()); return agents.find(agent => agent.id === session.agentId)?.name === ${JSON.stringify(name)};`,
        `session on ${name}`,
      );

    // Started: every agent still, the Codex one carrying on from a summary.
    await changeAgent();
    const after = await agentRows();
    expect(after.map((row) => [row.name, row.enabled])).toEqual([
      ["Fake Agent", true],
      ["Other Fake", true],
      ["Codex Fake", true],
    ]);
    expect(after[1]?.detail).not.toContain("summary");
    expect(after[2]?.detail).toBe("Codex · continues from a summary");
    await pick("Codex Fake");
    await sessionAgent("Codex Fake");
    // The transcript marks the switch.
    await wait(
      `return dock()?.textContent.includes('Switched to Codex Fake');`,
      "switch notice",
    );
    await inspector();
    await shownAgent("Codex Fake");
    // The picker follows the chat's harness: now the built-in ones are elsewhere.
    await changeAgent();
    const onCodex = await agentRows();
    expect(onCodex[1]?.detail).toBe("Anthropic · continues from a summary");
    await pick("Other Fake");
    await sessionAgent("Other Fake");
    await inspector();
    await shownAgent("Other Fake");
    // The conversation continues on the switched agent.
    await run(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'still here'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return dock()?.textContent.includes('You said: still here');`,
      "reply after the switch",
    );
  });
});
