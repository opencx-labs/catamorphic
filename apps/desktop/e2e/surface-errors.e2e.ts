import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle;
const probe = "e2e surface failure probe";
const inputSelector = '[aria-label="Search commands, pages, and more"]';
const helpers = `${setReactValueJs}
const input=()=>[...document.querySelectorAll('[data-workspace-visible="true"] ${inputSelector}')].find(el=>!el.closest('[inert]') && el.checkVisibility());
`;
const run = <T>(code: string) => app.eval<T>(`(()=>{${helpers};${code}})()`);
const shortcut = (key: string) =>
  app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
const type = (value: string) =>
  run(`setReactValue(document.activeElement,${JSON.stringify(value)})`);
const waitForInput = () =>
  app.waitFor(
    `document.activeElement?.matches(${JSON.stringify(inputSelector)})`,
  );
const expectFailures = (count: number) => {
  const errors = app.getRendererErrors();
  expect(errors).toHaveLength(count);
  for (const error of errors) {
    expect(error).toMatch(/^\[Work\] Could not render /);
    expect(error).toMatch(/E2E (surface failure|chat render failure)/);
  }
};
// A render failure in the real ranking path, with no product test hook.
// Keep throwing through React's retry, then restore before testing recovery.
const injectFailure = () =>
  app.eval(`(() => {
  window.__surfaceIndexOf = String.prototype.indexOf;
  String.prototype.indexOf = function(query, ...rest) {
    if (query === ${JSON.stringify(probe)}) throw new Error('E2E surface failure');
    return window.__surfaceIndexOf.apply(this, [query, ...rest]);
  };
})()`);
const restore = () =>
  app.eval(`(() => {
  if (window.__surfaceIndexOf) String.prototype.indexOf = window.__surfaceIndexOf;
  if (window.__surfaceLowerCase) String.prototype.toLowerCase = window.__surfaceLowerCase;
  delete window.__surfaceIndexOf;
  delete window.__surfaceLowerCase;
})()`);
const clickButton = async (selector: string, text: string) => {
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(`${selector} button`)})].find(el => el.textContent === ${JSON.stringify(text)} && el.checkVisibility());
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const point = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    return button.contains(document.elementFromPoint(point.x, point.y)) && point;
  })()`);
  await app.movePointer(point);
  await app.clickPointer(point);
};

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  await createProjectWorkspace({
    app,
    name: "Surface recovery",
    rootPath: path.join(app.userDataDir, "surface-recovery"),
  });
  await app.eval(`window.catamorphicDesktop.devWindow('fitSize',1300,900)`);
});
afterAll(async () => {
  if (app) {
    await restore();
    await app.eval(`(() => {
      if (window.__surfaceNotification) window.Notification = window.__surfaceNotification;
      if (window.__surfaceHasFocus) document.hasFocus = window.__surfaceHasFocus;
    })()`);
    await app.stop();
  }
});

it("keeps repeated-space fuzzy queries usable in the real palette", async () => {
  await shortcut("p");
  await waitForInput();
  await type("frmd  co");
  await app.waitFor(
    `[...document.querySelectorAll('[data-workspace-visible="true"] [data-palette="overlay"] [role="option"]')].some(el => el.textContent.includes('Framed content'))`,
  );
  await app.press("Escape");
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] [data-palette="overlay"]')?.closest('[inert]')`,
  );
  expectFailures(0);
});

