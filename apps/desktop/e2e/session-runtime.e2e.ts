import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
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
      `const button = $$('button').find(el => el.textContent.includes('Create or import project')); if (!button) return false; button.click(); return true;`,
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
    // Nothing pinned: before the first message, the inspector names the
    // model the harness itself would run, by the id it sends, marked as
    // its default.
    await wait(
      `const model = $('[aria-label="Change model"]'); return !!model && model.textContent.includes('fake-model-a-2.1') && model.textContent.includes('default');`,
    );
    await run(`$('[aria-label="Change model"]').click();`);
    await pick("Fake Model B");
    await inspector();
    await wait(
      `const model = $('[aria-label="Change model"]'); return !!model && model.textContent.trim() === 'fake-model-b';`,
    );
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
    await app.reload();
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
      `const model = $('[aria-label="Change model"]'); return !!model && model.textContent.includes('fake-model-a-2.1') && model.textContent.includes('default');`,
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
  await wait(`return !!$('[data-workspace-ready]');`);
  await run(`const { agents } = await window.catamorphicDesktop.agentsList();
    await window.catamorphicDesktop.agentsSetDefault(agents.find(agent => agent.name === 'Fake Agent').id);
    await window.catamorphicDesktop.setPrefs({dockSide:'right',dockPlacement:'center'});
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
    `await window.catamorphicDesktop.setPrefs({dockPlacement:'right'});`,
  );
  await wait(
    `const host=$('[data-dock-host]').getBoundingClientRect(), chat=dock().getBoundingClientRect(); return host.right-chat.right < 40;`,
  );
  if (process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT)
    await app.screenshot(
      `${process.env.CATAMORPHIC_INSPECTOR_SCREENSHOT}-dock-edge.png`,
    );
  // Dragging the strip to a new placement collapses the open chat as the
  // drag starts, with the minimize animation, instead of leaving it in
  // place to snap over when the drag ends.
  await wait(
    `return !document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity);`,
  );
  const handle = await app.eval<{ x: number; y: number; target: number }>(
    `(() => {const b=document.querySelector('[data-dock-arrows]').getBoundingClientRect(), h=document.querySelector('[data-dock-host]').getBoundingClientRect();
      return {x:b.left+b.width/2,y:b.top+b.height/2,target:h.left+h.width/6};})()`,
  );
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: handle.x,
    y: handle.y,
    button: "left",
    clickCount: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: handle.x - 40,
    y: handle.y,
    button: "left",
    buttons: 1,
  });
  await wait(
    `return $('[data-dock-rail]')?.dataset.dockDragging === 'true' && !!$('section[data-floating-chat].animate-dock-out');`,
  );
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: handle.target,
    y: handle.y,
    button: "left",
    buttons: 1,
  });
  await wait(`return !$('section[data-floating-chat="true"]');`);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: handle.target,
    y: handle.y,
    button: "left",
    clickCount: 1,
  });
  await wait(
    `return $('[data-dock-host]')?.dataset.dockPlacement==='left' && !$('[data-dock-dragging]') && !$('section[data-floating-chat="true"]');`,
  );
  await run(
    `await window.catamorphicDesktop.setPrefs({dockPlacement:'right'});`,
  );
  await wait(`return $('[data-dock-host]')?.dataset.dockPlacement==='right';`);
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
    Number.parseFloat(
      String(
        await run(
          `return getComputedStyle($('[data-dock-rail]')).transitionDuration;`,
        ),
      ),
    ),
  ).toBeLessThanOrEqual(0.001);
  await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  await run(`$('[aria-label="Expand chat bubbles"]').click();`);
  await wait(`return $('[data-dock-rail]')?.dataset.dockCollapsed==='false';`);
  await run(`$('[aria-label="Collapse chat bubbles"]').click();`);
  await wait(`return $('[data-dock-rail]')?.dataset.dockCollapsed==='true';`);
  await run(`$('[aria-label="Expand chat bubbles"]').focus();`);
  await app.press("ArrowLeft");
  await wait(`return $('[data-dock-host]')?.dataset.dockSide==='left';`);
  await app.reload();
  // The side, the placement and the person's fold all outlast a reload.
  await wait(
    `return $('[data-dock-host]')?.dataset.dockSide==='left' && $('[data-dock-host]')?.dataset.dockPlacement==='right' && $('[data-dock-rail]')?.dataset.dockCollapsed==='true';`,
  );
});

it("lands a dragged strip after a short drag, and slides it back when let go near its start", async () => {
  await run(
    `await window.catamorphicDesktop.setPrefs({dockPlacement:'left'});`,
  );
  await wait(
    `const button=$('[aria-label="Expand chat bubbles"]'); if(button && !button.inert) button.click(); return $('[data-dock-rail]')?.dataset.dockCollapsed === 'false' && $('[data-dock-host]')?.dataset.dockPlacement==='left';`,
  );
  const settled = () =>
    wait(
      `return !document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity);`,
    );
  /** Drag the strip's handle by dx and let go; resolves once it has slid. */
  const drag = async (dx: number) => {
    await settled();
    const handle = await app.eval<{ x: number; y: number }>(
      `(() => {const b=document.querySelector('[data-dock-arrows]').getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2};})()`,
    );
    await run(`const rail=$('[data-dock-rail]'); const animate=rail.animate.bind(rail);
      window.__dockSlid=false; rail.animate=(...args)=>{window.__dockSlid=true; return animate(...args);};`);
    const move = (
      x: number,
      type: "mousePressed" | "mouseMoved" | "mouseReleased",
    ) =>
      app.cdp("Input.dispatchMouseEvent", {
        type,
        x,
        y: handle.y,
        button: "left",
        ...(type === "mouseMoved" ? { buttons: 1 } : { clickCount: 1 }),
      });
    await move(handle.x, "mousePressed");
    await move(handle.x + Math.sign(dx) * 10, "mouseMoved");
    await move(handle.x + dx, "mouseMoved");
    await wait(
      `return $('[data-dock-rail]')?.dataset.dockDragging === 'true';`,
    );
    await move(handle.x + dx, "mouseReleased");
    await wait(
      `return !$('[data-dock-dragging]') && window.__dockSlid === true;`,
    );
  };
  // 45% of the way from its spot to the centre is enough to land there.
  await settled();
  const way = await app.eval<number>(
    `(() => {const h=document.querySelector('[data-dock-host]').getBoundingClientRect(), r=document.querySelector('[data-dock-rail]').getBoundingClientRect(); return h.width/2-(r.left-h.left+r.width/2);})()`,
  );
  await drag(Math.round(way * 0.45));
  await wait(`return $('[data-dock-host]')?.dataset.dockPlacement==='center';`);
  // Let go near where it started (well short of 40% of the way), it slides
  // back there instead of jumping.
  await drag(Math.max(20, Math.round(way * 0.15)));
  expect(await run(`return $('[data-dock-host]').dataset.dockPlacement;`)).toBe(
    "center",
  );
  await settled();
  expect(
    await run(`const h=$('[data-dock-host]').getBoundingClientRect(), r=$('[data-dock-rail]').getBoundingClientRect();
      return Math.round(Math.abs((r.left+r.right-h.left-h.right)/2));`),
  ).toBeLessThanOrEqual(1);
});

it("keeps the person's fold of the strip through a chat tab, beside an open chat and across a reload", async () => {
  const collapsed = (value: boolean) =>
    wait(
      `return $('[data-dock-rail]')?.dataset.dockCollapsed === '${value}' && !document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity);`,
    );
  const showTab = (key: string) =>
    run(
      `$$('[data-tab-orientation] [data-point-key]').find((tab) => tab.dataset.pointKey.startsWith(${JSON.stringify(key)}))?.querySelector('button')?.click();`,
    );
  // A page to return to, and a chat in a tab of its own.
  await run(
    `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Settings')?.click();`,
  );
  await wait(
    `return !!$('[data-tab-orientation] [data-point-key^="settings:"]');`,
  );
  await run(
    `window.dispatchEvent(new KeyboardEvent('keydown', {key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));`,
  );
  await wait(`return !!dock()?.querySelector('[aria-label="Open as tab"]');`);
  await run(`dock().querySelector('[aria-label="Open as tab"]').click();`);
  await wait(`return !!$('[data-tab-orientation] [data-point-key^="chat:"]');`);
  // On the page, the person folds the strip.
  await showTab("settings:");
  await run(
    `const button=$('[aria-label="Expand chat bubbles"]'); if(button && !button.inert) button.click();`,
  );
  await collapsed(false);
  await run(`$('[aria-label="Collapse chat bubbles"]').click();`);
  await collapsed(true);
  // The chat tab folds it too; leaving that tab keeps the person's fold
  // (it used to open the strip a beat after the page tab took over).
  const shown = (key: string) =>
    wait(
      `return !!$('[data-tab-orientation] [data-point-key^="${key}"] [aria-current="true"]');`,
    );
  await showTab("chat:");
  await shown("chat:");
  await collapsed(true);
  await showTab("settings:");
  await shown("settings:");
  await new Promise((resolve) => setTimeout(resolve, 600));
  await collapsed(true);
  // A chat opened keeps the strip open beside it; minimized, the fold returns.
  await run(
    `window.dispatchEvent(new KeyboardEvent('keydown', {key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));`,
  );
  await wait(
    `return dock()?.dataset.floatingChat === 'true' && $('[data-dock-rail]')?.dataset.dockCollapsed === 'false';`,
  );
  // A chat with a message minimizes (an empty one would close).
  await run(`const composer = dock().querySelector('[data-composer-input]');
    setReactValue(composer, 'hello strip');
    composer.closest('form').requestSubmit();`);
  await wait(
    `return !!dock()?.querySelector('[aria-label="Minimize chat to bubble"]');`,
  );
  await run(
    `dock().querySelector('[aria-label="Minimize chat to bubble"]').click();`,
  );
  await wait(`return !$('section[data-floating-chat="true"]');`);
  await collapsed(true);
  // Saved: a reload, or any other window of the profile, shows it folded.
  await app.reload();
  await collapsed(true);
  // Dragging the arrows of the strip shown open beside a chat is using it
  // open: it lands where it was dropped and stays open, not folded mid-drag.
  await run(
    `window.dispatchEvent(new KeyboardEvent('keydown', {key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));`,
  );
  await wait(
    `return dock()?.dataset.floatingChat === 'true' && $('[data-dock-rail]')?.dataset.dockCollapsed === 'false' && !document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity);`,
  );
  const from = await app.eval<{ x: number; y: number; placement: string }>(
    `(() => { const b = document.querySelector('[data-dock-arrows]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, placement: document.querySelector('[data-dock-host]').dataset.dockPlacement }; })()`,
  );
  const to = from.x + (from.placement === "left" ? 400 : -400);
  const mouse = (type: string, x: number) =>
    app.cdp("Input.dispatchMouseEvent", {
      type,
      x,
      y: from.y,
      button: "left",
      ...(type === "mouseMoved" ? { buttons: 1 } : { clickCount: 1 }),
    });
  await mouse("mousePressed", from.x);
  for (const step of [0.1, 0.4, 0.7, 1]) {
    await mouse("mouseMoved", from.x + (to - from.x) * step);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await wait(
    `return $('[data-dock-rail]')?.dataset.dockCollapsed === 'false';`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(
    await run(`return $('[data-dock-rail]')?.dataset.dockCollapsed;`),
  ).toBe("false");
  await mouse("mouseReleased", to);
  await wait(
    `return !$('[data-dock-dragging]') && $('[data-dock-host]')?.dataset.dockPlacement !== ${JSON.stringify(from.placement)};`,
  );
  await collapsed(false);
  await app.reload();
  await collapsed(false);
});

