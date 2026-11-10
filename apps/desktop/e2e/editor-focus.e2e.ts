import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  focusWindow,
  launchApp,
} from "./harness.js";

let app: AppHandle;
let projectId = "";

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor("!!document.querySelector('[data-sidebar=left]')");
  const rootPath = join(app.userDataDir, "editor-focus");
  const project = await createProjectWorkspace({
    app,
    name: "Editor focus",
    rootPath,
  });
  projectId = project.id;
  writeFileSync(join(rootPath, "ordinary.md"), "# Ordinary\n");
  writeFileSync(join(rootPath, "deferred.md"), "# Deferred\n");
  await focusWindow(app);
}, 180_000);

afterAll(async () => {
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
});

const open = (filePath: string) =>
  app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({
      projectId,
      surface: {
        url: `file:${filePath}`,
        title: filePath,
        mode: "tab",
        nonce: filePath,
      },
    })})`,
  );

/** Hold editor initialization while real Chromium input opens its tab menu. */
const holdFrames = () =>
  app.eval(`(() => {
    if (window.__editorFocusFrames) throw new Error('frames already held');
    const callbacks = new Map();
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    let nextId = 2_000_000_000;
    window.__editorFocusFrames = { callbacks, request, cancel };
    window.requestAnimationFrame = (callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!callbacks.delete(id)) cancel(id);
    };
    return true;
  })()`);

const restoreFrames = (release = false) =>
  app.eval<number>(`(() => {
    const hold = window.__editorFocusFrames;
    if (!hold) return 0;
    window.requestAnimationFrame = hold.request;
    window.cancelAnimationFrame = hold.cancel;
    delete window.__editorFocusFrames;
    const callbacks = [...hold.callbacks.values()];
    if (${release}) callbacks.forEach((callback) => callback(performance.now()));
    return callbacks.length;
  })()`);

it("focuses an opened document, then yields delayed initialization to its file menu", async () => {
  await open("ordinary.md");
  await app.waitFor(
    `(() => {
      const editor = window.__catMarkdownEditor?.editor;
      return editor && !editor.isDestroyed &&
        editor.view.dom.textContent.includes('Ordinary') &&
        document.activeElement === editor.view.dom;
    })()`,
    { label: "ordinary document takes initial focus" },
  );

  await holdFrames();
  try {
    await open("deferred.md");
    await app.waitFor(
      `(() => {
        const editor = window.__catMarkdownEditor?.editor;
        return editor && !editor.isDestroyed &&
          editor.view.dom.textContent.includes('Deferred') &&
          editor.view.dom.checkVisibility() &&
          window.__editorFocusFrames.callbacks.size > 0;
      })()`,
      { label: "real Markdown editor mounted with its initial frame held" },
    );
    const point = await app.waitFor<{ x: number; y: number }>(
      `(() => {
        const tab = [...document.querySelectorAll('[data-workspace-visible="true"] [data-point-key^="editor:"]')]
          .find((element) => element.textContent.includes('deferred.md'));
        if (!tab) return false;
        const rect = tab.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        return rect.width > 0 && tab.contains(document.elementFromPoint(point.x, point.y)) && point;
      })()`,
      { label: "deferred document tab ready for right-click" },
    );
    await app.movePointer(point);
    for (const type of ["mousePressed", "mouseReleased"])
      await app.cdp("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "right",
        clickCount: 1,
      });
    await app.waitFor(
      `(() => {
        const menu = document.querySelector('[role="menuitem"]')?.closest('[role="menu"]');
        if (!menu || !menu.contains(document.activeElement)) return false;
        window.__editorFocusMenu = menu;
        window.__editorFocusMenuItem = document.activeElement;
        return true;
      })()`,
      { label: "file menu owns focus before the editor frame is delivered" },
    );
    expect(await restoreFrames(true)).toBeGreaterThan(0);
    await app.eval(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
    );
    expect(
      await app.eval(`(() => {
        const menu = window.__editorFocusMenu;
        return menu.isConnected && menu.checkVisibility() &&
          document.activeElement === window.__editorFocusMenuItem &&
          menu.contains(document.activeElement);
      })()`),
    ).toBe(true);
    await app.press("Escape");
    await app.waitFor("!document.querySelector('[role=menuitem]')");
  } finally {
    await restoreFrames();
  }
});
