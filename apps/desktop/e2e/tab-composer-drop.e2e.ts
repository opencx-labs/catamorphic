import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  NEW_TAB_INPUT,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<title>Drop reference</title><p>A local reference page</p>");
});
const helpers = `
  const $ = s => document.querySelector(s);
  const chat = () => [...document.querySelectorAll('[data-chat-local-id]')].find(el => !el.closest('[inert]'));
  const composer = () => chat()?.querySelector('[data-composer-input]');
  const pills = () => [...(composer()?.querySelectorAll('[data-testid="composer-pill"]') ?? [])];
  ${setReactValueJs}
`;
const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
type DragSurface = Pick<AppHandle, "eval" | "waitFor" | "cdp">;
const wait = (body: string, label: string, surface: DragSurface = app) =>
  surface.waitFor(`(() => { ${helpers}\nreturn ${body}; })()`, { label });

/**
 * Let the actual tab write its transfer, then send it through Chromium's
 * native coordinate-based drag routing. Dispatching drop straight onto a
 * composer would skip the split overlay that can cover its chat.
 */
async function startTabDrag() {
  const items = await run<{ mimeType: string; data: string }[]>(`
    const source = $('[data-point-key^="browser:"]');
    window.__tabDropSource = source;
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    return [...transfer.types].map(mimeType => ({ mimeType, data: transfer.getData(mimeType) }));
  `);
  expect(
    items.some((item) => item.mimeType === "application/x-catamorphic-tab"),
  ).toBe(true);
  await wait("!!$('[data-tab-dragging]')", "tab drag started");
  return { items, dragOperationsMask: 17 };
}
async function pointInChat(composerTarget = false, surface: DragSurface = app) {
  return surface.eval<{ x: number; y: number }>(`(() => { ${helpers}
    const rect = ${composerTarget ? "composer()" : "chat()"}.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + ${composerTarget ? "12" : "Math.min(120, rect.height / 3)"} };
  })()`);
}
async function endTabDrag() {
  await run(`
    window.__tabDropSource.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    delete window.__tabDropSource;
  `);
  await wait("!$('[data-tab-dragging]')", "tab drag ended");
}
async function dropTab(composerTarget = false, surface: DragSurface = app) {
  const data = await startTabDrag();
  const point = await pointInChat(composerTarget, surface);
  await surface.cdp("Input.dispatchDragEvent", {
    type: "dragEnter",
    ...point,
    data,
  });
  await surface.cdp("Input.dispatchDragEvent", {
    type: "dragOver",
    ...point,
    data,
  });
  await wait(
    "chat()?.textContent.includes('Drop to attach')",
    "chat drop cue at the native hit target",
    surface,
  );
  if (surface === app && process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
        "tab-drop-target.png",
      ),
    );
  await surface.cdp("Input.dispatchDragEvent", {
    type: "drop",
    ...point,
    data,
  });
  await endTabDrag();
  await wait(
    "pills().some(p => p.dataset.pillKind === 'tab')",
    "tab attached inline",
    surface,
  );
  await wait(
    "!chat()?.textContent.includes('Drop to attach')",
    "drop cue dismissed",
    surface,
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await wait(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Create or import project')",
    "onboarding",
  );
  await run(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create or import project').click()",
  );
  await wait("!!$('[data-testid=project-name-input]')", "project name");
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Tab attachments')",
  );
  await wait(
    "!$('[data-testid=project-submit]').disabled",
    "project ready to create",
  );
  await run("$('[data-testid=project-submit]').click()");
  await wait(`!!$(${JSON.stringify(NEW_TAB_INPUT)})`, "workspace ready");
  await run(
    `setReactValue($(${JSON.stringify(NEW_TAB_INPUT)}), ${JSON.stringify(origin)})`,
  );
  await wait(
    "$('[data-item-id=web]')?.getAttribute('aria-selected') === 'true'",
    "local page selected",
  );
  await run(`$(${JSON.stringify(NEW_TAB_INPUT)}).focus()`);
  await app.press("Enter");
  await wait(
    "[...document.querySelectorAll('webview')].some(v => { try { return v.getTitle() === 'Drop reference'; } catch { return false; } })",
    "local reference page",
  );
  await run(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, [/Mac/.test(navigator.platform) ? 'metaKey' : 'ctrlKey']: true }))",
  );
  await wait(
    "!!composer() && !!chat()?.hasAttribute('data-floating-chat')",
    "floating chat",
  );
}, 180_000);

afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("workspace tab attachments", () => {
  it("drops onto the floating chat above its composer without losing its draft or moving the tab", async () => {
    await run("setReactValue(composer(), 'Read this draft ')");
    await dropTab();
    expect(await run("return composer().textContent")).toContain(
      "Read this draft ",
    );
    expect(
      await run("return pills().map(p => p.textContent).join()"),
    ).toContain("Drop reference");
    expect(
      await run(
        "return !!$('[data-point-key^=\"browser:\"]') && !$('[data-split-divider]')",
      ),
    ).toBe(true);
    if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
          "tab-drop-floating.png",
        ),
      );
  });

  it("clears the drop cue when the drag is cancelled", async () => {
    const data = await startTabDrag();
    const point = await pointInChat();
    await app.cdp("Input.dispatchDragEvent", {
      type: "dragEnter",
      ...point,
      data,
    });
    await app.cdp("Input.dispatchDragEvent", {
      type: "dragOver",
      ...point,
      data,
    });
    await wait(
      "!!$('[data-testid=chat-drop-target]')",
      "drop cue before cancellation",
    );
    // A drag can end at its source without another leave reaching the chat.
    await endTabDrag();
    await wait("!$('[data-testid=chat-drop-target]')", "cancelled drop cue");
    await app.cdp("Input.dispatchDragEvent", {
      type: "dragCancel",
      ...point,
      data,
    });
    expect(await run("return pills().length")).toBe(1);
  });

  it("keeps native file drops and the existing tab chip", async () => {
    const image = path.join(app.userDataDir, "drop-image.png");
    fs.writeFileSync(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const data = { items: [], files: [image], dragOperationsMask: 1 };
    const point = await pointInChat();
    for (const type of ["dragEnter", "dragOver", "drop"])
      await app.cdp("Input.dispatchDragEvent", { type, ...point, data });
    await wait(
      "pills().some(p => p.dataset.pillKind === 'image')",
      "native dropped image",
    );
    expect(await run("return pills().map(p => p.dataset.pillKind)")).toEqual([
      "tab",
      "image",
    ]);
    expect(await run("return composer().textContent")).toContain(
      "Read this draft ",
    );
  });

  it("drops onto a tabbed chat using the same chip and sends the tab context to the agent", async () => {
    await run(
      "chat().querySelector('button[aria-label=\"Open as tab\"]').click()",
    );
    await wait("chat()?.hasAttribute('data-chat-tab')", "chat tab");
    await run("setReactValue(composer(), 'Read the tab ')");
    await dropTab();
    expect(await run("return composer().textContent")).toContain(
      "Read the tab ",
    );
    expect(
      await run(
        "return pills().filter(p => p.dataset.pillKind === 'tab').length",
      ),
    ).toBe(2);
    expect(
      await run(
        "return !!$('[data-point-key^=\"browser:\"]') && !$('[data-split-divider]')",
      ),
    ).toBe(true);
    if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
          "tab-drop-tabbed.png",
        ),
      );
    await run("composer().focus()");
    await app.press("Enter");
    await wait(
      "chat()?.querySelector('[role=log]')?.textContent.includes('[text-pill tab]')",
      "agent received tab context",
    );
    expect(
      await run("return chat().querySelector('[role=log]').textContent"),
    ).toContain(origin);
  });

  it("accepts a sidebar tab at the top of a tall composer in a narrow reduced-motion window", async () => {
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await app.cdp("Emulation.setDeviceMetricsOverride", {
      width: 820,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await app.eval(
      "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar',headerPlacement:'sidebar'})",
    );
    await wait(
      "!!$('aside [data-point-key^=\"browser:\"]') && innerWidth === 820",
      "sidebar tabs in the narrow window",
    );
    await run(
      `setReactValue(composer(), ${JSON.stringify(Array.from({ length: 12 }, (_, i) => `Draft line ${i + 1}`).join("\n"))})`,
    );
    await wait(
      "composer()?.offsetHeight >= 96",
      "multiline composer at its height limit",
    );
    await dropTab(true);
    expect(await run("return composer().textContent")).toContain(
      "Draft line 12",
    );
    expect(await run("return pills().length")).toBe(1);
    expect(await run("return !!$('[data-split-divider]')")).toBe(false);
    await app.cdp("Emulation.clearDeviceMetricsOverride");
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  });

  it("accepts the same workspace tab in a detached chat and preserves its draft", async () => {
    await run(
      "chat().querySelector('button[aria-label=\"Pop out to floating chat\"]').click()",
    );
    await wait(
      "chat()?.hasAttribute('data-floating-chat')",
      "floating before detach",
    );
    await run("setReactValue(composer(), 'Detached draft ')");
    await app.waitFor(
      `(async () => { ${helpers} const draft = await window.catamorphicDesktop.dockDraftGet(chat().dataset.chatLocalId); return draft?.message?.includes('Detached draft'); })()`,
    );
    await app.movePointer({ x: 1, y: 1 });
    await app.eval("window.catamorphicDesktop.dockDetach(true)");
    const dock = await app.connectToFrame("surface=dock");
    try {
      await wait(
        "!!composer() && composer().textContent.includes('Detached draft')",
        "detached draft restored",
        dock,
      );
      await dropTab(false, dock);
      expect(
        await dock.eval(
          `(() => { ${helpers} return composer().textContent; })()`,
        ),
      ).toContain("Detached draft ");
      expect(
        await dock.eval(
          `(() => { ${helpers} return pills().filter(p => p.dataset.pillKind === 'tab').length; })()`,
        ),
      ).toBe(2);
      expect(dock.getRendererErrors()).toEqual([]);
    } finally {
      await app.eval("window.catamorphicDesktop.dockDetach(false)");
      dock.close();
    }
    await wait("!!composer()", "attached chat restored");
    expect(app.getRendererErrors()).toEqual([]);
  });
});