it("contains a tab render failure to its half of a split and preserves the other pane", async () => {
  await shortcut("t");
  await waitForInput();
  await type("keep this draft");
  await shortcut("t");
  await waitForInput();
  await type("second tab");
  await shortcut("\\");
  await app.waitFor(
    `document.querySelectorAll('[data-workspace-visible="true"] [data-workspace-slot] [data-palette="tab"]').length === 2`,
  );
  const failedKey = await app.eval<string>(`(() => {
    ${setReactValueJs}
    const inputs = [...document.querySelectorAll('[data-workspace-visible="true"] [data-workspace-slot] ${inputSelector}')];
    const input = inputs.find(el => el.value === 'second tab');
    const healthy = inputs.find(el => el !== input);
    // New Tab content mounts when it becomes visible; seed the sibling's
    // draft after both halves of the split are on screen.
    setReactValue(healthy, 'keep this draft');
    input.focus();
    const pane = input.closest('[data-surface-key]');
    window.__healthySurfaceInput = healthy;
    return pane.dataset.surfaceKey;
  })()`);
  await injectFailure();
  try {
    await type(probe);
    await app.waitFor(
      `!!document.querySelector('[data-surface-key="${failedKey}"] [data-surface-error]')`,
    );
    expect(
      await app.eval(
        `window.__healthySurfaceInput.isConnected && window.__healthySurfaceInput.value === 'keep this draft'`,
      ),
    ).toBe(true);
    expect(
      await app.eval(
        `document.querySelectorAll('[data-surface-error]').length`,
      ),
    ).toBe(1);
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp",
        "split-surface-error.png",
      ),
    );
  } finally {
    await restore();
  }
  await clickButton(
    `[data-surface-key="${failedKey}"] [data-surface-error]`,
    "Try again",
  );
  await app.waitFor(
    `!!document.querySelector('[data-surface-key="${failedKey}"] ${inputSelector}') && !document.querySelector('[data-surface-error]')`,
  );
  expect(
    await app.eval(
      `window.__healthySurfaceInput.isConnected && window.__healthySurfaceInput.value === 'keep this draft'`,
    ),
  ).toBe(true);
  await waitForInput();
  await injectFailure();
  try {
    await type(probe);
    await app.waitFor(
      `!!document.querySelector('[data-surface-key="${failedKey}"] [data-surface-error]')`,
    );
  } finally {
    await restore();
  }
  await clickButton(
    `[data-surface-key="${failedKey}"] [data-surface-error]`,
    "Close tab",
  );
  await app.waitFor(
    `!document.querySelector('[data-surface-key="${failedKey}"]')`,
  );
  expect(
    await app.eval(
      `window.__healthySurfaceInput.isConnected && window.__healthySurfaceInput.value === 'keep this draft'`,
    ),
  ).toBe(true);
  expectFailures(2);
});

it("lets a failed overlay close with Escape and opens a fresh palette", async () => {
  await shortcut("p");
  await waitForInput();
  await injectFailure();
  try {
    await type(probe);
    await app.waitFor(
      `!!document.querySelector('[role="dialog"] [data-surface-error]')`,
    );
    expect(
      await app.eval(
        `window.__healthySurfaceInput.isConnected && window.__healthySurfaceInput.value === 'keep this draft'`,
      ),
    ).toBe(true);
  } finally {
    await restore();
  }
  await app.press("Escape");
  await app.waitFor(`!document.querySelector('[data-surface-error]')`);
  await shortcut("p");
  await app.waitFor(
    `!!document.activeElement?.closest('[data-palette="overlay"]') && !document.activeElement.closest('[inert]')`,
  );
  await type("framed content");
  await app.waitFor(
    `[...document.querySelectorAll('[data-workspace-visible="true"] [data-palette="overlay"] [role="option"]')].some(el => el.textContent.includes('Framed content'))`,
  );
  await app.press("Escape");
  expectFailures(3);
});

