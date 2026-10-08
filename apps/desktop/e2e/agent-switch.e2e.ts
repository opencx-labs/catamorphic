import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Picking a chat's agent from its status popup, before the chat starts and
 * after (ADR 0214, lib/agent-switch). Before, any agent takes the chat.
 * After, one on its harness does, and one on another harness starts a new
 * chat: the conversation is never handed to it. Two seeded agents share the
 * built-in harness; a third runs on Codex.
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
const agentRows = (ready = "true") =>
  wait<{ name: string; enabled: boolean; detail: string }[]>(
    `const names = ['Fake Agent', 'Other Fake', 'Codex Fake'];
     const options = $$('[role="option"]').filter(el => !el.closest('[inert]'));
     if (!options.some(row => row.textContent.includes('Codex Fake'))) return false;
     const rows = options.flatMap(row => {
       const name = names.find(candidate => row.textContent.includes(candidate));
       return name ? [{
         name,
         enabled: row.getAttribute('aria-disabled') !== 'true',
         detail: row.textContent.replace(name, '').replace('current', '').trim(),
       }] : [];
     });
     return (${ready}) ? rows : false;`,
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

describe("picking a chat's agent", () => {
  it("takes any agent before the chat starts, after only its harness's, the rest in a new chat", async () => {
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

    // Before the first message: every agent simply takes the chat.
    await inspector();
    await shownAgent("Fake Agent");
    await changeAgent();
    const before = await agentRows();
    expect(before.map((row) => [row.name, row.enabled])).toEqual([
      ["Fake Agent", true],
      ["Other Fake", true],
      ["Codex Fake", true],
    ]);
    expect(before.some((row) => row.detail.includes("new chat"))).toBe(false);
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

    // The conversation starts on the built-in harness, which binds it.
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
    const session = (id = "window.__switch.id") =>
      run<{ agent: string; harness: string | null }>(
        `const {base, agents} = window.__switch; const session = await fetch(base + '/' + ${id}).then(r => r.json());
         return { agent: agents.find(agent => agent.id === session.agentId)?.name, harness: session.harness };`,
      );
    expect(await session()).toEqual({ agent: "Fake Agent", harness: "ai-sdk" });

    // Started: the agent on its harness takes it; Codex's row starts a new chat.
    await changeAgent();
    const after = await agentRows(
      `rows.some(row => row.name === 'Codex Fake' && row.detail.includes('new chat'))`,
    );
    expect(after.map((row) => [row.name, row.enabled])).toEqual([
      ["Fake Agent", true],
      ["Other Fake", true],
      ["Codex Fake", true],
    ]);
    expect(after[1]?.detail).not.toContain("new chat");
    expect(after[2]?.detail).toBe("Codex · starts a new chat");
    await pick("Other Fake");
    await wait(
      `return dock()?.textContent.includes('Switched to Other Fake');`,
      "switch notice",
    );
    expect(await session()).toEqual({ agent: "Other Fake", harness: "ai-sdk" });
    await inspector();
    await shownAgent("Other Fake");

    // Core refuses the conversation to another harness, whoever asks.
    const refused = await run<{ status: number; code: string }>(
      `const {base, id, agents} = window.__switch;
       const codex = agents.find(agent => agent.name === 'Codex Fake');
       const response = await fetch(base + '/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: codex.id }) });
       return { status: response.status, code: (await response.json()).code };`,
    );
    expect(refused).toEqual({ status: 409, code: "harness_fixed" });

    // Picking Codex opens a new chat with it; this one stays as it was.
    await changeAgent();
    await pick("Codex Fake");
    await wait(
      `const current = dock(); return !!current && !current.textContent.includes('You said: hello agent') && !!current.querySelector('[data-composer-input]');`,
      "new chat",
    );
    await inspector();
    await shownAgent("Codex Fake");
    await run(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'hello codex'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return dock()?.textContent.includes('You said: hello codex');`,
      "reply in the new chat",
    );
    const codexChat = await run<string>(
      `const sessions = await fetch(window.__switch.base).then(r => r.json());
       return sessions.items.find(item => item.id !== window.__switch.id)?.id;`,
    );
    expect(await session(JSON.stringify(codexChat))).toEqual({
      agent: "Codex Fake",
      harness: "codex",
    });
    expect(await session()).toEqual({ agent: "Other Fake", harness: "ai-sdk" });
  });
});
