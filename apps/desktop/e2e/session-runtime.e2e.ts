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
  const dock = () => {
    const candidates = $$('section[data-chat-local-id]').filter(el => !el.closest('[inert]') && el.getBoundingClientRect().width > 0 && el.querySelector('[data-composer-input]'));
    return candidates.find(el => el.dataset.floatingChat === 'true') ?? candidates[0];
  };
  ${setReactValueJs}
`;
const run = (body: string) =>
  app.eval(`(async () => { ${helpers} ${body} })()`);
const wait = (body: string) =>
  app.waitFor(`(async () => { ${helpers} ${body} })()`);
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
  // Navigate like a user: pointerdown on status dismisses any other hover
  // card. Waiting for every unrelated card to disappear can hang while the
  // pointer remains over a sidebar/project trigger after onboarding.
  const point = await app.waitFor<{ x: number; y: number }>(`(() => { ${helpers}
    const button = dock()?.querySelector('[aria-label^="Session status:"]');
    if (!button || button.closest('[inert]')) return false;
    const rect = button.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
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
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform), bubbles: true }));`,
    );
    await wait(`return !!dock()?.querySelector('[data-composer-input]');`);
    await run(
      `window.__draftAgentDefaults = await window.catamorphicDesktop.agentsList();`,
    );
    await inspector();
    await run(`$('[aria-label="Change model"]').click();`);
    await pick("Fake Model B");
    await inspector();
    await run(`$('[aria-label="Change reasoning"]').click();`);
    await pick("High effort");
    expect(
      await run(
        `return JSON.stringify(await window.catamorphicDesktop.agentsList()) === JSON.stringify(window.__draftAgentDefaults);`,
      ),
    ).toBe(true);
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
    await wait(
      `const {base,id} = window.__runtimeTest; const session = await fetch(base + '/' + id).then(r => r.json()); return session.model === 'fake-model-b' && session.modelEffort === 'high';`,
    );
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
      `const chat = $$('button').find(el => el.textContent.trim() === 'Quick chat'); if (!chat) return false; chat.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,altKey:true})); return true;`,
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
      `const model = $('[aria-label="Change model"]'); return !!model && !model.textContent.includes('fake-model-b');`,
    );
  });
});

it("keeps environment controls in status and dismisses connections by clicking outside", async () => {
  await app.press("Escape");
  await wait(`return !$('[data-testid="resource-inspector"]');`);
  // The floating title and status controls share one centered layout row.
  expect(
    await run(`const row = dock().querySelector('[data-testid="chat-status-chrome"]').getBoundingClientRect();
    const controls = dock().querySelector('[data-testid="chat-status-controls"]').getBoundingClientRect();
    return Math.abs((row.top + row.bottom) / 2 - (controls.top + controls.bottom) / 2);`),
  ).toBeLessThan(1);
  expect(
    await run(
      `return !!dock().querySelector('[data-testid="chat-environment-badge"], [aria-label="Manage environment connections"]');`,
    ),
  ).toBe(false);
  for (const theme of ["light", "dark"]) {
    await run(
      `await window.catamorphicDesktop.setTheme({ selection: '${theme}', overrides: {} });`,
    );
    await wait(`return document.documentElement.dataset.theme === '${theme}';`);
    await inspector();
    await wait(
      `return !!$('[data-testid="session-inspector-content"] [data-testid="chat-environment-badge"]') && !!$('[aria-label="Manage environment connections"]');`,
    );
    if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT) {
      await wait(
        `return getComputedStyle($('[data-testid="resource-inspector"]')).opacity === '1';`,
      );
      await app.screenshot(
        `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-${theme}.png`,
      );
    }
    await run(`$('[aria-label="Manage environment connections"]').click();`);
    await wait(
      `return !!$('[aria-labelledby="environment-connections-title"]') && !$('[data-testid="resource-inspector"]');`,
    );
    if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT) {
      await app.screenshot(
        `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-${theme}-connections.png`,
      );
    }
    // CDP uses Chromium's actual hit testing, including inherited pointer-events.
    // A synthetic click would pass even with a non-interactive backdrop.
    const point = await app.eval<{ x: number; y: number }>(`(() => {
      const panel = document.querySelector('[aria-labelledby="environment-connections-title"]').getBoundingClientRect();
      return { x: panel.left - 20, y: panel.top + panel.height / 2 };
    })()`);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await wait(
      `return !$('[aria-labelledby="environment-connections-title"]');`,
    );
    expect(await run(`return !!dock();`)).toBe(true);
  }
  await run(`dock().querySelector('[aria-label="Open as tab"]').click();`);
  await wait(
    `return !!dock()?.querySelector('[aria-label="Pop out to floating chat"]');`,
  );
  await wait(
    `return !document.getAnimations().some(a => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);`,
  );
  await inspector();
  await wait(`return !!$('[aria-label="Manage environment connections"]');`);
  if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT) {
    await wait(
      `return getComputedStyle($('[data-testid="resource-inspector"]')).opacity === '1';`,
    );
    await app.screenshot(
      `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-tab.png`,
    );
  }
});

it("uses themed harness marks in new-chat status", async () => {
  await app.press("Escape");
  for (const [harness, provider, brand] of [
    ["codex", "openai", "openai"],
    ["claude-code", "anthropic", "claude"],
    ["ai-sdk", "openrouter", "openrouter"],
  ]) {
    await run(`const agent = await window.catamorphicDesktop.agentsCreate({ name: '${brand} agent', harness: '${harness}', provider: '${provider}' });
      await window.catamorphicDesktop.agentsSetDefault(agent.id);`);
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform), bubbles: true }));`,
    );
    await wait(
      `return !!dock()?.querySelector('[data-harness-icon="${brand}"]');`,
    );
    for (const theme of ["light", "dark"]) {
      await run(
        `await window.catamorphicDesktop.setTheme({ selection: '${theme}', overrides: {} });`,
      );
      await wait(
        `return document.documentElement.dataset.theme === '${theme}' && !document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);`,
      );
      expect(
        await run(`const icon = dock().querySelector('[data-harness-icon="${brand}"]'); const style = getComputedStyle(icon);
        return { mask: style.maskImage, background: style.backgroundColor, color: style.color };`),
      ).toMatchObject({
        mask: expect.stringContaining("url("),
        background: expect.not.stringMatching(/rgba\(0, 0, 0, 0\)/),
      });
      if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT) {
        await app.screenshot(
          `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-${brand}-${theme}.png`,
        );
      }
    }
    await run(`dock().querySelector('[aria-label="Close chat"]').click();`);
    await wait(`return !$('section[data-floating-chat="true"]');`);
  }
});

