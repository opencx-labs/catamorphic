import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";
import { pressNativeMacKey } from "./native-pointer.js";

let app: AppHandle;
let projectId: string;
let sessionId: string;
let projectRoot: string;
let checkout: string;
let commandModifier: number;
let secondProjectId: string;
const terminal =
  "document.querySelector('[data-workspace-visible=\"true\"] [data-terminal-appearance]')";
const composer =
  "document.querySelector('[data-chat-local-id]:not([inert]) [data-composer-input]')";

async function key(
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers: number,
) {
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
}

async function nextTerminal(open: () => Promise<unknown>) {
  await app.eval(`window.__terminalEvents=[];true`);
  await open();
  await app.waitFor(`!!${terminal}?.querySelector('canvas')`, {
    label: "terminal canvas",
  });
  return app.waitFor<string>("window.__terminalEvents.at(-1)?.sessionId", {
    label: "shell output",
  });
}

async function assertDirectory(pty: string, directory: string) {
  const command = 'printf "\\nCTX_PATH=%s\\n" "$PWD"\r';
  await app.eval(
    `window.catamorphicDesktop.terminalWrite(${JSON.stringify(pty)},${JSON.stringify(command)})`,
  );
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(pty)}).then(b=>b?.buffer.includes(${JSON.stringify(`CTX_PATH=${directory}`)}))`,
    { label: "shell's actual working folder" },
  );
}

beforeAll(async () => {
  app = await launchApp();
  projectRoot = path.join(app.userDataDir, "terminal-project");
  await fs.mkdir(projectRoot, { recursive: true });
  await nativeGit(projectRoot, ["init", "-b", "main"]);
  await fs.writeFile(
    path.join(projectRoot, "README.md"),
    "Terminal workspace fixture\n",
  );
  await nativeGit(projectRoot, ["add", "."]);
  await nativeGit(projectRoot, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial",
  ]);
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Terminal workspace", rootPath: projectRoot, importExisting: true })})`,
  );
  projectId = project.id;
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'catppuccin-macchiato',overrides:{}})`,
  );
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'dark',overrides:{accent:'#ffbf3f'},fonts:{mono:'Menlo, monospace'}},${JSON.stringify(projectId)})`,
  );
  // Cold startup reads the profile once, outside the project's theme boundary.
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  const server = await app.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  const response = await fetch(
    `${server.url}/api/projects/${projectId}/agent/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Working in a checkout",
        source: "desktop",
      }),
    },
  );
  expect(response.status).toBe(201);
  sessionId = ((await response.json()) as { id: string }).id;
  await app.eval(
    `window.catamorphicDesktop.sessionUseOwnWorktree(${JSON.stringify({ projectId, sessionId })})`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({ projectId, surface: { url: `session:${sessionId}`, title: "Working in a checkout", mode: "tab", nonce: crypto.randomUUID() } })})`,
  );
  await app.waitFor(`!!${composer}`, { label: "worktree chat" });
  await app.waitFor(
    `!${composer}.closest('[data-chat-local-id]').getAnimations().some(a=>a.playState==='running')`,
  );
  await focusWindow(app);
  await app.eval(`${composer}.focus()`);
  await app.insertText("Hello terminal workspace");
  await app.press("Enter");
  await app.waitFor(
    `document.body.textContent.includes('You said: Hello terminal workspace')`,
    { timeoutMs: 60_000, label: "chat turn checked out its folder" },
  );
  await app.waitFor(`!document.querySelector('[aria-label="Stop the agent"]')`);
  const assignment = await app.eval<{ path: string }>(
    `window.catamorphicDesktop.sessionCheckout(${JSON.stringify({ projectId, sessionId })})`,
  );
  checkout = assignment.path;
  expect(checkout).not.toBe(projectRoot);
  commandModifier = await app.eval<number>(
    "/Mac/.test(navigator.platform)?4:2",
  );
  await app.eval(
    `window.__stopTerminalEvents=window.catamorphicDesktop.onTerminalData(p=>window.__terminalEvents.push(p));window.__terminalEvents=[];true`,
  );
});

afterAll(async () => {
  await app?.stop();
});

it("opens Ctrl+` in the chat's worktree with the project's theme, not the profile's", async () => {
  await app.eval(`${composer}.focus()`);
  const pty = await nextTerminal(() => key("`", "Backquote", 192, 2));
  await assertDirectory(pty, checkout);
  expect(
    await app.eval(`(() => {
    const t=${terminal};const c=t.querySelector('canvas');
    return {background:getComputedStyle(t).backgroundColor,
      pixel:[...c.getContext('2d').getImageData(c.width-2,c.height-2,1,1).data].slice(0,3)};
  })()`),
  ).toEqual({ background: "rgb(6, 6, 7)", pixel: [6, 6, 7] });
  expect(
    await app.eval(
      "window.catamorphicDesktop.getTheme(undefined,'profile').then(t=>t.selection)",
    ),
  ).toBe("catppuccin-macchiato");
});

it("keeps the chat's checkout when a closed terminal is reopened", async () => {
  await app.press("w", commandModifier);
  await app.waitFor(`!${terminal}`);
  const pty = await nextTerminal(() =>
    key("t", "KeyT", 84, commandModifier | 8),
  );
  await assertDirectory(pty, checkout);
  await app.press("w", commandModifier);
  await app.waitFor(`!${terminal}`);
});

