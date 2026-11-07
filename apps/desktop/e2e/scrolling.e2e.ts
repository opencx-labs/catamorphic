import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  openProjectSwitcher,
  setReactValueJs,
  workspaceDomHelpersJs,
} from "./harness.js";

let app: AppHandle;

const helpers = `${workspaceDomHelpersJs} ${setReactValueJs}
  const byText = (selector, text) => $$(selector).find(el => el.textContent.trim() === text);`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers} ${body} })()`);
const wait = (body: string, options?: { timeoutMs?: number; label?: string }) =>
  app.waitFor(`(() => { ${helpers} return (${body}); })()`, options);

beforeAll(async () => {
  app = await launchApp();
  await openProjectSwitcher(app);
  await wait(`!![...$$('button')].find(
    el => el.textContent.trim() === 'New project')`);
  await run(`byText('button', 'New project').click();`);
  await wait(`!!$('[data-testid="project-name-input"]')`);
  await run(
    `setReactValue($('[data-testid="project-name-input"]'), 'scrolling-test');`,
  );
  await wait(`(() => {
    const button = $('[data-testid="project-submit"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await wait(
    `!![...$$('[role="tab"], button')].find(
    el => el.textContent.includes('New Tab'))`,
    { timeoutMs: 60_000 },
  );
  await wait(
    `$('[aria-label="Switch project"]')?.textContent.includes('scrolling-test')`,
  );
  await wait(`!!byText('button', 'Settings')`);
  await run(`byText('button', 'Settings').click();`);
  await wait(`!!$('[aria-label="Edit Fake Agent"]')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize', 900, 480)`);
  await wait(`window.innerHeight <= 480`);
  await wait(`!$('#settings-import .animate-pulse')`);
});

afterAll(async () => {
  await app?.stop();
});

it("scrolls Settings to the last section without moving the workspace chrome", async () => {
  await app.eval(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
  const before = await run<number>(
    `return $('main').getBoundingClientRect().top;`,
  );
  const point = await run<{ x: number; y: number }>(`
    const panel = $('[data-settings-scroll]');
    panel.scrollTop = 0;
    const rect = panel.getBoundingClientRect();
    return { x: rect.right - 30, y: rect.top + 100 };
  `);
  // Sections keep loading (agents, connectors, presets) after the first
  // wheel, which can grow the page under a single tick; keep wheeling until
  // the last card is in view, the way a person would.
  const atEnd = `(() => {
    const panel = $('[data-settings-scroll]');
    const footer = panel.querySelector('#settings-import [data-testid="settings-browser-import"]');
    const rect = footer.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return panel.scrollTop > 0 && rect.bottom <= bounds.bottom + 1 && rect.bottom > bounds.top;
  })()`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: 10000,
    });
    await app.eval("new Promise((resolve) => setTimeout(resolve, 250))");
    // Stop only at the very end: the category rail follows scroll position
    // and must land on the last category, not merely show its card.
    if (
      await run<boolean>(
        `return (() => { const panel = $('[data-settings-scroll]'); return panel.scrollTop >= panel.scrollHeight - panel.clientHeight - 1; })()`,
      )
    )
      break;
  }
  await wait(atEnd, {
    label: "last Settings section reachable by wheel",
  });
  expect(await run(`return $('[aria-label="Settings category"]').value;`)).toBe(
    "import",
  );
  // Both import actions remain available before browser detection. Keep the
  // final action reachable at this short window height.
  const deltaY = await run<number>(`
    const panel = $('[data-settings-scroll]');
    const button = [...panel.querySelectorAll('button')].filter(el => el.getClientRects().length > 0).at(-1);
    const rect = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return rect.top < bounds.top ? rect.top - bounds.top - 16 : 0;
  `);
  if (deltaY !== 0) {
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY,
    });
  }
  await wait(
    `(() => {
    const panel = $('[data-settings-scroll]');
    const button = [...panel.querySelectorAll('button')].filter(el => el.getClientRects().length > 0).at(-1);
    const rect = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  })()`,
    { label: "last Settings action reachable by wheel" },
  );
  expect(await run(`return $('main').getBoundingClientRect().top;`)).toBe(
    before,
  );
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
  await wait(`!!$('[data-testid="configure-agent-modal"]')`);
  await wait(
    `(() => {
    const panel = $('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
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
  await wait(
    `(() => {
    const panel = $('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    const button = document.activeElement;
    const rect = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return button.textContent.trim() === 'Cancel' && panel.scrollTop > 0 &&
      rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  })()`,
    { label: "keyboard focus reveals the bottom action" },
  );
  await app.press("Tab");
  await wait(
    `(() => {
    const panel = $('[data-testid="configure-agent-modal"]').closest('[role="dialog"]');
    return panel.scrollTop === 0;
  })()`,
    { label: "Tab wraps back to the top of the dialog" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