it("centers expanded chats on request and drags the collapsed bubble between bottom corners", async () => {
  await run(`const { agents } = await window.catamorphicDesktop.agentsList();
    await window.catamorphicDesktop.agentsSetDefault(agents.find(agent => agent.name === 'Fake Agent').id);
    await window.catamorphicDesktop.setPrefs({dockSide:'right',dockAlignment:'center'});
    window.dispatchEvent(new KeyboardEvent('keydown', {key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));`);
  await wait(`return !!dock();`);
  await wait(
    `const button=$('[aria-label="Expand chat bubbles"]'); if(button && !button.inert) button.click(); return $('[data-dock-rail]')?.dataset.dockCollapsed === 'false';`,
  );
  await wait(`const host=$('[data-dock-host]').getBoundingClientRect(), rail=$('[data-dock-rail]').getBoundingClientRect(), chat=dock().getBoundingClientRect();
    return Math.abs((rail.left+rail.right-host.left-host.right)/2)<2 && Math.abs((chat.left+chat.right-host.left-host.right)/2)<2;`);
  if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT)
    await app.screenshot(
      `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-dock-center.png`,
    );
  await run(
    `await window.catamorphicDesktop.setPrefs({dockAlignment:'edge'});`,
  );
  await wait(
    `const host=$('[data-dock-host]').getBoundingClientRect(), chat=dock().getBoundingClientRect(); return host.right-chat.right < 40;`,
  );
  if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT)
    await app.screenshot(
      `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-dock-edge.png`,
    );
  await run(`$('[aria-label="Collapse chat bubbles"]').click();`);
  await wait(
    `return $('[data-dock-rail]')?.dataset.dockCollapsed === 'true' && !document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity);`,
  );
  for (const side of ["left", "right"]) {
    const point = await app.eval<{
      x: number;
      y: number;
      target: number;
    }>(`(() => {
      const box=document.querySelector('[aria-label="Expand chat bubbles"]').getBoundingClientRect();
      const host=document.querySelector('[data-dock-host]').getBoundingClientRect();
      return {x:box.left+box.width/2,y:box.top+box.height/2,target:${JSON.stringify(side)}==='left'?host.left+80:host.right-80};})()`);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.target,
      y: point.y,
      button: "left",
      buttons: 1,
    });
    await wait(
      `return $('[data-dock-rail]')?.dataset.dockDragging === 'true';`,
    );
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.target,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await wait(`const rail=$('[data-dock-rail]'), host=$('[data-dock-host]'); const box=rail.getBoundingClientRect(), bounds=host.getBoundingClientRect();
      return rail.dataset.dockCollapsed==='true' && host.dataset.dockSide===${JSON.stringify(side)} && Math.abs((${JSON.stringify(side)}==='left'?box.left-bounds.left:bounds.right-box.right)-32)<2;`);
  }
  // Escape cancels a drag, and neither dragging nor canceling expands the dock.
  const point = await app.eval<{ x: number; y: number }>(
    `(() => {const b=document.querySelector('[aria-label="Expand chat bubbles"]').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`,
  );
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x - 100,
    y: point.y,
    button: "left",
    buttons: 1,
  });
  await app.press("Escape");
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x - 100,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await wait(
    `return $('[data-dock-rail]')?.dataset.dockCollapsed==='true' && !$('[data-dock-dragging]') && $('[data-dock-host]').dataset.dockSide==='right';`,
  );
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  expect(
    await run(
      `return getComputedStyle($('[data-dock-rail]')).transitionDuration;`,
    ),
  ).toBe("0s");
  await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  await run(`$('[aria-label="Expand chat bubbles"]').click();`);
  await wait(`return $('[data-dock-rail]')?.dataset.dockCollapsed==='false';`);
  await run(`$('[aria-label="Collapse chat bubbles"]').click();`);
  await wait(`return $('[data-dock-rail]')?.dataset.dockCollapsed==='true';`);
  await run(`$('[aria-label="Expand chat bubbles"]').focus();`);
  await app.press("ArrowLeft");
  await wait(`return $('[data-dock-host]')?.dataset.dockSide==='left';`);
  await run(`window.location.reload();`);
  await wait(
    `return $('[data-dock-host]')?.dataset.dockSide==='left' && $('[data-dock-host]')?.dataset.dockAlignment==='edge';`,
  );
});
