import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WindowSession } from "../src/main/window-state.js";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";

/**
 * Window placement survives a relaunch: maximized stays maximized, a
 * resized window comes back at its size. Driven through the dev-only
 * window IPC (CDP can't reach Electron's window geometry).
 */

let app: AppHandle | undefined;
let coldStartServer: http.Server | undefined;

afterAll(async () => {
  try {
    await app?.stop();
  } finally {
    coldStartServer?.close();
  }
});

const geometry = () =>
  (app as AppHandle).eval<{
    width: number;
    height: number;
    maximized: boolean;
    focused: boolean;
    focusable: boolean;
    opacity: number;
  }>(`window.catamorphicDesktop.devWindow('get')`);

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("window state", () => {
  it("a maximized window relaunches maximized", async () => {
    app = await launchApp();
    await app.waitFor(
      "window.catamorphicDesktop.devWindow('get').then(state => state.visible)",
    );
    await (app as AppHandle).eval(
      `window.catamorphicDesktop.devWindow('maximize')`,
    );
    await app.waitFor(
      "window.catamorphicDesktop.devWindow('get').then(state => state.maximized)",
      { timeoutMs: 10_000, label: "native maximize completed" },
    );
    expect((await geometry()).maximized).toBe(true);
    expect(await geometry()).toMatchObject({
      focused: true,
      focusable: true,
      opacity: 1,
    });
    expect(await app.eval("document.hasFocus()")).toBe(true);
    const { userDataDir } = app;
    // This is crash recovery: wait for the debounced state write before SIGKILL.
    await expect
      .poll(async () => {
        try {
          const state: unknown = JSON.parse(
            await fs.readFile(
              path.join(userDataDir, "window-state.json"),
              "utf8",
            ),
          );
          return (
            state !== null &&
            typeof state === "object" &&
            "windows" in state &&
            Array.isArray(state.windows) &&
            state.windows.some((window) => window.state.maximized === true)
          );
        } catch {
          return false;
        }
      })
      .toBe(true);
    await app.kill();

    app = await launchApp({ userDataDir });
    await app.waitFor(
      "window.catamorphicDesktop.devWindow('get').then(state => state.visible)",
    );
    await app.waitFor(
      "window.catamorphicDesktop.devWindow('get').then(state => state.maximized)",
      { timeoutMs: 10_000, label: "saved native maximize restored" },
    );
    expect((await geometry()).maximized).toBe(true);
  }, 180_000);

  it("offers Close current Work window in a palette without a project", async () => {
    const handle = app as AppHandle;
    await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key:'p', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles:true
    }))`);
    await handle.waitFor(
      `!!document.querySelector('textarea[aria-label="Search commands, pages, and more"]')`,
    );
    await handle.eval(`(() => { ${setReactValueJs};
      setReactValue(document.querySelector('textarea[aria-label="Search commands, pages, and more"]'), '>close current work window');
    })()`);
    await handle.waitFor(
      `Array.from(document.querySelectorAll('[role="option"]')).some(row =>
      row.textContent.includes('Close current Work window'))`,
      { label: "close window command without a project" },
    );
    // With no project, the palette is the permanent empty page.
    await handle.eval(`(() => { ${setReactValueJs};
      setReactValue(document.querySelector('textarea[aria-label="Search commands, pages, and more"]'), '');
    })()`);
  });

  it("a resized window relaunches at its size", async () => {
    await (app as AppHandle).eval(
      `window.catamorphicDesktop.devWindow('setSize', 1000, 650)`,
    );
    await settle();
    const before = await geometry();
    expect(before.maximized).toBe(false);
    expect([before.width, before.height]).toEqual([1000, 650]);
    const { userDataDir } = app as AppHandle;
    await (app as AppHandle).kill();

    app = await launchApp({ userDataDir });
    const after = await geometry();
    expect(after.maximized).toBe(false);
    expect([after.width, after.height]).toEqual([1000, 650]);
  }, 180_000);

  it("restores every window, its profile and project group, hidden state, and existing tabs after Quit", async () => {
    const handle = app as AppHandle;
    const frames: FrameHandle[] = [];
    const active = (projectId: string) =>
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(projectId)}`;
    const create = (frame: AppHandle | FrameHandle, name: string) =>
      frame.eval<{ id: string }>(
        `window.catamorphicDesktop.createProject(${JSON.stringify({ name, rootPath: path.join(handle.userDataDir, name) })})`,
      );
    const navigate = async (
      frame: AppHandle | FrameHandle,
      projectId: string,
    ) => {
      await frame.eval(
        `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(projectId)}})`,
      );
      await frame.waitFor(active(projectId));
      await frame.waitFor(
        `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]')`,
      );
    };
    const read = async (): Promise<WindowSession> =>
      JSON.parse(
        await fs.readFile(
          path.join(handle.userDataDir, "window-state.json"),
          "utf8",
        ),
      );
    try {
      const first = await create(handle, "Saved first");
      await navigate(handle, first.id);
      // This tab is already persisted with its project. The window collection
      // stores only ownership and native presentation, never another tab copy.
      await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
        key:'t', altKey:true, metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles:true
      }))`);
      await handle.waitFor(
        `!!document.querySelector('[data-workspace-visible="true"] input[aria-label="Address and search bar"]')`,
      );
      await handle.eval(`(() => { ${setReactValueJs};
        const input=document.querySelector('[data-workspace-visible="true"] input[aria-label="Address and search bar"]');
        setReactValue(input, 'data:text/html,<title>Saved window page</title><p>Restored</p>');
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      })()`);
      await handle.waitFor(
        `window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(first.id)}).then(state =>
        JSON.stringify(state).includes('Saved window page'))`,
        { label: "browser tab persisted in its project" },
      );
      const background = await create(handle, "Saved background");
      await navigate(handle, background.id);
      await navigate(handle, first.id);
      const second = await create(handle, "Saved second");
      await handle.eval(
        `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(second.id)},newWindow:true})`,
      );
      const other = await handle.connectToFrame(`project=${second.id}`);
      frames.push(other);
      await other.waitFor(active(second.id));
      await other.waitFor(`!!document.querySelector('[data-workspace-ready]')`);
      await other.eval(
        `window.catamorphicDesktop.devWindow('setSize',900,600)`,
      );
      // Palette close has exactly the native close button's lifecycle: an
      // occupied workspace becomes hidden and keeps its resources alive.
      await other.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
        key:'p', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles:true
      }))`);
      await other.waitFor(
        `!!document.querySelector('textarea[aria-label="Search commands, pages, and more"]')`,
      );
      await other.eval(`(() => { ${setReactValueJs};
        setReactValue(document.querySelector('textarea[aria-label="Search commands, pages, and more"]'), '>close current work window');
      })()`);
      await other.waitFor(
        `Array.from(document.querySelectorAll('[role="option"]')).some(row => row.textContent.includes('Close current Work window'))`,
      );
      await other.eval(`Array.from(document.querySelectorAll('[role="option"]')).find(row =>
        row.textContent.includes('Close current Work window')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);
      await other.waitFor(
        `window.catamorphicDesktop.devWindow('get').then(state => !state.visible)`,
        { label: "palette hides the occupied window" },
      );
      expect(await other.eval(active(second.id))).toBe(true);

      // A third window changes to an empty profile. It remains a real saved
      // workspace window, without borrowing another profile's last project.
      const third = await create(handle, "Saved third");
      await handle.eval(
        `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(third.id)},newWindow:true})`,
      );
      const empty = await handle.connectToFrame(`project=${third.id}`);
      frames.push(empty);
      await empty.waitFor(active(third.id));
      const profile = await empty.eval<{ id: string }>(
        `window.catamorphicDesktop.profilesCreate('Saved empty profile')`,
      );
      await empty.eval(
        `window.catamorphicDesktop.windowSetProfile(${JSON.stringify(profile.id)})`,
      );
      await empty.eval(`location.reload(); true`);
      await empty.waitFor(
        `!!document.querySelector('[aria-label="Switch profile: Saved empty profile"]')`,
      );
      await empty.eval(
        `window.catamorphicDesktop.devWindow('setSize',860,560)`,
      );
      await handle.eval(`window.catamorphicDesktop.devWindow('maximize')`);
      await handle.waitFor(
        `window.catamorphicDesktop.devWindow('get').then(state => state.maximized)`,
      );
      await handle.eval(`window.catamorphicDesktop.devWindow('focus')`);
      const focusedId = await handle.eval<string>(
        `new URLSearchParams(location.search).get('window')`,
      );
      await expect
        .poll(async () => {
          const saved = await read();
          return (
            saved.windows.length === 3 &&
            saved.lastFocusedWindowId === focusedId &&
            saved.windows.some(
              (window) =>
                window.projectIds.includes(second.id) && !window.visible,
            ) &&
            saved.windows.some(
              (window) =>
                window.profileId === profile.id &&
                window.projectIds.length === 0,
            )
          );
        })
        .toBe(true);
      const before = await read();
      expect(
        [
          ...(before.windows.find((window) =>
            window.projectIds.includes(first.id),
          )?.projectIds ?? []),
        ].sort(),
      ).toEqual([first.id, background.id].sort());
      const userDataDir = handle.userDataDir;
      for (const frame of frames.splice(0)) frame.close();
      await handle.stop({ preserveUserData: true });
      // Quit closes windows one by one. The file must keep their complete
      // pre-quit set, including the window that was already hidden.
      expect(await read()).toEqual(before);
      app = await launchApp({ userDataDir, activateWindow: false });
      for (const saved of before.windows) {
        const frame = await app.connectToFrame(`window=${saved.id}`);
        frames.push(frame);
        await frame.waitFor(
          `!!document.querySelector('[data-workspace-root]')`,
        );
        await frame.waitFor(
          `window.catamorphicDesktop.windowProfile().then(id => id === ${JSON.stringify(saved.profileId)})`,
        );
        await frame.waitFor(`JSON.stringify(Array.from(document.querySelectorAll('[data-project-runtime]'))
          .map(el => el.dataset.projectRuntime).filter(id => id !== 'initial').sort()) === ${JSON.stringify(JSON.stringify([...saved.projectIds].sort()))}`);
        if (saved.activeProjectId)
          await frame.waitFor(active(saved.activeProjectId));
        await frame.waitFor(`window.catamorphicDesktop.devWindow('get').then(state =>
          state.visible === ${saved.visible} && state.maximized === ${saved.state.maximized})`);
        if (saved.id === focusedId) {
          // The restored page may own keyboard focus inside its webview.
          // Check the native workspace window, independently of which of its
          // renderer documents is focused. No test activation may mask it.
          await expect
            .poll(
              () =>
                frame.eval(`window.catamorphicDesktop.devWindow('get').then(state => ({
                  focused: state.focused,
                  visible: state.visible,
                  documentFocused: document.hasFocus(),
                  activeElement: document.activeElement?.tagName
                }))`),
              { timeout: 15_000, message: "last focused workspace restored" },
            )
            .toMatchObject({ focused: true, visible: true });
          await frame.waitFor(
            `Array.from(document.querySelectorAll('[data-workspace-visible="true"] webview')).some(view => view.getURL().startsWith('data:text/html,'))`,
          );
        }
        expect(frame.getRendererErrors()).toEqual([]);
      }
      const restored = await read();
      expect(restored.windows.map((window) => window.id).sort()).toEqual(
        before.windows.map((window) => window.id).sort(),
      );
      expect(
        restored.windows.flatMap((window) => window.projectIds).sort(),
      ).toEqual(before.windows.flatMap((window) => window.projectIds).sort());
    } finally {
      for (const frame of frames) frame.close();
    }
  }, 240_000);

  it("saves a tab opened immediately before ordinary Quit", async () => {
    await app?.stop();
    app = await launchApp();
    const handle = app;
    const project = await handle.eval<{
      id: string;
    }>(`window.catamorphicDesktop.createProject({
      name:'Immediate Quit', rootPath:${JSON.stringify(`${handle.userDataDir}/immediate-quit`)}
    })`);
    await handle.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
    );
    await handle.waitFor(
      `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]')`,
    );
    await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{
      key:',',altKey:true,metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true
    }));true`);
    // No wait for a debounce, a save or even the new tab's screen.
    const userDataDir = handle.userDataDir;
    await handle.stop({ preserveUserData: true, captureFinalFrame: false });
    app = await launchApp({ userDataDir });
    await app.waitFor(
      `window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(project.id)}).then(state =>
      state?.tabs.some(tab => tab.kind === 'settings'))`,
      { label: "tab opened immediately before Quit persisted" },
    );
    await app.waitFor(
      `!!document.querySelector('[aria-label="Settings categories"]')`,
    );
  }, 180_000);

  it("resumes saving when native beforeunload cancels Quit, then permits a retry", async () => {
    const handle = app as AppHandle;
    await handle.eval(
      `window.onbeforeunload=()=>{window.__cancelledQuit=true;return false;};true`,
    );
    await handle.eval(`window.catamorphicDesktop.devWindow('quit')`);
    await handle.waitFor(`window.__cancelledQuit === true`, {
      label: "native close cancelled by beforeunload",
    });
    await handle.eval(`window.catamorphicDesktop.devWindow('setSize',940,640)`);
    await expect
      .poll(async () => {
        const saved: WindowSession = JSON.parse(
          await fs.readFile(
            path.join(handle.userDataDir, "window-state.json"),
            "utf8",
          ),
        );
        return saved.windows[0]?.state.width;
      })
      .toBe(940);
    await handle.eval(`window.onbeforeunload=null;true`);
    const userDataDir = handle.userDataDir;
    await handle.stop({ preserveUserData: true });
    app = await launchApp({ userDataDir });
    expect((await geometry()).width).toBe(940);
  }, 180_000);

  it("forgets deleted projects live and rejects stale saved claims on relaunch", async () => {
    await app?.stop();
    app = await launchApp();
    const handle = app;
    const create = (name: string) =>
      handle.eval<{ id: string }>(
        `window.catamorphicDesktop.createProject(${JSON.stringify({ name, rootPath: path.join(handle.userDataDir, name) })})`,
      );
    const first = await create("Removed project");
    await handle.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(first.id)}})`,
    );
    await handle.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(first.id)}`,
    );
    const second = await create("Kept project");
    await handle.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(second.id)}})`,
    );
    await handle.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second.id)}`,
    );
    await handle.eval(
      `window.catamorphicDesktop.deleteProject({projectId:${JSON.stringify(first.id)}})`,
    );
    await handle.waitFor(
      `!document.querySelector('[data-project-runtime="${first.id}"]')`,
      { label: "deleted project unmounted" },
    );
    expect(
      await handle.eval<string[]>(
        `window.catamorphicDesktop.workspaceInitial().then(initial=>initial.projectIds)`,
      ),
    ).toEqual([second.id]);
    const userDataDir = handle.userDataDir;
    await handle.stop({ preserveUserData: true });
    const file = path.join(userDataDir, "window-state.json");
    const stale: WindowSession = JSON.parse(await fs.readFile(file, "utf8"));
    const saved = stale.windows[0];
    if (!saved) throw new Error("Missing saved window");
    saved.projectIds.push(first.id);
    saved.activeProjectId = first.id;
    await fs.writeFile(file, JSON.stringify(stale));
    app = await launchApp({ userDataDir });
    await app.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(second.id)}`,
    );
    expect(
      await app.eval<string[]>(
        `window.catamorphicDesktop.workspaceInitial().then(initial=>initial.projectIds)`,
      ),
    ).toEqual([second.id]);
    expect(
      await app.eval(
        `!!document.querySelector('[data-project-runtime="${first.id}"]')`,
      ),
    ).toBe(false);
  }, 180_000);

  it("keeps a stale empty window from mounting or saving a project owned by another restored window", async () => {
    await app?.stop();
    app = await launchApp();
    const handle = app;
    const project = await handle.eval<{
      id: string;
    }>(`window.catamorphicDesktop.createProject({
      name:'Sole owned project',rootPath:${JSON.stringify(`${handle.userDataDir}/sole-owned-project`)}
    })`);
    await handle.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
    );
    await handle.waitFor(
      `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]')`,
    );
    await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{
      key:'t',altKey:true,metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true
    }))`);
    await handle.waitFor(
      `!!document.querySelector('input[aria-label="Address and search bar"]')`,
    );
    await handle.eval(`(()=>{${setReactValueJs};
      const input=document.querySelector('input[aria-label="Address and search bar"]');
      setReactValue(input,'data:text/html,<title>Sole owner sentinel</title><p>Kept by its owner</p>');
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    })()`);
    await handle.waitFor(
      `window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(project.id)}).then(state=>
      state?.browsers.some(browser=>browser.title==='Sole owner sentinel'))`,
      { label: "owner's browser persisted" },
    );
    const userDataDir = handle.userDataDir;
    await handle.stop({ preserveUserData: true });
    const file = path.join(userDataDir, "window-state.json");
    const saved: WindowSession = JSON.parse(await fs.readFile(file, "utf8"));
    const owner = saved.windows[0];
    if (!owner) throw new Error("Missing owner window");
    const emptyId = randomUUID();
    const missingProjectId = randomUUID();
    await fs.writeFile(
      file,
      JSON.stringify({
        windows: [
          {
            ...owner,
            id: emptyId,
            projectIds: [missingProjectId],
            activeProjectId: missingProjectId,
          },
          owner,
        ],
        lastFocusedWindowId: owner.id,
      }),
    );
    app = await launchApp({ userDataDir, activateWindow: false });
    const empty = await app.connectToFrame(`window=${emptyId}`);
    const owned = await app.connectToFrame(`window=${owner.id}`);
    try {
      await owned.waitFor(
        `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime===${JSON.stringify(project.id)}`,
      );
      await owned.waitFor(
        `!!document.querySelector('[data-workspace-ready] webview')`,
      );
      await empty.waitFor(
        `!!document.querySelector('[aria-label="Switch profile: Default Profile"]')`,
      );
      // An ordinary utility action must stay in this unclaimed window. A
      // fallback that mounted the other project's model would save this tab
      // into that project's store, despite the rejected ownership claim.
      await empty.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{
        key:',',altKey:true,metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true
      }))`);
      await empty.waitFor(
        `!!document.querySelector('[aria-label="Settings categories"]')`,
      );
      await empty.eval(
        `window.catamorphicDesktop.devUpdateRestart({abort:true})`,
      );
      expect(
        await empty.eval(`!!document.querySelector('[data-workspace-ready]')`),
      ).toBe(false);
      expect(
        await empty.eval(`document.querySelectorAll('webview').length`),
      ).toBe(0);
      expect(
        await empty.eval(
          `window.catamorphicDesktop.workspaceInitial().then(initial=>initial.projectIds)`,
        ),
      ).toEqual([]);
      expect(
        await owned.eval(
          `window.catamorphicDesktop.workspaceInitial().then(initial=>initial.projectIds)`,
        ),
      ).toEqual([project.id]);
      expect(
        await owned.eval(`window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(project.id)}).then(state=>({
        settings:state.tabs.some(tab=>tab.kind==='settings'),
        sentinel:state.browsers.some(browser=>browser.title==='Sole owner sentinel')
      }))`),
      ).toEqual({ settings: false, sentinel: true });
      await expect
        .poll(async () => {
          const current: WindowSession = JSON.parse(
            await fs.readFile(file, "utf8"),
          );
          return current.windows
            .filter((window) => window.projectIds.includes(project.id))
            .map((window) => window.id);
        })
        .toEqual([owner.id]);
    } finally {
      empty.close();
      owned.close();
    }
    // A fresh window accepts its unowned last project before taking a cold
    // launch URL. The arriving link must survive that project's restoration.
    await app.stop({ preserveUserData: true });
    await fs.writeFile(file, JSON.stringify({ windows: [] }));
    const fixture = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<title>Cold launch after project claim</title><p>The link reached its project.</p>",
      );
    });
    coldStartServer = fixture;
    await new Promise<void>((resolve) =>
      fixture.listen(0, "127.0.0.1", resolve),
    );
    const address = fixture.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const coldUrl = `http://127.0.0.1:${address.port}/cold-start`;
    app = await launchApp({ userDataDir, urls: [coldUrl] });
    await app.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime===${JSON.stringify(project.id)}`,
    );
    await app.waitFor(
      `Array.from(document.querySelectorAll('[data-workspace-ready] webview')).some(view => view.getURL() === ${JSON.stringify(coldUrl)})`,
      { label: "cold launch URL opened in the claimed project" },
    );
    await app.waitFor(
      `window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(project.id)}).then(state =>
        state?.browsers.some(browser => browser.url === ${JSON.stringify(coldUrl)}))`,
      { label: "cold launch URL persisted with the claimed project" },
    );
  }, 240_000);
});