it("recovers a failed chat in the same tab and keeps the tab's close action working", async () => {
  await shortcut("n");
  const chatId = await app.waitFor<string>(`(() => {
    const chat = document.querySelector('[data-chat-tab]');
    const composer = chat?.querySelector('[data-composer-input]');
    return composer && chat.dataset.chatLocalId;
  })()`);
  const composer = `[data-chat-local-id="${chatId}"] [data-composer-input]`;
  const activity = `[data-workspace-visible="true"] [data-point-key="chat:${chatId}"] [data-activity="working"]`;
  await app.eval(`(() => {
    ${setReactValueJs}
    const input = document.querySelector(${JSON.stringify(composer)});
    setReactValue(input, 'perf turn steps=0 quiet=90 stream=1');
    input.closest('form').requestSubmit();
  })()`);
  await app.waitFor(`!!document.querySelector(${JSON.stringify(activity)})`);
  await app.eval(`(() => {
    window.__surfaceNotification = window.Notification;
    window.__surfaceHasFocus = document.hasFocus;
    window.__surfaceNotifications = [];
    window.Notification = class {
      static permission = 'granted';
      constructor(title, options) { window.__surfaceNotifications.push(options.body); }
    };
    document.hasFocus = () => false;
  })()`);
  const crashChat = async () => {
    await app.eval(`(() => {
      window.__surfaceLowerCase = String.prototype.toLowerCase;
      String.prototype.toLowerCase = function() {
        if (String(this) === 'e2e_surface_failure') throw new Error('E2E chat render failure');
        return window.__surfaceLowerCase.call(this);
      };
      document.querySelector(${JSON.stringify(composer)}).focus();
    })()`);
    try {
      await app.insertText("/e2e_surface_failure");
      await app.waitFor(
        `!!document.querySelector('[data-chat-local-id="${chatId}"] [data-surface-error]')`,
      );
    } finally {
      await restore();
    }
  };
  await crashChat();
  expect(
    await app.eval(`!!document.querySelector(${JSON.stringify(activity)})`),
  ).toBe(true);
  expect(await app.eval(`window.__surfaceNotifications`)).toEqual([]);
  expect(
    await app.eval(
      `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]')`,
    ),
  ).toBe(true);
  await clickButton(
    `[data-chat-local-id="${chatId}"] [data-surface-error]`,
    "Try again",
  );
  await app.waitFor(`!!document.querySelector(${JSON.stringify(composer)})`);
  // The failed slash query is a retained draft, so the composer shows Send
  // until it is cleared. The backend turn must still offer Stop afterward.
  await app.eval(`document.querySelector(${JSON.stringify(composer)}).focus()`);
  // CDP does not resolve macOS's native editing key bindings.
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 4 : 2,
      ...(type === "keyDown" ? { commands: ["selectAll"] } : {}),
    });
  await app.press("Backspace");
  await app.waitFor(
    `document.querySelector(${JSON.stringify(composer)})?.textContent === ''`,
    { label: "the retained failed-query draft cleared" },
  );
  await app.waitFor(
    `!!document.querySelector('[data-chat-local-id="${chatId}"] [data-testid="chat-stop"]')`,
  );
  expect(await app.eval(`window.__surfaceNotifications`)).toEqual([]);
  await crashChat();
  expect(
    await app.eval(`!!document.querySelector(${JSON.stringify(activity)})`),
  ).toBe(true);
  expect(await app.eval(`window.__surfaceNotifications`)).toEqual([]);
  await app.eval(`(() => {
    window.Notification = window.__surfaceNotification;
    document.hasFocus = window.__surfaceHasFocus;
    delete window.__surfaceNotification;
    delete window.__surfaceHasFocus;
  })()`);
  await app.eval(
    `document.querySelector('[data-workspace-visible="true"] [data-point-key="chat:${chatId}"] [aria-label^="Close"]').click()`,
  );
  await app.waitFor(
    `!document.querySelector('[data-chat-local-id="${chatId}"]')`,
  );
  expectFailures(5);
});