it("uses the project folder outside a chat and takes the current project theme on open", async () => {
  await key("t", "KeyT", 84, commandModifier);
  await app.waitFor("!!document.querySelector('[data-palette=tab] textarea')");
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'light',overrides:{}},${JSON.stringify(projectId)})`,
  );
  await app.waitFor(
    "document.querySelector('[data-workspace-visible=true] [data-theme=light]')!==null || getComputedStyle(document.querySelector('[data-workspace-visible=true]')).colorScheme==='light'",
  );
  const pty = await nextTerminal(() => key("`", "Backquote", 192, 2));
  await assertDirectory(pty, projectRoot);
  const theme = await app.eval<{ colors: Record<string, string> }>(
    `window.catamorphicDesktop.getTheme(${JSON.stringify(projectId)})`,
  );
  expect(await app.eval(`${terminal}.style.backgroundColor`)).toBe(
    await app.eval(
      `(() => {const c=document.createElement('div');c.style.backgroundColor=${JSON.stringify(theme.colors["bg-inset"])};return c.style.backgroundColor})()`,
    ),
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("opens a shell from a floating chat in the same assigned checkout", async () => {
  await app.press("w", commandModifier);
  await app.waitFor(`!${terminal}`);
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const tab=document.querySelector('[data-point-key^="chat:"] .workspace-tab-label');
    if(!tab)return false;const r=tab.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await app.clickPointer(point);
  await app.waitFor(`!!${composer}`);
  await app.waitFor(
    `!${composer}.closest('[data-chat-local-id]').getAnimations().some(a=>a.playState==='running')`,
  );
  await app.eval(`${composer}.focus()`);
  await app.press("Escape");
  await app.waitFor(
    "!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')",
  );
  await app.waitFor(
    "!document.querySelector('[data-floating-chat]:not([inert])').getAnimations().some(a=>a.playState==='running')",
  );
  await app.eval(`${composer}.focus()`);
  const pty = await nextTerminal(() => key("`", "Backquote", 192, 2));
  await assertDirectory(pty, checkout);
  expect(app.getRendererErrors()).toEqual([]);
});

it("uses each project's theme without repainting or restarting a retained shell", async () => {
  await app.eval(`window.__retainedTerminal=${terminal};true`);
  const root = path.join(app.userDataDir, "second-project");
  const second = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Profile theme project", rootPath: root })})`,
  );
  secondProjectId = second.id;
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(second.id)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible=true]')?.dataset.projectRuntime===${JSON.stringify(second.id)}`,
  );
  const pty = await nextTerminal(() => key("`", "Backquote", 192, 2));
  await assertDirectory(pty, root);
  expect(await app.eval(`${terminal}.style.backgroundColor`)).toBe(
    "rgb(24, 25, 38)",
  );
  expect(await app.eval("window.__retainedTerminal.isConnected")).toBe(true);
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(projectId)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible=true]')?.dataset.projectRuntime===${JSON.stringify(projectId)}`,
  );
  expect(await app.eval(`${terminal}===window.__retainedTerminal`)).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});

it("routes a terminal shortcut from a foreign project's dock chat to that chat's workspace", async () => {
  await app.eval("window.catamorphicDesktop.setPrefs({dockMultiProject:true})");
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(secondProjectId)}})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible=true]')?.dataset.projectRuntime===${JSON.stringify(secondProjectId)}`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-chat-project="${projectId}"]:not([inert]) [data-composer-input]')`,
  );
  await app.eval(
    `document.querySelector('[data-chat-project="${projectId}"]:not([inert]) [data-composer-input]').focus()`,
  );
  const pty = await nextTerminal(() => key("`", "Backquote", 192, 2));
  await app.waitFor(
    `document.querySelector('[data-workspace-visible=true]')?.dataset.projectRuntime===${JSON.stringify(projectId)}`,
  );
  await assertDirectory(pty, checkout);
  expect(app.getRendererErrors()).toEqual([]);
});

it("routes the native terminal shortcut from a detached chat to its worktree", async () => {
  await app.movePointer({ x: 1, y: 1 });
  await app.eval("window.catamorphicDesktop.dockDetach(true)");
  const dock = await app.connectToFrame("surface=dock");
  try {
    await dock.waitFor(
      `!!document.querySelector('[data-chat-project="${projectId}"]:not([inert]) [data-composer-input]')`,
    );
    await dock.waitFor(
      "!document.querySelector('[data-floating-chat]:not([inert])').getAnimations({subtree:true}).some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity)",
    );
    await dock.eval("window.catamorphicDesktop.devWindow('focus')");
    await dock.eval(
      `document.querySelector('[data-chat-project="${projectId}"]:not([inert]) [data-composer-input]').focus();true`,
    );
    await dock.waitFor(
      "document.hasFocus() && document.activeElement?.hasAttribute('data-composer-input')",
    );
    const pty = await nextTerminal(async () => {
      if (process.platform === "darwin")
        await pressNativeMacKey("grave", ["control"]);
      else execFileSync("xdotool", ["key", "--clearmodifiers", "ctrl+grave"]);
    });
    await assertDirectory(pty, checkout);
    expect(dock.getRendererErrors()).toEqual([]);
  } finally {
    dock.close();
    await app.eval("window.catamorphicDesktop.dockDetach(false)");
  }
  expect(app.getRendererErrors()).toEqual([]);
});
