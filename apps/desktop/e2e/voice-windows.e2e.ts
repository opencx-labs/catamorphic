import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, type FrameHandle, launchApp } from "./harness.js";

let app: AppHandle;
let other: FrameHandle;
let here: string;
let there: string;
const active = (projectId: string) =>
  `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(projectId)}`;
const api = "window.catamorphicDesktop";
const mic = '[data-testid="voice-button"]';

beforeAll(async () => {
  app = await launchApp({
    env: { CATAMORPHIC_E2E_FAKE_VOICE: '[""]' },
  });
  const create = (name: string) =>
    app.eval<{ id: string }>(
      `${api}.createProject(${JSON.stringify({ name, rootPath: path.join(app.userDataDir, name) })})`,
    );
  here = (await create("Voice here")).id;
  await app.eval(
    `${api}.workspaceNavigate({projectId:${JSON.stringify(here)}})`,
  );
  await app.waitFor(active(here));
  there = (await create("Voice there")).id;
  await app.eval(
    `${api}.workspaceNavigate({projectId:${JSON.stringify(there)},newWindow:true})`,
  );
  other = await app.connectToFrame(`project=${there}`);
  await other.waitFor(active(there));
  await other.waitFor(`!!document.querySelector('[data-workspace-ready]')`);
  // A chat in the other window supplies the old profile-wide fallback.
  await other.eval(
    `${api}.voiceFrontChat({projectId:${JSON.stringify(there)},sessionId:'other-window-chat'})`,
  );
}, 180_000);

afterAll(async () => {
  other?.close();
  await app?.stop();
});

describe("voice across project windows", () => {
  it("starts the assistant in the shortcut's window without a focused chat", async () => {
    await app.eval(`${api}.devWindow('focus')`);
    await app.waitFor("document.hasFocus()");
    // The renderer shortcut and the native input path share main's resolver.
    // Send the real keys through a page so before-input-event receives them.
    await app.eval(`${api}.workspaceNavigate({projectId:${JSON.stringify(here)},surface:{
      url:'data:text/html,<title>Voice window</title><p>Talk here</p>',title:'Voice window',
      mode:'tab',open:'browser',nonce:crypto.randomUUID()}})`);
    await app.waitFor(
      `(() => { try { return document.querySelector('webview')?.getTitle() === 'Voice window'; } catch { return false; } })()`,
    );
    const modifier = process.platform === "darwin" ? "meta" : "control";
    await app.eval(`(() => {
      const view=document.querySelector('webview'); view.focus();
      for(const type of ['keyDown','keyUp'])
        view.sendInputEvent({type,keyCode:'Space',modifiers:['${modifier}','shift']});
    })()`);
    const session = await app.waitFor<{ projectId: string; sessionId: string }>(
      `${api}.getPrefs().then(prefs => prefs.assistantSession)`,
      { label: "assistant created by the shortcut", timeoutMs: 30_000 },
    );
    expect(session.projectId).toBe(here);
    await app.waitFor(
      `${api}.voiceStatus().then(status => status.phase === 'listening')`,
    );
    await app.eval(
      `${api}.voicePress({action:'talk-to-work',projectId:${JSON.stringify(here)}}).then(()=>${api}.voiceRelease({heldMs:0}))`,
    );
    await app.waitFor(
      `${api}.voiceStatus().then(status => status.phase === 'off')`,
    );
  });

  it("opens the assistant chat in its real owner from another window's microphone", async () => {
    const session = await app.eval<{ projectId: string; sessionId: string }>(
      `${api}.getPrefs().then(prefs => prefs.assistantSession)`,
    );
    await other.eval(`${api}.devWindow('focus')`);
    await other.waitFor("document.hasFocus()");
    await other.eval(`(() => {
      const mic=document.querySelector('${mic}'); const box=mic.getBoundingClientRect();
      mic.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:box.x+box.width/2,clientY:box.y+box.height/2}));
    })()`);
    await other.waitFor(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).some(item=>item.textContent.includes('Open assistant chat'))`,
    );
    await other.eval(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find(item=>item.textContent.includes('Open assistant chat')).click()`,
    );
    await app.waitFor(
      `!!document.querySelector('section[data-floating-chat] [data-composer-input]')`,
      { label: "assistant chat rendered in the owning window" },
    );
    await app.waitFor(`${api}.devWindow('get').then(state=>state.focused)`);
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir,
        "assistant-owner-window.png",
      ),
    );
    await app.waitFor(
      `${api}.workspaceStateGet(${JSON.stringify(here)}).then(state=>JSON.stringify(state).includes(${JSON.stringify(session.sessionId)}))`,
      { label: "assistant chat saved in its owning workspace" },
    );
    expect(await other.eval(active(there))).toBe(true);
    expect(app.getRendererErrors()).toEqual([]);
    expect(other.getRendererErrors()).toEqual([]);
  });

  it("routes the detached dock's open action directly to the assistant's owner", async () => {
    await app.press("w", process.platform === "darwin" ? 4 : 2);
    await app.waitFor("!document.querySelector('section[data-floating-chat]')");
    await other.eval(`${api}.devWindow('focus')`);
    await other.eval(`${api}.dockDetach(true)`);
    const dock = await app.connectToFrame("surface=dock");
    try {
      await dock.waitFor(`!!document.querySelector('${mic}')`);
      // The native menu's Open action uses this same narrow request.
      await dock.eval(`${api}.voiceOpenChat()`);
      await dock.waitFor(
        `!!document.querySelector('section[data-floating-chat] [data-composer-input]')`,
      );
      await app.waitFor(`${api}.devWindow('get').then(state=>state.focused)`);
      expect(await other.eval(active(there))).toBe(true);
      expect(dock.getRendererErrors()).toEqual([]);
    } finally {
      await app.eval(`${api}.dockDetach(false)`);
      dock.close();
    }
  });

  it("admits the floating microphone's open action and restores the owning window", async () => {
    await app.eval(
      `${api}.voicePress({action:'talk-to-work',projectId:${JSON.stringify(here)}}).then(()=>${api}.voiceRelease({heldMs:0}))`,
    );
    await app.waitFor(
      `${api}.voiceStatus().then(status=>status.phase==='listening')`,
    );
    await other.eval(`${api}.devWindow('minimize')`);
    await app.eval(`${api}.devWindow('minimize')`);
    const bubble = await app.connectToFrame("surface=voice");
    try {
      await bubble.waitFor(
        `${api}.voiceBubbleState().then(state=>state?.shown)`,
      );
      await bubble.eval(`${api}.voiceOpenChat()`);
      await app.waitFor(
        `${api}.devWindow('get').then(state=>state.focused && state.visible)`,
      );
      await app.waitFor(
        `!!document.querySelector('section[data-floating-chat] [data-composer-input]')`,
      );
      expect(bubble.getRendererErrors()).toEqual([]);
    } finally {
      bubble.close();
      await app.eval(
        `${api}.voicePress({action:'talk-to-work',projectId:${JSON.stringify(here)}}).then(()=>${api}.voiceRelease({heldMs:0}))`,
      );
      await other.eval(`${api}.devWindow('restore')`);
    }
  });
});
