import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { WindowSession } from "../src/main/window-state.js";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle | undefined;
const frames: FrameHandle[] = [];
afterAll(async () => {
  for (const frame of frames) frame.close();
  await app?.stop();
});

const active = (projectId: string) =>
  `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(projectId)}`;
const readWindows = async (userDataDir: string): Promise<WindowSession> =>
  JSON.parse(
    await fs.readFile(path.join(userDataDir, "window-state.json"), "utf8"),
  );

it("reopens the hidden workspace when an empty window selects its profile", async () => {
  app = await launchApp();
  const handle = app;
  const profileId = await handle.eval<string>(
    "window.catamorphicDesktop.windowProfile()",
  );
  const project = await handle.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Personal work", rootPath: path.join(handle.userDataDir, "personal") })})`,
  );
  await handle.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
  );
  await handle.waitFor(active(project.id));
  await handle.waitFor("!!document.querySelector('[data-workspace-ready]')");
  // A live resource must stay in its original renderer, not be recreated in
  // the new window after its project claim is refused.
  await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key:'t', altKey:true, metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles:true
  }))`);
  await handle.waitFor(
    "!!document.querySelector('input[aria-label=\"Address and search bar\"]')",
  );
  await handle.eval(`(() => { ${setReactValueJs};
    const input = document.querySelector('input[aria-label="Address and search bar"]');
    setReactValue(input, 'data:text/html,<title>Personal page</title><p>Retained personal work</p>');
    input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
  })()`);
  await handle.waitFor("!!document.querySelector('webview')");
  await handle.eval(
    "window.__personalPage = document.querySelector('webview'); true",
  );

  const otherProfile = await handle.eval<{ id: string }>(
    "window.catamorphicDesktop.profilesCreate('Empty source')",
  );
  await handle.eval(
    `window.catamorphicDesktop.openProfileWindow(${JSON.stringify(otherProfile.id)})`,
  );
  await expect
    .poll(
      async () =>
        (await readWindows(handle.userDataDir)).windows.find(
          (window) => window.profileId === otherProfile.id,
        )?.id,
    )
    .toBeTruthy();
  // Read the settled record after the assertion, which waits for persistence.
  const sourceState = (await readWindows(handle.userDataDir)).windows.find(
    (window) => window.profileId === otherProfile.id,
  );
  if (!sourceState) throw new Error("The empty source window was not saved");
  const source = await handle.connectToFrame(`window=${sourceState.id}`);
  frames.push(source);
  await source.waitFor(
    "!!document.querySelector('[aria-label=\"Switch profile: Empty source\"]')",
  );

  // The reported path: the palette's native close action hides occupied work.
  await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key:'p', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles:true
  }))`);
  await handle.waitFor(
    "!!document.querySelector('textarea[aria-label=\"Search commands, pages, and more\"]')",
  );
  await handle.eval(`(() => { ${setReactValueJs};
    setReactValue(document.querySelector('textarea[aria-label="Search commands, pages, and more"]'), '>close current work window');
  })()`);
  await handle.waitFor(
    "Array.from(document.querySelectorAll('[role=\"option\"]')).some(row => row.textContent.includes('Close current Work window'))",
  );
  await handle.eval(
    "Array.from(document.querySelectorAll('[role=\"option\"]')).find(row => row.textContent.includes('Close current Work window')).dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }))",
  );
  await handle.waitFor(
    "window.catamorphicDesktop.devWindow('get').then(state => !state.visible)",
  );

  await source.eval(
    "document.querySelector('[aria-label=\"Switch profile: Empty source\"]').click()",
  );
  await source.waitFor(
    '!!document.querySelector(\'[role="dialog"][aria-label="Profiles"]:not([inert])\')',
  );
  await source.eval(
    "Array.from(document.querySelectorAll('[role=\"dialog\"][aria-label=\"Profiles\"] button')).find(button => button.textContent.includes('Default Profile')).click()",
  );
  await handle.waitFor(
    "window.catamorphicDesktop.devWindow('get').then(state => state.visible && state.focused)",
    { label: "the hidden Personal workspace comes forward" },
  );
  await source.waitFor(
    "!!document.querySelector('[aria-label=\"Switch profile: Empty source\"]') && !document.querySelector('.animate-profile-veil-in, .animate-profile-veil-out')",
  );
  expect(await source.eval("window.catamorphicDesktop.windowProfile()")).toBe(
    otherProfile.id,
  );
  expect(
    await source.eval(
      "window.catamorphicDesktop.profilesList().then(data => data.lastActiveProfileId)",
    ),
  ).toBe(profileId);
  expect(await handle.eval(active(project.id))).toBe(true);
  expect(
    await handle.eval(
      "window.__personalPage.isConnected && window.__personalPage === document.querySelector('webview')",
    ),
  ).toBe(true);
  expect(
    await handle.eval(
      "document.body.innerText.includes('Make yourself at home')",
    ),
  ).toBe(false);
  expect(handle.getRendererErrors()).toEqual([]);
  expect(source.getRendererErrors()).toEqual([]);
  if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
    await handle.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
        "profile-reopened.png",
      ),
    );

  // Preserve a fixture matching installs that already have an empty duplicate.
  await handle.eval("window.close()");
  await handle.waitFor(
    "window.catamorphicDesktop.devWindow('get').then(state => !state.visible)",
  );
  await handle.stop({ preserveUserData: true });
  source.close();
  const saved = await readWindows(handle.userDataDir);
  const duplicate = saved.windows.find(
    (window) => window.id === sourceState.id,
  );
  if (!duplicate) throw new Error("The empty source window was not retained");
  duplicate.profileId = profileId;
  await fs.writeFile(
    path.join(handle.userDataDir, "window-state.json"),
    JSON.stringify(saved),
  );
  app = await launchApp({
    userDataDir: handle.userDataDir,
    activateWindow: false,
  });
  const empty = await app.connectToFrame(`window=${sourceState.id}`);
  frames.push(empty);
  await empty.waitFor(
    "!!document.querySelector('[aria-label=\"Switch profile: Default Profile\"]')",
  );
  await empty.eval("window.catamorphicDesktop.devWindow('focus')");
  const ownerState = saved.windows.find((window) =>
    window.projectIds.includes(project.id),
  );
  if (!ownerState)
    throw new Error("The original project owner was not retained");
  const owner = await app.connectToFrame(`window=${ownerState.id}`);
  frames.push(owner);
  await owner.waitFor(active(project.id));
  await empty.eval(
    `window.catamorphicDesktop.openProfileWindow(${JSON.stringify(profileId)})`,
  );
  await owner.waitFor(
    "window.catamorphicDesktop.devWindow('get').then(state => state.visible && state.focused)",
    { label: "retained work wins over the focused empty duplicate" },
  );
  expect(await owner.eval(active(project.id))).toBe(true);
  expect(
    (await readWindows(handle.userDataDir)).windows.filter((window) =>
      window.projectIds.includes(project.id),
    ),
  ).toHaveLength(1);
  expect(owner.getRendererErrors()).toEqual([]);
  expect(empty.getRendererErrors()).toEqual([]);
}, 180_000);
