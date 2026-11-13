import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  focusWindow,
  launchApp,
} from "./harness.js";

let app: AppHandle;
let projectId: string;
let firstId: string;
let otherId: string;
const api = "window.catamorphicDesktop";
const helpers = `
  const shown = (selector,opacity=true) => {
    const visible=el=>!el.closest('[inert]')&&el.checkVisibility({opacityProperty:opacity,visibilityProperty:true});
    const candidates=[...document.querySelectorAll(selector)].filter(visible);
    const overlay=[...document.querySelectorAll('[data-palette="overlay"]')].filter(visible).at(-1);
    return candidates.find(el=>overlay&&el.closest('[data-palette]')===overlay)??candidates[0];
  };
  const palette = () => shown('[data-palette="overlay"]') ?? shown('[data-palette="tab"]');
  const input = () => palette()?.querySelector('textarea,[contenteditable="true"]');
`;
const run = <T>(body: string) => app.eval<T>(`(() => {${helpers}\n${body}})()`);
const wait = (body: string, label: string) =>
  app.waitFor(`(() => {${helpers}\n${body}})()`, { label });
const command = (key: "t" | "p" | "w") =>
  app.press(key, process.platform === "darwin" ? 4 : 2);
async function click(selector: string) {
  // Hover can reveal row actions. Do not require opacity before moving
  // the native pointer into the target row.
  const hover = await app.waitFor<{ x: number; y: number }>(`(() => {${helpers}
    const el=shown(${JSON.stringify(selector)},false);
    if(!el)return false;el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:false;
  })()`);
  await app.movePointer(hover);
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => {${helpers}
    const el=shown(${JSON.stringify(selector)}); if(!el || el.matches(':disabled')) return false;
    el.scrollIntoView({block:'nearest',inline:'nearest'});
    const surface=el.closest('[data-palette],.settings-card');
    if(surface?.getAnimations({subtree:true}).some(a=>a.effect?.getTiming().iterations!==Infinity&&(a.pending||a.playState==='running')))return false;
    const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    return el.contains(document.elementFromPoint(x,y))?{x,y}:false;
  })()`,
    { label: `reachable ${selector}` },
  );
  await app.clickPointer(point);
}
async function enterChat(host: "tab" | "overlay") {
  await command(host === "tab" ? "t" : "p");
  await wait(
    `return input()?.matches('textarea') && input()===document.activeElement;`,
    `${host} input focused`,
  );
  await app.insertText("chat");
  await app.press("Space");
  await wait(
    `return input()?.dataset.testid==='palette-agent-input' && document.activeElement===input();`,
    "chat composer focused",
  );
}
async function pick(id: string) {
  await click('[data-testid="palette-choose-agent"]');
  await wait(
    `return palette()?.dataset.palette==='overlay' && palette().textContent.includes('Chat agent') && input()===document.activeElement;`,
    "shared chat agent picker",
  );
  await click(`[data-item-id="pick:agent:${id}"]`);
  await wait(
    `return input()?.dataset.testid==='palette-agent-input' && input()===document.activeElement;`,
    "draft restored",
  );
}

beforeAll(async () => {
  app = await launchApp();
  const project = await createProjectWorkspace({
    app,
    name: "Palette agents",
    rootPath: path.join(app.userDataDir, "palette-agents"),
  });
  projectId = project.id;
  const ids = await app.eval<{ first: string; other: string }>(
    `${api}.agentsList().then(data=>({first:data.agents.find(a=>a.name==='Fake Agent').id,other:data.agents.find(a=>a.name==='Other Fake').id}))`,
  );
  firstId = ids.first;
  otherId = ids.other;
  await focusWindow(app);
});
afterAll(async () => {
  await app?.stop();
});

for (const host of ["tab", "overlay"] as const) {
  it(`${host} chooses an agent without replacing its multiline draft or attachment`, async () => {
    await enterChat(host);
    await app.insertText("First line");
    await app.press("Enter", 8);
    await app.insertText("Second line");
    await run(
      `const data=new DataTransfer(); data.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'pixel.png',{type:'image/png'})); input().dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));`,
    );
    await wait(
      `return !!palette()?.querySelector('[data-testid="composer-pill"] img');`,
      "draft image prepared",
    );
    await app.press("Home");
    await app.press("ArrowRight", 8);
    await run(
      `window.__draft=input(); const s=getSelection(); window.__draftSelection={anchor:s.anchorNode,anchorOffset:s.anchorOffset,focus:s.focusNode,focusOffset:s.focusOffset};`,
    );
    await pick(otherId);
    expect(
      await run(`const s=getSelection(),before=window.__draftSelection;
      return input()===window.__draft && input().innerText.includes('First line') && input().innerText.includes('Second line') &&
        !!palette().querySelector('[data-testid="composer-pill"] img') &&
        s.anchorNode===before.anchor && s.anchorOffset===before.anchorOffset && s.focusNode===before.focus && s.focusOffset===before.focusOffset;`),
    ).toBe(true);
    expect(
      await run(
        `return palette().querySelector('[data-testid="palette-choose-agent"]').textContent.includes('Other Fake');`,
      ),
    ).toBe(true);
    await click('[data-testid="palette-choose-agent"]');
    await wait(
      `return input()?.matches('textarea') && input()===document.activeElement;`,
      "picker search focused",
    );
    await app.insertText("Other");
    for (const type of ["keyDown", "keyUp"])
      await app.cdp("Input.dispatchKeyEvent", {
        type,
        key: "z",
        code: "KeyZ",
        windowsVirtualKeyCode: 90,
        modifiers: process.platform === "darwin" ? 4 : 2,
        ...(type === "keyDown" ? { commands: ["undo"] } : {}),
      });
    await wait(`return input()?.value==='';`, "picker search is undoable");
    await app.press("Escape");
    await wait(
      `return input()===window.__draft && document.activeElement===input();`,
      "cancel restores the same draft",
    );
    expect(
      await app.eval(`${api}.agentsList().then(data=>data.defaultAgentId)`),
    ).toBe(firstId);
    expect(
      await app.eval(
        `${api}.agentsList().then(data=>data.projectDefaults?.[${JSON.stringify(projectId)}]??null)`,
      ),
    ).toBe(null);
    // Sending must use the displayed draft choice, not the saved default.
    const before = await app.eval<string[]>(
      `${api}.dockSnapshot().then(data=>data.chats.map(chat=>chat.entry.localId))`,
    );
    await app.press("Enter");
    await app.waitFor(
      `${api}.dockSnapshot().then(data=>data.chats.some(chat=>chat.projectId===${JSON.stringify(projectId)}&&chat.entry.agentId===${JSON.stringify(otherId)}&&!!chat.entry.sessionId&&!${JSON.stringify(before)}.includes(chat.entry.localId)))`,
      { label: "new chat uses its selected agent" },
    );
    await app.press("Escape");
  });
}

it("retains independent agent choices and follows Settings defaults until explicitly chosen", async () => {
  await enterChat("tab");
  await app.insertText("Chosen draft");
  await pick(otherId);
  const first = await run<string>(
    `return input().closest('[data-surface-key]').dataset.surfaceKey;`,
  );
  await enterChat("tab");
  await app.insertText("Inherited draft");
  const second = await run<string>(
    `return input().closest('[data-surface-key]').dataset.surfaceKey;`,
  );
  expect(
    await run(`return palette().textContent.includes('Fake Agent');`),
  ).toBe(true);
  await command("p");
  await wait(
    `return input()===document.activeElement&&input()?.matches('textarea');`,
    "settings command input",
  );
  await app.insertText("Settings");
  await wait(
    `return !!palette()?.querySelector('[data-item-id="tab:settings"]');`,
    "Settings destination",
  );
  await run(
    `palette().querySelector('[data-item-id="tab:settings"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));`,
  );
  await wait(
    `return !!shown('[data-setting-id="agents"]');`,
    "agent settings shown",
  );
  expect(
    await run(`return shown('[aria-label="Default agent scope"]').value;`),
  ).toBe("personal");
  await click(`[aria-label="Make Other Fake the default agent"]`);
  await app.waitFor(
    `${api}.agentsList().then(data=>data.projectDefaults?.[${JSON.stringify(projectId)}]===${JSON.stringify(otherId)}&&data.defaultAgentId===${JSON.stringify(firstId)})`,
    { label: "Settings changes only this project's default immediately" },
  );
  await click('[data-testid="agent-default-reset"]');
  await app.waitFor(
    `${api}.agentsList().then(data=>!data.projectDefaults?.[${JSON.stringify(projectId)}])`,
    { label: "reset restores inheritance" },
  );
  await click('[aria-label="Default agent scope"]');
  await app.press("Home");
  await app.press("Enter");
  await wait(
    `return shown('[aria-label="Default agent scope"]').value==='profile';`,
    "profile default scope selected",
  );
  await click('[aria-label="Make Other Fake the default agent"]');
  await app.waitFor(
    `${api}.agentsList().then(data=>data.defaultAgentId===${JSON.stringify(otherId)}&&!data.projectDefaults?.[${JSON.stringify(projectId)}])`,
    { label: "profile scope changes its default without an override" },
  );
  for (const key of [first, second]) {
    await click(
      `[data-workspace-visible="true"] [data-tab-orientation] [data-point-key="${key}"] .workspace-tab-label`,
    );
    await wait(
      `return input()===document.activeElement && palette().querySelector('[data-testid="palette-choose-agent"]')?.textContent.includes('Other Fake');`,
      "retained draft sees its correct agent",
    );
  }
  await app.eval(`${api}.agentsSetDefault(${JSON.stringify(firstId)})`);
  await wait(
    `return palette().querySelector('[data-testid="palette-choose-agent"]')?.textContent.includes('Fake Agent');`,
    "unselected draft follows changed default",
  );
  await click(
    `[data-workspace-visible="true"] [data-tab-orientation] [data-point-key="${first}"] .workspace-tab-label`,
  );
  await wait(
    `return palette().querySelector('[data-testid="palette-choose-agent"]')?.textContent.includes('Other Fake');`,
    "explicit draft choice stays independent",
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("deleting an agent collapses its row before it disappears", async () => {
  await command("p");
  await wait(
    `return input()===document.activeElement&&input()?.matches('textarea');`,
    "command input",
  );
  await app.insertText("Settings");
  await wait(
    `return !!palette()?.querySelector('[data-item-id="tab:settings"]');`,
    "Settings destination",
  );
  await app.press("Enter");
  await wait(
    `return !!shown('[data-setting-id="agents"]');`,
    "agent settings shown",
  );
  const selector = `[data-agent-id="${firstId}"]`;
  const height = await run<number>(
    `return shown(${JSON.stringify(selector)}).getBoundingClientRect().height;`,
  );
  // Observe real frame heights while using the row's native Remove action.
  await run(`window.__removeHeights=[];window.__removePositions=[];window.__removeInert=false;const row=shown(${JSON.stringify(selector)});const frame=row.closest('[data-collapsible]');const sibling=shown('[data-agent-id="${otherId}"]');
    const until=performance.now()+1200;const sample=()=>{window.__removeHeights.push(frame.getBoundingClientRect().height);window.__removePositions.push(sibling.getBoundingClientRect().top);window.__removeInert ||= !!row.closest('[inert]');if(performance.now()<until) requestAnimationFrame(sample);};requestAnimationFrame(sample);`);
  await click('[aria-label="Remove Fake Agent"]');
  await wait(
    `return !document.querySelector(${JSON.stringify(selector)});`,
    "removed row leaves after collapsing",
  );
  expect(
    await run(
      `return window.__removeInert&&window.__removeHeights.some(h=>h>0&&h<${height})&&window.__removeHeights.length>2;`,
    ),
  ).toBe(true);
  await wait(
    `return window.__removePositions.length>10;`,
    "sibling motion sampled",
  );
  expect(
    await run(
      `const positions=window.__removePositions;const start=positions[0],end=positions.at(-1);return start-end>${height}-2&&positions.some(y=>y<start-1&&y>end+1);`,
    ),
  ).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});
