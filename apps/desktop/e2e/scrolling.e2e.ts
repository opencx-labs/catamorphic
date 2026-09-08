import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;

const run = <T>(body: string) =>
  app.eval<T>(`(() => {
  const $ = (selector) => document.querySelector(selector);
  const byText = (selector, text) => [...document.querySelectorAll(selector)]
    .find(el => el.textContent.trim() === text);
  ${setReactValueJs}
  ${body}
})()`);

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!![...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'New project')`);
  await run(`byText('button', 'New project').click();`);
  await app.waitFor(
    `!!document.querySelector('[data-testid="project-name-input"]')`,
  );
  await run(
    `setReactValue($('[data-testid="project-name-input"]'), 'scrolling-test');`,
  );
  await app.waitFor(`(() => {
    const button = document.querySelector('[data-testid="project-submit"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await app.waitFor(
    `!![...document.querySelectorAll('[role="tab"], button')].find(
    el => el.textContent.includes('New Tab'))`,
    { timeoutMs: 60_000 },
  );
  await app.waitFor(`!![...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'Settings')`);
  await run(`byText('button', 'Settings').click();`);
  await app.waitFor(
    `!!document.querySelector('[aria-label="Edit Fake Agent"]')`,
  );
  await app.eval(`window.catamorphicDesktop.devWindow('setSize', 900, 480)`);
  await app.waitFor(`window.innerHeight <= 480`);
});

afterAll(async () => {
  await app?.stop();
});

it("scrolls Settings to the last section without moving the workspace chrome", async () => {
  const before = await run<number>(
    `return document.querySelector('main').getBoundingClientRect().top;`,
  );
  const point = await run<{ x: number; y: number }>(`
    const panel = $('[data-settings-scroll]');
    panel.scrollTop = 0;
    const rect = panel.getBoundingClientRect();
    return { x: rect.right - 30, y: rect.top + 100 };
  `);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: 10000,
  });
  await app.waitFor(
    `(() => {
    const panel = document.querySelector('[data-settings-scroll]');
    const button = [...panel.querySelectorAll('button')].filter(el => el.getClientRects().length > 0).at(-1);
    const rect = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return panel.scrollTop > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  })()`,
    { label: "last Settings action reachable by wheel" },
  );
  expect(
    await run(
      `return document.querySelector('main').getBoundingClientRect().top;`,
    ),
  ).toBe(before);
  expect(await app.eval("document.scrollingElement.scrollTop")).toBe(0);
  expect(
    await run(`
    const panel = $('[data-settings-scroll]');
    const button = [...panel.querySelectorAll('button')].filter(el => el.getClientRects().length > 0).at(-1);
    const rect = button.getBoundingClientRect();
    return panel.scrollWidth <= panel.clientWidth &&
      button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  `),
  ).toBe(true);
});

it("keeps long agent dialogs inside the window and scrolls their bottom actions into view", async () => {
  await run(`$('[data-settings-scroll]').scrollTop = 0;
    $('[aria-label="Edit Fake Agent"]').click();`);
  await app.waitFor(
    `!!document.querySelector('[data-testid="configure-agent-modal"]')`,
  );
  await app.waitFor(
    `(() => {
    const panel = document.querySelector('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    return panel.scrollHeight > panel.clientHeight;
  })()`,
    { label: "agent form overflows at minimum window height" },
  );
  expect(
    await run(`
    const panel = $('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    const rect = panel.getBoundingClientRect();
    return rect.top >= 23 && rect.bottom <= window.innerHeight - 23;
  `),
  ).toBe(true);

  // The focus trap must reveal its destination, including when Shift+Tab
  // wraps straight from the initially focused panel to the final action.
  await run(`
    const panel = $('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    panel.scrollTop = 0;
    panel.focus({ preventScroll: true });
  `);
  await app.press("Tab", 8);
  await app.waitFor(
    `(() => {
    const panel = document.querySelector('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    const button = document.activeElement;
    const rect = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return button.textContent.trim() === 'Cancel' && panel.scrollTop > 0 &&
      rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  })()`,
    { label: "keyboard focus reveals the bottom action" },
  );
  await app.press("Tab");
  await app.waitFor(
    `(() => {
    const panel = document.querySelector('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    return panel.scrollTop === 0;
  })()`,
    { label: "Tab wraps back to the top of the dialog" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
