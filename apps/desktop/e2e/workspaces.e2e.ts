import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";
import { pressNativeMacKey } from "./native-pointer.js";

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
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(first)}})`,
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
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}})`,
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
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(first)}})`,
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
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}})`,
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
    `innerHeight <= 130 && innerWidth < 350 && !document.querySelector('[data-floating-chat]:not([inert])')`,
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
    `window.catamorphicDesktop.setPrefs({dockPlacement:'center'})`,
  );
  // The workspace window is in front, so the dock rests inside its chat
  // region (between the sidebars) rather than the display's work area.
  const region = await app.eval<{
    left: number;
    right: number;
    bottom: number;
  }>(
    `(() => { const r = document.querySelector('[data-workspace-chat-region]').getBoundingClientRect(); return { left: screenX + r.left, right: screenX + r.right, bottom: screenY + (outerHeight - innerHeight) + r.bottom }; })()`,
  );
  await dock.waitFor(
    `Math.abs(screenX + outerWidth / 2 - ${(region.left + region.right) / 2}) < 3 && Math.abs(screenY + outerHeight + 12 - ${region.bottom}) < 3`,
    { label: "dock centered in the workspace chat region" },
  );
  // In its own window the pill folds from its menu, which has no arrows
  // (ADR 0242): as they did, it minimizes the open chat and keeps the fold
  // as the profile's choice.
  await toggleNative();
  await dock.eval(`window.catamorphicDesktop.setPrefs({dockCollapsed:true})`);
  await dock.waitFor(
    // The collapsed bubble with the microphone and downloads beside it.
    `innerWidth <= 154 && document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
  );
  // Native movement uses the same two resting corners, even with centered expansion.
  await dock.eval(`(async () => {
    const api=window.catamorphicDesktop; const start=screenX+innerWidth/2;
    await api.dockDrag({phase:'start',screenX:start,reducedMotion:true});
    await api.dockDrag({phase:'move',screenX:screen.availLeft+screen.availWidth-60,reducedMotion:true});
    await api.dockDrag({phase:'end',screenX:screen.availLeft+screen.availWidth-60,reducedMotion:true});
  })()`);
  await dock.waitFor(
    `document.querySelector('[data-dock-host]')?.dataset.dockSide === 'right' && Math.abs(screenX + outerWidth + 12 - ${region.right}) < 3 && Math.abs(screenY + outerHeight + 12 - ${region.bottom}) < 3`,
    { label: "collapsed dock in the region's bottom-right corner" },
  );
  await dock.eval(
    `document.querySelector('[aria-label="Expand chat bubbles"]').click()`,
  );
  await dock.waitFor(
    `Math.abs(screenX + outerWidth / 2 - ${(region.left + region.right) / 2}) < 3`,
  );
  await toggleNative();
  await dock.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert])')`,
  );
  // Closing the detached window returns the dock for this session only:
  // the launch default stays what Settings chose.
  await dock.eval(`window.close()`);
  await app.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`,
    { label: "dock back in the window after closing it" },
  );
  expect(
    await app.eval<boolean>(
      `window.catamorphicDesktop.getPrefs().then((prefs) => prefs.dockDetached)`,
    ),
  ).toBe(true);
  await app.eval(
    `window.catamorphicDesktop.setPrefs({dockSide:'right',dockDetached:false,dockPlacement:'right'})`,
  );
  await app.waitFor(
    `document.querySelector('[data-dock-side]')?.dataset.dockSide === 'right'`,
  );
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')?.innerText === 'Keep this draft'`,
    { label: "draft after reattaching" },
  );
  // A one-off detach from the dock menu floats it without touching the default.
  await app.eval(`window.catamorphicDesktop.dockDetach(true)`);
  dock = await app.connectToFrame("surface=dock");
  await dock.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')?.innerText === 'Keep this draft'`,
    { label: "one-off detach keeps the draft" },
  );
  expect(
    await app.eval<boolean>(
      `window.catamorphicDesktop.getPrefs().then((prefs) => prefs.dockDetached)`,
    ),
  ).toBe(false);
  await dock.eval(`window.catamorphicDesktop.dockDetach(false)`);
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')?.innerText === 'Keep this draft'`,
    { label: "draft after the one-off return" },
  );
});