it("fits detached window recovery and accepts a native click on Try again", async () => {
  // With no workspace tabs left, a new chat intentionally occupies the
  // workspace. Keep a tab behind this fixture so it can minimize to the dock.
  await shortcut("t");
  await waitForInput();
  await app.eval(`window.catamorphicDesktop.dockNewChat()`);
  const chatId = await app.waitFor<string>(
    `document.querySelector('[data-floating-chat] [data-composer-input]')?.closest('[data-chat-local-id]').dataset.chatLocalId`,
  );
  await app.eval(`(() => {
    ${setReactValueJs}
    setReactValue(document.querySelector('[data-chat-local-id="${chatId}"] [data-composer-input]'), 'recovery fixture');
  })()`);
  await app.waitFor(
    `!!document.querySelector('[data-chat-local-id="${chatId}"] [aria-label="Minimize chat to bubble"]')`,
  );
  await app.eval(
    `document.querySelector('[data-chat-local-id="${chatId}"] [aria-label="Minimize chat to bubble"]').click()`,
  );
  await app.waitFor(`!document.querySelector('[data-floating-chat]')`);
  await app.eval(`window.catamorphicDesktop.dockDetach(true)`);
  const dock = await app.connectToFrame("surface=dock");
  try {
    await dock.waitFor(
      `!!document.querySelector('[data-dock-host]') && innerHeight < 160`,
    );
    await dock.eval(`(() => {
      window.__surfaceFilter = Array.prototype.filter;
      Array.prototype.filter = function(fn, ...rest) {
        if (this.some(item => item && typeof item === 'object' && item.entry && item.projectId))
          throw new Error('E2E dock root render failure');
        return window.__surfaceFilter.call(this, fn, ...rest);
      };
    })()`);
    await app.eval(
      `window.catamorphicDesktop.dockActivate(${JSON.stringify(chatId)})`,
    );
    await dock.waitFor(
      `!!document.querySelector('[data-surface-error]') && innerWidth >= 480 && innerHeight >= 220`,
    );
    await dock.eval(
      `Array.prototype.filter = window.__surfaceFilter; delete window.__surfaceFilter;`,
    );
    await dock.eval(`window.catamorphicDesktop.devWindow('focus')`);
    await dock.waitFor(`document.hasFocus()`);
    // The OS applies a resized X11 window's restored input shape after
    // Electron's IPC returns, as in the dock's other native pointer tests.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await dock.eval(`document.addEventListener('pointerdown', event => {
      window.__recoveryPointer = {x: event.clientX, y: event.clientY, target: event.target.outerHTML};
    }, true)`);
    const button = await dock.waitFor<{ x: number; y: number }>(`(() => {
      const button = document.querySelector('[data-surface-error] button');
      const rect = button.getBoundingClientRect();
      const point = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      return getComputedStyle(button).pointerEvents === 'auto' &&
        rect.bottom < innerHeight && button.contains(document.elementFromPoint(point.x, point.y)) && point;
    })()`);
    const dockBounds = await dock.eval<{ x: number; y: number }>(
      `window.catamorphicDesktop.devWindow('get').then(state => state.contentBounds)`,
    );
    const mainBounds = await app.eval<{ x: number; y: number }>(
      `window.catamorphicDesktop.devWindow('get').then(state => state.contentBounds)`,
    );
    const point = {
      x: dockBounds.x - mainBounds.x + button.x,
      y: dockBounds.y - mainBounds.y + button.y,
    };
    await app.movePointer(point);
    await app.clickPointer(point);
    await dock
      .waitFor(
        `!!document.querySelector('[data-dock-host]') && !document.querySelector('[data-surface-error]')`,
      )
      .catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}; recovery pointer: ${JSON.stringify(await dock.eval(`({pointer: window.__recoveryPointer, focused: document.hasFocus(), width: innerWidth, height: innerHeight, text: document.body.innerText})`))}; current bounds: ${JSON.stringify(await dock.eval(`window.catamorphicDesktop.devWindow('get')`))}; dock bounds: ${JSON.stringify(dockBounds)}; main bounds: ${JSON.stringify(mainBounds)}; point: ${JSON.stringify(point)}`,
        );
      });
    expect(dock.getRendererErrors()).toHaveLength(1);
    expect(dock.getRendererErrors()[0]).toContain(
      "E2E dock root render failure",
    );
  } finally {
    await dock.eval(
      `if (window.__surfaceFilter) Array.prototype.filter = window.__surfaceFilter;`,
    );
    dock.close();
    await app.eval(`window.catamorphicDesktop.dockDetach(false)`);
  }
  expectFailures(5);
});
