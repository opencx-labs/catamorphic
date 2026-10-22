import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/** A chat keeps its identity and history across agent and harness changes. */
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
  it("switches agents and harnesses in place before and after the chat starts", async () => {
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
      `await window.catamorphicDesktop.agentsCreate({ name: 'Codex Fake', harness: 'codex', effort: 'low' });`,
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
    await run(`$('[aria-label="Change reasoning"]').click();`);
    await wait(
      `const row = $('[data-item-id="pick:effort:high"]'); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return true;`,
      "set draft effort",
    );
    await inspector();
    await wait(
      `return $('[aria-label="Change reasoning"]')?.textContent.trim() === 'high';`,
      "draft effort shown",
    );
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

    // Every row switches the existing chat, including Codex.
    await changeAgent();
    const after = await agentRows();
    expect(after.map((row) => [row.name, row.enabled])).toEqual([
      ["Fake Agent", true],
      ["Other Fake", true],
      ["Codex Fake", true],
    ]);
    expect(after[1]?.detail).not.toContain("new chat");
    expect(after[2]?.detail).not.toContain("new chat");
    await pick("Other Fake");
    await wait(
      `return dock()?.textContent.includes('Switched to Other Fake');`,
      "switch notice",
    );
    expect(await session()).toEqual({ agent: "Other Fake", harness: "ai-sdk" });
    await inspector();
    await shownAgent("Other Fake");

    // A different harness continues in the same surface and session.
    await changeAgent();
    await pick("Codex Fake");
    await wait(
      `const current = dock(); return !!current && current.textContent.includes('You said: hello agent') && current.textContent.includes('Switched to Codex Fake');`,
      "same chat after harness switch",
    );
    await inspector();
    await shownAgent("Codex Fake");
    await wait(
      `return $('[aria-label="Change reasoning"]')?.textContent.trim() === 'low';`,
      "new agent default replaces draft effort",
    );
    await run(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'hello codex'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return dock()?.textContent.includes('You said: hello codex');`,
      "reply in the same chat",
    );
    expect(await session()).toEqual({ agent: "Codex Fake", harness: "codex" });
    expect(
      await run(
        `const sessions = await fetch(window.__switch.base).then(r => r.json()); return sessions.items.map(item => item.id);`,
      ),
    ).toEqual([await run(`return window.__switch.id;`)]);
    await changeAgent();
    await pick("Fake Agent");
    await wait(
      `return dock()?.textContent.includes('Switched to Fake Agent');`,
      "switch back notice",
    );
    await run(
      `const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'back again'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return dock()?.textContent.includes('You said: back again');`,
      "reply after switching back",
    );
    expect(await session()).toEqual({ agent: "Fake Agent", harness: "ai-sdk" });
    expect(
      await run(
        `return dock().textContent.includes('You said: hello agent') && dock().textContent.includes('You said: hello codex');`,
      ),
    ).toBe(true);
  });

  it("explains why the busy model cannot change on hover, then allows a pick while idle", async () => {
    await run(
      `const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'slowly wait for interruption'); input.closest('form').requestSubmit();`,
    );
    await wait(
      `return !!dock()?.querySelector('[data-testid="chat-stop"]');`,
      "turn running",
    );
    try {
      await inspector();
      const point = await wait<{ x: number; y: number }>(
        `
        const model = $('[aria-label="Change model"]'); if (!model?.disabled) return false;
        const r = model.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 };
      `,
        "busy model disabled",
      );
      await app.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await wait(
        `return $$('[role="tooltip"]').some(el => el.textContent === 'Finish the current turn to change the model.');`,
        "model hover explains why",
      );
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(),
          "model-disabled-reason.png",
        ),
      );
      for (const type of ["mousePressed", "mouseReleased"])
        await app.cdp("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
      expect(
        await run(
          `return $$('[role="option"]').filter(el => !el.closest('[inert]')).length;`,
        ),
      ).toBe(0);
    } finally {
      await run(
        `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); dock()?.querySelector('[data-testid="chat-stop"]')?.click();`,
      );
    }
    await wait(
      `return !dock()?.querySelector('[data-testid="chat-stop"]');`,
      "turn stopped",
    );
    await inspector();
    await wait(
      `const model = $('[aria-label="Change model"]'); if (!model || model.disabled) return false; model.click(); return true;`,
      "idle model picker",
    );
    await wait(
      `const row = $('[data-item-id="pick:model:fake-model-b"]'); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); return true;`,
      "pick a model while idle",
    );
    await wait(
      `const s = await fetch(window.__switch.base+'/'+window.__switch.id).then(r=>r.json()); return s.model === 'fake-model-b';`,
      "session model updated",
    );
  });

  it("uses each subsession's harness icon and follows a changed agent", async () => {
    await run(`const {base,id,agents} = window.__switch;
      const codex = agents.find(agent=>agent.name==='Codex Fake');
      const response = await fetch(base, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({parentSessionId:id,agentId:codex.id,title:'Codex child'})});
      if (!response.ok) throw new Error(await response.text());
      window.__switch.child = (await response.json()).id;
    `);
    await wait(
      `const chip = $$('[data-testid="chip"][data-kind="subagent"]').find(el=>el.textContent.includes('Codex child')); return !!chip?.querySelector('[data-harness-icon="openai"]');`,
      "Codex subsession icon",
    );
    await run(`const agent = await window.catamorphicDesktop.agentsCreate({name:'Claude Fake',harness:'claude-code'});
      const {base,child}=window.__switch;
      const response=await fetch(base+'/'+child,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:agent.id})});
      if(!response.ok) throw new Error(await response.text());
    `);
    await wait(
      `const chip = $$('[data-testid="chip"][data-kind="subagent"]').find(el=>el.textContent.includes('Codex child')); return !!chip?.querySelector('[data-harness-icon="claude"]');`,
      "changed subsession icon",
    );
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(),
        "subsession-harness-icon.png",
      ),
    );
  });

  it("refreshes subsession icons for new and edited project agents", async () => {
    const project = await run<{ id: string; root: string }>(`
      const id = window.__switch.base.split('/projects/')[1].split('/')[0];
      return {id, root: await window.catamorphicDesktop.projectRoot(id)};
    `);
    const agentPath = `${PROJECT_AGENTS_DIR}/chip-helper.json`;
    const definition = path.join(project.root, agentPath);
    fs.mkdirSync(path.dirname(definition), { recursive: true });
    const writeDefinition = (kind: string) =>
      fs.writeFileSync(
        definition,
        JSON.stringify({
          version: 1,
          name: "Chip Helper",
          kind,
          credentials: { source: "profile" },
        }),
      );
    writeDefinition("codex");
    await run(`const {base,child}=window.__switch;
      const response=await fetch(base+'/'+child,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:${JSON.stringify(`project:${project.id}:chip-helper`)}})});
      if(!response.ok) throw new Error(await response.text());
    `);
    await wait(
      `const chip = $$('[data-testid="chip"][data-kind="subagent"]').find(el=>el.textContent.includes('Codex child')); return !!chip?.querySelector('[data-harness-icon="openai"]');`,
      "new project agent icon",
    );
    writeDefinition("claude-code");
    await run(`await window.catamorphicDesktop.gitRecord({
      projectId:${JSON.stringify(project.id)},
      message:'Change project agent harness',
      paths:[${JSON.stringify(agentPath)}],
    });`);
    await wait(
      `const chip = $$('[data-testid="chip"][data-kind="subagent"]').find(el=>el.textContent.includes('Codex child')); return !!chip?.querySelector('[data-harness-icon="claude"]');`,
      "edited project agent icon",
    );
  });
});

import fs from "node:fs";
import { PROJECT_AGENTS_DIR } from "@catamorphic/workflow/project-layout";