it("restores each project's floating chat in single-project mode", async () => {
  await app.eval(
    `window.catamorphicDesktop.setPrefs({dockMultiProject:false})`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second)}`,
  );
  // The dock's + floats it (Cmd+N would open it in the New Tab in front).
  await app.waitFor(
    `(() => { const plus = document.querySelector('[data-dock-rail] button[aria-label="New chat"]'); plus?.click(); return !!plus; })()`,
    { label: "the dock's +" },
  );
  await app.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')`,
  );
  const secondChat = await app.eval<string>(
    `document.querySelector('[data-floating-chat]:not([inert])').dataset.chatLocalId`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(first)}})`,
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
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-floating-chat]:not([inert])')?.dataset.chatLocalId === ${JSON.stringify(secondChat)}`,
    { label: "second project's floating chat restored" },
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(first)}})`,
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
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(third.id)}, newWindow: true})`,
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

it("moves a project this window keeps behind the one in front to a window of its own", async () => {
  const mounted = (projectId: string) =>
    `!!document.querySelector('[data-project-runtime=${JSON.stringify(projectId)}]')`;
  // A shell running in the second project, holding something of its own.
  await app.eval(
    "window.__shells=[];window.catamorphicDesktop.onTerminalData(({sessionId})=>{if(!window.__shells.includes(sessionId))window.__shells.push(sessionId)})",
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second)}`,
  );
  // Shells already printing here (the first project's) are not this one.
  await app.eval("window.__shellsBefore=[...window.__shells]");
  await key("`", "ctrlKey: true");
  const shell = await app.waitFor<string>(
    "window.__shells.find((id) => !window.__shellsBefore.includes(id)) ?? false",
    { label: "second project's shell" },
  );
  await app.eval(
    `window.catamorphicDesktop.terminalWrite(${JSON.stringify(shell)}, ${JSON.stringify("MOVED_MARK=kept; echo moved-$((40+2))\r")})`,
  );
  const printed = (frame: AppHandle | FrameHandle, text: string) =>
    frame.waitFor(
      `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(shell)}).then(b => !!b?.running && b.buffer.includes(${JSON.stringify(text)}))`,
      { label: `the shell printed ${text}` },
    );
  await printed(app, "moved-42");
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(first)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(first)}`,
  );
  expect(await app.eval<boolean>(mounted(second))).toBe(true);
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}, newWindow: true})`,
  );
  const other = await app.connectToFrame(`project=${second}`);
  try {
    // Its own window shows it, named for it, with its chat as it was left.
    await other.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second)} && document.title === 'Second project'`,
      { label: "second project in its own window" },
    );
    await other.waitFor(
      `document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]') !== null`,
      { label: "second project's workspace restored" },
    );
    // The same shell, still running, now answering here.
    await other.waitFor(
      "!!document.querySelector('[data-workspace-visible=\"true\"] canvas')",
      { label: "the shell's tab in the new window" },
    );
    await other.eval(
      `window.catamorphicDesktop.terminalWrite(${JSON.stringify(shell)}, ${JSON.stringify('echo "$MOVED_MARK-after"\r')})`,
    );
    await printed(other, "kept-after");
    // This window let it go and kept everything else.
    await app.waitFor(`!${mounted(second)}`, {
      label: "second project let go here",
    });
    expect(await activeProject()).toBe(first);
    expect(await app.eval<string>("document.title")).toBe("First project");
    expect(
      await app.eval(
        `window.__retainedBrowser.isConnected && window.__retainedTerminal.isConnected`,
      ),
    ).toBe(true);
    // Asked again, the window showing it comes forward; nothing moves.
    await app.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(second)}, newWindow: true})`,
    );
    await other.waitFor("document.hasFocus()", {
      label: "second project's window in front",
    });
    expect(await app.eval<boolean>(mounted(second))).toBe(false);
    expect(await activeProject()).toBe(first);
  } finally {
    other.close();
  }
});

it.runIf(process.platform === "darwin")(
  "goes between project windows with Cmd+`, as any Mac app does",
  async () => {
    // The Window menu is the system's: Cmd+` walks the open windows.
    await app.eval("window.catamorphicDesktop.devWindow('focus')");
    await app.waitFor("document.hasFocus()", {
      label: "first project's window is key",
    });
    await pressNativeMacKey("grave", ["command"]);
    await app.waitFor("!document.hasFocus()", {
      label: "Cmd+` moved to another window",
    });
    // Each press takes the next; the walk comes back around.
    let back = false;
    for (let press = 0; press < 3 && !back; press += 1) {
      await pressNativeMacKey("grave", ["command"]);
      back = await app
        .waitFor("document.hasFocus()", { timeoutMs: 2_000 })
        .then(() => true)
        .catch(() => false);
    }
    expect(back).toBe(true);
  },
);
