import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle;
let dock: FrameHandle | undefined;
let first = "";
let second = "";
let chatId = "";
beforeAll(async () => {
  app = await launchApp();
});
afterAll(async () => {
  dock?.close();
  await app?.stop();
});
const commandModifier =
  "metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform)";
const key = (key: string, modifiers = commandModifier) =>
  app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ${modifiers}, bubbles: true, cancelable: true }))`,
  );
const activeProject = () =>
  app.eval<string>(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime`,
  );

it("keeps browser and terminal resources alive when the same window switches projects", async () => {
  const create = async (name: string) =>
    app.eval<{ id: string }>(
      `window.catamorphicDesktop.createProject(${JSON.stringify({ name, rootPath: path.join(app.userDataDir, name) })})`,
    );
  first = (await create("First project")).id;
  fs.mkdirSync(path.join(app.userDataDir, "First project"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(app.userDataDir, "First project", "note.txt"),
    "A file belonging only to the first project.\n",
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(first)})`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-chat-region]')`,
  );
  await key("`", "ctrlKey: true");
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] canvas')`,
    { label: "first terminal" },
  );
  await key("t", `${commandModifier}, altKey: true`);
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] input[aria-label="Address and search bar"]')`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; const input = document.querySelector('[data-workspace-visible="true"] input[aria-label="Address and search bar"]'); setReactValue(input, 'data:text/html,<title>Retained page</title><p>Still here</p>'); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true})); })()`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] webview')`,
    { label: "first browser" },
  );
  await app.eval(
    `window.__retainedTerminal = document.querySelector('canvas'); window.__retainedBrowser = document.querySelector('webview'); true;`,
  );
  second = (await create("Second project")).id;
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(second)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second)}`,
  );
  expect(await activeProject()).toBe(second);
  expect(
    await app.eval(
      `window.__retainedBrowser.isConnected && window.__retainedTerminal.isConnected`,
    ),
  ).toBe(true);
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(first)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(first)}`,
  );
  expect(
    await app.eval(
      `document.querySelector('[data-workspace-visible="true"] webview') === window.__retainedBrowser`,
    ),
  ).toBe(true);
});

it("shows a project's chat and theme over another project's workspace and routes file clicks home", async () => {
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'midnight',overrides:{accent:'#8b72d8'}}, ${JSON.stringify(first)}); window.catamorphicDesktop.setPrefs({dockMultiProject:true});`,
  );
  await key("n");
  await app.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`,
  );
  chatId = await app.eval<string>(
    `document.querySelector('[data-floating-chat]:not([inert])').dataset.chatLocalId`,
  );
  await app.eval(
    `(() => { ${setReactValueJs}; const input = document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]'); setReactValue(input, 'work slowly please'); input.closest('form').requestSubmit(); })()`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(second)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second)}`,
  );
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert])')?.dataset.chatLocalId === ${JSON.stringify(chatId)}`,
  );
  expect(
    await app.eval(
      `getComputedStyle(document.querySelector('[data-floating-chat]:not([inert])')).getPropertyValue('--color-accent').trim()`,
    ),
  ).toBe("#8b72d8");
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert])')?.innerText.includes('Done after a long think.')`,
    { label: "agent completes after project switch" },
  );
  await app.eval(
    `window.catamorphicDesktop.setPrefs({dockMultiProject:false})`,
  );
  await app.waitFor(
    `!document.querySelector('[data-floating-chat]:not([inert])')`,
    {
      label: "current-project scope hides another project's chat",
    },
  );
  await app.eval(`window.catamorphicDesktop.setPrefs({dockMultiProject:true})`);
  await app.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert])')`,
  );
  await app.eval(
    `window.catamorphicDesktop.dockCommand({ projectId:${JSON.stringify(first)},localId:${JSON.stringify(chatId)},event:{kind:'file',path:'note.txt'}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(first)}`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] .monaco-editor')`,
    { label: "file opened in owning project" },
  );
});

it("keeps an unsent draft when detached and reattached, and supports either edge", async () => {
  await app.eval(
    `(() => { ${setReactValueJs}; setReactValue(document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]'), 'Keep this draft'); })()`,
  );
  await app.eval(
    `window.catamorphicDesktop.setPrefs({dockDetached:true,dockSide:'left'})`,
  );
  dock = await app.connectToFrame("surface=dock");
  await dock.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')?.innerText === 'Keep this draft'`,
    { label: "draft in native dock" },
  );
  expect(
    await dock.eval(
      `document.querySelector('[data-dock-side]')?.dataset.dockSide`,
    ),
  ).toBe("left");
  const toggleNative = () =>
    dock?.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', {key:'m',${commandModifier},bubbles:true,cancelable:true}))`,
    );
  await toggleNative();
  await dock.waitFor(
    `innerHeight <= 80 && innerWidth < 350 && !document.querySelector('[data-floating-chat]:not([inert])')`,
    {
      label: "native dock shrinks to its bubbles",
    },
  );
  await toggleNative();
  await dock.waitFor(
    `innerHeight > 400 && document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')?.innerText === 'Keep this draft'`,
    {
      label: "native keyboard restore retains draft",
    },
  );
  await dock.eval(
    `window.catamorphicDesktop.setPrefs({dockSide:'right',dockDetached:false})`,
  );
  await app.waitFor(
    `document.querySelector('[data-dock-side]')?.dataset.dockSide === 'right'`,
  );
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')?.innerText === 'Keep this draft'`,
    { label: "draft after reattaching" },
  );
});

it("restores each project's floating chat in single-project mode", async () => {
  await app.eval(
    `window.catamorphicDesktop.setPrefs({dockMultiProject:false})`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(second)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second)}`,
  );
  await key("n");
  await app.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`,
  );
  const secondChat = await app.eval<string>(
    `document.querySelector('[data-floating-chat]:not([inert])').dataset.chatLocalId`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(first)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert])')?.dataset.chatLocalId === ${JSON.stringify(chatId)}`,
    { label: "first project's floating chat restored" },
  );
  const target = await app.eval<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('[data-chat-bubble="${chatId}"] button[aria-label^="Minimize"]').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...target,
      button: "left",
      clickCount: 1,
    });
  }
  await app.waitFor(
    `!document.querySelector('[data-floating-chat]:not([inert])')`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(second)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert])')?.dataset.chatLocalId === ${JSON.stringify(secondChat)}`,
    { label: "second project's floating chat restored" },
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(first)})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(first)}`,
  );
});

it("opens a different project in its own window without moving the original workspace", async () => {
  const third = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Third project", rootPath: path.join(app.userDataDir, "third") })})`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify(third.id)}, true)`,
  );
  const other = await app.connectToFrame(`project=${third.id}`);
  try {
    await other.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(third.id)}`,
    );
    expect(await activeProject()).toBe(first);
    expect(
      await app.eval(
        `window.__retainedBrowser.isConnected && window.__retainedTerminal.isConnected`,
      ),
    ).toBe(true);
  } finally {
    other.close();
  }
});