it("folds the strip into its corner in one motion, beside a leaving chat or alone", async () => {
  const idle = `!document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity)`;
  await run(
    `await window.catamorphicDesktop.setPrefs({dockSide:'right',dockPlacement:'center',dockCollapsed:false});`,
  );
  await wait(
    `return $('[data-dock-host]')?.dataset.dockPlacement==='center' && $('[data-dock-rail]')?.dataset.dockCollapsed==='false' && ${idle};`,
  );
  // A floating chat with a message, so folding minimizes it.
  if (!(await run(`return dock()?.dataset.floatingChat === 'true';`))) {
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown', {key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));`,
    );
    await wait(`return dock()?.dataset.floatingChat === 'true';`);
  }
  await run(`const composer = dock().querySelector('[data-composer-input]');
    setReactValue(composer, 'fold beside me');
    composer.closest('form').requestSubmit();`);
  await wait(
    `return dock()?.textContent.includes('You said: fold beside me') && ${idle};`,
  );
  const read = <T>(body: string) =>
    app.eval<T>(`(async () => { ${helpers} ${body} })()`);
  const chatId = await read<string>(`return dock().dataset.chatLocalId;`);
  const chatSection = `$('section[data-chat-local-id=${JSON.stringify(chatId)}]')`;
  type Frame = {
    t: number;
    folded: boolean;
    left: number;
    right: number;
    width: number;
    /** The chat's opacity, as it leaves. */
    chat: number | null;
    /** The chats whose dock rendered since the frame before. */
    rendered: string[];
    /** Renders of the dock host since the frame before (for the log). */
    host: number;
  };
  /**
   * Every frame of the strip from the press until it rests, with the
   * renders of every chat's dock (its content component, read from React's
   * fibers: each render gives it a new first hook; a skipped one keeps it).
   */
  const record = async (folded: boolean, act: () => Promise<unknown>) => {
    // Its own loop only: a loop from the recording before, still waiting
    // for its next frame, stops instead of joining this one.
    await run(`window.__fold = [];
      const recording = window.__foldRecording = (window.__foldRecording ?? 0) + 1;
      const fiberOf = (element) => element[Object.keys(element).find((key) => key.startsWith('__reactFiber$'))];
      const heads = (element) => {
        let fiber = fiberOf(element);
        while (fiber && typeof fiber.type !== 'function') fiber = fiber.return;
        return fiber ? [fiber.memoizedState, fiber.alternate?.memoizedState].filter(Boolean) : [];
      };
      const docks = () => $$('section[data-chat-local-id]').map((section) => ({ id: section.dataset.chatLocalId, heads: heads(section) }));
      const seen = new Set([...docks().flatMap((dock) => dock.heads), ...heads($('[data-dock-host]'))]);
      const tick = (t) => {
        if (!window.__fold || window.__foldRecording !== recording) return;
        const rendered = [];
        for (const dock of docks()) {
          for (const head of dock.heads) {
            if (seen.has(head)) continue;
            seen.add(head);
            rendered.push(dock.id);
          }
        }
        let host = 0;
        for (const head of heads($('[data-dock-host]'))) {
          if (seen.has(head)) continue;
          seen.add(head);
          host++;
        }
        const rail = $('[data-dock-rail]').getBoundingClientRect();
        const chat = ${chatSection};
        window.__fold.push({ t, folded: $('[data-dock-rail]').dataset.dockCollapsed === 'true', left: rail.left, right: rail.right, width: rail.width, chat: chat ? Number(getComputedStyle(chat).opacity) : null, rendered, host });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);`);
    await wait(`return window.__fold.length >= 2;`);
    await act();
    await wait(
      `return window.__fold.at(-1)?.folded === ${folded} && (${!folded} || !$('section[data-floating-chat="true"]')) && ${idle};`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    return read<Frame[]>(
      `const frames = window.__fold; window.__fold = null; return frames;`,
    );
  };
  /**
   * Each chat's dock renders at most once, for the press that starts the
   * motion, and never while the strip moves: a render there stalls the
   * width and padding transitions while the slide goes on.
   */
  const rendersOnce = (frames: Frame[]) => {
    const counts = new Map<string, number>();
    for (const frame of frames)
      for (const id of frame.rendered)
        counts.set(id, (counts.get(id) ?? 0) + 1);
    // When each frame came and which docks had rendered by it, should one
    // render more than once.
    const start = frames[0]?.t ?? 0;
    const log = JSON.stringify(
      frames.map((frame) => [
        Math.round(frame.t - start),
        frame.folded,
        frame.host,
        frame.rendered,
      ]),
    );
    // The count is read (the press re-renders the docks once).
    expect(counts.size, log).toBeGreaterThan(0);
    expect(Math.max(...counts.values()), log).toBe(1);
  };
  const corner = () =>
    read<number>(
      `return $('[data-dock-host]').getBoundingClientRect().right - 32;`,
    );
  /**
   * The strip moves between its spot and its corner as one motion: its
   * edge toward where it goes and its width both make steady progress from
   * the first frame that moves, in step with each other, with no frame
   * where it stops short of where it lands or snaps on landing.
   */
  const oneMotion = (frames: Frame[]) => {
    const start = frames.findIndex(
      (frame) => frame.folded !== frames[0]?.folded,
    );
    expect(start).toBeGreaterThan(0);
    const from = frames[start - 1];
    const to = frames.at(-1);
    if (!from || !to) throw new Error("no frames");
    const travel = to.right - from.right;
    const narrowing = from.width - to.width;
    expect(Math.abs(travel)).toBeGreaterThan(40);
    expect(Math.abs(narrowing)).toBeGreaterThan(40);
    let still = 0;
    let moved = false;
    for (const [index, frame] of frames.slice(start).entries()) {
      const previous = frames[start + index - 1] ?? from;
      // Never back the way it came, never a width it has left behind.
      expect(
        (frame.right - previous.right) * Math.sign(travel),
      ).toBeGreaterThan(-1);
      expect(
        (previous.width - frame.width) * Math.sign(narrowing),
      ).toBeGreaterThan(-1);
      const slid = (frame.right - from.right) / travel;
      const narrowed = (from.width - frame.width) / narrowing;
      // The width changes as the strip slides, not once it has landed.
      expect(narrowed).toBeGreaterThan(slid - 0.35);
      const step = Math.max(
        Math.abs(frame.right - previous.right),
        Math.abs(frame.width - previous.width),
      );
      const remaining = Math.max(
        Math.abs(to.right - frame.right),
        Math.abs(frame.width - to.width),
      );
      if (step > 0.5) moved = true;
      if (moved && remaining > 3) {
        still = step < 0.5 ? still + 1 : 0;
        expect(still).toBeLessThan(3);
      }
    }
    // It lands within its motion, not long after.
    const landed = frames.findIndex(
      (frame, index) =>
        index >= start &&
        Math.abs(frame.right - to.right) < 1 &&
        Math.abs(frame.width - to.width) < 1,
    );
    expect(landed).toBeGreaterThanOrEqual(start);
    expect((frames[landed]?.t ?? Infinity) - from.t).toBeLessThan(700);
  };
  /** Folded beside a chat that leaves: it folds while the chat goes. */
  const foldsWithChat = async (frames: Frame[]) => {
    oneMotion(frames);
    const firstFolded = frames.find((frame) => frame.folded);
    expect(firstFolded?.chat ?? 0).toBeGreaterThan(0.5);
    expect(
      Math.abs((frames.at(-1)?.right ?? 0) - (await corner())),
    ).toBeLessThan(1);
    expect(
      await run(
        `return $('[data-bubble-items]').getBoundingClientRect().width;`,
      ),
    ).toBe(0);
  };

  // Folded beside an open chat: the strip folds as the chat leaves, not
  // after it has gone.
  const arrows = await app.eval<{ x: number; y: number }>(
    `(() => { const b = document.querySelector('[data-dock-arrows]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  const withChat = await record(true, () => app.clickPointer(arrows));
  await foldsWithChat(withChat);
  expect(withChat.at(-1)?.chat).toBe(0);

  // However the open chat leaves while the strip is folded, the strip
  // folds with it: Escape, its own minimize button, its bubble, the
  // shortcut.
  const routes: Record<string, string> = {
    Escape: `window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));`,
    "its minimize button": `${chatSection}.querySelector('[aria-label="Minimize chat to bubble"]').click();`,
    "its bubble": `$('[data-chat-bubble=${JSON.stringify(chatId)}] button[aria-label^="Minimize"]').click();`,
    "the shortcut": `window.dispatchEvent(new KeyboardEvent('keydown', {key:'m',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true}));`,
  };
  for (const [route, leave] of Object.entries(routes)) {
    // The chat opens again, and the strip with it beside it.
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown', {key:'m',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true,cancelable:true}));`,
    );
    await wait(
      `return ${chatSection}?.dataset.floatingChat === 'true' && $('[data-dock-rail]')?.dataset.dockCollapsed === 'false' && ${idle};`,
    );
    const frames = await record(true, () => run(leave));
    try {
      await foldsWithChat(frames);
    } catch (error) {
      throw new Error(`Leaving by ${route}: ${String(error)}`);
    }
  }

  // Opened again, it comes back to the centre the same way, rendering
  // no chat while it moves.
  const opening = await record(false, () =>
    run(`$('[aria-label="Expand chat bubbles"]').click();`),
  );
  oneMotion(opening);
  rendersOnce(opening);
  const open = await read<{ center: number; width: number }>(
    `const host = $('[data-dock-host]').getBoundingClientRect(), rail = $('[data-dock-rail]').getBoundingClientRect();
      return { center: rail.left + rail.width / 2 - (host.left + host.width / 2), width: rail.width };`,
  );
  expect(Math.abs(open.center)).toBeLessThan(1);

  // Alone, the same.
  const alone = await record(true, () =>
    run(`$('[aria-label="Collapse chat bubbles"]').click();`),
  );
  oneMotion(alone);
  rendersOnce(alone);
  const host = await read<{ center: number }>(
    `const host = $('[data-dock-host]').getBoundingClientRect(); return { center: host.left + host.width / 2 };`,
  );
  const offset = (frame: Frame) => (frame.left + frame.right) / 2 - host.center;
  const inCorner = alone.at(-1);
  if (!inCorner) throw new Error("no frames");
  const cornerOffset = offset(inCorner);

  // Opened again before the fold lands, it turns back from where it is:
  // the slide and the width take the same way back and land together,
  // and it rests open, as wide as it was.
  await record(false, () =>
    run(`$('[aria-label="Expand chat bubbles"]').click();`),
  );
  const reversed = await record(false, () =>
    run(`$('[aria-label="Collapse chat bubbles"]').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      $('[aria-label="Expand chat bubbles"]').click();`),
  );
  const farthest = Math.max(
    ...reversed.map((frame) => Math.abs(offset(frame))),
  );
  // It turned back part-way, not from its corner.
  expect(farthest).toBeGreaterThan(5);
  expect(farthest).toBeLessThan(Math.abs(cornerOffset) - 5);
  const turned = reversed.findIndex(
    (frame) => Math.abs(offset(frame)) === farthest,
  );
  const back = (near: (frame: Frame) => boolean) =>
    reversed.findIndex(
      (_frame, index) => index > turned && reversed.slice(index).every(near),
    );
  const slidBack = back((frame) => Math.abs(offset(frame)) < 1);
  const widenedBack = back((frame) => Math.abs(frame.width - open.width) < 1);
  expect(slidBack).toBeGreaterThan(turned);
  expect(widenedBack).toBeGreaterThan(turned);
  expect(
    Math.abs(
      (reversed[slidBack]?.t ?? Infinity) -
        (reversed[widenedBack]?.t ?? -Infinity),
    ),
  ).toBeLessThan(50);
  const reopened = await read<{ center: number; width: number }>(
    `const host = $('[data-dock-host]').getBoundingClientRect(), rail = $('[data-dock-rail]').getBoundingClientRect();
      return { center: rail.left + rail.width / 2 - (host.left + host.width / 2), width: rail.width };`,
  );
  expect(Math.abs(reopened.center)).toBeLessThan(1);
  expect(Math.abs(reopened.width - open.width)).toBeLessThan(1);

  // Folded from the keyboard, focus moves from the arrows to the bubble
  // that takes their place, and back, instead of falling to the page.
  await run(`$('[aria-label="Collapse chat bubbles"]').focus();`);
  await app.press("Enter");
  await wait(
    `return $('[data-dock-rail]')?.dataset.dockCollapsed === 'true' && document.activeElement === $('[aria-label="Expand chat bubbles"]') && ${idle};`,
  );
  expect(
    await run(
      `return $('[aria-label="Expand chat bubbles"]').getAttribute('aria-expanded');`,
    ),
  ).toBe("false");
  await app.press("Enter");
  await wait(
    `return $('[data-dock-rail]')?.dataset.dockCollapsed === 'false' && document.activeElement === $('[aria-label="Collapse chat bubbles"]') && ${idle};`,
  );

  // Without motion, it is in its corner at once: a frame or two for the
  // change to show, where the fold takes about fifteen.
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    // The page has taken the preference: its transitions are instant.
    await wait(
      `return matchMedia('(prefers-reduced-motion: reduce)').matches && parseFloat(getComputedStyle($('[data-bubble-items]')).transitionDuration) < 0.001;`,
    );
    const instant = await record(true, () =>
      run(`$('[aria-label="Collapse chat bubbles"]').click();`),
    );
    const start = instant.findIndex((frame) => frame.folded);
    const settledAt = instant.findIndex(
      (frame, index) =>
        index >= start &&
        Math.abs(frame.right - (instant.at(-1)?.right ?? 0)) < 1 &&
        Math.abs(frame.width - (instant.at(-1)?.width ?? 0)) < 1,
    );
    expect(settledAt - start).toBeLessThanOrEqual(4);
    await record(false, () =>
      run(`$('[aria-label="Expand chat bubbles"]').click();`),
    );
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  }
});
